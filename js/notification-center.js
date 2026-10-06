// ============================================================
// NOTIFICATION CENTER (bell icon, top right of Home)
// ============================================================
// Three sections:
//  1. Missed days  - class days with no attendance marked, with quick actions
//  2. Advice       - tips worked out from the current attendance numbers
//  3. Recent       - notifications sent and marks saved from them
// The bell shows a count of missed days + subjects in danger.
// History: the app keeps it in localStorage; the service worker writes its
// own entries to IndexedDB ("notificationLog"), merged here on open.
// Uses globals: classes, currentAnalysisData, getMinAttendanceCriteria,
// getSubjectAnalysis, attendanceSplit, formatLocalDate, parseLocalDate, DayCheck.
// ============================================================

(function () {
    'use strict';

    const LOG_KEY = 'bunkit_notification_log';
    const SEEN_KEY = 'bunkit_notifications_seen';

    function esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function className() {
        const sel = document.getElementById('classSelector')?.value;
        if (sel && classes[sel]) return sel;
        const last = localStorage.getItem('lastOpenedClass');
        return last && classes[last] ? last : null;
    }

    function today() { return formatLocalDate(new Date()); }

    function addDays(dateStr, n) {
        const d = parseLocalDate(dateStr);
        d.setDate(d.getDate() + n);
        return formatLocalDate(d);
    }

    function fmt(dateStr, opts) {
        return parseLocalDate(dateStr).toLocaleDateString('en-IN', opts || { weekday: 'short', day: 'numeric', month: 'short' });
    }

    function timeAgo(iso) {
        const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} min ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs} h ago`;
        const days = Math.round(hrs / 24);
        return days === 1 ? 'yesterday' : `${days} days ago`;
    }

    function getLogs() {
        try { return JSON.parse(localStorage.getItem('attendance_logs') || '{}') || {}; } catch (e) { return {}; }
    }

    function reminderPassed() {
        const name = className();
        let time = '16:30';
        try { time = (JSON.parse(localStorage.getItem(`notificationSettings_${name}`) || 'null') || {}).time || time; } catch (e) { /* default */ }
        const [h, m] = time.split(':').map(Number);
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
    }

    // ---------- 1. Missed days ----------
    function missedDays() {
        const name = className();
        if (!name || !window.DayCheck) return [];
        const cls = classes[name];
        const logs = getLogs();
        let start = cls.portalSetup?.semesterStartDate || Object.keys(logs).sort()[0] || today();
        // Portal mode: days up to the baseline date are already counted in the portal numbers
        if (cls.portalSetup?.active && cls.portalSetup.baselineDate && cls.portalSetup.baselineDate >= start) {
            start = addDays(cls.portalSetup.baselineDate, 1);
        }
        // Today only counts once the reminder time has passed
        let end = reminderPassed() ? today() : addDays(today(), -1);
        if (cls.lastDate && end > cls.lastDate) end = cls.lastDate;

        const out = [];
        for (let d = end; d >= start; d = addDays(d, -1)) {
            if (logs[d] && Object.keys(logs[d]).length) continue;
            const n = DayCheck.periodKeysFor(name, d).length;
            if (n) out.push({ date: d, classes: n });
            if (out.length > 400) break;
        }
        return out; // newest first
    }

    // ---------- 2. Advice ----------
    function analysisData() {
        if (typeof currentAnalysisData !== 'undefined' && currentAnalysisData.length) return currentAnalysisData;
        if (window.SmartSearch?.computeClassAttendance) return SmartSearch.computeClassAttendance() || [];
        return [];
    }

    function advice() {
        const data = analysisData();
        const min = (typeof getMinAttendanceCriteria === 'function' ? getMinAttendanceCriteria() : 0.75) * 100;
        const items = [];
        const name = className();

        const rows = data.map(sub => {
            const { stats } = getSubjectAnalysis(sub.attended, sub.totalHeld, sub.remaining, null, sub.odml);
            const split = attendanceSplit(sub.attended, sub.totalHeld, sub.odml, sub.remaining);
            return { sub, stats, split };
        });

        rows.filter(r => r.split.totalHeld && r.stats.stillNeed > r.stats.remaining).forEach(r => {
            items.push({
                level: 'danger', icon: 'fa-circle-exclamation',
                title: `${r.sub.name} can't reach ${min}% anymore`,
                body: `Even attending all ${r.stats.remaining} remaining classes ends at ${r.stats.projectedMaxPercent.toFixed(1)}%. Talk to your faculty about OD/ML or a condonation.`
            });
        });

        rows.filter(r => r.split.totalHeld && r.split.withPct < min && r.stats.stillNeed <= r.stats.remaining)
            .sort((a, b) => a.split.withPct - b.split.withPct)
            .forEach(r => {
                items.push({
                    level: 'warning', icon: 'fa-arrow-trend-up',
                    title: `Attend ${r.stats.stillNeed} more ${r.sub.name} class${r.stats.stillNeed !== 1 ? 'es' : ''}`,
                    body: `It's at ${r.split.withPct.toFixed(1)}% now. Don't skip it until it's back above ${min}%.`
                });
            });

        rows.filter(r => r.split.totalHeld && r.split.odml && r.split.withoutPct < min && r.split.withPct >= min).forEach(r => {
            items.push({
                level: 'info', icon: 'fa-briefcase-medical',
                title: `${r.sub.name} is above ${min}% only with OD/ML`,
                body: `Original attendance is ${r.split.withoutPct.toFixed(1)}% (${r.split.withPct.toFixed(1)}% with ${r.split.odml} OD/ML hours). Your college may count OD/ML only up to ${min}%.`
            });
        });

        // Once OD/ML is used: how to use the whole allowance and keep the minimum
        rows.filter(r => r.split.odml && r.stats.allowancePlan && typeof odmlPlanText === 'function').forEach(r => {
            const plan = odmlPlanText(r.sub.name, r.stats.allowancePlan, r.stats.remaining, min);
            if (!plan) return;
            const p = r.stats.allowancePlan;
            items.push({
                level: !p.eligible || p.needWithoutMore > r.stats.remaining ? 'danger' : p.unused ? 'warning' : 'info',
                icon: 'fa-briefcase-medical',
                title: plan.title,
                body: plan.lines.join(' ')
            });
        });

        const skippable = rows.filter(r => r.split.totalHeld && r.split.withPct >= min && r.stats.maxSkippable > 0)
            .sort((a, b) => b.stats.maxSkippable - a.stats.maxSkippable);
        if (skippable.length) {
            const top = skippable.slice(0, 3).map(r => `${r.sub.name} (${r.stats.maxSkippable})`).join(', ');
            items.push({
                level: 'safe', icon: 'fa-shield-halved',
                title: 'Safe to skip if you need to',
                body: `Most room left: ${top}. These counts keep you at or above ${min}% till the end of the semester.`
            });
        }

        // Upcoming exams (next 7 days)
        if (typeof getSavedExamPeriods === 'function') {
            const t = today();
            const soon = addDays(t, 7);
            getSavedExamPeriods()
                .filter(e => e.end >= t && e.start <= soon)
                .sort((a, b) => a.start.localeCompare(b.start))
                .forEach(e => {
                    const days = Math.round((parseLocalDate(e.start > t ? e.start : t) - parseLocalDate(t)) / 86400000);
                    const when = e.start <= t ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
                    items.unshift({
                        level: e.start <= addDays(t, 1) ? 'danger' : 'warning', icon: 'fa-file-pen',
                        title: `${e.title} ${when}`,
                        body: `${fmt(e.start)}${e.end !== e.start ? ` → ${fmt(e.end)}` : ''}. Attendance is compulsory, don't plan leave on ${e.end !== e.start ? 'these days' : 'this day'}.`
                    });
                });
        }

        // Tomorrow
        if (name && window.DayCheck) {
            const tmr = addDays(today(), 1);
            const keys = DayCheck.periodKeysFor(name, tmr);
            const cls = classes[name];
            if ((cls.holidays || []).includes(tmr)) {
                items.push({ level: 'info', icon: 'fa-umbrella-beach', title: 'Tomorrow is a holiday', body: `${fmt(tmr)}: no classes.` });
            } else if (keys.length) {
                const counts = {};
                keys.forEach(k => { const c = k.split('_p')[0]; counts[c] = (counts[c] || 0) + 1; });
                const list = Object.keys(counts).map(code => {
                    const s = cls.subjects.find(x => x.code === code);
                    return `${s?.shortName || s?.name || code}${counts[code] > 1 ? ` ×${counts[code]}` : ''}`;
                }).join(', ');
                const risky = rows.filter(r => counts[r.sub.code] && r.split.withPct < min).map(r => r.sub.name);
                items.push({
                    level: risky.length ? 'warning' : 'info', icon: 'fa-calendar-day',
                    title: `Tomorrow: ${keys.length} class${keys.length !== 1 ? 'es' : ''}`,
                    body: `${fmt(tmr)} · ${list}.${risky.length ? ` Don't miss ${risky.join(', ')}.` : ''}`
                });
            }
        }

        if (!items.length && rows.length) {
            items.push({ level: 'safe', icon: 'fa-circle-check', title: 'All good', body: `Every subject is at or above ${min}%.` });
        }
        return items;
    }

    // ---------- 3. History ----------
    function readLog() {
        try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]') || []; } catch (e) { return []; }
    }

    function log(entry) {
        const list = readLog();
        list.unshift({ at: new Date().toISOString(), ...entry });
        localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(0, 40)));
        refreshBadge();
    }

    // Pull entries the service worker wrote while the app was closed
    function mergeServiceWorkerLog() {
        return new Promise((resolve) => {
            let req;
            try { req = indexedDB.open('BunkitDB', 1); } catch (e) { resolve(); return; }
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
            };
            req.onerror = () => resolve();
            req.onsuccess = (e) => {
                try {
                    const tx = e.target.result.transaction(['settings'], 'readwrite');
                    const store = tx.objectStore('settings');
                    const get = store.get('notificationLog');
                    get.onsuccess = () => {
                        const swEntries = Array.isArray(get.result) ? get.result : [];
                        if (swEntries.length) {
                            const merged = readLog().concat(swEntries).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
                            localStorage.setItem(LOG_KEY, JSON.stringify(merged.slice(0, 40)));
                            store.delete('notificationLog');
                        }
                    };
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => resolve();
                } catch (err) { resolve(); }
            };
        });
    }

    // ---------- dismissed (deleted) items ----------
    // History entries are removed from the log; missed days and tips are derived,
    // so deleting them stores their id here and they stay hidden.
    const DISMISS_KEY = 'bunkit_notifications_dismissed';
    function dismissed() {
        try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch (e) { return new Set(); }
    }
    function saveDismissed(set) {
        localStorage.setItem(DISMISS_KEY, JSON.stringify([...set].slice(-400)));
    }
    const missedId = (m) => `m:${className()}:${m.date}`;
    const tipId = (t) => `a:${className()}:${t.title}`;
    const histId = (h) => `h:${h.at}|${h.title}`;

    // ---------- badge ----------
    function badgeCount() {
        const gone = dismissed();
        const missed = missedDays().filter(m => !gone.has(missedId(m))).length;
        const danger = advice().filter(a => a.level === 'danger' && !gone.has(tipId(a))).length;
        const lastSeen = localStorage.getItem(SEEN_KEY) || '';
        const fresh = readLog().filter(e => e.at > lastSeen).length;
        return missed + danger + fresh;
    }

    let badgeTimer = null;
    function refreshBadge() {
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => {
            const bell = document.querySelector('.dash-notification-bell');
            if (!bell) return;
            let n = 0;
            try { n = className() ? badgeCount() : 0; } catch (e) { n = 0; }
            bell.dataset.count = n > 9 ? '9+' : String(n);
            bell.classList.toggle('has-count', n > 0);
            bell.setAttribute('aria-label', n ? `Notifications, ${n} need attention` : 'Notifications');
        }, 200);
    }

    // ---------- panel (Instagram-style) ----------
    let filter = 'all';
    let selecting = false;
    let selected = new Set();
    let lastSeenAtOpen = '';
    let undoBatch = null;
    let undoTimer = null;

    // "3m", "5h", "2d", "3w"
    function shortAgo(iso) {
        const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
        if (mins < 1) return 'now';
        if (mins < 60) return `${mins}m`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        const days = Math.round(hrs / 24);
        if (days < 7) return `${days}d`;
        return `${Math.round(days / 7)}w`;
    }

    const TONE = { danger: 'red', warning: 'amber', info: 'blue', safe: 'green' };

    // One list of every item, each with an id, kind, time and group
    function collect() {
        const gone = dismissed();
        const name = className();
        const items = [];
        if (name) {
            advice().forEach(t => {
                const id = tipId(t);
                if (gone.has(id)) return;
                items.push({ id, kind: 'tip', group: 'foryou', at: new Date().toISOString(), tone: TONE[t.level] || 'blue',
                    icon: `<i class="fa-solid ${t.icon}"></i>`, title: t.title, body: t.body, unread: t.level === 'danger' });
            });
            missedDays().forEach(m => {
                const id = missedId(m);
                if (gone.has(id)) return;
                const at = `${m.date}T${reminderTime()}:00`;
                items.push({ id, kind: 'missed', date: m.date, at: new Date(at).toISOString(), tone: 'violet',
                    icon: '<i class="fa-regular fa-calendar-xmark"></i>', title: `${fmt(m.date)} isn't marked`,
                    body: `${m.classes} class${m.classes !== 1 ? 'es' : ''} waiting for attendance.`, unread: true });
            });
        }
        readLog().forEach(h => {
            items.push({ id: histId(h), kind: 'hist', at: h.at, tone: 'slate', icon: esc(h.icon || '🔔'), emoji: true,
                title: h.title, body: h.body || '', unread: h.at > lastSeenAtOpen, raw: h });
        });
        return items;
    }

    function reminderTime() {
        const name = className();
        try { return (JSON.parse(localStorage.getItem(`notificationSettings_${name}`) || 'null') || {}).time || '16:30'; } catch (e) { return '16:30'; }
    }

    function groupOf(it) {
        if (it.group === 'foryou') return 'foryou';
        if (it.kind === 'hist' && it.unread) return 'new';
        const t = new Date(); t.setHours(0, 0, 0, 0);
        const d = new Date(it.at);
        const days = (t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
        if (days <= 0) return 'today';
        if (days < 7) return 'week';
        return 'earlier';
    }
    const GROUPS = [['foryou', 'For you'], ['new', 'New'], ['today', 'Today'], ['week', 'This week'], ['earlier', 'Earlier']];

    function rowHTML(it) {
        const action = it.kind === 'missed' && !selecting ? `
            <div class="ign-actions">
                <button class="ign-btn ign-btn-primary" onclick="event.stopPropagation(); NotificationCenter.mark('${it.date}', 'Attended')">Present</button>
                <button class="ign-btn" onclick="event.stopPropagation(); NotificationCenter.mark('${it.date}', 'Skipped')" aria-label="Mark absent">Absent</button>
            </div>` : '';
        const onRow = selecting ? `NotificationCenter.selectEl(this)`
            : it.kind === 'missed' ? `NotificationCenter.manual('${it.date}')` : '';
        return `
            <div class="ign-row-wrap" data-id="${esc(it.id)}">
                <div class="ign-swipe-bg"><i class="fa-regular fa-trash-can"></i> Delete</div>
                <div class="ign-row ${it.unread ? 'unread' : ''} ${selected.has(it.id) ? 'picked' : ''}" ${onRow ? `onclick="${onRow}"` : ''}>
                    ${selecting ? `<span class="ign-check"><i class="fa-solid fa-check"></i></span>` : ''}
                    <span class="ign-avatar ign-${it.tone} ${it.unread ? 'ring' : ''}">${it.icon}</span>
                    <div class="ign-text">
                        <p><strong>${esc(it.title)}</strong>${it.body ? ` ${esc(it.body)}` : ''} <time>${it.group === 'foryou' ? '' : shortAgo(it.at)}</time></p>
                        ${action}
                    </div>
                    ${!selecting ? `<button class="ign-del" onclick="event.stopPropagation(); NotificationCenter.removeEl(this)" aria-label="Delete notification"><i class="fa-regular fa-trash-can"></i></button>` : ''}
                    ${it.unread && !selecting ? '<span class="ign-dot"></span>' : ''}
                </div>
            </div>`;
    }

    function render() {
        const panel = document.getElementById('notifCenter');
        if (!panel) return;
        const all = collect();
        const shown = all.filter(it => filter === 'all' || (filter === 'missed' && it.kind === 'missed') ||
            (filter === 'tips' && it.kind === 'tip') || (filter === 'activity' && it.kind === 'hist'));
        const counts = { all: all.length, missed: all.filter(i => i.kind === 'missed').length, tips: all.filter(i => i.kind === 'tip').length, activity: all.filter(i => i.kind === 'hist').length };

        panel.querySelector('.ign-head-action').innerHTML = all.length
            ? `<button class="ign-link" onclick="NotificationCenter.toggleSelecting()">${selecting ? 'Done' : 'Edit'}</button>` : '';
        panel.querySelector('.ign-chips').innerHTML = [['all', 'All'], ['missed', 'Missed days'], ['tips', 'For you'], ['activity', 'Activity']]
            .map(([k, l]) => `<button class="ign-chip ${filter === k ? 'on' : ''}" onclick="NotificationCenter.setFilter('${k}')">${l}${counts[k] ? ` <span>${counts[k]}</span>` : ''}</button>`).join('');

        let body = '';
        if (!shown.length) {
            body = `<div class="ign-empty">
                <div class="ign-empty-icon"><i class="fa-regular fa-bell"></i></div>
                <h3>${filter === 'all' ? "You're all caught up" : 'Nothing here'}</h3>
                <p>${filter === 'missed' ? 'Every class day is marked.' : 'New reminders and tips will show up here.'}</p>
            </div>`;
        } else {
            GROUPS.forEach(([key, label]) => {
                const list = shown.filter(it => groupOf(it) === key).sort((a, b) => b.at.localeCompare(a.at));
                if (!list.length) return;
                body += `<section class="ign-group"><h3>${label}</h3>${list.map(rowHTML).join('')}</section>`;
            });
        }
        panel.querySelector('.ign-list').innerHTML = body;

        const bar = panel.querySelector('.ign-select-bar');
        bar.hidden = !selecting;
        if (selecting) {
            bar.innerHTML = `
                <button class="ign-link" onclick="NotificationCenter.selectAll()">${selected.size === shown.length && shown.length ? 'Unselect all' : 'Select all'}</button>
                <button class="ign-btn ign-btn-danger" ${selected.size ? '' : 'disabled'} onclick="NotificationCenter.remove([...NotificationCenter._selected()])">
                    <i class="fa-regular fa-trash-can"></i> Delete${selected.size ? ` (${selected.size})` : ''}</button>`;
        }
        if (!selecting) attachSwipe(panel);
        panel._shown = shown;
    }

    // Swipe a row left to delete (phones)
    function attachSwipe(panel) {
        panel.querySelectorAll('.ign-row-wrap').forEach(wrap => {
            const row = wrap.querySelector('.ign-row');
            let x0 = null, y0 = 0, dx = 0, dragging = false;
            row.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; dragging = false; row.style.transition = 'none'; }, { passive: true });
            row.addEventListener('touchmove', e => {
                if (x0 === null) return;
                const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
                if (!dragging && Math.abs(my) > Math.abs(mx)) { x0 = null; return; }
                if (Math.abs(mx) > 8) dragging = true;
                dx = Math.min(0, mx);
                row.style.transform = `translateX(${dx}px)`;
                wrap.classList.toggle('swiping', dx < -10);
            }, { passive: true });
            row.addEventListener('touchend', () => {
                if (x0 === null) return;
                row.style.transition = '';
                if (dx < -Math.min(110, wrap.offsetWidth * 0.32)) {
                    row.style.transform = `translateX(-${wrap.offsetWidth}px)`;
                    setTimeout(() => remove([wrap.dataset.id]), 180);
                } else {
                    row.style.transform = '';
                    wrap.classList.remove('swiping');
                }
                if (dragging) { row.addEventListener('click', ev => ev.stopPropagation(), { capture: true, once: true }); }
                x0 = null;
            });
        });
    }

    function remove(ids) {
        if (!ids || !ids.length) return;
        const idSet = new Set(ids);
        const log = readLog();
        const keptLog = log.filter(h => !idSet.has(histId(h)));
        const removedLog = log.filter(h => idSet.has(histId(h)));
        const gone = dismissed();
        const newlyDismissed = ids.filter(id => !id.startsWith('h:') && !gone.has(id));
        newlyDismissed.forEach(id => gone.add(id));
        localStorage.setItem(LOG_KEY, JSON.stringify(keptLog));
        saveDismissed(gone);
        undoBatch = { removedLog, newlyDismissed };
        ids.forEach(id => selected.delete(id));
        if (selecting && !collect().length) selecting = false;
        render();
        refreshBadge();
        showUndo(ids.length);
    }

    function showUndo(n) {
        const panel = document.getElementById('notifCenter');
        const bar = panel?.querySelector('.ign-snack');
        if (!bar) return;
        bar.innerHTML = `<span>${n === 1 ? 'Notification deleted' : `${n} notifications deleted`}</span><button onclick="NotificationCenter.undo()">Undo</button>`;
        bar.classList.add('show');
        clearTimeout(undoTimer);
        undoTimer = setTimeout(() => { bar.classList.remove('show'); undoBatch = null; }, 5000);
    }

    function undo() {
        if (!undoBatch) return;
        const log = readLog().concat(undoBatch.removedLog).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
        localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 40)));
        const gone = dismissed();
        undoBatch.newlyDismissed.forEach(id => gone.delete(id));
        saveDismissed(gone);
        undoBatch = null;
        document.querySelector('#notifCenter .ign-snack')?.classList.remove('show');
        render();
        refreshBadge();
    }

    async function open() {
        let panel = document.getElementById('notifCenter');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'notifCenter';
            panel.className = 'ign-backdrop';
            panel.innerHTML = `
                <aside class="ign-panel" role="dialog" aria-label="Notifications">
                    <header class="ign-head">
                        <button class="ign-back" onclick="NotificationCenter.close()" aria-label="Close"><i class="fa-solid fa-arrow-left"></i></button>
                        <h2>Notifications</h2>
                        <div class="ign-head-action"></div>
                    </header>
                    <div class="ign-chips"></div>
                    <div class="ign-list"></div>
                    <div class="ign-select-bar" hidden></div>
                    <div class="ign-snack" role="status"></div>
                </aside>`;
            panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
            document.body.appendChild(panel);
        }
        await mergeServiceWorkerLog();
        lastSeenAtOpen = localStorage.getItem(SEEN_KEY) || '';
        filter = 'all';
        selecting = false;
        selected = new Set();
        render();
        requestAnimationFrame(() => panel.classList.add('open'));
        document.body.classList.add('ign-lock');
        localStorage.setItem(SEEN_KEY, new Date().toISOString());
        refreshBadge();
    }

    function close() {
        document.getElementById('notifCenter')?.classList.remove('open');
        document.body.classList.remove('ign-lock');
    }

    function isOpen() {
        return document.getElementById('notifCenter')?.classList.contains('open');
    }

    // ---------- wiring ----------
    function init() {
        const bell = document.querySelector('.dash-notification-bell');
        if (bell) {
            bell.setAttribute('role', 'button');
            bell.setAttribute('tabindex', '0');
            bell.addEventListener('click', open);
            bell.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        }
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
        mergeServiceWorkerLog().then(refreshBadge);
        // Re-count after classes load and every few minutes (reminder time / new day)
        setTimeout(refreshBadge, 1500);
        setInterval(refreshBadge, 5 * 60 * 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.NotificationCenter = {
        open, close, log, refreshBadge,
        // Data changed (marks, holidays...): update badge and an open panel
        refresh() { refreshBadge(); if (isOpen()) render(); },
        mark(dateStr, status) {
            if (window.DayCheck) DayCheck.mark(dateStr, status);
            setTimeout(() => { if (isOpen()) render(); refreshBadge(); }, 400);
        },
        manual(dateStr) {
            close();
            if (window.DayCheck) DayCheck.manual(dateStr);
        },
        toggleAll() { render(); },
        remove, undo,
        setFilter(f) { filter = f; selected = new Set(); render(); },
        toggleSelecting() { selecting = !selecting; selected = new Set(); render(); },
        toggleSelect(id) { if (selected.has(id)) selected.delete(id); else selected.add(id); render(); },
        // ids come from the row's data-id (safe for titles with quotes)
        selectEl(el) { const id = el.closest('.ign-row-wrap')?.dataset.id; if (id) NotificationCenter.toggleSelect(id); },
        removeEl(el) { const id = el.closest('.ign-row-wrap')?.dataset.id; if (id) remove([id]); },
        selectAll() {
            const shown = document.getElementById('notifCenter')?._shown || [];
            selected = selected.size === shown.length ? new Set() : new Set(shown.map(i => i.id));
            render();
        },
        _selected: () => selected,
        _missedDays: missedDays,
        _advice: advice
    };
})();
