// ============================================================
// TIMETABLE MODES - Monthly / Daily / Fixed
// ============================================================
// Renders #timetablePage. Each mode works in its own way:
//  - Monthly: timetable reviewed every month; changes apply from a chosen
//    date, earlier days keep their old timetable (timetable_history_*).
//  - Daily:   no fixed timetable; each day's periods are entered one by one
//    (custom_schedules_*[date] = { CODE: n, _periods: [...] }).
//  - Fixed:   one weekly timetable; edits apply from a chosen date.
// Uses globals from index.html: classes, selectedClass, getTimetableArrangement,
// getTimetableHistory, getCustomScheduleForDate, formatLocalDate, parseLocalDate,
// getTimetableMode, ttUpdateClass, ttNextReviewDate, markTimetableReviewed,
// renderTimetableModeBanner, editSelectedClass, switchPage, getSubjectColor.
// ============================================================

(function () {
    'use strict';

    const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const MODE_LABELS = { monthly: 'Changes every month', daily: 'Changes every day', fixed: 'Fixed timetable' };

    let dailyDate = null;     // date being edited in Daily mode
    let dailyDraft = null;    // array of subject codes / null (free)
    let monthlyViewIdx = null; // history version shown in Monthly mode

    // --- Helpers ---
    function esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function className() {
        const name = document.getElementById('classSelector')?.value;
        return name && classes[name] ? name : null;
    }

    function cls() {
        const name = className();
        return name ? classes[name] : null;
    }

    function today() {
        return formatLocalDate(new Date());
    }

    function addDays(dateStr, n) {
        const d = parseLocalDate(dateStr);
        d.setDate(d.getDate() + n);
        return formatLocalDate(d);
    }

    function fmt(dateStr, opts) {
        return parseLocalDate(dateStr).toLocaleDateString('en-IN', opts || { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function dayIndexOf(dateStr) {
        const dow = parseLocalDate(dateStr).getDay();
        return dow === 0 ? 6 : dow - 1;
    }

    function subjectColor(code) {
        const c = cls();
        const idx = c ? c.subjects.findIndex(s => s.code === code) : -1;
        if (typeof getSubjectColor === 'function' && idx >= 0) return getSubjectColor(idx);
        const palette = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];
        return palette[Math.max(idx, 0) % palette.length];
    }

    function subjectName(code) {
        const s = cls()?.subjects.find(x => x.code === code);
        return s ? (s.shortName || s.name) : code;
    }

    function codeOf(item) {
        return item && typeof item === 'object' ? item.code : item;
    }

    // Weekly arrangement, falling back to subject schedule counts
    function weeklyArrangement(arrangement) {
        const c = cls();
        const result = {};
        for (let d = 0; d < 7; d++) {
            const dayArr = arrangement && arrangement[d];
            if (Array.isArray(dayArr) && dayArr.length) {
                result[d] = dayArr.map(codeOf);
            } else {
                const periods = [];
                (c?.subjects || []).forEach(s => {
                    const n = typeof parseScheduleValue === 'function' ? parseScheduleValue(s.schedule?.[d]) : (parseInt(s.schedule?.[d]) || 0);
                    for (let i = 0; i < n; i++) periods.push(s.code);
                });
                result[d] = periods;
            }
        }
        return result;
    }

    // Periods for a date in "usual" timetable (version in effect that day)
    function usualPeriodsFor(dateStr) {
        const name = className();
        const arr = weeklyArrangement(getTimetableArrangement(name, dateStr));
        return (arr[dayIndexOf(dateStr)] || []).slice();
    }

    function recalc() {
        if (window.SyncManager) { try { SyncManager.uploadAll(); } catch (e) { /* offline */ } }
        if (typeof recalculateEverything === 'function') { try { recalculateEverything(); } catch (e) { /* ignore */ } }
        if (typeof renderTimetableModeBanner === 'function') renderTimetableModeBanner();
    }

    // --- Weekly grid ---
    function renderWeekGrid(arrangement) {
        const week = weeklyArrangement(arrangement);
        const days = [0, 1, 2, 3, 4, 5, 6].filter(d => week[d].some(Boolean));
        if (!days.length) {
            return `<div class="tm-empty"><i class="fa-regular fa-calendar-xmark"></i><p>No timetable set yet.</p></div>`;
        }
        const maxP = Math.max(...days.map(d => week[d].length));
        let head = '<tr><th>Period</th>' + days.map(d => `<th>${DAY_NAMES[d]}</th>`).join('') + '</tr>';
        let body = '';
        for (let p = 0; p < maxP; p++) {
            body += `<tr><td class="tm-pnum">${p + 1}</td>` + days.map(d => {
                const code = week[d][p];
                if (!code) return '<td><span class="tm-free">—</span></td>';
                const color = subjectColor(code);
                return `<td><span class="tm-chip" style="--chip:${color}" title="${esc(code)}">${esc(subjectName(code))}</span></td>`;
            }).join('') + '</tr>';
        }
        return `<div class="tm-grid-scroll"><table class="tm-grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
    }

    function versionStart(v) {
        if (v.effectiveFrom > '2000-01-01') return fmt(v.effectiveFrom);
        const start = cls()?.portalSetup?.semesterStartDate;
        return start ? fmt(start) : 'Class start';
    }

    function versionsList(history, activeIdx, clickable) {
        if (!history.length) return '';
        const t = today();
        return `<div class="tm-versions">${history.map((v, i) => {
            const isNow = t >= v.effectiveFrom && (!v.effectiveTo || t <= v.effectiveTo);
            const isPast = v.effectiveTo && v.effectiveTo < t;
            const name = isNow ? 'Current timetable' : isPast ? 'Old timetable' : 'Upcoming timetable';
            const to = v.effectiveTo ? fmt(v.effectiveTo) : 'onwards';
            const perWeek = Object.values(weeklyArrangement(v.arrangement)).reduce((n, day) => n + day.filter(Boolean).length, 0);
            return `<div class="tm-version-row">
                <button class="tm-version ${i === activeIdx ? 'active' : ''}" ${clickable ? `onclick="TimetableModes.viewVersion(${i})"` : 'disabled'}>
                    <span class="tm-version-dot ${isNow ? 'now' : ''}"></span>
                    <span class="tm-version-text">
                        <span class="tm-version-range">${name}</span>
                        <span class="tm-version-meta">${versionStart(v)} → ${to} · ${perWeek} classes a week</span>
                    </span>
                    ${isNow ? '<span class="tm-badge">Now</span>' : ''}
                </button>
                <button class="tm-icon-btn" onclick="editTimetableVersion(${i})" title="Edit" aria-label="Edit ${name}"><i class="fa-solid fa-pen"></i></button>
            </div>`;
        }).join('')}</div>`;
    }

    // Timetable changes in plain words (used by Fixed and Monthly modes)
    function versionsCard(history, activeIdx, clickable) {
        return `
            <section class="tm-card">
                <h3 class="tm-subhead"><i class="fa-solid fa-layer-group"></i> Timetable changed during the semester?</h3>
                <div class="tm-change-actions">
                    <button class="tm-change-btn" onclick="openTimetableChange('old')">
                        <span class="tm-change-icon">📜</span>
                        <span><strong>Add my old timetable</strong><small>It was different at the start. Example: 20 Jul → 18 Aug</small></span>
                    </button>
                    <button class="tm-change-btn" onclick="openTimetableChange('new')">
                        <span class="tm-change-icon">🔄</span>
                        <span><strong>My timetable changed</strong><small>Set the new one from the day it starts</small></span>
                    </button>
                </div>
                ${history.length > 1 ? `
                    <p class="tm-muted tm-versions-note">Each day is counted with the timetable that was used on that day.</p>
                    ${versionsList(history, activeIdx, clickable)}` : ''}
            </section>`;
    }

    // ============================================================
    // MODE: FIXED
    // ============================================================
    function renderFixed() {
        const name = className();
        const history = getTimetableHistory(name);
        return `
            <section class="tm-card">
                <div class="tm-card-head">
                    <div>
                        <h2><i class="fa-solid fa-lock"></i> Fixed timetable</h2>
                        <p>One timetable for the whole semester. If it changes, edit it and choose the date the change starts — earlier days keep the old timetable.</p>
                    </div>
                    <button class="tm-btn tm-btn-primary" onclick="TimetableModes.editTimetable()"><i class="fa-solid fa-pen-to-square"></i> Edit timetable</button>
                </div>
                ${renderWeekGrid(getTimetableArrangement(name, today()))}
            </section>
            ${versionsCard(history, -1, false)}`;
    }

    // ============================================================
    // MODE: MONTHLY
    // ============================================================
    function renderMonthly() {
        const name = className();
        const c = cls();
        const t = today();
        const history = getTimetableHistory(name);
        const nextReview = ttNextReviewDate(name);
        const due = t >= nextReview;

        // Which version to show (default: current)
        let idx = monthlyViewIdx;
        if (idx === null || !history[idx]) idx = history.findIndex(v => t >= v.effectiveFrom && (!v.effectiveTo || t <= v.effectiveTo));
        const shown = idx >= 0 ? history[idx] : null;
        const arrangement = shown ? shown.arrangement : getTimetableArrangement(name, t);
        const label = shown
            ? `${versionStart(shown)} → ${shown.effectiveTo ? fmt(shown.effectiveTo) : 'onwards'}`
            : 'Current timetable';

        return `
            <section class="tm-card tm-review ${due ? 'due' : ''}">
                <div class="tm-review-icon"><i class="fa-solid ${due ? 'fa-bell' : 'fa-calendar-check'}"></i></div>
                <div class="tm-review-text">
                    <strong>${due ? 'Monthly check due — has your timetable changed?' : 'Timetable is up to date'}</strong>
                    <span>${due ? `Review was due on ${fmt(nextReview)}.` : `Next check on ${fmt(nextReview)}.`}
                        ${c?.timetableReviewedAt ? `Last checked ${fmt(c.timetableReviewedAt)}.` : ''}</span>
                </div>
                <div class="tm-review-actions">
                    <button class="tm-btn" onclick="TimetableModes.noChanges()"><i class="fa-solid fa-check"></i> No changes this month</button>
                    <button class="tm-btn tm-btn-primary" onclick="TimetableModes.editTimetable()"><i class="fa-solid fa-pen-to-square"></i> Update for this month</button>
                </div>
            </section>

            <section class="tm-card">
                <div class="tm-card-head">
                    <div>
                        <h2><i class="fa-solid fa-calendar-days"></i> ${esc(label)}</h2>
                        <p>Attendance for each day is calculated with the timetable that was in effect on that day.</p>
                    </div>
                </div>
                ${renderWeekGrid(arrangement)}
            </section>

            ${versionsCard(history, idx, true)}`;
    }

    // ============================================================
    // MODE: DAILY
    // ============================================================
    function dailyEntry(dateStr) {
        const custom = getCustomScheduleForDate(dateStr);
        if (custom && Array.isArray(custom._periods)) return custom._periods.slice();
        return null;
    }

    function renderDaily() {
        const c = cls();
        const t = today();
        if (!dailyDate) dailyDate = t;
        if (!dailyDraft) {
            const saved = dailyEntry(dailyDate);
            dailyDraft = saved ? saved : [];
        }
        const saved = dailyEntry(dailyDate);
        const isHoliday = (c.holidays || []).includes(dailyDate);
        const outside = (c.portalSetup?.semesterStartDate && dailyDate < c.portalSetup.semesterStartDate) || (c.lastDate && dailyDate > c.lastDate);

        // 14-day strip: last 7 + next 6
        let strip = '';
        for (let i = -7; i <= 6; i++) {
            const d = addDays(t, i);
            const entered = !!dailyEntry(d);
            const hol = (c.holidays || []).includes(d);
            const state = hol ? 'holiday' : entered ? 'done' : (d < t ? 'missing' : 'pending');
            strip += `<button class="tm-day ${state} ${d === dailyDate ? 'active' : ''} ${d === t ? 'today' : ''}" onclick="TimetableModes.pickDay('${d}')" title="${fmt(d)}">
                <span>${parseLocalDate(d).toLocaleDateString('en-IN', { weekday: 'short' })}</span>
                <strong>${parseLocalDate(d).getDate()}</strong>
                <i></i>
            </button>`;
        }

        const options = (code) => `<option value="">Free period</option>` + c.subjects.map(s =>
            `<option value="${esc(s.code)}" ${s.code === code ? 'selected' : ''}>${esc(s.name)} (${esc(s.code)})</option>`).join('');

        const rows = dailyDraft.map((code, i) => `
            <div class="tm-period-row">
                <span class="tm-period-num" style="--chip:${code ? subjectColor(code) : '#94a3b8'}">${i + 1}</span>
                <select onchange="TimetableModes.setPeriod(${i}, this.value)">${options(code)}</select>
                <button class="tm-icon-btn" onclick="TimetableModes.removePeriod(${i})" title="Remove period" aria-label="Remove period"><i class="fa-solid fa-xmark"></i></button>
            </div>`).join('');

        let notice = '';
        if (isHoliday) notice = `<div class="tm-notice"><i class="fa-solid fa-umbrella-beach"></i> This date is in your holiday list — no classes are counted.</div>`;
        else if (outside) notice = `<div class="tm-notice"><i class="fa-solid fa-calendar-xmark"></i> This date is outside your semester.</div>`;

        return `
            <section class="tm-card">
                <div class="tm-card-head">
                    <div>
                        <h2><i class="fa-solid fa-sun"></i> Day-by-day timetable</h2>
                        <p>Enter each day's periods one by one before classes start. Days you don't enter use your usual weekly timetable.</p>
                    </div>
                </div>
                <div class="tm-strip">${strip}</div>
                <div class="tm-legend">
                    <span><i class="done"></i> Entered</span><span><i class="missing"></i> Not entered</span><span><i class="pending"></i> Upcoming</span><span><i class="holiday"></i> Holiday</span>
                </div>
            </section>

            <section class="tm-card">
                <div class="tm-day-head">
                    <button class="tm-icon-btn" onclick="TimetableModes.pickDay('${addDays(dailyDate, -1)}')" aria-label="Previous day"><i class="fa-solid fa-chevron-left"></i></button>
                    <div class="tm-day-title">
                        <strong>${fmt(dailyDate, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
                        <span class="tm-status ${saved ? 'ok' : ''}">${saved ? `<i class="fa-solid fa-circle-check"></i> Saved · ${saved.filter(Boolean).length} classes` : '<i class="fa-regular fa-circle"></i> Not entered — using usual timetable'}</span>
                    </div>
                    <button class="tm-icon-btn" onclick="TimetableModes.pickDay('${addDays(dailyDate, 1)}')" aria-label="Next day"><i class="fa-solid fa-chevron-right"></i></button>
                    <input type="date" class="tm-date-input" value="${dailyDate}" onchange="TimetableModes.pickDay(this.value)" aria-label="Pick a date">
                </div>
                ${notice}
                <div class="tm-periods">
                    ${rows || '<p class="tm-muted tm-center">No periods yet. Add them one by one, or start from your usual timetable.</p>'}
                </div>
                <div class="tm-period-tools">
                    <button class="tm-btn" onclick="TimetableModes.addPeriod()"><i class="fa-solid fa-plus"></i> Add period</button>
                    <button class="tm-btn" onclick="TimetableModes.copyUsual()"><i class="fa-regular fa-copy"></i> Copy usual timetable</button>
                </div>
                <div class="tm-day-actions">
                    ${saved ? '<button class="tm-btn tm-btn-danger" onclick="TimetableModes.clearDay()"><i class="fa-solid fa-rotate-left"></i> Use usual timetable</button>' : '<span></span>'}
                    <button class="tm-btn tm-btn-primary" onclick="TimetableModes.saveDay()"><i class="fa-solid fa-floppy-disk"></i> Save day</button>
                </div>
            </section>`;
    }

    // ============================================================
    // RENDER / ACTIONS
    // ============================================================
    // Mode editor (Profile → Class Management → Timetable Mode)
    const MODE_OPTIONS = [
        { mode: 'monthly', icon: 'fa-calendar-days', title: 'Changes every month', desc: "Reviewed monthly. A new timetable counts from the date it starts — earlier days keep the old one." },
        { mode: 'daily', icon: 'fa-sun', title: 'Changes every day', desc: "No fixed timetable. Enter each day's periods one by one before classes start." },
        { mode: 'fixed', icon: 'fa-lock', title: 'Fixed timetable', desc: 'One timetable for the whole semester. Edit it only if something changes.' }
    ];
    let editorPick = null;

    function renderEditor() {
        const modal = document.getElementById('tmModeModal');
        if (!modal) return;
        const name = className();
        const current = name ? classes[name].timetableMode : null;
        modal.innerHTML = `
            <div class="modal-content tm-mode-modal">
                <button class="modal-close" onclick="closeModal('tmModeModal')">&times;</button>
                <div class="tm-chooser-head">
                    <h2>Timetable Mode</h2>
                    <p>How does the timetable for <strong>${esc(name)}</strong> work?</p>
                </div>
                <div class="tm-choices" role="radiogroup">
                    ${MODE_OPTIONS.map(o => `
                    <button class="tm-choice ${editorPick === o.mode ? 'selected' : ''}" role="radio" aria-checked="${editorPick === o.mode}" onclick="TimetableModes.pick('${o.mode}')">
                        <span class="tm-choice-radio"></span>
                        <span class="tm-choice-icon"><i class="fa-solid ${o.icon}"></i></span>
                        <span class="tm-choice-text"><strong>${o.title}${current === o.mode ? ' <em class="tm-current">Current</em>' : ''}</strong><span>${o.desc}</span></span>
                    </button>`).join('')}
                </div>
                ${current && editorPick && editorPick !== current ? '<p class="tm-editor-note"><i class="fa-solid fa-circle-info"></i> Saved timetables and daily entries are kept. Only the new mode is used from now on.</p>' : ''}
                <button class="tm-btn tm-btn-primary tm-chooser-confirm" ${editorPick ? '' : 'disabled'} onclick="TimetableModes.saveEditor()">
                    <i class="fa-solid fa-check"></i> Save
                </button>
            </div>`;
    }

    function openModeEditor() {
        const name = className();
        if (!name) {
            if (typeof showToast === 'function') showToast('No class selected', 'Add a class first', { duration: 3000 });
            return;
        }
        let modal = document.getElementById('tmModeModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'tmModeModal';
            modal.className = 'modal';
            document.body.appendChild(modal);
        }
        editorPick = classes[name].timetableMode || null;
        renderEditor();
        openModal('tmModeModal');
    }

    function pick(mode) {
        editorPick = mode;
        renderEditor();
    }

    function saveEditor() {
        if (!editorPick) return;
        setMode(editorPick);
        closeModal('tmModeModal');
    }

    function render() {
        const content = document.getElementById('tmContent');
        if (!content) return;
        const name = className();
        const label = document.getElementById('tmClassLabel');

        if (!name) {
            if (label) label.textContent = 'No class selected';
            content.innerHTML = `<section class="tm-card tm-empty"><i class="fa-solid fa-graduation-cap"></i><p>Select or add a class to set up its timetable.</p></section>`;
            return;
        }

        const chosen = classes[name].timetableMode;
        if (!chosen) {
            if (label) label.textContent = name;
            content.innerHTML = `
                <section class="tm-card tm-empty">
                    <i class="fa-solid fa-calendar-week"></i>
                    <p><strong>Timetable mode not set</strong><br>Choose whether your timetable changes monthly, daily or stays fixed.</p>
                    <button class="tm-btn tm-btn-primary" onclick="TimetableModes.openModeEditor()"><i class="fa-solid fa-sliders"></i> Choose mode</button>
                </section>`;
            return;
        }

        if (label) {
            label.innerHTML = `${esc(name)} <span class="tm-mode-badge"><i class="fa-solid ${chosen === 'monthly' ? 'fa-calendar-days' : chosen === 'daily' ? 'fa-sun' : 'fa-lock'}"></i> ${MODE_LABELS[chosen]}</span>`;
        }
        content.innerHTML = chosen === 'monthly' ? renderMonthly() : chosen === 'daily' ? renderDaily() : renderFixed();
    }

    function setMode(mode) {
        const name = className();
        if (!name || !MODE_LABELS[mode]) return;
        if (classes[name].timetableMode !== mode) {
            const changes = { timetableMode: mode };
            // Start the monthly clock from today when switching to monthly
            if (mode === 'monthly') changes.timetableReviewedAt = today();
            ttUpdateClass(name, changes);
            if (typeof ttUpdateMenuDesc === 'function') ttUpdateMenuDesc();
            if (typeof renderTimetableModeBanner === 'function') renderTimetableModeBanner();
            if (typeof showToast === 'function') showToast('Timetable mode', MODE_LABELS[mode], { duration: 2000 });
        }
        monthlyViewIdx = null;
        dailyDraft = null;
        render();
    }

    function open(mode) {
        if (typeof switchPage === 'function') switchPage('timetablePage');
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function editTimetable() {
        // Class editor: when the timetable changes, it asks from which date it applies
        if (typeof editSelectedClass === 'function') editSelectedClass();
    }

    function noChanges() {
        const name = className();
        if (name) markTimetableReviewed(name);
        if (typeof showToast === 'function') showToast('Timetable checked', `Next check in one month`, { duration: 2500 });
        render();
    }

    function viewVersion(i) {
        monthlyViewIdx = i;
        render();
    }

    // Daily actions
    function pickDay(dateStr) {
        if (!dateStr) return;
        dailyDate = dateStr;
        dailyDraft = null;
        render();
    }

    function setPeriod(i, code) {
        if (!dailyDraft) return;
        dailyDraft[i] = code || null;
        render();
    }

    function addPeriod() {
        if (!dailyDraft) dailyDraft = [];
        dailyDraft.push(null);
        render();
    }

    function removePeriod(i) {
        if (!dailyDraft) return;
        dailyDraft.splice(i, 1);
        render();
    }

    function copyUsual() {
        dailyDraft = usualPeriodsFor(dailyDate);
        if (!dailyDraft.length && typeof showToast === 'function') showToast('No usual timetable for this day', 'Add periods one by one', { duration: 2500 });
        render();
    }

    function saveDay() {
        const name = className();
        if (!name || !dailyDraft) return;
        // Trim trailing free periods
        const periods = dailyDraft.slice();
        while (periods.length && !periods[periods.length - 1]) periods.pop();

        const counts = {};
        periods.forEach(code => { if (code) counts[code] = (counts[code] || 0) + 1; });

        const key = `custom_schedules_${name}`;
        const all = JSON.parse(localStorage.getItem(key) || '{}');
        all[dailyDate] = { ...counts, _periods: periods };
        localStorage.setItem(key, JSON.stringify(all));

        dailyDraft = null;
        recalc();
        if (typeof showToast === 'function') showToast('Day saved', `${fmt(dailyDate)} · ${periods.filter(Boolean).length} classes`, { duration: 2500 });
        render();
    }

    function clearDay() {
        const name = className();
        if (!name) return;
        const key = `custom_schedules_${name}`;
        const all = JSON.parse(localStorage.getItem(key) || '{}');
        delete all[dailyDate];
        localStorage.setItem(key, JSON.stringify(all));
        dailyDraft = null;
        recalc();
        render();
    }

    // Re-render after any class save (e.g. timetable edited in the class editor)
    if (typeof window.saveToStorage === 'function') {
        const originalSave = window.saveToStorage;
        window.saveToStorage = function () {
            const result = originalSave.apply(this, arguments);
            if (document.getElementById('timetablePage')?.classList.contains('active')) setTimeout(render, 50);
            return result;
        };
    }

    window.TimetableModes = {
        render, setMode, open, editTimetable, noChanges, viewVersion, openModeEditor, pick, saveEditor,
        pickDay, setPeriod, addPeriod, removePeriod, copyUsual, saveDay, clearDay
    };
    window.openTimetablePage = open;
})();
