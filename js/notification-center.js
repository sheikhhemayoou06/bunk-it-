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
    const MISSED_LIMIT = 10;

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

    // ---------- badge ----------
    function badgeCount() {
        const missed = missedDays().length;
        const danger = advice().filter(a => a.level === 'danger').length;
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

    // ---------- panel ----------
    let showAllMissed = false;

    function render() {
        const panel = document.getElementById('notifCenter');
        if (!panel) return;
        const name = className();
        const missed = name ? missedDays() : [];
        const tips = name ? advice() : [];
        const history = readLog();
        const visible = showAllMissed ? missed : missed.slice(0, MISSED_LIMIT);

        const missedHtml = missed.length ? `
            <div class="nc-list">
                ${visible.map(m => `
                    <div class="nc-missed">
                        <div class="nc-missed-date">
                            <strong>${fmt(m.date)}</strong>
                            <span>${m.classes} class${m.classes !== 1 ? 'es' : ''} · not marked</span>
                        </div>
                        <div class="nc-missed-actions">
                            <button class="nc-mini present" onclick="NotificationCenter.mark('${m.date}', 'Attended')" title="All present" aria-label="Mark all present on ${fmt(m.date)}">✅</button>
                            <button class="nc-mini absent" onclick="NotificationCenter.mark('${m.date}', 'Skipped')" title="All absent" aria-label="Mark all absent on ${fmt(m.date)}">❌</button>
                            <button class="nc-mini" onclick="NotificationCenter.manual('${m.date}')" title="Mark manually" aria-label="Mark ${fmt(m.date)} manually">✏️</button>
                        </div>
                    </div>`).join('')}
            </div>
            ${missed.length > MISSED_LIMIT ? `<button class="nc-more" onclick="NotificationCenter.toggleAll()">${showAllMissed ? 'Show fewer' : `Show all ${missed.length} missed days`}</button>` : ''}`
            : `<div class="nc-empty"><i class="fa-solid fa-circle-check"></i> Every class day is marked.</div>`;

        const adviceHtml = tips.length ? tips.map(a => `
            <div class="nc-tip ${a.level}">
                <span class="nc-tip-icon"><i class="fa-solid ${a.icon}"></i></span>
                <div><strong>${esc(a.title)}</strong><p>${esc(a.body)}</p></div>
            </div>`).join('') : `<div class="nc-empty">Advice appears once attendance is marked.</div>`;

        const historyHtml = history.length ? history.slice(0, 15).map(h => `
            <div class="nc-hist">
                <span class="nc-hist-icon">${esc(h.icon || '🔔')}</span>
                <div><strong>${esc(h.title)}</strong>${h.body ? `<p>${esc(h.body)}</p>` : ''}</div>
                <time>${timeAgo(h.at)}</time>
            </div>`).join('') : `<div class="nc-empty">No notifications yet.</div>`;

        panel.querySelector('.nc-body').innerHTML = `
            <section class="nc-section">
                <h3><i class="fa-regular fa-calendar-xmark"></i> Missed days ${missed.length ? `<span class="nc-count">${missed.length}</span>` : ''}</h3>
                ${missedHtml}
            </section>
            <section class="nc-section">
                <h3><i class="fa-regular fa-lightbulb"></i> Advice</h3>
                ${adviceHtml}
            </section>
            <section class="nc-section">
                <h3><i class="fa-regular fa-bell"></i> Recent notifications</h3>
                ${historyHtml}
            </section>`;
    }

    async function open() {
        let panel = document.getElementById('notifCenter');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'notifCenter';
            panel.className = 'nc-backdrop';
            panel.innerHTML = `
                <aside class="nc-panel" role="dialog" aria-label="Notifications">
                    <header class="nc-head">
                        <h2>Notifications</h2>
                        <button class="nc-close" onclick="NotificationCenter.close()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                    </header>
                    <div class="nc-body"></div>
                </aside>`;
            panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
            document.body.appendChild(panel);
        }
        await mergeServiceWorkerLog();
        showAllMissed = false;
        render();
        requestAnimationFrame(() => panel.classList.add('open'));
        localStorage.setItem(SEEN_KEY, new Date().toISOString());
        refreshBadge();
    }

    function close() {
        document.getElementById('notifCenter')?.classList.remove('open');
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
        toggleAll() { showAllMissed = !showAllMissed; render(); },
        _missedDays: missedDays,
        _advice: advice
    };
})();
