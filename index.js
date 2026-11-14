const MODULE_NAME = 'st_refresh_extension';
const EXTENSION_NAME = '🔄 새로고침';
const MENU_ITEM_ID = 'st-refresh-wand-item';
const SETTINGS_ID = 'st-refresh-extension-settings';
const DIALOG_ID = 'st-refresh-confirm-dialog';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    confirmBeforeRefresh: true,
});

let settings;
let saveSettingsDebounced;
let uiObserver;
let menuObserver;
let syncQueued = false;

function loadSettings() {
    const context = SillyTavern.getContext();
    const extensionSettings = context.extensionSettings;
    saveSettingsDebounced = context.saveSettingsDebounced;

    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }

    settings = extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (typeof settings[key] === 'undefined') {
            settings[key] = value;
        }
    }
    saveSettingsDebounced();
}

function saveSettings() {
    saveSettingsDebounced?.();
}

function refreshPage() {
    closeConfirmDialog();
    window.location.reload();
}

function closeConfirmDialog() {
    const overlay = document.getElementById(DIALOG_ID);
    if (!overlay) return;
    overlay.remove();
}

function showConfirmDialog() {
    if (document.getElementById(DIALOG_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = DIALOG_ID;
    overlay.className = 'st-refresh-dialog-overlay';
    overlay.innerHTML = `
        <section class="st-refresh-dialog" role="dialog" aria-modal="true" aria-labelledby="st-refresh-dialog-title">
            <div id="st-refresh-dialog-title" class="st-refresh-dialog-title">새로고침 할래?</div>
            <div class="st-refresh-dialog-actions">
                <button type="button" class="st-refresh-cancel">아니</button>
                <button type="button" class="st-refresh-accept">응</button>
            </div>
        </section>
    `;

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeConfirmDialog();
    });

    const cancelButton = overlay.querySelector('.st-refresh-cancel');
    const acceptButton = overlay.querySelector('.st-refresh-accept');
    cancelButton.addEventListener('click', closeConfirmDialog);
    acceptButton.addEventListener('click', refreshPage);

    document.body.appendChild(overlay);
    cancelButton.focus({ preventScroll: true });
}

function requestRefresh() {
    if (!settings?.enabled) return;
    if (settings.confirmBeforeRefresh) {
        showConfirmDialog();
    } else {
        refreshPage();
    }
}

function handleDialogKeydown(event) {
    const overlay = document.getElementById(DIALOG_ID);
    if (!overlay) return;

    if (event.key === 'Escape') {
        event.preventDefault();
        closeConfirmDialog();
        return;
    }

    if (event.key === 'Tab') {
        const buttons = [...overlay.querySelectorAll('button:not(:disabled)')];
        if (buttons.length !== 2) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }
}

function findSettingsPanel() {
    // These are the standard SillyTavern extension settings containers.
    return document.querySelector('#extensions_settings2, #extensions_settings');
}

function findWandMenu() {
    // The list-group is preferred when present; fall back to the menu container.
    return document.querySelector(
        '#extensionsMenu .list-group, #extensions_menu .list-group, #extensionsMenu, #extensions_menu'
    );
}

function renderSettings() {
    if (document.getElementById(SETTINGS_ID)) return true;

    const settingsPanel = findSettingsPanel();
    if (!settingsPanel) return false;

    const container = document.createElement('div');
    container.id = SETTINGS_ID;
    container.className = 'st-refresh-settings';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${EXTENSION_NAME}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="st-refresh-enabled">
                    <input id="st-refresh-enabled" type="checkbox">
                    <span>활성화</span>
                </label>
                <label class="checkbox_label" for="st-refresh-confirm">
                    <input id="st-refresh-confirm" type="checkbox">
                    <span>새로고침 전 확인 팝업 표시</span>
                </label>
                <div class="st-refresh-settings-action">
                    <button id="st-refresh-settings-button" class="menu_button" type="button" title="새로고침" aria-label="새로고침">🔄</button>
                </div>
            </div>
        </div>
    `;

    settingsPanel.appendChild(container);

    const enabledInput = container.querySelector('#st-refresh-enabled');
    const confirmInput = container.querySelector('#st-refresh-confirm');
    const refreshButton = container.querySelector('#st-refresh-settings-button');

    function updateControls() {
        enabledInput.checked = Boolean(settings.enabled);
        confirmInput.checked = Boolean(settings.confirmBeforeRefresh);
        confirmInput.disabled = !settings.enabled;
        refreshButton.disabled = !settings.enabled;
        container.classList.toggle('st-refresh-disabled', !settings.enabled);
    }

    enabledInput.addEventListener('change', () => {
        settings.enabled = enabledInput.checked;
        updateControls();
        updateWandMenuItem();
        saveSettings();
    });

    confirmInput.addEventListener('change', () => {
        settings.confirmBeforeRefresh = confirmInput.checked;
        saveSettings();
    });

    refreshButton.addEventListener('click', requestRefresh);
    updateControls();
    return true;
}

function updateWandMenuItem() {
    const existing = document.getElementById(MENU_ITEM_ID);
    if (!settings?.enabled) {
        existing?.remove();
        return Boolean(existing);
    }

    const menu = findWandMenu();
    if (!menu) return false;

    // If SillyTavern recreates its menu, recreate this item in the new container.
    if (existing && existing.parentElement === menu) return true;
    existing?.remove();

    const item = document.createElement('button');
    item.id = MENU_ITEM_ID;
    item.type = 'button';
    item.className = 'list-group-item flex-container flexGap5 st-refresh-wand-item';
    item.textContent = '🔄 새로고침';
    item.addEventListener('click', requestRefresh);
    menu.appendChild(item);
    observeMenuContainer(menu);
    return true;
}

function observeMenuContainer(menu) {
    if (!menu?.parentElement || menuObserver?.target === menu.parentElement) return;
    menuObserver?.disconnect();
    menuObserver = new MutationObserver(() => {
        // Re-add the item if SillyTavern rebuilds the Extensions menu.
        if (settings?.enabled && !document.getElementById(MENU_ITEM_ID)) {
            updateWandMenuItem();
        }
    });
    menuObserver.target = menu.parentElement;
    menuObserver.observe(menu.parentElement, { childList: true });
}

function queueUiSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
        syncQueued = false;
        renderSettings();
        updateWandMenuItem();
    });
}

function observeUi() {
    if (uiObserver) uiObserver.disconnect();

    // SillyTavern can build/rebuild its settings and Extensions menu after the
    // extension script loads. Observe only until both UI elements are mounted.
    uiObserver = new MutationObserver(() => {
        queueUiSync();
        const settingsReady = Boolean(document.getElementById(SETTINGS_ID));
        const menuReady = Boolean(document.getElementById(MENU_ITEM_ID));
        if (settingsReady && menuReady) {
            uiObserver.disconnect();
            uiObserver = null;
        }
    });

    uiObserver.observe(document.body, { childList: true, subtree: true });
    queueUiSync();
}

function initialize() {
    loadSettings();
    observeUi();
    document.addEventListener('keydown', handleDialogKeydown);
    console.log(`[${EXTENSION_NAME}] 확장이 준비되었습니다.`);
}

jQuery(initialize);
