// ============================================================
// CLASS REMINDERS: "mark attendance" right after each class ends
// ============================================================
// Needs class timings (Timetable → Class timings). Every 30 s, and whenever the
// app comes back to the foreground, finished classes that aren't marked yet
// get one reminder each:
//  - app visible  → in-app card with Present / Absent
//  - app hidden   → system notification with Present / Absent buttons
//  - where the browser supports scheduled notifications, today's remaining
//    classes are also pre-scheduled so they arrive even with the app closed
// Uses globals: classes, getDaySlots, getPeriodTimes, formatLocalDate,
// SyncManager, NotificationCenter, renderTodayTimetable, showToast.
// ============================================================
(function () {
    'use strict';

    const TICK_MS = 30000;
    const LATE_LIMIT_MIN = 6 * 60; // don't nag about classes that ended hours ago (Missed days covers them)

    function className() {
        const sel = document.getElementById('classSelector')?.value;
        if (sel && typeof classes !== 'undefined' && classes[sel]) return sel;
        const last = localStorage.getItem('lastOpenedClass');
        return last && typeof classes !== 'undefined' && classes[last] ? last : null;
    }

    function esc(t) {
        return String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const toMin = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t.split(':').map(Number).reduce((h, m) => h * 60 + m) : null);
    const fmt12 = (t) => {
        const m = toMin(t); if (m === null) return t || '';
        const h = Math.floor(m / 60);
        return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
    };

    function remindersOn(name) {
        try {
            const s = JSON.parse(localStorage.getItem(`notificationSettings_${name}`) || 'null');
            return !s || s.classReminders !== false;
        } catch (e) { return true; }
    }

    function logs() {
        try { return JSON.parse(localStorage.getItem('attendance_logs') || '{}') || {}; } catch (e) { return {}; }
    }

    function notifiedKey(date) { return `classReminded_${date}`; }
    function notifiedSet(date) {
        try { return new Set(JSON.parse(localStorage.getItem(notifiedKey(date)) || '[]')); } catch (e) { return new Set(); }
    }
    function remember(date, key) {
        const set = notifiedSet(date);
        set.add(key);
        localStorage.setItem(notifiedKey(date), JSON.stringify([...set]));
    }

    // Today's slots with times, subject names and whether they are marked
    function todaysClasses(name) {
        const today = formatLocalDate(new Date());
        const times = (typeof getPeriodTimes === 'function' && getPeriodTimes(name)) || {};
        const dayLog = logs()[today] || {};
        const cls = classes[name];
        return (typeof getDaySlots === 'function' ? getDaySlots(name, today) : []).filter(Boolean).map(sl => {
            const sub = cls.subjects.find(x => x.code === sl.code) || {};
            const t = times[sl.idx] || {};
            return { ...sl, date: today, name: sub.name || sl.code, start: t.start, end: t.end,
                endMin: toMin(t.end), startMin: toMin(t.start), marked: !!(dayLog[sl.key] || dayLog[sl.code]) };
        });
    }

    // ---------- marking ----------
    function mark(date, key, status) {
        const all = logs();
        const day = all[date] = all[date] || {};
        day[key] = status;
        localStorage.setItem('attendance_logs', JSON.stringify(all));
        try {
            const stamps = JSON.parse(localStorage.getItem('attendance_log_timestamps') || '{}');
            stamps[date] = new Date().toISOString();
            localStorage.setItem('attendance_log_timestamps', JSON.stringify(stamps));
        } catch (e) { /* ignore */ }
        if (window.SyncManager) {
            try { SyncManager.saveLog ? SyncManager.saveLog(date, day) : SyncManager.uploadAll(); } catch (e) { /* offline */ }
        }
        if (window.DayCheck?.syncDayPlan) DayCheck.syncDayPlan();
        if (typeof renderTodayTimetable === 'function') { try { renderTodayTimetable(); } catch (e) { /* ignore */ } }
        if (window.NotificationCenter) NotificationCenter.refresh();
        closeCard(key);
        if (typeof showToast === 'function') {
            const name = classes[className()]?.subjects.find(s => s.code === key.split('_p')[0])?.name || key;
            showToast(status === 'Attended' ? '✅ Marked present' : '❌ Marked absent', `${name} · attendance updated`, { duration: 3000 });
        }
    }

    // ---------- in-app card ----------
    function cardHost() {
        let el = document.getElementById('classReminderStack');
        if (!el) {
            el = document.createElement('div');
            el.id = 'classReminderStack';
            el.className = 'crm-stack';
            document.body.appendChild(el);
        }
        return el;
    }

    function showCard(c) {
        const host = cardHost();
        if (host.querySelector(`[data-key="${CSS.escape(c.key)}"]`)) return;
        const card = document.createElement('div');
        card.className = 'crm-card';
        card.dataset.key = c.key;
        card.innerHTML = `
            <div class="crm-icon"><i class="fa-solid fa-bell"></i></div>
            <div class="crm-text">
                <strong>${esc(c.name)} just ended</strong>
                <span>${c.start && c.end ? `${fmt12(c.start)} – ${fmt12(c.end)} · ` : ''}Were you there?</span>
            </div>
            <div class="crm-actions">
                <button class="crm-btn crm-yes" aria-label="Mark present">Present</button>
                <button class="crm-btn crm-no" aria-label="Mark absent">Absent</button>
            </div>
            <button class="crm-x" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>`;
        card.querySelector('.crm-yes').onclick = () => mark(c.date, c.key, 'Attended');
        card.querySelector('.crm-no').onclick = () => mark(c.date, c.key, 'Skipped');
        card.querySelector('.crm-x').onclick = () => closeCard(c.key);
        host.appendChild(card);
        requestAnimationFrame(() => card.classList.add('show'));
    }

    function closeCard(key) {
        const card = document.querySelector(`#classReminderStack [data-key="${CSS.escape(key)}"]`);
        if (!card) return;
        card.classList.remove('show');
        setTimeout(() => card.remove(), 300);
    }

    // ---------- system notification ----------
    async function systemNotify(c, name, when) {
        if (!('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return false;
        try {
            const reg = await navigator.serviceWorker.ready;
            const opts = {
                body: `${c.start && c.end ? `${fmt12(c.start)} – ${fmt12(c.end)} · ` : ''}Mark your attendance for this class.`,
                icon: '/icon-192x192.png',
                badge: '/badge-icon.png',
                tag: `class-check-${c.date}-${c.key}`,
                renotify: false,
                actions: [
                    { action: 'present', title: '✅ Present' },
                    { action: 'absent', title: '❌ Absent' }
                ],
                data: { kind: 'class-check', date: c.date, key: c.key, className: name, url: '/' }
            };
            if (when && typeof TimestampTrigger !== 'undefined') opts.showTrigger = new TimestampTrigger(when);
            await reg.showNotification(`🔔 ${c.name} just ended`, opts);
            return true;
        } catch (e) { return false; }
    }

    // Pre-schedule today's remaining classes where the browser supports it
    let scheduledFor = '';
    async function prescheduleToday(name) {
        if (typeof TimestampTrigger === 'undefined' || Notification.permission !== 'granted') return;
        const today = formatLocalDate(new Date());
        if (scheduledFor === `${name}|${today}`) return;
        scheduledFor = `${name}|${today}`;
        const base = new Date(); base.setHours(0, 0, 0, 0);
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        for (const c of todaysClasses(name)) {
            if (c.endMin === null || c.endMin <= nowMin || c.marked) continue;
            await systemNotify(c, name, base.getTime() + c.endMin * 60000);
        }
    }

    // ---------- the check ----------
    function tick() {
        const name = className();
        if (!name || !remindersOn(name)) return;
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const list = todaysClasses(name);
        if (!list.length) return;
        const done = notifiedSet(list[0].date);
        const visible = document.visibilityState === 'visible';

        list.forEach(c => {
            if (c.endMin === null || nowMin < c.endMin || c.marked) { if (c.marked) closeCard(c.key); return; }
            if (nowMin - c.endMin > LATE_LIMIT_MIN) return;
            if (done.has(c.key)) { if (visible) showCard(c); return; }
            remember(c.date, c.key);
            if (window.NotificationCenter) NotificationCenter.log({ icon: '🔔', title: `${c.name} just ended`, body: `${c.start && c.end ? `${fmt12(c.start)} – ${fmt12(c.end)} · ` : ''}Mark your attendance` });
            if (visible) showCard(c);
            else if (typeof TimestampTrigger === 'undefined') systemNotify(c, name);
        });
        // Ended classes leave Home's timetable at the right minute
        if (typeof renderTodayTimetable === 'function' && document.getElementById('dashboardPage')?.classList.contains('active')) {
            try { renderTodayTimetable(); } catch (e) { /* ignore */ }
        }
        prescheduleToday(name);
    }

    // ---------- marks chosen on a notification ----------
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const d = event.data || {};
            if (d.type === 'CLASS_MARK' && d.date && d.key && d.status) mark(d.date, d.key, d.status);
        });
    }

    async function applyQueued() {
        if (!('indexedDB' in window)) return;
        const read = () => new Promise(resolve => {
            let req; try { req = indexedDB.open('BunkitDB', 1); } catch (e) { resolve(null); return; }
            req.onupgradeneeded = e => { const db = e.target.result; if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings'); };
            req.onerror = () => resolve(null);
            req.onsuccess = e => {
                try {
                    const tx = e.target.result.transaction(['settings'], 'readwrite');
                    const store = tx.objectStore('settings');
                    const g = store.get('pendingClassMarks');
                    g.onsuccess = () => { const v = g.result; if (v) store.delete('pendingClassMarks'); resolve(v || null); };
                    g.onerror = () => resolve(null);
                } catch (err) { resolve(null); }
            };
        });
        const queue = await read();
        if (Array.isArray(queue)) queue.forEach(q => q && q.date && q.key && q.status && mark(q.date, q.key, q.status));
    }

    function start() {
        let tries = 0;
        const wait = setInterval(() => {
            tries++;
            if (className() || tries > 40) {
                clearInterval(wait);
                applyQueued();
                tick();
                setInterval(tick, TICK_MS);
            }
        }, 500);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    window.ClassReminders = { tick, mark, todaysClasses };
})();
