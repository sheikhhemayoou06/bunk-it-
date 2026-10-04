// ============================================================
// DAY CHECK: end-of-day "How was today?" notification
// ============================================================
// After each working day (at the class reminder time) the user gets a
// notification with ✅ All Present / ❌ All Absent buttons. Tapping the body
// opens an in-app panel with a third option: mark manually.
//  - Only days with classes (holidays / empty days / outside semester skipped)
//  - Skipped when the day is already marked
//  - Existing OD / ML / Cancelled marks are kept
// The service worker cannot read localStorage, so this file mirrors a small
// "day plan" (classes per day + which days are marked) into IndexedDB, and
// applies marks the service worker queued while the app was closed.
// Uses globals from index.html: classes, getClassCountsForDate, formatLocalDate,
// parseLocalDate, showToast, switchPage.
// ============================================================

(function () {
    'use strict';

    const KEEP = new Set(['Duty Leave (OD)', 'Medical Leave (ML)', 'Cancelled']);

    // ---------- small IndexedDB helpers (same DB/store as sw.js) ----------
    function idb(mode, fn) {
        return new Promise((resolve) => {
            let req;
            try { req = indexedDB.open('BunkitDB', 1); } catch (e) { resolve(null); return; }
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
            };
            req.onerror = () => resolve(null);
            req.onsuccess = (e) => {
                const db = e.target.result;
                try {
                    const tx = db.transaction(['settings'], mode);
                    const result = fn(tx.objectStore('settings'));
                    tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : null);
                    tx.onerror = () => resolve(null);
                } catch (err) { resolve(null); }
            };
        });
    }
    const idbGet = (key) => idb('readonly', store => store.get(key));
    const idbPut = (key, value) => idb('readwrite', store => store.put(value, key));
    const idbDelete = (key) => idb('readwrite', store => store.delete(key));

    // ---------- class + schedule ----------
    function currentClassName() {
        const sel = document.getElementById('classSelector')?.value;
        if (sel && classes[sel]) return sel;
        const last = localStorage.getItem('lastOpenedClass');
        return last && classes[last] ? last : null;
    }

    function addDays(dateStr, n) {
        const d = parseLocalDate(dateStr);
        d.setDate(d.getDate() + n);
        return formatLocalDate(d);
    }

    function fmt(dateStr) {
        return parseLocalDate(dateStr).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    }

    // Period keys scheduled on a date ("CODE_p1", "CODE_p2", ...), [] when no classes
    function periodKeysFor(className, dateStr) {
        const cls = classes[className];
        if (!cls) return [];
        if ((cls.holidays || []).includes(dateStr)) return [];
        const start = cls.portalSetup?.semesterStartDate;
        if (start && dateStr < start) return [];
        if (cls.lastDate && dateStr > cls.lastDate) return [];
        const counts = typeof getClassCountsForDate === 'function' ? getClassCountsForDate(dateStr, className) : {};
        const keys = [];
        Object.keys(counts).forEach(code => {
            if (!cls.subjects.some(s => s.code === code)) return;
            for (let i = 1; i <= counts[code]; i++) keys.push(`${code}_p${i}`);
        });
        return keys;
    }

    function getLogs() {
        try { return JSON.parse(localStorage.getItem('attendance_logs') || '{}') || {}; } catch (e) { return {}; }
    }

    function isMarked(dateStr, logs = getLogs()) {
        return !!(logs[dateStr] && Object.keys(logs[dateStr]).length);
    }

    // ---------- apply a whole-day mark ----------
    function applyDayMark(dateStr, status, { quiet = false } = {}) {
        const className = currentClassName();
        if (!className) return { applied: 0 };
        const keys = periodKeysFor(className, dateStr);
        if (!keys.length) return { applied: 0 };

        const logs = getLogs();
        const before = logs[dateStr] ? { ...logs[dateStr] } : null;
        const dayLog = logs[dateStr] = logs[dateStr] || {};
        let applied = 0, kept = 0;

        keys.forEach(key => {
            const code = key.split('_p')[0];
            const existing = dayLog[key] || dayLog[code];
            if (existing && KEEP.has(existing)) { kept++; return; }
            dayLog[key] = status;
            applied++;
        });
        // Old whole-day marks are replaced by the per-period ones just written
        Object.keys(dayLog).forEach(k => {
            if (!k.includes('_p') && keys.some(key => key.startsWith(k + '_p'))) {
                if (!KEEP.has(dayLog[k])) delete dayLog[k];
            }
        });

        localStorage.setItem('attendance_logs', JSON.stringify(logs));
        try {
            const stamps = JSON.parse(localStorage.getItem('attendance_log_timestamps') || '{}');
            stamps[dateStr] = new Date().toISOString();
            localStorage.setItem('attendance_log_timestamps', JSON.stringify(stamps));
        } catch (e) { /* ignore */ }
        if (window.SyncManager) {
            try {
                if (SyncManager.saveLog) SyncManager.saveLog(dateStr, logs[dateStr]);
                else SyncManager.uploadAll();
            } catch (e) { /* offline */ }
        }
        // recalculateEverything() runs automatically on the attendance_logs change
        syncDayPlan();

        if (!quiet && typeof showToast === 'function') {
            const label = status === 'Attended' ? '✅ All present' : '❌ All absent';
            showToast(`${label} · ${fmt(dateStr)}`,
                `${applied} class${applied !== 1 ? 'es' : ''} marked${kept ? `, ${kept} OD/ML/cancelled kept` : ''}. Attendance updated.`,
                {
                    duration: 6000,
                    actionText: 'Undo',
                    onAction: () => {
                        const l = getLogs();
                        if (before) l[dateStr] = before; else delete l[dateStr];
                        localStorage.setItem('attendance_logs', JSON.stringify(l));
                        if (window.SyncManager) { try { SyncManager.saveLog ? SyncManager.saveLog(dateStr, l[dateStr] || {}) : SyncManager.uploadAll(); } catch (e) { /* offline */ } }
                        syncDayPlan();
                    }
                });
        }
        return { applied, kept };
    }

    // ---------- mirror the plan for the service worker ----------
    let planTimer = null;
    function syncDayPlan() {
        clearTimeout(planTimer);
        planTimer = setTimeout(async () => {
            const className = currentClassName();
            if (!className) return;
            const today = formatLocalDate(new Date());
            const logs = getLogs();
            const days = {};
            const logged = [];
            for (let i = -14; i <= 45; i++) {
                const d = addDays(today, i);
                const n = periodKeysFor(className, d).length;
                if (n) days[d] = n;
                if (isMarked(d, logs)) logged.push(d);
            }
            await idbPut('dayPlan', { className, days, logged, updatedAt: new Date().toISOString() });
            // The service worker only reminds classes whose settings it can read:
            // mirror the effective settings (default on at 16:30, like the app)
            let settings = { enabled: true, time: '16:30' };
            try { settings = JSON.parse(localStorage.getItem(`notificationSettings_${className}`) || 'null') || settings; } catch (e) { /* default */ }
            await idbPut(`notificationSettings_${className}`, settings);
            await idbPut('classesData', JSON.parse(JSON.stringify(classes)));
        }, 300);
    }

    // ---------- apply marks queued by the service worker ----------
    async function applyQueuedMarks() {
        const queue = await idbGet('pendingQuickMarks');
        if (!Array.isArray(queue) || !queue.length) return;
        await idbDelete('pendingQuickMarks');
        const done = [];
        queue.forEach(item => {
            if (!item || !item.date || !item.status) return;
            const r = applyDayMark(item.date, item.status, { quiet: true });
            if (r.applied || r.kept) done.push(`${item.status === 'Attended' ? 'All present' : 'All absent'} · ${fmt(item.date)}`);
        });
        if (done.length && typeof showToast === 'function') {
            showToast('✅ Saved from notification', done.join(', '), { duration: 5000 });
        }
        if (done.length && window.NotificationCenter) {
            NotificationCenter.log({ icon: '✅', title: 'Applied marks from notifications', body: done.join(', ') });
        }
    }

    // ---------- in-app panel ----------
    function openPanel(dateStr) {
        const className = currentClassName();
        const date = dateStr || formatLocalDate(new Date());
        const keys = className ? periodKeysFor(className, date) : [];
        let el = document.getElementById('dayCheckSheet');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dayCheckSheet';
            el.className = 'dc-sheet-backdrop';
            el.addEventListener('click', (e) => { if (e.target === el) closePanel(); });
            document.body.appendChild(el);
        }
        const marked = isMarked(date);
        const subjects = {};
        keys.forEach(k => { const c = k.split('_p')[0]; subjects[c] = (subjects[c] || 0) + 1; });
        const names = Object.keys(subjects).map(code => {
            const s = classes[className]?.subjects.find(x => x.code === code);
            return `${s?.shortName || s?.name || code}${subjects[code] > 1 ? ` ×${subjects[code]}` : ''}`;
        });

        el.innerHTML = `
            <div class="dc-sheet" role="dialog" aria-label="How was today?">
                <div class="dc-sheet-grip"></div>
                <h3>How was ${date === formatLocalDate(new Date()) ? 'today' : fmt(date)}?</h3>
                <p class="dc-sheet-sub">${keys.length
                    ? `${fmt(date)} · ${keys.length} class${keys.length !== 1 ? 'es' : ''}${marked ? ' · <strong>already marked</strong> (this will update it)' : ''}`
                    : `${fmt(date)} · no classes scheduled`}</p>
                ${names.length ? `<div class="dc-sheet-chips">${names.map(n => `<span>${n}</span>`).join('')}</div>` : ''}
                ${keys.length ? `
                <div class="dc-sheet-actions">
                    <button class="dc-act present" onclick="DayCheck.mark('${date}', 'Attended')"><span>✅</span>All Present</button>
                    <button class="dc-act absent" onclick="DayCheck.mark('${date}', 'Skipped')"><span>❌</span>All Absent</button>
                    <button class="dc-act manual" onclick="DayCheck.manual('${date}')"><span>✏️</span>Mark manually</button>
                </div>
                <p class="dc-sheet-note">OD, ML and cancelled classes you already marked are kept.</p>` : `
                <button class="dc-act manual" onclick="DayCheck.close()">Close</button>`}
            </div>`;
        requestAnimationFrame(() => el.classList.add('open'));
    }

    function closePanel() {
        const el = document.getElementById('dayCheckSheet');
        if (el) el.classList.remove('open');
    }

    function openManual(dateStr) {
        closePanel();
        if (typeof switchPage === 'function') switchPage('studentPortalPage');
        // Period-wise grid, scrolled to that day
        setTimeout(() => {
            if (window.amsOpenDay) window.amsOpenDay(dateStr);
        }, 150);
    }

    // ---------- notification ----------
    // Shows the day check for today if it is a working day that is not marked yet.
    // Returns true when something was shown.
    async function notifyToday(className, { force = false } = {}) {
        const name = className || currentClassName();
        if (!name) return false;
        const today = formatLocalDate(new Date());
        const keys = periodKeysFor(name, today);
        if (!force && (!keys.length || isMarked(today))) return false;

        if (window.NotificationCenter) {
            NotificationCenter.log({ icon: '📚', title: 'How was today?', body: `${fmt(today)} · ${keys.length} class${keys.length !== 1 ? 'es' : ''} to mark` });
        }

        // App open and visible: show the panel instead of a system notification
        if (document.visibilityState === 'visible' && !force) {
            openPanel(today);
            return true;
        }
        if (!('Notification' in window) || Notification.permission !== 'granted') {
            openPanel(today);
            return true;
        }
        try {
            const reg = await navigator.serviceWorker.ready;
            await reg.showNotification('📚 How was today?', {
                body: `${fmt(today)} · ${keys.length} class${keys.length !== 1 ? 'es' : ''} in ${name}. Mark all at once, or tap to mark each class.`,
                icon: '/icon-192x192.png',
                badge: '/badge-icon.png',
                tag: `day-check-${today}`,
                requireInteraction: true,
                actions: [
                    { action: 'all-present', title: '✅ All Present' },
                    { action: 'all-absent', title: '❌ All Absent' }
                ],
                data: { kind: 'day-check', date: today, className: name, url: `/?dayCheck=${today}` }
            });
            return true;
        } catch (e) {
            openPanel(today);
            return true;
        }
    }

    // ---------- wiring ----------
    function handleUrl() {
        const params = new URLSearchParams(window.location.search);
        const date = params.get('dayCheck');
        if (!date) return;
        params.delete('dayCheck');
        const rest = params.toString();
        window.history.replaceState({}, document.title, window.location.pathname + (rest ? `?${rest}` : ''));
        setTimeout(() => openPanel(date), 600);
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type === 'QUICK_MARK' && data.date && data.status) {
                applyDayMark(data.date, data.status);
                if (window.NotificationCenter) {
                    NotificationCenter.log({ icon: data.status === 'Attended' ? '✅' : '❌', title: `Marked all ${data.status === 'Attended' ? 'present' : 'absent'} from notification`, body: fmt(data.date) });
                }
            } else if (data.type === 'OPEN_DAY_CHECK' && data.date) {
                openPanel(data.date);
            }
        });
    }

    function init() {
        handleUrl();
        // Wait for classes to load before touching the plan / queue
        let tries = 0;
        const wait = setInterval(() => {
            tries++;
            if (currentClassName() || tries > 40) {
                clearInterval(wait);
                if (currentClassName()) {
                    applyQueuedMarks();
                    syncDayPlan();
                }
            }
        }, 250);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') applyQueuedMarks();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.DayCheck = {
        notifyToday,
        open: openPanel,
        close: closePanel,
        mark(dateStr, status) { closePanel(); applyDayMark(dateStr, status); },
        manual: openManual,
        syncDayPlan,
        periodKeysFor
    };
})();
