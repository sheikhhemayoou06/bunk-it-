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
    // ---------- Class timings ----------
    function periodTimesFor() {
        const name = className();
        return (name && typeof getPeriodTimes === 'function' && getPeriodTimes(name)) || {};
    }

    function periodCount() {
        const name = className();
        const week = weeklyArrangement(getTimetableArrangement(name, today()));
        let max = 0;
        for (let d = 0; d < 7; d++) max = Math.max(max, (week[d] || []).length);
        const times = periodTimesFor();
        Object.keys(times).forEach(k => { if (/^\d+$/.test(k) && times[k] && (times[k].start || times[k].end)) max = Math.max(max, +k + 1); });
        return Math.max(max, 1);
    }

    // Lunch break being edited ({ after: period number, start, end }) or null
    let lunchDraft;
    let lunchDraftClass = null;
    let extraPeriods = 0;   // rows added with "Add period" (not saved yet)

    function timeRow(i, t) {
        return `
                <div class="tm-time-row">
                    <span class="tm-time-p">P${i + 1}</span>
                    <input type="time" id="tmStart_${i}" value="${esc(t.start || '')}" aria-label="Period ${i + 1} start">
                    <span class="tm-time-sep">–</span>
                    <input type="time" id="tmEnd_${i}" value="${esc(t.end || '')}" aria-label="Period ${i + 1} end">
                </div>`;
    }

    function lunchRow(n, l) {
        return `
                <div class="tm-lunch-row">
                    <span class="tm-lunch-label"><i class="fa-solid fa-utensils"></i> Lunch</span>
                    <label class="tm-lunch-after">after
                        <select id="tmLunchAfter" onchange="TimetableModes.moveLunch(${n})">${Array.from({ length: n }, (_, k) => k + 1).map(k => `<option value="${k}" ${k === l.after ? 'selected' : ''}>P${k}</option>`).join('')}</select>
                    </label>
                    <input type="time" id="tmLunchStart" value="${esc(l.start || '')}" aria-label="Lunch start">
                    <span class="tm-time-sep">–</span>
                    <input type="time" id="tmLunchEnd" value="${esc(l.end || '')}" aria-label="Lunch end">
                    <button type="button" class="tm-lunch-x" onclick="TimetableModes.removeLunch(${n})" aria-label="Remove lunch break"><i class="fa-solid fa-xmark"></i></button>
                </div>`;
    }

    function timingsCard() {
        const times = periodTimesFor();
        const set = Object.keys(times).filter(k => /^\d+$/.test(k) && times[k] && times[k].start && times[k].end).length;
        if (lunchDraft === undefined || lunchDraftClass !== className()) {
            lunchDraft = times.lunch && times.lunch.after ? { ...times.lunch } : null;
            lunchDraftClass = className();
            extraPeriods = 0;
        }
        const n = periodCount() + extraPeriods;
        if (lunchDraft && lunchDraft.after > n) lunchDraft.after = n;
        const lunch = lunchDraft;
        let rows = '';
        for (let i = 0; i < n; i++) {
            rows += timeRow(i, times[i] || {});
            if (lunch && lunch.after === i + 1) rows += lunchRow(n, lunch);
        }
        return `
            <section class="tm-card" id="tmTimingsCard">
                <div class="tm-card-head">
                    <div>
                        <h2><i class="fa-regular fa-clock"></i> Class timings</h2>
                        <p>${set ? `${set} of ${n} periods have times.` : 'Type your own start and end time for each period, any way your college runs it.'} After each class ends you'll get a reminder to mark it, and it leaves Home's timetable.</p>
                    </div>
                </div>
                <div class="tm-times">${rows}</div>
                <div class="tm-time-extra">
                    <button type="button" class="tm-btn" onclick="TimetableModes.addTimeRow(${n})"><i class="fa-solid fa-plus"></i> Add period</button>
                    ${n > 1 ? `<button type="button" class="tm-btn" onclick="TimetableModes.removeTimeRow(${n})"><i class="fa-solid fa-minus"></i> Remove last</button>` : ''}
                    ${!lunch ? `<button type="button" class="tm-btn" onclick="TimetableModes.addLunch(${n})"><i class="fa-solid fa-utensils"></i> Add lunch break</button>` : ''}
                </div>
                <details class="tm-quickfill">
                    <summary>Quick fill (optional)</summary>
                    <div class="tm-autofill">
                        <label><span>First class</span><input type="time" id="tmAfStart" value="${esc((times[0] && times[0].start) || '')}"></label>
                        <label><span>Class length</span><select id="tmAfLen">${[40, 45, 50, 55, 60, 90].map(m => `<option value="${m}" ${m === 50 ? 'selected' : ''}>${m} min</option>`).join('')}</select></label>
                        <label><span>Gap</span><select id="tmAfGap">${[0, 5, 10, 15].map(m => `<option value="${m}" ${m === 0 ? 'selected' : ''}>${m} min</option>`).join('')}</select></label>
                        <button class="tm-btn" onclick="TimetableModes.autofillTimes(${n})"><i class="fa-solid fa-wand-magic-sparkles"></i> Fill</button>
                    </div>
                </details>
                <p class="tm-time-msg" id="tmTimeMsg" role="status"></p>
                <div class="tm-day-actions">
                    <button class="tm-btn" onclick="TimetableModes.clearTimes()"><i class="fa-solid fa-rotate-left"></i> Clear</button>
                    <button class="tm-btn tm-btn-primary" onclick="TimetableModes.saveTimes(${n})"><i class="fa-solid fa-floppy-disk"></i> Save timings</button>
                </div>
            </section>`;
    }

    const hm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    const mins = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t.split(':').map(Number).reduce((h, m) => h * 60 + m) : null);

    // Times typed so far, so redrawing the card (lunch added / moved) keeps them
    function readTyped(n) {
        const out = {};
        for (let i = 0; i < n; i++) {
            const a = document.getElementById(`tmStart_${i}`)?.value || '';
            const b = document.getElementById(`tmEnd_${i}`)?.value || '';
            if (a || b) out[i] = { start: a, end: b };
        }
        if (lunchDraft && document.getElementById('tmLunchStart')) {
            lunchDraft.start = document.getElementById('tmLunchStart').value;
            lunchDraft.end = document.getElementById('tmLunchEnd').value;
        }
        return out;
    }

    function redrawTimings(n) {
        const typed = readTyped(n);
        const card = document.getElementById('tmTimingsCard');
        if (!card) return;
        card.outerHTML = timingsCard();
        Object.keys(typed).forEach(i => {
            const a = document.getElementById(`tmStart_${i}`), b = document.getElementById(`tmEnd_${i}`);
            if (a) a.value = typed[i].start;
            if (b) b.value = typed[i].end;
        });
    }

    function addTimingPeriod(n) {
        readTyped(n);
        extraPeriods++;
        redrawTimings(n);
        document.getElementById(`tmStart_${n}`)?.focus();
    }

    // Drops the last row and its saved time
    function removeTimingPeriod(n) {
        readTyped(n);
        const name = className();
        const times = periodTimesFor();
        if (name && times[n - 1]) { delete times[n - 1]; if (typeof savePeriodTimes === 'function') savePeriodTimes(name, times); }
        // Exactly one row fewer, even when rows above it have no times yet
        extraPeriods = Math.max(0, (n - 1) - periodCount());
        if (lunchDraft && lunchDraft.after > n - 1) lunchDraft.after = Math.max(1, n - 1);
        const card = document.getElementById('tmTimingsCard');
        const typed = {};
        for (let i = 0; i < n - 1; i++) {
            const a = document.getElementById(`tmStart_${i}`)?.value || '', b = document.getElementById(`tmEnd_${i}`)?.value || '';
            if (a || b) typed[i] = { start: a, end: b };
        }
        if (!card) return;
        card.outerHTML = timingsCard();
        Object.keys(typed).forEach(i => {
            const a = document.getElementById(`tmStart_${i}`), b = document.getElementById(`tmEnd_${i}`);
            if (a) a.value = typed[i].start;
            if (b) b.value = typed[i].end;
        });
    }

    function addLunch(n) {
        // Default position: after the middle period, times typed by the student
        const after = Math.max(1, Math.ceil(n / 2));
        const prevEnd = document.getElementById(`tmEnd_${after - 1}`)?.value || '';
        const nextStart = document.getElementById(`tmStart_${after}`)?.value || '';
        lunchDraft = { after, start: prevEnd, end: nextStart && nextStart > prevEnd ? nextStart : '' };
        redrawTimings(n);
        document.getElementById('tmLunchStart')?.focus();
    }

    function moveLunch(n) {
        readTyped(n);
        if (lunchDraft) lunchDraft.after = +document.getElementById('tmLunchAfter').value || 1;
        redrawTimings(n);
    }

    function removeLunch(n) {
        readTyped(n);
        lunchDraft = null;
        redrawTimings(n);
    }

    function autofillTimes(n) {
        const start = mins(document.getElementById('tmAfStart')?.value);
        const len = +document.getElementById('tmAfLen')?.value || 50;
        const gap = +document.getElementById('tmAfGap')?.value || 0;
        const msg = document.getElementById('tmTimeMsg');
        if (start === null) { if (msg) { msg.textContent = 'Enter the first class time to quick fill.'; msg.className = 'tm-time-msg err'; } return; }
        readTyped(n);
        const lunchLen = lunchDraft && mins(lunchDraft.start) !== null && mins(lunchDraft.end) !== null ? mins(lunchDraft.end) - mins(lunchDraft.start) : 0;
        let t = start;
        for (let i = 0; i < n; i++) {
            const a = document.getElementById(`tmStart_${i}`), b = document.getElementById(`tmEnd_${i}`);
            if (a) a.value = hm(t);
            if (b) b.value = hm(t + len);
            t += len + gap;
            if (lunchDraft && lunchDraft.after === i + 1) {
                const ls = document.getElementById('tmLunchStart'), le = document.getElementById('tmLunchEnd');
                const l = lunchLen > 0 ? lunchLen : 45;
                if (ls) ls.value = hm(t - gap);
                if (le) le.value = hm(t - gap + l);
                t += l - gap;
            }
        }
        if (msg) { msg.textContent = 'Filled in. Change any time you need, then Save.'; msg.className = 'tm-time-msg'; }
    }

    // Saves exactly what the student typed: no order, overlap or length rules
    function saveTimes(n) {
        const name = className();
        if (!name) return;
        const out = {};
        for (let i = 0; i < n; i++) {
            const a = document.getElementById(`tmStart_${i}`)?.value || '';
            const b = document.getElementById(`tmEnd_${i}`)?.value || '';
            if (a || b) out[i] = { start: a, end: b };
        }
        if (lunchDraft && document.getElementById('tmLunchStart')) {
            const ls = document.getElementById('tmLunchStart').value, le = document.getElementById('tmLunchEnd').value;
            const after = +document.getElementById('tmLunchAfter').value || lunchDraft.after;
            if (ls || le) out.lunch = { after, start: ls, end: le };
        }
        lunchDraft = out.lunch ? { ...out.lunch } : null;
        if (typeof savePeriodTimes === 'function') savePeriodTimes(name, out);
        extraPeriods = Math.max(0, n - periodCount());
        if (typeof renderTodayTimetable === 'function') { try { renderTodayTimetable(); } catch (e) { /* ignore */ } }
        if (window.ClassReminders) ClassReminders.tick();
        const count = Object.keys(out).filter(k => k !== 'lunch').length;
        if (typeof showToast === 'function') showToast('Class timings saved', `${count} period${count !== 1 ? 's' : ''}${out.lunch ? ' + lunch' : ''}`, { duration: 2500 });
        if (typeof closeModal === 'function') closeModal('tmTimingsModal');
        render();
    }

    function clearTimes() {
        const name = className();
        if (!name || !confirm('Clear all class timings?')) return;
        lunchDraft = null;
        extraPeriods = 0;
        if (typeof savePeriodTimes === 'function') savePeriodTimes(name, {});
        const card = document.getElementById('tmTimingsCard');
        if (card) card.outerHTML = timingsCard();
        render();
    }

    // ---------- ⋮ menu (Timetable page header, Home timetable card) ----------
    function openMenu(btn) {
        let menu = document.getElementById('tmMoreMenu');
        if (menu && menu.classList.contains('open')) { closeMenu(); return; }
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'tmMoreMenu';
            menu.className = 'tm-more-menu';
            menu.setAttribute('role', 'menu');
            document.body.appendChild(menu);
            document.addEventListener('click', e => {
                if (menu.classList.contains('open') && !menu.contains(e.target) && !e.target.closest('.tm-more')) closeMenu();
            });
            document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
            window.addEventListener('resize', closeMenu);
        }
        const item = (icon, title, sub, action) => `<button type="button" role="menuitem" onclick="TimetableModes.menuAction('${action}')"><span class="tm-mm-ic">${icon}</span><span><strong>${title}</strong><small>${sub}</small></span></button>`;
        const mode = cls()?.timetableMode;
        menu.innerHTML = `
            ${mode === 'daily'
                ? item('<i class="fa-solid fa-pen"></i>', 'Edit this day', 'Periods for the selected date', 'editDay')
                : item('<i class="fa-solid fa-pen"></i>', 'Edit timetable', 'Change subjects and periods', 'edit')}
            ${mode === 'monthly' ? item('<i class="fa-solid fa-circle-check"></i>', 'No changes this month', 'Monthly timetable check', 'noChanges') : ''}
            ${item('<i class="fa-solid fa-arrows-rotate"></i>', 'New timetable', 'Changed from a date onwards', 'new')}
            ${item('<i class="fa-solid fa-clock-rotate-left"></i>', 'Old timetable', 'Used on earlier dates', 'old')}
            ${item('<i class="fa-solid fa-clock"></i>', 'Timetable timings', 'Your class times and lunch break', 'timings')}
            ${item('<i class="fa-solid fa-sliders"></i>', 'Timetable mode', 'Fixed, monthly or daily', 'mode')}`;
        const r = btn.getBoundingClientRect();
        menu.style.top = `${r.bottom + window.scrollY + 6}px`;
        menu.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
        menu.classList.add('open');
    }

    function closeMenu() {
        document.getElementById('tmMoreMenu')?.classList.remove('open');
    }

    function menuAction(action) {
        closeMenu();
        if (!className()) { alert('Please select or add a class first.'); return; }
        if (action === 'new' || action === 'old') { if (typeof openTimetableChange === 'function') openTimetableChange(action); return; }
        if (action === 'timings') return openTimingsModal();
        if (action === 'mode') return openModeEditor();
        if (action === 'edit') return editTimetable();
        if (action === 'noChanges') return noChanges();
        if (action === 'editDay') {
            if (!document.getElementById('timetablePage')?.classList.contains('active')) { viewDate = today(); open(); }
            return openDayEditor();
        }
    }

    function focusTimings() {
        openTimingsModal();
    }

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
            const pt = periodTimesFor()[p];
            body += `<tr><td class="tm-pnum">${p + 1}${pt && pt.start ? `<small class="tm-ptime">${pt.start}</small>` : ''}</td>` + days.map(d => {
                const code = week[d][p];
                if (!code) return '<td><span class="tm-free">—</span></td>';
                const color = subjectColor(code);
                return `<td><span class="tm-chip" style="--chip:${color}" title="${esc(code)}">${esc(subjectName(code))}</span></td>`;
            }).join('') + '</tr>';
            const lunch = periodTimesFor().lunch;
            if (lunch && lunch.after === p + 1) {
                body += `<tr class="tm-lunch-grid"><td class="tm-pnum"><i class="fa-solid fa-utensils"></i></td><td colspan="${days.length}">Lunch${lunch.start || lunch.end ? ` · ${esc(lunch.start || '?')} – ${esc(lunch.end || '?')}` : ''}</td></tr>`;
            }
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
                        <span class="tm-change-icon"><i class="fa-solid fa-clock-rotate-left"></i></span>
                        <span><strong>Add my old timetable</strong><small>It was different at the start. Example: 20 Jul → 18 Aug</small></span>
                    </button>
                    <button class="tm-change-btn" onclick="openTimetableChange('new')">
                        <span class="tm-change-icon"><i class="fa-solid fa-arrows-rotate"></i></span>
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
    // TIMETABLE VIEW (the whole page): week tabs + day list / week grid
    // ============================================================
    let viewDate = null;      // selected date
    let viewMode = 'day';     // 'day' | 'week'

    const to12 = (t) => {
        const m = mins(t);
        if (m === null) return null;
        const h = Math.floor(m / 60) % 24;
        return { t: `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`, ap: h < 12 ? 'AM' : 'PM' };
    };

    function weekStart(dateStr) { return addDays(dateStr, -dayIndexOf(dateStr)); }

    function slotsFor(dateStr) {
        const name = className();
        if (typeof getDaySlots !== 'function') return [];
        const slots = getDaySlots(name, dateStr);
        while (slots.length && !slots[slots.length - 1]) slots.pop();
        return slots;
    }

    function renderView() {
        const name = className();
        const c = cls();
        const t = today();
        if (!viewDate) viewDate = t;
        const ws = weekStart(viewDate);
        const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
        const counts = days.map(d => slotsFor(d).filter(Boolean).length);
        const shownDays = days.filter((d, i) => i < 6 || counts[i] > 0 || d === viewDate);
        const weekLabel = `${fmt(ws, { day: 'numeric', month: 'short' })} – ${fmt(addDays(ws, 6), { day: 'numeric', month: 'short' })}`;

        const tabs = shownDays.map(d => {
            const n = counts[days.indexOf(d)];
            const hol = (c.holidays || []).includes(d);
            return `<button class="tv-tab ${d === viewDate ? 'active' : ''} ${d === t ? 'today' : ''}" onclick="TimetableModes.viewDay('${d}')">
                <span>${parseLocalDate(d).toLocaleDateString('en-IN', { weekday: 'short' })}</span>
                <strong>${parseLocalDate(d).getDate()}</strong>
                <i class="${hol ? 'hol' : n ? 'has' : ''}"></i>
            </button>`;
        }).join('');

        return `
            <div class="tv">
                <div class="tv-bar">
                    <div class="tv-week">
                        <button class="tv-nav" onclick="TimetableModes.viewDay('${addDays(ws, -7)}')" aria-label="Previous week"><i class="fa-solid fa-chevron-left"></i></button>
                        <span>${weekLabel}</span>
                        <button class="tv-nav" onclick="TimetableModes.viewDay('${addDays(ws, 7)}')" aria-label="Next week"><i class="fa-solid fa-chevron-right"></i></button>
                    </div>
                    <div class="tv-seg" role="tablist">
                        <button class="${viewMode === 'day' ? 'on' : ''}" onclick="TimetableModes.setView('day')">Day</button>
                        <button class="${viewMode === 'week' ? 'on' : ''}" onclick="TimetableModes.setView('week')">Week</button>
                    </div>
                </div>
                ${viewMode === 'day' ? `<div class="tv-tabs">${tabs}</div>${renderDayList(viewDate)}` : `<div class="tv-weekgrid">${renderWeekGrid(getTimetableArrangement(name, viewDate))}</div>`}
                ${viewDate !== t ? `<button class="tv-today" onclick="TimetableModes.viewDay('${t}')"><i class="fa-regular fa-calendar"></i> Today</button>` : ''}
            </div>`;
    }

    function renderDayList(dateStr) {
        const c = cls();
        const t = today();
        const times = periodTimesFor();
        const head = `<div class="tv-dayhead"><strong>${fmt(dateStr, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>${dateStr === t ? '<em>Today</em>' : ''}</div>`;
        if ((c.holidays || []).includes(dateStr)) {
            return head + `<div class="tv-empty"><span></span><strong>Holiday</strong><small>No classes are counted on this day.</small></div>`;
        }
        const slots = slotsFor(dateStr);
        if (!slots.some(Boolean)) {
            return head + `<div class="tv-empty"><span></span><strong>No classes</strong><small>Nothing scheduled for this day.</small></div>`;
        }
        const now = new Date();
        const nowMin = dateStr === t ? now.getHours() * 60 + now.getMinutes() : null;
        let nextMarked = false;
        const lunch = times.lunch && times.lunch.after ? times.lunch : null;
        let html = '';
        slots.forEach((sl, i) => {
            const pt = times[i] || {};
            const st = to12(pt.start), en = to12(pt.end);
            const sM = mins(pt.start), eM = mins(pt.end);
            let state = '';
            if (nowMin !== null && sM !== null && eM !== null) {
                if (nowMin >= sM && nowMin < eM) state = 'now';
                else if (nowMin >= eM) state = 'done';
                else if (!nextMarked && sl) { state = 'next'; nextMarked = true; }
            }
            const timeCol = `<div class="tv-time">${st ? `<b>${st.t}</b><small>${st.ap}</small>` : `<b>P${i + 1}</b>`}</div>`;
            if (!sl) {
                html += `<div class="tv-row free">${timeCol}<div class="tv-card"><span class="tv-p">P${i + 1}</span><strong>Free period</strong>${st && en ? `<small>${st.t} ${st.ap} – ${en.t} ${en.ap}</small>` : ''}</div></div>`;
            } else {
                const sub = c.subjects.find(x => x.code === sl.code) || {};
                html += `<div class="tv-row ${state}" style="--c:${subjectColor(sl.code)}">${timeCol}
                    <div class="tv-card">
                        <span class="tv-p">P${i + 1}</span>
                        <strong>${esc(sub.name || sl.code)}</strong>
                        <small>${st && en ? `${st.t} ${st.ap} – ${en.t} ${en.ap} · ` : ''}${esc(sl.code)}${sub.classroom ? ` · Room ${esc(sub.classroom)}` : ''}</small>
                        ${state === 'now' ? '<em class="tv-badge now">● Now</em>' : state === 'next' ? '<em class="tv-badge">Next</em>' : ''}
                    </div></div>`;
            }
            if (lunch && lunch.after === i + 1) {
                const ls = to12(lunch.start), le = to12(lunch.end);
                const live = nowMin !== null && mins(lunch.start) !== null && mins(lunch.end) !== null && nowMin >= mins(lunch.start) && nowMin < mins(lunch.end);
                html += `<div class="tv-row lunch ${live ? 'now' : ''}"><div class="tv-time">${ls ? `<b>${ls.t}</b><small>${ls.ap}</small>` : ''}</div>
                    <div class="tv-card"><strong>Lunch break</strong>${ls && le ? `<small>${ls.t} ${ls.ap} – ${le.t} ${le.ap}</small>` : ''}${live ? '<em class="tv-badge now">● Now</em>' : ''}</div></div>`;
            }
        });
        const n = slots.filter(Boolean).length;
        return head + `<div class="tv-list">${html}</div>
            <p class="tv-foot">${n} class${n !== 1 ? 'es' : ''}${Object.keys(times).some(k => /^\d+$/.test(k)) ? '' : ' · <button class="tv-link" onclick="TimetableModes.menuAction(\'timings\')">Add class timings</button>'}</p>`;
    }

    function viewDay(d) { viewDate = d; if (cls()?.timetableMode === 'daily') { dailyDate = d; dailyDraft = null; } render(); }
    function setView(m) { viewMode = m; render(); }

    // ---------- pop-ups: class timings, day editor (daily mode) ----------
    function modalShell(id) {
        let m = document.getElementById(id);
        if (!m) { m = document.createElement('div'); m.id = id; m.className = 'modal'; document.body.appendChild(m); }
        return m;
    }

    function openTimingsModal() {
        if (!className()) return;
        lunchDraft = undefined;
        const m = modalShell('tmTimingsModal');
        m.innerHTML = `<div class="modal-content tm-pop"><button class="modal-close" onclick="closeModal('tmTimingsModal')">&times;</button>${timingsCard()}</div>`;
        if (typeof openModal === 'function') openModal('tmTimingsModal'); else m.classList.add('active');
    }

    function openDayEditor() {
        if (!className()) return;
        dailyDate = viewDate || today();
        dailyDraft = null;
        modalShell('tmDayModal');
        renderDayModal();
        if (typeof openModal === 'function') openModal('tmDayModal'); else document.getElementById('tmDayModal').classList.add('active');
    }

    function renderDayModal() {
        const m = document.getElementById('tmDayModal');
        if (!m) return;
        if (!dailyDate) dailyDate = today();
        if (!dailyDraft) dailyDraft = dailyEntry(dailyDate) || [];
        const html = renderDaily();
        // Only the day editor (second card) goes in the pop-up
        const i = html.lastIndexOf('<section class="tm-card">');
        m.innerHTML = `<div class="modal-content tm-pop"><button class="modal-close" onclick="closeModal('tmDayModal')">&times;</button>${html.slice(i)}</div>`;
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
        if (label) {
            label.innerHTML = `${esc(name)}${chosen ? ` <span class="tm-mode-badge"><i class="fa-solid ${chosen === 'monthly' ? 'fa-calendar-days' : chosen === 'daily' ? 'fa-sun' : 'fa-lock'}"></i> ${MODE_LABELS[chosen]}</span>` : ''}`;
        }
        content.innerHTML = renderView();
        // Pop-ups that are open follow the latest data
        if (document.getElementById('tmTimingsModal')?.classList.contains('active') && !document.getElementById('tmTimingsCard')) openTimingsModal();
        if (document.getElementById('tmDayModal')?.classList.contains('active')) renderDayModal();
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
        lunchDraft = undefined;
        viewDate = today();
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
        viewDate = dateStr;
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
        autofillTimes, saveTimes, clearTimes, focusTimings, addLunch, moveLunch, removeLunch,
        addTimeRow: addTimingPeriod, removeTimeRow: removeTimingPeriod,
        openMenu, menuAction, viewDay, setView, openTimingsModal, openDayEditor,
        render, setMode, open, editTimetable, noChanges, viewVersion, openModeEditor, pick, saveEditor,
        pickDay, setPeriod, addPeriod, removePeriod, copyUsual, saveDay, clearDay
    };
    window.openTimetablePage = open;
})();
