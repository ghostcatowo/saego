/**
 * 새로고침 (refresh_button)
 * 코드 버전: v1.2.0
 *
 * ★ 코드를 고칠 때마다 이 버전을 올릴 것!
 *   - manifest.json 의 "version" 과 style.css 맨 위 버전도 같은 숫자로 같이 올리기
 *   - 작은 수정(버그, 문구, 디자인): 1.2.0 → 1.2.1
 *   - 기능 추가/변경:               1.2.0 → 1.3.0
 *
 * 변경 기록
 *   v1.2.0  팝업 디자인 개선(둥근 모서리, 응/아니 색), '새로고침 전 확인' → '새로고침 팝업'(켜기/끄기)
 *   v1.1.0  실리태번 기본 팝업 사용, 팝업 위치/탭 닫힘 문제 수정
 *   v1.0.0  첫 버전
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'refresh_button';
const NAME = '새로고침';
const FLAG = 'rf_manual_reload';
const DEFAULTS = { enabled: true, confirm: true, guard: true };

let popupOpen = false;
let manualReload = false;
let lockAbort = null;

/* ---------------- 설정 ---------------- */

function getSettings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    for (const key of Object.keys(DEFAULTS)) {
        if (typeof s[key] !== 'boolean') s[key] = DEFAULTS[key];
    }
    return s;
}

/* ---------------- 새로고침 ---------------- */

function doReload() {
    manualReload = true;
    try { sessionStorage.setItem(FLAG, '1'); } catch { /* 무시 */ }
    location.reload();
}

async function requestReload() {
    const s = getSettings();
    if (!s.enabled || popupOpen) return;
    if (s.confirm && !(await askConfirm())) return;
    doReload();
}

/* ---------------- 확인 팝업 ---------------- */

// 실리태번 기본 팝업을 써서 위치/닫힘 문제를 피함. 안 되면 아래 직접 만든 팝업으로 대체
async function askConfirm() {
    try {
        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = await import('../../../popup.js');
        popupOpen = true;
        try {
            const result = await callGenericPopup(
                '<div class="rf-native-text">새로고침 할래?</div>',
                POPUP_TYPE.CONFIRM,
                '',
                {
                    okButton: '응',
                    cancelButton: '아니',
                    onOpen: (popup) => tidyNativePopup(popup, POPUP_RESULT),
                },
            );
            return result === POPUP_RESULT.AFFIRMATIVE;
        } finally {
            popupOpen = false;
        }
    } catch (err) {
        console.warn(`[${NAME}] 기본 팝업을 못 써서 대체 팝업을 사용해요`, err);
        return askConfirmFallback();
    }
}

// 왼쪽 '아니' / 오른쪽 '응', X 버튼 숨김, 바깥 클릭으로 취소
function tidyNativePopup(popup, POPUP_RESULT) {
    try {
        const { okButton, cancelButton, closeButton, dlg, body } = popup;
        dlg?.classList.add('rf-popup');
        if (cancelButton) cancelButton.style.order = '0';
        if (okButton) okButton.style.order = '1';
        if (closeButton) closeButton.style.display = 'none';
        dlg?.addEventListener('click', (e) => {
            if (e.target !== dlg) return;
            const r = (body || dlg).getBoundingClientRect();
            const inside = e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top && e.clientY <= r.bottom;
            if (inside) return;
            try {
                if (typeof popup.completeCancelled === 'function') popup.completeCancelled();
                else if (typeof popup.complete === 'function') popup.complete(POPUP_RESULT.CANCELLED);
            } catch { /* 무시 */ }
        });
    } catch { /* 무시 */ }
}

function askConfirmFallback() {
    return new Promise((resolve) => {
        popupOpen = true;
        const prevFocus = document.activeElement;
        const openedAt = Date.now();

        const overlay = document.createElement('div');
        overlay.className = 'rf-overlay';
        overlay.innerHTML = `
            <div class="rf-dialog" role="alertdialog" aria-modal="true" aria-labelledby="rf-dialog-text">
                <p class="rf-dialog-text" id="rf-dialog-text">새로고침 할래?</p>
                <div class="rf-dialog-actions">
                    <button type="button" class="rf-btn-no">아니</button>
                    <button type="button" class="rf-btn-yes">응</button>
                </div>
            </div>`;

        const btnNo = overlay.querySelector('.rf-btn-no');
        const btnYes = overlay.querySelector('.rf-btn-yes');

        // 화면 크기가 꼬여도(주소창, 확대, 키보드) 지금 보이는 영역 가운데에 뜨도록 맞춤
        const vv = window.visualViewport;
        const fit = () => {
            if (!vv) return;
            overlay.style.inset = 'auto';
            overlay.style.left = `${vv.offsetLeft}px`;
            overlay.style.top = `${vv.offsetTop}px`;
            overlay.style.width = `${vv.width}px`;
            overlay.style.height = `${vv.height}px`;
        };

        const close = (result) => {
            vv?.removeEventListener('resize', fit);
            vv?.removeEventListener('scroll', fit);
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            popupOpen = false;
            try { prevFocus?.focus?.(); } catch { /* 무시 */ }
            resolve(result);
        };

        function onKey(e) {
            if (e.key === 'Escape' || e.key === 'Esc') {
                e.preventDefault();
                e.stopPropagation();
                close(false);
            } else if (e.key === 'Tab') {
                const active = document.activeElement;
                if (e.shiftKey && active === btnNo) { e.preventDefault(); btnYes.focus(); }
                else if (!e.shiftKey && active === btnYes) { e.preventDefault(); btnNo.focus(); }
                else if (active !== btnNo && active !== btnYes) { e.preventDefault(); btnNo.focus(); }
            }
        }

        // 팝업을 연 터치가 바로 바깥 클릭으로 처리되는 것을 막기 위해 잠깐 무시
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && Date.now() - openedAt > 250) close(false);
        });
        btnNo.addEventListener('click', () => close(false));
        btnYes.addEventListener('click', () => close(true));
        document.addEventListener('keydown', onKey, true);

        // 팝업 안의 터치/클릭을 실리태번이 "바깥 클릭"으로 받아 확장 탭을 닫지 않게 막음
        for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) {
            overlay.addEventListener(type, (e) => e.stopPropagation());
        }

        document.body.appendChild(overlay);
        fit();
        vv?.addEventListener('resize', fit);
        vv?.addEventListener('scroll', fit);
        btnNo.focus();
    });
}

/* ---------------- 새로고침 방지 ---------------- */

function onBeforeUnload(e) {
    if (manualReload) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
}

// Web Lock을 쥐고 있으면 브라우저가 탭을 정리할 때 덜 건드리는 경우가 있음 (보장은 아님)
function acquireLock() {
    if (lockAbort || !navigator.locks) return;
    const ac = new AbortController();
    lockAbort = ac;
    navigator.locks
        .request(`rf-keepalive-${Math.random().toString(36).slice(2)}`, { signal: ac.signal }, () =>
            new Promise((resolve) => ac.signal.addEventListener('abort', resolve, { once: true })))
        .catch(() => { /* 무시 */ });
}

function releaseLock() {
    lockAbort?.abort();
    lockAbort = null;
}

function applyGuard() {
    const s = getSettings();
    const on = s.enabled && s.guard;
    document.documentElement.classList.toggle('rf-guard', on);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (on) {
        window.addEventListener('beforeunload', onBeforeUnload);
        acquireLock();
    } else {
        releaseLock();
    }
}

// 직접 누르지 않은 새로고침/재로드로 열렸다면 알려줌
function notifyIfReloaded() {
    const s = getSettings();
    let wasManual = false;
    try {
        wasManual = sessionStorage.getItem(FLAG) === '1';
        sessionStorage.removeItem(FLAG);
    } catch { /* 무시 */ }
    if (!s.enabled || !s.guard || wasManual) return;

    const nav = performance.getEntriesByType?.('navigation')?.[0];
    if (document.wasDiscarded || nav?.type === 'reload') {
        if (typeof toastr !== 'undefined') toastr.info('페이지가 다시 불러와졌어요.', NAME);
    }
}

/* ---------------- UI ---------------- */

function segBlock(key, title, hint, labelOn, labelOff) {
    return `
        <div class="rf-block" data-key="${key}">
            <div class="rf-title">${title}</div>
            <div class="rf-hint">${hint}</div>
            <div class="rf-seg" role="radiogroup" aria-label="${title}">
                <button type="button" role="radio" data-val="1">${labelOn}</button>
                <button type="button" role="radio" data-val="0">${labelOff}</button>
            </div>
        </div>`;
}

function buildSettingsHtml() {
    return `
    <div class="rf-settings extension_container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-rotate"></i> ${NAME}</b>
                <span class="rf-status" role="img"></span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <button type="button" class="rf-reload">
                    <i class="fa-solid fa-rotate"></i><span>${NAME}</span>
                </button>
                ${segBlock('enabled', '확장 활성화',
                    '끄면 마법봉 메뉴의 새로고침도 사라져요.', '켜기', '끄기')}
                ${segBlock('confirm', '새로고침 팝업',
                    '켜면 새로고침 전에 한 번 물어봐요. 마법봉 메뉴에도 똑같이 적용돼요.', '켜기', '끄기')}
                ${segBlock('guard', '새로고침 방지',
                    '자동 새로고침을 최대한 막아요. 직접 누른 새로고침은 그대로 돼요. 브라우저가 메모리 부족으로 탭을 정리하는 건 완전히 막을 수 없어요.',
                    '켜기', '끄기')}
            </div>
        </div>
    </div>`;
}

function refreshUI() {
    const s = getSettings();
    const guardOn = s.enabled && s.guard;
    const $root = $('.rf-settings');

    $root.toggleClass('rf-disabled', !s.enabled);
    $root.find('.rf-reload').prop('disabled', !s.enabled);
    $root.find('.rf-block').not('[data-key="enabled"]').find('button').prop('disabled', !s.enabled);

    $root.find('.rf-block').each(function () {
        const value = s[this.dataset.key];
        $(this).find('.rf-seg button').each(function () {
            this.setAttribute('aria-checked', String((this.dataset.val === '1') === value));
        });
    });

    const label = guardOn ? '새로고침 방지 켜짐' : '새로고침 방지 꺼짐';
    $root.find('.rf-status')
        .toggleClass('rf-on', guardOn)
        .toggleClass('rf-off', !guardOn)
        .attr({ title: label, 'aria-label': label });

    $('#rf_wand_container').toggle(s.enabled);
    applyGuard();
}

jQuery(() => {
    getSettings();

    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (host) host.insertAdjacentHTML('beforeend', buildSettingsHtml());

    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        menu.insertAdjacentHTML('beforeend', `
            <div id="rf_wand_container" class="extension_container interactable" tabindex="0">
                <div id="rf_wand_btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem">
                    <div class="fa-solid fa-rotate extensionsMenuExtensionButton"></div>
                    <span>${NAME}</span>
                </div>
            </div>`);
        $('#rf_wand_btn').on('click', requestReload);
    }

    const $root = $('.rf-settings');
    $root.on('click', '.rf-reload', requestReload);
    $root.on('click', '.rf-seg button', function () {
        const key = $(this).closest('.rf-block').data('key');
        getSettings()[key] = this.dataset.val === '1';
        saveSettingsDebounced();
        refreshUI();
    });

    refreshUI();
    notifyIfReloaded();
});
