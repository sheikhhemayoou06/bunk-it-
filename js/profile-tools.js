// ============================================================
// PROFILE TOOLS: OD / Medical leave for a date range, Exam days
// ============================================================
// 1. Mark OD or ML: every scheduled class between two dates (all subjects or
//    chosen ones) is marked "Duty Leave (OD)" / "Medical Leave (ML)". The
//    previous marks are kept with the record so it can be undone exactly.
//    Future dates are fine: they count once the day arrives.
// 2. Exam days: saved on the class (class.examDays). Leave planning, Smart
//    Search and notifications treat them as compulsory attendance.
// Uses globals: classes, selectedClass, saveToStorage, openModal, closeModal,
// formatLocalDate, parseLocalDate, showToast, DayCheck.
// ============================================================

(function () {
    'use strict';

    const TYPES = {
        od: { status: 'Duty Leave (OD)', label: 'OD (Duty Leave)', icon: '📋' },
        ml: { status: 'Medical Leave (ML)', label: 'Medical Leave', icon: '🏥' }
    };

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

    function fmt(dateStr) {
        return parseLocalDate(dateStr).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    }

    function range(from, to) {
        const out = [];
        if (!from || !to || to < from) return out;
        for (let d = from; d <= to && out.length <= 200; d = addDays(d, 1)) out.push(d);
        return out;
    }

    function getLogs() {
        try { return JSON.parse(localStorage.getItem('attendance_logs') || '{}') || {}; } catch (e) { return {}; }
    }

    function saveLogs(logs, dates) {
        localStorage.setItem('attendance_logs', JSON.stringify(logs));
        try {
            const stamps = JSON.parse(localStorage.getItem('attendance_log_timestamps') || '{}');
            const now = new Date().toISOString();
            dates.forEach(d => { stamps[d] = now; });
            localStorage.setItem('attendance_log_timestamps', JSON.stringify(stamps));
        } catch (e) { /* ignore */ }
        if (window.SyncManager) { try { SyncManager.uploadAll(); } catch (e) { /* offline */ } }
    }

    // Save a change on the stored class and the working copy
    function updateClass(mutator) {
        const name = className();
        if (!name) return;
        mutator(classes[name]);
        if (typeof selectedClass !== 'undefined' && selectedClass && selectedClass !== classes[name]) mutator(selectedClass);
        if (typeof saveToStorage === 'function') saveToStorage();
    }

    function ensureModal() {
        let modal = document.getElementById('ptModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'ptModal';
            modal.className = 'modal';
            document.body.appendChild(modal);
        }
        return modal;
    }

    // ============================================================
    // 1. OD / MEDICAL LEAVE FOR A DATE RANGE
    // ============================================================
    let leaveType = 'od';

    // Classes to mark: [{ date, key }] for chosen subjects
    function plannedMarks(from, to, codes) {
        const name = className();
        if (!name || !window.DayCheck) return [];
        const marks = [];
        range(from, to).forEach(date => {
            DayCheck.periodKeysFor(name, date).forEach(key => {
                if (codes.includes(key.split('_p')[0])) marks.push({ date, key });
            });
        });
        return marks;
    }

    function chosenCodes() {
        return Array.from(document.querySelectorAll('#ptSubjects input:checked')).map(i => i.value);
    }

    function openLeave(prefill = {}) {
        const name = className();
        if (!name) { alert('Please add or select a class first.'); return; }
        const cls = classes[name];
        if (prefill.type) leaveType = prefill.type;
        const from = prefill.from || today();
        const to = prefill.to || from;

        const modal = ensureModal();
        modal.innerHTML = `
            <div class="modal-content pt-modal">
                <button class="modal-close" onclick="closeModal('ptModal')">&times;</button>
                <div class="pt-icon">${TYPES[leaveType].icon}</div>
                <h2>Mark OD / Medical leave</h2>
                <p class="pt-lead">Marks every class in these dates at once. Future dates count when the day comes.</p>

                <div class="pt-seg" role="radiogroup">
                    ${Object.keys(TYPES).map(t => `
                        <button class="${leaveType === t ? 'active' : ''}" role="radio" aria-checked="${leaveType === t}" onclick="ProfileTools.setType('${t}')">${TYPES[t].icon} ${TYPES[t].label}</button>`).join('')}
                </div>

                <div class="pt-dates">
                    <label><span>From</span><input type="date" id="ptFrom" value="${from}"></label>
                    <label><span>To</span><input type="date" id="ptTo" value="${to}"></label>
                </div>

                <div class="pt-field-label">Subjects <button class="pt-link" onclick="ProfileTools.toggleAll()">Select all / none</button></div>
                <div class="pt-subjects" id="ptSubjects">
                    ${cls.subjects.map(s => `
                        <label class="pt-check"><input type="checkbox" value="${esc(s.code)}" ${!prefill.codes || prefill.codes.includes(s.code) ? 'checked' : ''}><span>${esc(s.name)}</span></label>`).join('')}
                </div>

                <div class="pt-preview" id="ptPreview"></div>

                <div class="form-actions" style="justify-content: space-between;">
                    <button class="btn secondary-btn" onclick="closeModal('ptModal')">Cancel</button>
                    <button class="btn primary-btn" onclick="ProfileTools.saveLeave()">Save</button>
                </div>
                ${leaveHistoryHtml()}
            </div>`;
        modal.querySelectorAll('input').forEach(i => i.addEventListener('change', updateLeavePreview));
        updateLeavePreview();
        if (!modal.classList.contains('active')) openModal('ptModal');
    }

    function updateLeavePreview() {
        const el = document.getElementById('ptPreview');
        if (!el) return;
        const from = document.getElementById('ptFrom').value;
        const to = document.getElementById('ptTo').value;
        if (!from || !to || to < from) { el.innerHTML = '<span class="pt-warn">Pick a valid range: "To" must be on or after "From".</span>'; return; }
        const codes = chosenCodes();
        if (!codes.length) { el.innerHTML = '<span class="pt-warn">Choose at least one subject.</span>'; return; }

        const marks = plannedMarks(from, to, codes);
        const days = new Set(marks.map(m => m.date));
        const logs = getLogs();
        const changed = marks.filter(m => {
            const prev = logs[m.date]?.[m.key] || logs[m.date]?.[m.key.split('_p')[0]];
            return prev && prev !== TYPES[leaveType].status;
        }).length;
        const exams = typeof getExamOn === 'function' ? [...days].filter(d => getExamOn(d)) : [];

        el.innerHTML = marks.length
            ? `<div><strong>${marks.length}</strong> class${marks.length !== 1 ? 'es' : ''} on <strong>${days.size}</strong> day${days.size !== 1 ? 's' : ''} will be marked <strong>${TYPES[leaveType].label}</strong>.</div>
               ${changed ? `<div class="pt-warn">${changed} of them are already marked and will be changed.</div>` : ''}
               ${exams.length ? `<div class="pt-warn">Includes exam day${exams.length > 1 ? 's' : ''}: ${exams.map(fmt).join(', ')}.</div>` : ''}
               ${impactHtml(marks, logs)}`
            : '<span>No classes in these dates (holidays, weekends or outside the semester).</span>';
    }

    // Effect of the marks on each subject's numbers right now, with the OD/ML limit.
    // Marks on future days count when the day comes; in portal mode, days up to the
    // baseline date are already inside the portal numbers.
    function impactHtml(marks, logs) {
        const name = className();
        const cls = classes[name];
        const status = TYPES[leaveType].status;
        const data = (typeof currentAnalysisData !== 'undefined' && currentAnalysisData.length) ? currentAnalysisData
            : (window.SmartSearch?.computeClassAttendance ? SmartSearch.computeClassAttendance() : []);
        if (!data.length || typeof cappedWithPct !== 'function') return '';

        const t = today();
        const baseline = cls.portalSetup?.active ? cls.portalSetup.baselineDate : null;
        const delta = {};
        let future = 0, insideBaseline = 0;
        const bucket = (s) => {
            const u = String(s || '').toUpperCase();
            if (u === 'ATTENDED' || u === 'PRESENT' || u === 'P') return 'p';
            if (u === 'SKIPPED' || u === 'ABSENT' || u === 'A') return 'a';
            if (u.includes('(OD)') || u.includes('(ML)') || u === 'OD' || u === 'ML') return 'o';
            return null; // not marked / cancelled
        };
        marks.forEach(({ date, key }) => {
            if (date > t) { future++; return; }
            if (baseline && date <= baseline) { insideBaseline++; return; }
            const code = key.split('_p')[0];
            const prev = bucket(logs[date]?.[key] || logs[date]?.[code]);
            const d = delta[code] = delta[code] || { held: 0, att: 0, odml: 0 };
            if (prev === 'o') return;                                   // already OD/ML
            if (prev === 'p') { d.odml++; return; }                     // present → OD/ML: same %
            if (prev === 'a') { d.att++; d.odml++; return; }            // absent → OD/ML
            d.held++; d.att++; d.odml++;                                // not marked → held + OD/ML
        });

        const rows = Object.keys(delta).map(code => {
            const sub = data.find(x => x.code === code);
            if (!sub) return '';
            const d = delta[code];
            const before = cappedWithPct(sub.attended, sub.totalHeld, sub.odml, sub.remaining);
            const after = attendanceSplit(sub.attended + d.att, sub.totalHeld + d.held, (Number(sub.odml) || 0) + d.odml, sub.remaining);
            let counts;
            if (after.allowance !== null) {
                counts = `${Math.min(after.odml, after.allowance)} of ${after.allowance} allowed hours`
                    + (after.odmlUnused ? `<br><span class="pt-warn">${after.odmlUnused} over the ${after.limitLabel}, won't count</span>` : '')
                    + (after.belowBand ? `<br><span class="pt-warn">Own attendance ${after.withoutPct.toFixed(1)}%, below ${after.ownMin}%</span>` : '');
            } else {
                counts = after.capped
                    ? `<span class="pt-warn">${after.odmlCounted} of ${after.odml} OD/ML hours count (${after.notApplied || after.limitLabel})</span>`
                    : `${after.odml} OD/ML hour${after.odml !== 1 ? 's' : ''}, all count`;
            }
            const name = cls.subjects.find(s => s.code === code)?.name || code;
            return `<tr><td>${esc(name)}</td><td>${before.toFixed(1)}% → <strong>${after.withPct.toFixed(1)}%</strong></td><td>${counts}</td></tr>`;
        }).join('');

        return `
            ${rows ? `<table class="pt-impact"><thead><tr><th>Subject</th><th>Now → after</th><th>OD/ML</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
            ${future ? `<div>${future} class${future !== 1 ? 'es are' : ' is'} on future days and will count when the day comes.</div>` : ''}
            ${insideBaseline ? `<div class="pt-muted">${insideBaseline} class${insideBaseline !== 1 ? 'es are' : ' is'} on or before your portal baseline date, already included in the portal numbers.</div>` : ''}
            <div class="pt-muted">${ruleSummary()}</div>`;
    }

    function saveLeave() {
        const from = document.getElementById('ptFrom').value;
        const to = document.getElementById('ptTo').value;
        const codes = chosenCodes();
        if (!from || !to || to < from) { alert('Please pick a valid date range.'); return; }
        if (!codes.length) { alert('Please choose at least one subject.'); return; }
        const marks = plannedMarks(from, to, codes);
        if (!marks.length) { alert('There are no classes in these dates.'); return; }

        const status = TYPES[leaveType].status;
        const logs = getLogs();
        const dates = [...new Set(marks.map(m => m.date))];
        const before = {};
        dates.forEach(d => { before[d] = logs[d] ? { ...logs[d] } : null; });

        marks.forEach(({ date, key }) => {
            const dayLog = logs[date] = logs[date] || {};
            delete dayLog[key.split('_p')[0]]; // old whole-day mark for that subject
            dayLog[key] = status;
        });
        saveLogs(logs, dates);

        const record = { id: 'lv' + Date.now(), type: leaveType, from, to, codes, classes: marks.length, before, savedAt: new Date().toISOString() };
        updateClass(c => { c.leaveRecords = (c.leaveRecords || []).concat(record).slice(-30); });

        closeModal('ptModal');
        if (typeof showToast === 'function') {
            showToast(`${TYPES[leaveType].icon} ${TYPES[leaveType].label} saved`, `${marks.length} class${marks.length !== 1 ? 'es' : ''}, ${fmt(from)}${to !== from ? ` → ${fmt(to)}` : ''}. Attendance updated.`, { duration: 5000 });
        }
        if (window.NotificationCenter) {
            NotificationCenter.log({ icon: TYPES[leaveType].icon, title: `${TYPES[leaveType].label} marked`, body: `${fmt(from)}${to !== from ? ` → ${fmt(to)}` : ''} · ${marks.length} classes` });
        }
    }

    function leaveHistoryHtml() {
        const name = className();
        const records = (classes[name]?.leaveRecords || []).slice().reverse().slice(0, 6);
        if (!records.length) return '';
        return `
            <div class="pt-recent">
                <div class="pt-recent-title">Recent OD / ML</div>
                ${records.map(r => `
                    <div class="pt-recent-row">
                        <span>${TYPES[r.type].icon} ${fmt(r.from)}${r.to !== r.from ? ` → ${fmt(r.to)}` : ''} · ${r.classes} classes</span>
                        <button onclick="ProfileTools.undoLeave('${r.id}')">Undo</button>
                    </div>`).join('')}
            </div>`;
    }

    function undoLeave(id) {
        const name = className();
        const record = (classes[name]?.leaveRecords || []).find(r => r.id === id);
        if (!record) return;
        const logs = getLogs();
        Object.keys(record.before).forEach(d => {
            if (record.before[d]) logs[d] = record.before[d]; else delete logs[d];
        });
        saveLogs(logs, Object.keys(record.before));
        updateClass(c => { c.leaveRecords = (c.leaveRecords || []).filter(r => r.id !== id); });
        if (typeof showToast === 'function') showToast('↩️ Undone', `${TYPES[record.type].label} ${fmt(record.from)}${record.to !== record.from ? ` → ${fmt(record.to)}` : ''} removed.`, { duration: 3500 });
        openLeave({ from: record.from, to: record.to });
    }

    // ============================================================
    // 2. EXAM DAYS (compulsory attendance)
    // ============================================================
    function openExams() {
        const name = className();
        if (!name) { alert('Please add or select a class first.'); return; }
        const exams = (classes[name].examDays || []).slice().sort((a, b) => a.from.localeCompare(b.from));
        const t = today();

        const modal = ensureModal();
        modal.innerHTML = `
            <div class="modal-content pt-modal">
                <button class="modal-close" onclick="closeModal('ptModal')">&times;</button>
                <div class="pt-icon">📝</div>
                <h2>Exam days</h2>
                <p class="pt-lead">Days you must attend. They're never suggested for leave, and you're warned if a planned leave includes one.</p>

                <div class="pt-exam-list">
                    ${exams.length ? exams.map(e => {
                        const past = (e.to || e.from) < t;
                        return `
                        <div class="pt-exam ${past ? 'past' : ''}">
                            <div>
                                <strong>${esc(e.title || 'Exam')}</strong>
                                <span>${fmt(e.from)}${e.to && e.to !== e.from ? ` → ${fmt(e.to)}` : ''}${past ? ' · done' : ''}</span>
                            </div>
                            <button class="pt-icon-btn" onclick="ProfileTools.removeExam('${e.id}')" aria-label="Remove ${esc(e.title || 'exam')}"><i class="fa-solid fa-trash-can"></i></button>
                        </div>`;
                    }).join('') : '<div class="pt-empty">No exam days yet.</div>'}
                </div>

                <div class="pt-field-label">Add exam days</div>
                <label class="pt-text"><span>Name</span><input type="text" id="ptExamTitle" maxlength="40" placeholder="e.g. Mid-term 1, Practical exam"></label>
                <div class="pt-dates">
                    <label><span>From</span><input type="date" id="ptExamFrom" value="${t}"></label>
                    <label><span>To (optional)</span><input type="date" id="ptExamTo" value=""></label>
                </div>

                <div class="form-actions" style="justify-content: space-between;">
                    <button class="btn secondary-btn" onclick="closeModal('ptModal')">Close</button>
                    <button class="btn primary-btn" onclick="ProfileTools.addExam()">Add exam days</button>
                </div>
            </div>`;
        if (!modal.classList.contains('active')) openModal('ptModal');
    }

    function addExam() {
        const title = document.getElementById('ptExamTitle').value.trim() || 'Exam';
        const from = document.getElementById('ptExamFrom').value;
        const to = document.getElementById('ptExamTo').value || from;
        if (!from) { alert('Please pick the exam date.'); return; }
        if (to < from) { alert('"To" must be on or after "From".'); return; }
        updateClass(c => {
            c.examDays = (c.examDays || []).concat({ id: 'ex' + Date.now(), title, from, to });
        });
        if (typeof showToast === 'function') showToast('📝 Exam days saved', `${title}: ${fmt(from)}${to !== from ? ` → ${fmt(to)}` : ''}`, { duration: 3000 });
        openExams();
    }

    function removeExam(id) {
        updateClass(c => { c.examDays = (c.examDays || []).filter(e => e.id !== id); });
        openExams();
    }

    // ============================================================
    // 3. MINIMUM ATTENDANCE REQUIRED
    // ============================================================
    const PRESETS = [60, 65, 70, 75, 80, 85];

    function currentMin() {
        return typeof getMinAttendanceCriteria === 'function' ? Math.round(getMinAttendanceCriteria() * 1000) / 10 : 75;
    }

    function openMinAttendance() {
        const value = currentMin();
        const modal = ensureModal();
        modal.innerHTML = `
            <div class="modal-content pt-modal">
                <button class="modal-close" onclick="closeModal('ptModal')">&times;</button>
                <div class="pt-icon">🎯</div>
                <h2>Minimum attendance required</h2>
                <p class="pt-lead">The percentage your college requires. Every calculation uses it: status, classes you can miss, advice and notifications.</p>
                <div class="pt-presets">
                    ${PRESETS.map(p => `<button class="${p === value ? 'active' : ''}" onclick="ProfileTools.pickMin(${p})">${p}%</button>`).join('')}
                </div>
                <label class="pt-text"><span>Or enter your own</span>
                    <input type="number" id="ptMinInput" min="1" max="100" step="0.5" value="${value}" inputmode="decimal">
                </label>
                <div class="pt-subhead">Applies to</div>
                <div class="pt-options">
                    <label class="pt-option"><input type="radio" name="ptScope" value="subject" ${overallNow() ? '' : 'checked'}>
                        <span><strong>Each subject</strong><small>Every subject must reach the minimum on its own (most colleges).</small></span></label>
                    <label class="pt-option"><input type="radio" name="ptScope" value="overall" ${overallNow() ? 'checked' : ''}>
                        <span><strong>Overall</strong><small>Only your total attendance across all subjects must reach it.</small></span></label>
                </div>
                <div class="pt-preview" id="ptMinPreview"></div>
                <div class="form-actions" style="justify-content: space-between;">
                    <button class="btn secondary-btn" onclick="closeModal('ptModal')">Cancel</button>
                    <button class="btn primary-btn" onclick="ProfileTools.saveMin()">Save</button>
                </div>
            </div>`;
        document.getElementById('ptMinInput').addEventListener('input', updateMinPreview);
        modal.querySelectorAll('input[name="ptScope"]').forEach(r => r.addEventListener('change', updateMinPreview));
        updateMinPreview();
        if (!modal.classList.contains('active')) openModal('ptModal');
    }

    function overallNow() {
        return typeof isOverallMode === 'function' ? isOverallMode() : localStorage.getItem('calcSettings_isOverall') === 'true';
    }

    function setOverall(on) {
        localStorage.setItem('calcSettings_isOverall', on ? 'true' : 'false');
        const box = document.getElementById('overallCriteriaCheckbox');
        if (box) box.checked = !!on;
    }

    function readMin() {
        const v = parseFloat(document.getElementById('ptMinInput')?.value);
        return isNaN(v) ? null : Math.round(v * 10) / 10;
    }

    // What the chosen minimum means for the current numbers
    function updateMinPreview() {
        const el = document.getElementById('ptMinPreview');
        if (!el) return;
        const v = readMin();
        document.querySelectorAll('.pt-presets button').forEach(b => b.classList.toggle('active', parseFloat(b.textContent) === v));
        if (v === null || v < 1 || v > 100) { el.innerHTML = '<span class="pt-warn">Enter a value between 1 and 100.</span>'; return; }
        const data = (typeof currentAnalysisData !== 'undefined' && currentAnalysisData.length) ? currentAnalysisData
            : (window.SmartSearch?.computeClassAttendance ? SmartSearch.computeClassAttendance() : []);
        if (!data.length || typeof getSubjectAnalysis !== 'function') { el.innerHTML = `Calculations will use <strong>${v}%</strong>.`; return; }
        if (document.querySelector('input[name="ptScope"]:checked')?.value === 'overall') {
            const t = data.reduce((a, s) => ({ attended: a.attended + s.attended, totalHeld: a.totalHeld + s.totalHeld, remaining: a.remaining + s.remaining, odml: a.odml + (Number(s.odml) || 0) }), { attended: 0, totalHeld: 0, remaining: 0, odml: 0 });
            const st = getSubjectAnalysis(t.attended, t.totalHeld, t.remaining, v / 100, t.odml).stats;
            el.innerHTML = `
                <div>Overall now: <strong>${st.currentPercent.toFixed(1)}%</strong> ${st.currentPercent >= v ? '— above' : '— below'} ${v}%.</div>
                <div>${st.stillNeed > st.remaining ? `<span class="pt-warn">Can't reach ${v}% overall this semester.</span>` : `You could miss <strong>${st.maxSkippable}</strong> class${st.maxSkippable !== 1 ? 'es' : ''} in total and still finish at ${v}% overall.`}</div>`;
            return;
        }
        let safe = 0, risk = 0, cantReach = 0, canMiss = 0;
        data.forEach(sub => {
            const { stats } = getSubjectAnalysis(sub.attended, sub.totalHeld, sub.remaining, v / 100, sub.odml);
            if (stats.stillNeed > stats.remaining) cantReach++;
            else if (stats.currentPercent >= v) safe++;
            else risk++;
            canMiss += stats.maxSkippable;
        });
        el.innerHTML = `
            <div>At <strong>${v}%</strong>: <strong>${safe}</strong> subject${safe !== 1 ? 's' : ''} safe, <strong>${risk}</strong> below${cantReach ? `, <span class="pt-warn">${cantReach} can't reach it</span>` : ''}.</div>
            <div>You could miss <strong>${canMiss}</strong> class${canMiss !== 1 ? 'es' : ''} in total and still finish at ${v}%.</div>`;
    }

    function saveMin() {
        const v = readMin();
        if (v === null || v < 1 || v > 100) { alert('Please enter a value between 1 and 100.'); return; }
        const input = document.getElementById('minAttendanceInput');
        if (input) input.value = v;
        localStorage.setItem('calcSettings_minAttendance', String(v));
        setOverall(document.querySelector('input[name="ptScope"]:checked')?.value === 'overall');
        // Medical minimum can't be above the attendance minimum
        if (typeof validateMedicalSettings === 'function') { try { validateMedicalSettings(); } catch (e) { /* ignore */ } }
        if (window.SyncManager?.saveSettings) { try { SyncManager.saveSettings(); } catch (e) { /* offline */ } }
        if (typeof recalculateEverything === 'function') recalculateEverything();
        closeModal('ptModal');
        if (window.ProfilePage) ProfilePage.render();
        if (typeof showToast === 'function') showToast('🎯 Minimum attendance updated', `All calculations now use ${v}% ${overallNow() ? 'overall' : 'in each subject'}.`, { duration: 3000 });
    }

    // ============================================================
    // 4. OD / ML RULE
    // ============================================================
    // Default = SRM portal: OD/ML counts from 65% own attendance, lifts you only up to 75%,
    // and counts fully once your own attendance is 75% or more. Each part can be changed.
    const ODML_PRESETS = {
        srm: { own: 65, lift: 'min', aboveAll: true, hourPct: null },
        all: { own: 0, lift: 'none', aboveAll: true, hourPct: null }
    };

    function ownMinNow() {
        return typeof getMinMedicalCriteria === 'function' ? getMinMedicalCriteria() : 65;
    }

    function odmlNow() {
        return typeof getOdmlSettings === 'function' ? getOdmlSettings() : { lift: 'min', aboveAll: true, hourPct: null };
    }

    const liftPct = (lift) => lift === 'none' || lift === null ? null : lift === 'min' ? currentMin() : parseFloat(lift);

    // One line describing the active rule (Profile row, previews)
    function ruleSummary() {
        const st = odmlNow();
        const own = ownMinNow();
        const lift = liftPct(st.lift);
        const parts = [];
        if (lift === null) parts.push(own > 0 ? `OD/ML counts from ${own}% own attendance` : 'All OD/ML counts');
        else parts.push(`OD/ML counts from ${own}% own, lifts up to ${lift}%`);
        if (lift !== null) parts.push(st.aboveAll ? `all counts at ${lift}%+` : `ignored at ${lift}%+`);
        if (st.hourPct !== null && st.hourPct !== '') parts.push(`max ${st.hourPct}% of classes`);
        parts.push(overallNow() ? 'overall' : 'per subject');
        return parts.join(' · ');
    }

    function openOdmlLimit() {
        const st = odmlNow();
        const lift = liftPct(st.lift);
        const modal = ensureModal();
        modal.innerHTML = `
            <div class="modal-content pt-modal">
                <button class="modal-close" onclick="closeModal('ptModal')">&times;</button>
                <div class="pt-icon">🏥</div>
                <h2>OD / ML rule</h2>
                <p class="pt-lead">How your college counts Duty Leave and Medical Leave. Every calculation, table and recommendation follows it.</p>
                <div class="pt-presets pt-odml-presets">
                    <button onclick="ProfileTools.odmlPreset('srm')">College default (SRM)</button>
                    <button onclick="ProfileTools.odmlPreset('all')">Count all OD/ML</button>
                </div>
                <div class="pt-rule">
                    <label class="pt-rule-row"><span><strong>Counts from</strong><small>Below this own attendance (present only), OD/ML doesn't count.</small></span>
                        <span class="pt-num"><input type="number" id="ptOwnMin" min="0" max="100" step="1" value="${ownMinNow()}" inputmode="numeric">%</span></label>
                    <label class="pt-rule-row"><span><strong>Lifts you up to</strong><small>OD/ML can raise you to this % but not above. Empty = no limit.</small></span>
                        <span class="pt-num"><input type="number" id="ptLift" min="0" max="100" step="0.5" value="${lift ?? ''}" placeholder="none" inputmode="decimal">%</span></label>
                    <label class="pt-rule-row"><span><strong>Already at or above that</strong><small>When your own attendance has reached the limit.</small></span>
                        <select id="ptAbove"><option value="all" ${st.aboveAll ? 'selected' : ''}>All OD/ML counts</option><option value="none" ${st.aboveAll ? '' : 'selected'}>OD/ML ignored</option></select></label>
                    <label class="pt-rule-row"><span><strong>Max OD/ML hours</strong><small>Limit as % of each subject's classes. Empty = no limit.</small></span>
                        <span class="pt-num"><input type="number" id="ptHourPct" min="0" max="100" step="1" value="${st.hourPct ?? ''}" placeholder="none" inputmode="numeric">%</span></label>
                </div>
                <div class="pt-example" id="ptOdmlExample"></div>
                <div class="pt-preview" id="ptOdmlPreview"></div>
                <div class="form-actions" style="justify-content: space-between;">
                    <button class="btn secondary-btn" onclick="closeModal('ptModal')">Cancel</button>
                    <button class="btn primary-btn" onclick="ProfileTools.saveOdmlLimit()">Save</button>
                </div>
            </div>`;
        modal.querySelectorAll('input, select').forEach(i => {
            i.addEventListener('input', updateOdmlPreview);
            i.addEventListener('change', updateOdmlPreview);
        });
        updateOdmlPreview();
        if (!modal.classList.contains('active')) openModal('ptModal');
    }

    function odmlPreset(name) {
        const p = ODML_PRESETS[name];
        if (!p) return;
        const set = (id, v) => { const i = document.getElementById(id); if (i) i.value = v; };
        set('ptOwnMin', p.own);
        set('ptLift', p.lift === 'min' ? currentMin() : p.lift === 'none' ? '' : p.lift);
        set('ptAbove', p.aboveAll ? 'all' : 'none');
        set('ptHourPct', p.hourPct ?? '');
        updateOdmlPreview();
    }

    function readOdmlChoice() {
        const num = (id) => { const v = (document.getElementById(id)?.value || '').trim(); return v === '' ? null : parseFloat(v); };
        const own = num('ptOwnMin') ?? 0;
        const lift = num('ptLift');
        const hourPct = num('ptHourPct');
        const bad = (v) => v !== null && (isNaN(v) || v < 0 || v > 100);
        if (bad(own) || bad(lift) || bad(hourPct)) return null;
        if (lift !== null && lift < own) return null;
        return {
            own,
            // Following the minimum keeps the limit right if the minimum changes later
            lift: lift === null ? 'none' : Math.abs(lift - currentMin()) < 1e-9 ? 'min' : lift,
            aboveAll: (document.getElementById('ptAbove')?.value || 'all') === 'all',
            hourPct
        };
    }

    // Apply a choice to storage; returns a function that restores the previous values
    function applyOdmlChoice(c) {
        const before = localStorage.getItem('calcSettings_odmlRule3');
        const medInput = document.getElementById('minMedicalInput');
        const medBefore = medInput ? medInput.value : null;
        localStorage.setItem('calcSettings_odmlRule3', JSON.stringify({ lift: c.lift, aboveAll: c.aboveAll, hourPct: c.hourPct }));
        if (medInput) { medInput.max = 100; medInput.value = c.own; }
        return () => {
            if (before === null) localStorage.removeItem('calcSettings_odmlRule3'); else localStorage.setItem('calcSettings_odmlRule3', before);
            if (medInput && medBefore !== null) medInput.value = medBefore;
        };
    }

    // Worked examples for the rule being edited (7 OD/ML hours out of 100 classes)
    function exampleLine() {
        if (typeof attendanceSplit !== 'function') return '';
        return [64, 65, 70, 75].map(own => {
            const r = attendanceSplit(own + 7, 100, 7, 0).withPct;
            return `<span>${own}% + 7 → <strong>${Math.round(r * 100) / 100}%</strong></span>`;
        }).join('');
    }

    // Each subject with OD/ML under the chosen rule
    function updateOdmlPreview() {
        const el = document.getElementById('ptOdmlPreview');
        const ex = document.getElementById('ptOdmlExample');
        if (!el) return;
        const c = readOdmlChoice();
        if (!c) {
            el.innerHTML = '<span class="pt-warn">Use percentages between 0 and 100; "lifts up to" can\'t be below "counts from".</span>';
            if (ex) ex.innerHTML = '';
            return;
        }
        const data = (typeof currentAnalysisData !== 'undefined' && currentAnalysisData.length) ? currentAnalysisData : [];
        const withOd = data.filter(s => Number(s.odml) > 0);

        // Preview only: the previous settings are restored right after (no save, no sync)
        window.bunkitRecalcRunning = true;
        const restore = applyOdmlChoice(c);
        let rows = '', example = '';
        try {
            example = exampleLine();
            rows = withOd.map(s => {
                const sp = attendanceSplit(s.attended, s.totalHeld, s.odml, s.remaining);
                const note = sp.notApplied ? sp.notApplied : sp.capped ? `${sp.odmlCounted} of ${sp.odml} h${sp.limitLabel ? ` (${sp.limitLabel})` : ''}` : 'all count';
                return `<tr><td>${esc(s.name)}</td><td>${sp.withoutPct.toFixed(2)}%</td><td><strong>${sp.withPct.toFixed(2)}%</strong></td><td class="pt-muted">${note}</td></tr>`;
            }).join('');
        } finally {
            restore();
            window.bunkitRecalcRunning = false;
        }
        if (ex) ex.innerHTML = `<div class="pt-subhead">Example · 7 OD/ML out of 100 classes</div><div class="pt-example-row">${example}</div>`;
        el.innerHTML = withOd.length
            ? `<table class="pt-impact"><thead><tr><th>Subject</th><th>Own</th><th>Total</th><th>OD/ML</th></tr></thead><tbody>${rows}</tbody></table>`
            : 'No OD/ML hours marked yet, so nothing changes right now.';
    }

    function saveOdmlLimit() {
        const c = readOdmlChoice();
        if (!c) { alert('Use percentages between 0 and 100. "Lifts you up to" can\'t be below "Counts from".'); return; }
        applyOdmlChoice(c);
        localStorage.setItem('calcSettings_minMedical', String(c.own));
        if (window.SyncManager?.saveSettings) { try { SyncManager.saveSettings(); } catch (e) { /* offline */ } }
        if (typeof recalculateEverything === 'function') recalculateEverything();
        closeModal('ptModal');
        if (window.ProfilePage) ProfilePage.render();
        if (typeof showToast === 'function') showToast('🏥 OD / ML rule updated', ruleSummary(), { duration: 3500 });
    }

    window.ProfileTools = {
        openOdmlLimit, saveOdmlLimit, ruleSummary, odmlPreset,
        openMinAttendance, saveMin,
        pickMin(v) { const i = document.getElementById('ptMinInput'); if (i) i.value = v; updateMinPreview(); },
        openLeave, saveLeave, undoLeave,
        setType(t) {
            const from = document.getElementById('ptFrom')?.value;
            const to = document.getElementById('ptTo')?.value;
            leaveType = t;
            openLeave({ type: t, from, to, codes: chosenCodes() });
        },
        toggleAll() {
            const boxes = Array.from(document.querySelectorAll('#ptSubjects input'));
            const all = boxes.every(b => b.checked);
            boxes.forEach(b => { b.checked = !all; });
            updateLeavePreview();
        },
        openExams, addExam, removeExam
    };
})();
