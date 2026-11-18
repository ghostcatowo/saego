/**
 * 새로고침 (refresh_button)
 * 코드 버전: v1.9.8
 *
 * ★ 코드를 고칠 때마다 이 버전을 올릴 것!
 *   - style.css 맨 위 버전, 아래 VERSION 도 같은 숫자로 같이 올리기
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const VERSION = 'v1.9.8';
const MODULE = 'refresh_button';
const NAME = '새로고침';
const FLAG = 'rf_manual_reload';   // 버튼으로 직접 새로고침했다는 표시(시각)
const CODE_FLAG = 'rf_code_reload';   // 코드(실리태번·확장)가 일으킨 새로고침 표시(시각)
const USER_FLAG = 'rf_user_reload'; // 당겨서·F5 등 사용자가 브라우저로 한 새로고침(확인됨) 표시(시각)
const ALIVE = 'rf_page_alive';     // 페이지가 마지막으로 살아 있던 때의 상태(탭 단위로 저장)
const LOG_MAX = 20;
const FREEZE_LOG_MIN_MS = 5 * 60 * 1000; // 이 시간 이상 동결됐다가 무사히 돌아온 경우만 기록 (짧은 건 쌓이지 않게)
const DEFAULTS = { enabled: true, confirm: true, guard: true };
const TAGS = { ok: '막음', fail: '실패', warn: '새로고침', error: '오류', info: '참고' };

let popupOpen = false;
let manualReload = false;
let lockAbort = null;
let lockErrNoted = false;
let rtc = null;              // 탭이 정리되지 않게 하려는 '살아 있는 연결'
let rtcErrNoted = false;
let activeTab = 'settings';

// 페이지 상태 추적 (새로고침 원인 분석용)
let lastHiddenAt = 0;
let lastFreezeAt = 0;
let unloading = '';          // '' | 'pagehide' | 'bfcache'

/* ---------------- 설정 ---------------- */

function getSettings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    for (const key of Object.keys(DEFAULTS)) {
        if (typeof s[key] !== 'boolean') s[key] = DEFAULTS[key];
    }
    if ('keepAlive' in s) delete s.keepAlive; // 삭제된 기능의 옛 설정 정리
    if (!Array.isArray(s.log)) s.log = [];
    if (s.log.length > LOG_MAX) s.log.length = LOG_MAX;
    return s;
}

/* ---------------- 로그 ---------------- */
// 새로고침이 안 막혔을 때, 또는 오류가 났을 때 원인을 확인하려고 남기는 기록이에요.
// 'ok' 막음(초록) / 'fail' 실패(빨강) / 'warn' 새로고침·직접 한 것 포함(노랑) / 'error' 오류(빨강) / 'info' 참고

const pad = (n) => String(n).padStart(2, '0');
const clip = (str, n) => (str.length > n ? `${str.slice(0, n)}…` : str);
const scrub = (str) => String(str).split(location.origin).join(''); // 접속 주소(IP·도메인)는 기록에서 뺌

function fmtTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDur(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}초`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}분 ${sec % 60}초`;
    return `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

function addLog(type, text, detail = '') {
    const s = getSettings();
    const now = Date.now();
    text = scrub(text);
    const d = clip(scrub(detail || ''), 900);
    const top = s.log[0];
    if (top && top.type === type && top.text === text && (top.detail || '') === d && now - top.t < 5000) {
        top.n = (top.n || 1) + 1; // 같은 일이 연달아 생기면 ×N 으로 묶기
        top.t = now;
    } else {
        s.log.unshift({ t: now, type, text, detail: d, n: 1 });
        if (s.log.length > LOG_MAX) s.log.length = LOG_MAX;
    }
    saveSettingsDebounced();
    renderLog();
}

// 오류 기록에 주소·폴더 경로(서버 IP, 확장 폴더 이름 등)가 남지 않게 파일 이름과 줄 번호만 남김
function stripPaths(text) {
    return String(text || '').replace(/(?:https?|file|chrome-extension):\/\/[^\s)]*\/([^\/\s)?#]*)(?:[?#][^\s):]*)?/g, '$1');
}

function logErr(label, err) {
    const stack = stripPaths(String(err?.stack || '').split('\n').slice(0, 6).join('\n'));
    addLog('error', `${label}: ${stripPaths(err?.message || err)}`, stack);
}

// 이 확장에서 난 오류만 기록 (다른 확장의 오류까지 쌓이지 않게)
function captureOwnErrors() {
    window.addEventListener('error', (e) => {
        try {
            const stack = String(e.error?.stack || '');
            if (!String(e.filename || '').includes(MODULE) && !stack.includes(MODULE)) return;
            addLog('error', `오류: ${stripPaths(e.message)}`, stripPaths(`${e.filename}:${e.lineno}:${e.colno}\n${stack.split('\n').slice(0, 6).join('\n')}`));
        } catch { /* 무시 */ }
    });
    window.addEventListener('unhandledrejection', (e) => {
        try {
            const r = e.reason;
            const stack = String(r?.stack || '');
            if (!stack.includes(MODULE)) return;
            addLog('error', `처리 안 된 오류: ${stripPaths(r?.message || r)}`, stripPaths(stack.split('\n').slice(0, 6).join('\n')));
        } catch { /* 무시 */ }
    });
}

function renderLog() {
    const s = getSettings();
    const badge = document.querySelector('.rf-settings .rf-badge');
    if (badge) badge.textContent = String(s.log.length);

    const count = document.querySelector('.rf-settings .rf-logcount');
    if (count) count.textContent = `기록 ${s.log.length}개`;

    const list = document.querySelector('.rf-settings .rf-log-list');
    if (!list) return;

    // 다시 그려도 펼쳐 둔 기록은 그대로 열려 있게
    const opened = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.k));
    list.textContent = '';

    if (!s.log.length) {
        const empty = document.createElement('div');
        empty.className = 'rf-log-empty';
        empty.textContent = '아직 기록이 없어요.';
        list.appendChild(empty);
        return;
    }

    s.log.forEach((item, i) => {
        const det = document.createElement('details');
        det.className = `rf-log rf-log-${item.type}`;
        det.dataset.k = String(item.t);
        if (opened.has(det.dataset.k)) det.open = true;

        const sum = document.createElement('summary');
        const time = document.createElement('div');
        time.className = 'rf-log-time';
        time.textContent = fmtTime(item.t);
        const text = document.createElement('div');
        text.className = 'rf-log-text';
        const tag = document.createElement('span');
        tag.className = 'rf-log-tag';
        tag.textContent = TAGS[item.type] || '참고';
        text.append(tag, ` ${item.text}${item.n > 1 ? ` (×${item.n})` : ''}`);
        sum.append(time, text);

        const body = document.createElement('div');
        body.className = 'rf-logbody';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rf-copy-one';
        btn.dataset.i = String(i);
        btn.textContent = '이 기록 복사';
        body.append(btn);
        if (item.detail) {
            const pre = document.createElement('pre');
            pre.textContent = item.detail;
            body.append(pre);
        }

        det.append(sum, body);
        list.appendChild(det);
    });
}

/* ---------------- 로그 복사 ---------------- */

// 브라우저 이름·버전과 OS 버전만 짧게 (기기 코드명 같은 건 남기지 않음). 모르는 브라우저면 원래 문자열을 그대로 보여줌
function browserInfo() {
    const ua = navigator.userAgent || '';
    const ver = (re) => (ua.match(re) || [])[1];
    const rules = [
        ['삼성 인터넷', /SamsungBrowser\/(\d+)/], ['웨일', /Whale\/(\d+)/], ['엣지', /EdgA?\/(\d+)|EdgiOS\/(\d+)/],
        ['오페라', /OPR\/(\d+)/], ['파이어폭스', /Firefox\/(\d+)|FxiOS\/(\d+)/], ['다음', /DaumApps\/(\d+)/],
        ['네이버 앱', /NAVER\(inapp;[^)]*?(\d+)\)/], ['크롬', /Chrome\/(\d+)|CriOS\/(\d+)/], ['사파리', /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/],
    ];
    let name = '';
    let v = '';
    for (const [n, re] of rules) {
        const m = ua.match(re);
        if (m) { name = n; v = m[1] || m[2] || ''; break; }
    }
    const engine = ver(/Chrome\/(\d+)/);
    const os = ver(/Android ([\d.]+)/) ? `안드로이드 ${ver(/Android ([\d.]+)/)}`
        : ver(/OS ([\d_]+) like Mac/) ? `iOS ${ver(/OS ([\d_]+) like Mac/).replace(/_/g, '.')}`
        : /Windows/.test(ua) ? '윈도우' : /Mac OS X/.test(ua) ? '맥' : /Linux/.test(ua) ? '리눅스' : '';
    if (!name) return ua; // 처음 보는 브라우저는 원본 그대로
    const eng = engine && name !== '크롬' ? ` (엔진 크롬 ${engine})` : '';
    return `${name} ${v}${eng}${os ? ` / ${os}` : ''}`;
}

// indices 를 주면 그 기록만, 안 주면 전체
function buildLogText(indices) {
    const s = getSettings();
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
    const yn = (v) => (v ? 'O' : 'X');
    const head = [
        `[새로고침 확장 ${VERSION}] 로그 복사 시각 ${fmtTime(Date.now())}`,
        `브라우저: ${browserInfo()}`,
        `지원: 탐색API ${yn(window.navigation)} / WebLock ${yn(navigator.locks)} / 보안연결 ${yn(window.isSecureContext)} / 설치앱모드 ${yn(standalone)}`,
        `설정: 방지 ${s.guard ? '켜짐' : '꺼짐'} / 새로고침 기능 ${s.enabled ? '켜짐' : '꺼짐'} / 연결 유지 ${rtcState()}`,
    ];
    const picked = indices ? indices.filter((i) => s.log[i]) : s.log.map((_, i) => i);
    const body = picked.length
        ? picked.map((i) => {
            const x = s.log[i];
            const lines = [`${i + 1}. ${fmtTime(x.t)} [${TAGS[x.type] || '참고'}] ${x.text}${x.n > 1 ? ` (×${x.n})` : ''}`];
            if (x.detail) lines.push(...x.detail.split('\n').map((l) => `   ${l}`));
            return lines.join('\n');
        }).join('\n\n')
        : '(기록 없음)';
    const title = indices
        ? `기록 ${picked.map((i) => i + 1).join(', ')}번 (전체 ${s.log.length}개 중)`
        : `기록 ${s.log.length}개 (위가 최신)`;
    return `${head.join('\n')}\n\n${title}\n\n${body}`;
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* 무시 */ }
    ta.remove();
    return ok;
}

// 복사됐다는 표시는 알림 대신 버튼 글자를 잠깐 바꿔서 보여줌
function flashBtn(btn, label) {
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = label;
    clearTimeout(btn._rfT);
    btn._rfT = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
}

async function copyLog(btn, indices) {
    const text = buildLogText(indices);
    const raw = document.querySelector('.rf-settings .rf-log-raw');
    raw?.classList.remove('rf-show');

    let ok = false;
    try {
        await navigator.clipboard.writeText(text);
        ok = true;
    } catch {
        ok = fallbackCopy(text);
    }

    if (ok) { flashBtn(btn, '복사됨'); return; }
    // 복사가 막힌 환경이면 글을 보여주고 직접 복사하게 함
    if (raw) {
        raw.value = text;
        raw.classList.add('rf-show');
        raw.focus();
        raw.select();
    }
}

/* ---------------- 새로고침 ---------------- */

function doReload() {
    manualReload = true;
    setTimeout(() => { manualReload = false; }, 5000); // 새로고침이 취소돼도 방지가 계속 꺼져 있지 않게
    try { sessionStorage.setItem(FLAG, String(Date.now())); } catch { /* 무시 */ }
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
        logErr('기본 팝업을 못 써서 브라우저 확인창으로 대신했어요', err);
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
// 어떤 새로고침도 막거나 취소하지 않음 (실리태번·확장·당겨서·F5 모두 그대로 됨).
// 폰이 백그라운드 탭을 종료·동결해서 생기는 새로고침을 줄이려고, 탭이 '활동 중'으로 보이게 하는 연결 유지(WebRTC)와 Web Lock 을 씀.
// onNavigate 는 막지 않고 누가 새로고침했는지만 기록해 둠 (기록 탭용, 주소·경로는 남기지 않음).

function onNavigate(e) {
    if (manualReload) return;
    const isReload = e.navigationType === 'reload';
    const isSameUrl = !e.destination?.sameDocument && e.destination?.url === location.href;
    if (!isReload && !isSameUrl) return;
    if (e.userInitiated) {
        try { sessionStorage.setItem(USER_FLAG, String(Date.now())); } catch { /* 무시 */ }
        return;
    }
    // 코드(실리태번·확장)가 한 새로고침: 취소하지 않고, 누가 불렀는지만 남김 (다음에 열릴 때 기록)
    try { sessionStorage.setItem(CODE_FLAG, JSON.stringify({ t: Date.now() })); } catch { /* 무시 */ }
}

// Web Lock을 쥐고 있으면 브라우저가 탭을 정리할 때 덜 건드리는 경우가 있음 (보장은 아님)
function acquireLock() {
    if (lockAbort || !navigator.locks) return;
    const ac = new AbortController();
    lockAbort = ac;
    navigator.locks
        .request(`rf-keepalive-${Math.random().toString(36).slice(2)}`, { signal: ac.signal }, () =>
            new Promise((resolve) => ac.signal.addEventListener('abort', resolve, { once: true })))
        .catch((err) => {
            if (err?.name === 'AbortError' || lockErrNoted) return;
            lockErrNoted = true;
            logErr('Web Lock을 잡지 못했어요', err);
        });
}

function releaseLock() {
    lockAbort?.abort();
    lockAbort = null;
}

// 화면 안에서 두 연결(WebRTC)을 서로 이어 두는 방식. 밖으로 나가는 통신·소리·알림은 없고,
// 크롬은 연결이 살아 있는 탭을 '정지'시키지 않는 규칙이 있음 (삼성 인터넷에서도 되는지는 기록으로 확인).
function rtcState() {
    if (!rtc) return '꺼짐';
    return rtc.b.connectionState || rtc.b.iceConnectionState || '?';
}

function stopKeepAlive() {
    try { rtc?.a.close(); rtc?.b.close(); } catch { /* 무시 */ }
    rtc = null;
}

async function startKeepAlive() {
    if (rtc || typeof RTCPeerConnection === 'undefined') return;
    try {
        const a = new RTCPeerConnection({ iceServers: [] });
        const b = new RTCPeerConnection({ iceServers: [] });
        rtc = { a, b };
        a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
        b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
        b.onconnectionstatechange = () => {
            if (b.connectionState === 'failed' && !rtcErrNoted) {
                rtcErrNoted = true;
                addLog('error', '연결 유지(WebRTC) 연결이 실패했어요', '네트워크 연결이 없거나 브라우저가 막았을 수 있어요');
            }
        };
        a.createDataChannel('rf-keep');
        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);
    } catch (err) {
        stopKeepAlive();
        if (!rtcErrNoted) {
            rtcErrNoted = true;
            logErr('연결 유지(WebRTC)를 시작하지 못했어요', err);
        }
    }
}

// 연결이 끊겼으면 다시 만듦 (앱에 돌아왔을 때 등)
function ensureKeepAlive() {
    if (rtc && !['failed', 'closed', 'disconnected'].includes(rtcState())) return;
    stopKeepAlive();
    startKeepAlive();
}

// 방지 기능은 '새로고침 활성화'와 상관없이 자기 설정(guard)만 따름
function applyGuard() {
    const on = getSettings().guard;
    const nav = window.navigation;
    document.documentElement.classList.toggle('rf-guard', on);
    nav?.removeEventListener('navigate', onNavigate);

    if (!on) {
        releaseLock();
        stopKeepAlive();
        return;
    }
    nav?.addEventListener('navigate', onNavigate);
    acquireLock();
    ensureKeepAlive();
}

/* ---------------- 페이지 상태 추적 / 새로고침 원인 분석 ---------------- */
// 페이지가 사라지면 그 뒤 일은 기록할 수 없어서, 화면 보임/숨김 같은 변화가 있을 때만 상태를 저장해 두었다가
// 다음에 열릴 때 비교해서 '어떻게 사라졌는지'를 추정해요. (타이머 없음)

function readAlive() {
    try { return JSON.parse(sessionStorage.getItem(ALIVE) || 'null'); } catch { return null; }
}

function beat(why) {
    try {
        sessionStorage.setItem(ALIVE, JSON.stringify({
            t: Date.now(),
            why,
            vis: document.visibilityState,
            hiddenAt: lastHiddenAt,
            freezeAt: lastFreezeAt,
            unl: unloading,
            rtc: rtcState(),
        }));
    } catch { /* 무시 */ }
}

function startHeartbeat() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') lastHiddenAt = Date.now();
        else if (getSettings().guard) ensureKeepAlive();
        beat(`visibility:${document.visibilityState}`);
    });
    window.addEventListener('pagehide', (e) => {
        unloading = e.persisted ? 'bfcache' : 'pagehide';
        beat(unloading);
    });
    window.addEventListener('pageshow', () => { unloading = ''; beat('pageshow'); });
    document.addEventListener('freeze', () => { lastFreezeAt = Date.now(); beat('freeze'); });
    document.addEventListener('resume', () => {
        // 오래(5분 이상) 동결됐다가 새로고침 없이 돌아온 경우만 남겨서, 연결 유지가 효과 있는지 확인할 수 있게 함
        if (lastFreezeAt && Date.now() - lastFreezeAt >= FREEZE_LOG_MIN_MS) addLog('info', `동결됐다가 무사히 돌아왔어요 (약 ${fmtDur(Date.now() - lastFreezeAt)} 동결)`, `연결 유지: ${rtcState()}`);
        lastFreezeAt = 0;
        beat('resume');
    });
    beat('start');
}

// 페이지가 열린 이유를 확인해서 기록 (startHeartbeat 보다 먼저 불러야 함)
// 빨강(실패) = 사용자가 안 했는데 탭이 종료·폐기된 경우 / 노랑 = 새로고침 (직접 한 것 포함)
function checkLoadReason() {
    const prev = readAlive();
    const now = Date.now();
    let manualAt = 0;
    let userAt = 0;
    let codeInfo = null;
    try {
        manualAt = Number(sessionStorage.getItem(FLAG)) || 0;
        userAt = Number(sessionStorage.getItem(USER_FLAG)) || 0;
        codeInfo = JSON.parse(sessionStorage.getItem(CODE_FLAG) || 'null');
        sessionStorage.removeItem(FLAG);
        sessionStorage.removeItem(USER_FLAG);
        sessionStorage.removeItem(CODE_FLAG);
    } catch { /* 무시 */ }

    // 15초 안에 한 것만 '직접'으로 인정
    if (manualAt && now - manualAt < 15000) {
        addLog('warn', '직접 새로고침했어요 (새로고침 버튼)');
        return;
    }
    if (userAt && now - userAt < 15000) {
        addLog('warn', '직접 새로고침했어요 (당겨서·F5 등)');
        return;
    }
    if (codeInfo && now - codeInfo.t < 15000) {
        addLog('info', '코드가 일으킨 새로고침이에요 (실리태번·확장이 필요해서 한 것)');
        return;
    }
    if (!getSettings().guard) return;

    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const type = nav?.type || '?';
    const discarded = !!document.wasDiscarded;
    const abrupt = !!prev && !prev.unl; // 이전 페이지가 '닫히는 과정' 없이 사라짐
    if (!discarded && type !== 'reload' && !abrupt) return;

    const lines = [`불러온 방식: ${type} / 탭 폐기됨: ${discarded ? '예' : '아니오'}`];
    if (prev) {
        lines.push(`이전 페이지 마지막 신호: ${fmtDur(now - prev.t)} 전 (${prev.why}, 화면 ${prev.vis === 'hidden' ? '숨김' : '보임'}${prev.unl ? ', 닫히는 중' : ''})`);
        if (prev.vis === 'hidden' && prev.hiddenAt) lines.push(`화면이 숨겨진 뒤 경과: ${fmtDur(now - prev.hiddenAt)}`);
        if (prev.freezeAt) lines.push(`동결(freeze) 기록: ${fmtDur(now - prev.freezeAt)} 전`);
        lines.push(`연결 유지: ${prev.rtc || '기록 없음'}`);
    } else {
        lines.push('이전 페이지 신호 없음 (이 탭에서 처음 열렸거나 저장소가 비었어요)');
    }

    // 사용자가 한 게 아닌데 페이지가 사라진 경우만 '실패'
    if (discarded || abrupt) {
        let guess;
        if (discarded) guess = '브라우저가 메모리 정리를 위해 탭을 폐기했다가 다시 불러왔어요';
        else if (prev.vis === 'hidden') guess = '백그라운드에 있는 동안 브라우저나 폰이 탭을 강제로 종료한 것 같아요';
        else guess = '페이지가 갑자기 종료됐어요 (충돌·메모리 부족 등)';
        addLog('fail', `막지 못한 새로고침 — ${guess}`, lines.join('\n'));
        if (typeof toastr !== 'undefined') toastr.warning('새로고침 방어 실패 🫠', NAME);
        return;
    }

    // 정상적으로 닫히고 다시 열렸다면 직접 한 새로고침일 수 있어서 실패로 치지 않음
    addLog('warn', '새로고침됐어요 — 직접 한 것인지 확인하지 못했어요', lines.join('\n'));
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
                        '다른 앱을 쓰는 동안 폰이 탭을 종료해서 새로고침되는 걸 줄여봐요. 어떤 새로고침도 막지는 않아요(당겨서·F5·실리태번 모두 그대로 돼요). 완전히 막을 수는 없어요.')}
                    <div class="rf-legend">
                        표시등: 초록 = 방지 켜짐 · 노랑 = 방지만 켜짐(새로고침 기능 꺼짐) · 빨강 = 방지 꺼짐
                    </div>
                </div>

                <div class="rf-pane" data-pane="log">
                    <div class="rf-logbar">
                        <span class="rf-logcount">기록 0개</span>
                        <span class="rf-logbtns">
                            <button type="button" class="rf-clear">기록 지우기</button>
                        </span>
                    </div>
                    <textarea class="rf-log-raw" readonly></textarea>
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

captureOwnErrors();

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
    $root.on('click', '.rf-copy-one', function () { copyLog(this, [Number(this.dataset.i)]); });
    $root.on('click', '.rf-clear', () => {
        getSettings().log = [];
        saveSettingsDebounced();
        renderLog();
    });

    checkLoadReason();
    startHeartbeat();
    refreshUI();
});
