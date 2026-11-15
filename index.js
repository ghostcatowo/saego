/**
 * 새로고침 (refresh_button)
 * 코드 버전: v1.4.1
 *
 * ★ 코드를 고칠 때마다 이 버전을 올릴 것!
 *   - manifest.json 의 "version" 과 style.css 맨 위 버전도 같은 숫자로 같이 올리기
 *   - 작은 수정(버그, 문구, 디자인): 1.4.1 → 1.4.2
 *   - 기능 추가/변경:               1.4.1 → 1.5.0
 *
 * 변경 기록
 *   v1.4.1  토스트 문구 변경(새로고침 방어 성공 🫶 / 실패 🫠)
 *   v1.4.0  설정/기록 탭 추가(방어 성공·실패 기록), 새로고침 기능과 방지 기능을 따로 켜고 끄기,
 *           노란 표시등(방지만 켜짐), '새로고침 활성화'로 이름 변경, 예비 팝업 코드 삭제
 *   v1.3.0  새로고침 방지 강화(Navigation API로 차단 + 알림), 버튼 크기 축소, 초록/빨강 색
 *   v1.2.0  팝업 디자인 개선, '새로고침 팝업'(켜기/끄기)
 *   v1.1.0  실리태번 기본 팝업 사용, 팝업 위치/탭 닫힘 문제 수정
 *   v1.0.0  첫 버전
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'refresh_button';
const NAME = '새로고침';
const FLAG = 'rf_manual_reload';
const LOG_MAX = 100;
const DEFAULTS = { enabled: true, confirm: true, guard: true };

let popupOpen = false;
let manualReload = false;
let lockAbort = null;
let guardNoted = false;      // 이번 페이지에서 방지 시작 기록을 남겼는지
let activeTab = 'settings';
let lastBlockedToast = 0;

/* ---------------- 설정 ---------------- */

function getSettings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    for (const key of Object.keys(DEFAULTS)) {
        if (typeof s[key] !== 'boolean') s[key] = DEFAULTS[key];
    }
    if (!Array.isArray(s.log)) s.log = [];
    return s;
}

/* ---------------- 기록 ---------------- */

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// type: 'ok'(방어 성공) | 'fail'(방어 실패) | 'info'(참고)
function addLog(type, text) {
    const s = getSettings();
    const now = Date.now();
    const top = s.log[0];
    if (top && top.type === type && top.text === text && now - top.t < 5000) {
        top.n = (top.n || 1) + 1; // 같은 일이 연달아 생기면 ×N 으로 묶기
        top.t = now;
    } else {
        s.log.unshift({ t: now, type, text, n: 1 });
        if (s.log.length > LOG_MAX) s.log.length = LOG_MAX;
    }
    saveSettingsDebounced();
    renderLog();
}

function renderLog() {
    const s = getSettings();
    const badge = document.querySelector('.rf-settings .rf-badge');
    if (badge) badge.textContent = String(s.log.length);

    const list = document.querySelector('.rf-settings .rf-log-list');
    if (!list) return;
    list.textContent = '';

    if (!s.log.length) {
        const empty = document.createElement('div');
        empty.className = 'rf-log-empty';
        empty.textContent = '아직 기록이 없어요.';
        list.appendChild(empty);
        return;
    }

    const tags = { ok: '방어 성공', fail: '방어 실패', info: '참고' };
    for (const item of s.log) {
        const row = document.createElement('div');
        row.className = `rf-log-item rf-log-${item.type}`;

        const time = document.createElement('div');
        time.className = 'rf-log-time';
        time.textContent = fmtTime(item.t);

        const text = document.createElement('div');
        text.className = 'rf-log-text';
        const tag = document.createElement('span');
        tag.className = 'rf-log-tag';
        tag.textContent = tags[item.type] || '참고';
        text.append(tag, ` ${item.text}${item.n > 1 ? ` (×${item.n})` : ''}`);

        row.append(time, text);
        list.appendChild(row);
    }
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

/* ---------------- 확인 팝업 (실리태번 기본 팝업) ---------------- */

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
        console.warn(`[${NAME}] 기본 팝업을 못 써서 브라우저 확인창을 사용해요`, err);
        return window.confirm('새로고침 할래?');
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

/* ---------------- 새로고침 방지 ---------------- */

// (예비) Navigation API가 없는 브라우저에서만 사용: 새로고침 전에 브라우저 확인창
function onBeforeUnload(e) {
    if (manualReload) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
}

function notifyBlocked() {
    const now = Date.now();
    if (now - lastBlockedToast < 4000) return;
    lastBlockedToast = now;
    if (typeof toastr !== 'undefined') {
        toastr.success('새로고침 방어 성공 🫶', NAME);
    }
}

// 페이지/확장이 스스로 일으키는 새로고침(location.reload 등)을 취소.
// 사용자가 브라우저로 직접 하는 새로고침(F5, 당겨서 새로고침)은 userInitiated라서 건드리지 않음.
function onNavigate(e) {
    if (manualReload) return;
    const isReload = e.navigationType === 'reload';
    const isSameUrl = !e.destination?.sameDocument && e.destination?.url === location.href;
    if (!isReload && !isSameUrl) return;
    if (e.userInitiated) return;

    if (!e.cancelable) {
        addLog('fail', '새로고침이 일어났는데 취소할 수 없는 종류라서 막지 못했어요.');
        return;
    }
    e.preventDefault();
    addLog('ok', isReload
        ? '페이지가 스스로 일으킨 새로고침을 취소했어요.'
        : '같은 주소로 다시 이동하는 것을 취소했어요.');
    notifyBlocked();
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

// 방지 기능은 '새로고침 활성화'와 상관없이 자기 설정(guard)만 따름
function applyGuard() {
    const on = getSettings().guard;
    const nav = window.navigation;
    document.documentElement.classList.toggle('rf-guard', on);
    window.removeEventListener('beforeunload', onBeforeUnload);
    nav?.removeEventListener('navigate', onNavigate);

    if (!on) {
        releaseLock();
        return;
    }
    if (nav) nav.addEventListener('navigate', onNavigate);
    else window.addEventListener('beforeunload', onBeforeUnload);
    acquireLock();

    if (!guardNoted) {
        guardNoted = true;
        addLog('info', '새로고침 방지를 시작했어요.');
        if (!nav) addLog('fail', '이 브라우저는 자동 새로고침 취소를 지원하지 않아서 확인창 방식으로 대신해요. (모바일에선 안 뜰 수 있어요)');
        if (!navigator.locks) addLog('fail', '탭 정리를 줄이는 기능(Web Lock)을 쓸 수 없어요. https 주소가 아니거나 브라우저가 지원하지 않아요.');
    }
}

// 페이지가 열린 이유를 확인해서 기록
function checkLoadReason() {
    let wasManual = false;
    try {
        wasManual = sessionStorage.getItem(FLAG) === '1';
        sessionStorage.removeItem(FLAG);
    } catch { /* 무시 */ }

    if (wasManual) {
        addLog('info', '새로고침 버튼으로 직접 새로고침했어요.');
        return;
    }
    if (!getSettings().guard) return;

    const nav = performance.getEntriesByType?.('navigation')?.[0];
    let reason = '';
    if (document.wasDiscarded) {
        reason = '브라우저가 메모리를 정리하려고 탭을 닫았다가 다시 불러왔어요. 확장으로는 막을 수 없는 경우예요.';
    } else if (nav?.type === 'reload') {
        reason = '브라우저가 페이지를 다시 불러왔어요. (당겨서 새로고침, F5, 앱 복귀 중 재로드 등) 확장이 취소할 수 없는 종류예요.';
    }
    if (!reason) return;

    addLog('fail', reason);
    if (typeof toastr !== 'undefined') toastr.warning('새로고침 방어 실패 🫠', NAME);
}

/* ---------------- UI ---------------- */

function segBlock(key, title, hint) {
    return `
        <div class="rf-block" data-key="${key}">
            <div class="rf-title">${title}</div>
            <div class="rf-hint">${hint}</div>
            <div class="rf-seg" role="radiogroup" aria-label="${title}">
                <button type="button" role="radio" data-val="1">켜기</button>
                <button type="button" role="radio" data-val="0">끄기</button>
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
                <div class="rf-tabs" role="tablist">
                    <button type="button" class="rf-tab" role="tab" data-tab="settings">설정</button>
                    <button type="button" class="rf-tab" role="tab" data-tab="log">기록 <span class="rf-badge">0</span></button>
                </div>

                <div class="rf-pane" data-pane="settings">
                    <button type="button" class="rf-reload">
                        <i class="fa-solid fa-rotate"></i><span>${NAME}</span>
                    </button>
                    ${segBlock('enabled', '새로고침 활성화',
                        '끄면 새로고침 버튼과 마법봉 메뉴 항목이 사라져요. 새로고침 방지는 따로 켜고 꺼요.')}
                    ${segBlock('confirm', '새로고침 팝업',
                        '켜면 새로고침 전에 한 번 물어봐요. 마법봉 메뉴에도 똑같이 적용돼요.')}
                    ${segBlock('guard', '새로고침 방지',
                        '자동 새로고침을 최대한 막아요. 직접 누른 새로고침은 그대로 돼요. 브라우저가 메모리 부족으로 탭을 정리하는 건 완전히 막을 수 없어요.')}
                    <div class="rf-legend">
                        표시등: 초록 = 방지 켜짐 · 노랑 = 방지만 켜짐(새로고침 기능 꺼짐) · 빨강 = 방지 꺼짐
                    </div>
                </div>

                <div class="rf-pane" data-pane="log">
                    <div class="rf-log-toolbar">
                        <button type="button" class="rf-clear">기록 지우기</button>
                    </div>
                    <div class="rf-log-list"></div>
                </div>
            </div>
        </div>
    </div>`;
}

function updateTabs() {
    const $root = $('.rf-settings');
    $root.find('.rf-tab').each(function () {
        const active = this.dataset.tab === activeTab;
        $(this).toggleClass('rf-tab-active', active).attr('aria-selected', String(active));
    });
    $root.find('.rf-pane').each(function () {
        $(this).toggleClass('rf-pane-hidden', this.dataset.pane !== activeTab);
    });
}

function refreshUI() {
    const s = getSettings();
    const $root = $('.rf-settings');

    // 새로고침 기능(버튼/팝업)만 '새로고침 활성화'를 따르고, 방지는 따로 동작
    $root.find('.rf-reload').prop('disabled', !s.enabled);
    $root.find('.rf-block[data-key="confirm"]')
        .toggleClass('rf-dim', !s.enabled)
        .find('button').prop('disabled', !s.enabled);

    $root.find('.rf-block').each(function () {
        const value = s[this.dataset.key];
        $(this).find('.rf-seg button').each(function () {
            this.setAttribute('aria-checked', String((this.dataset.val === '1') === value));
        });
    });

    // 표시등: 방지 켜짐=초록 / 방지만 켜짐(새로고침 기능 꺼짐)=노랑 / 방지 꺼짐=빨강
    const state = !s.guard ? 'off' : (s.enabled ? 'on' : 'warn');
    const labels = {
        on: '새로고침 방지 켜짐',
        warn: '새로고침 방지만 켜짐 (새로고침 기능은 꺼짐)',
        off: '새로고침 방지 꺼짐',
    };
    $root.find('.rf-status')
        .removeClass('rf-on rf-warn rf-off')
        .addClass(`rf-${state}`)
        .attr({ title: labels[state], 'aria-label': labels[state] });

    $('#rf_wand_container').toggle(s.enabled);
    updateTabs();
    applyGuard();
    renderLog();
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
    $root.on('click', '.rf-tab', function () {
        activeTab = this.dataset.tab;
        updateTabs();
    });
    $root.on('click', '.rf-clear', () => {
        getSettings().log = [];
        saveSettingsDebounced();
        renderLog();
    });

    checkLoadReason();
    refreshUI();
});
