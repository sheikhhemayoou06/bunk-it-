// ============================================================
// ATTENDANCE CALENDAR (date chip, top right of Home)
// ============================================================
// Month view of the selected class: every day coloured by what happened
// (present / absent / mixed / OD-ML / not marked / holiday / exam / no classes).
// Tapping a day shows its classes period by period with quick actions.
// Uses globals: classes, formatLocalDate, parseLocalDate, getExamOn, DayCheck,
// ProfileTools, amsOpenSuddenHoliday, switchPage.
// ============================================================

(function () {
    'use strict';

    const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let viewMonth = null;   // 'YYYY-MM'
    let selected = null;    // 'YYYY-MM-DD'

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

    function getLogs() {
        try { return JSON.parse(localStorage.getItem('attendance_logs') || '{}') || {}; } catch (e) { return {}; }
    }

    function bucket(status) {
        const s = String(status || '').toUpperCase().trim();
        if (s === 'ATTENDED' || s === 'PRESENT' || s === 'P') return 'p';
        if (s === 'SKIPPED' || s === 'ABSENT' || s === 'A') return 'a';
        if (s === 'DUTY LEAVE (OD)' || s === 'OD' || s === 'MEDICAL LEAVE (ML)' || s === 'ML') return 'o';
        if (s === 'CANCELLED' || s === 'C') return 'c';
        return null;
    }

    // Everything the calendar needs about one day
    function dayInfo(name, dateStr, logs) {
        const cls = classes[name];
        const info = { date: dateStr, keys: [], marks: [], state: 'none', exam: null, holiday: false, outside: false };
        info.exam = typeof getExamOn === 'function' ? getExamOn(dateStr) : null;
        const start = cls.portalSetup?.semesterStartDate;
        if ((start && dateStr < start) || (cls.lastDate && dateStr > cls.lastDate)) { info.outside = true; return info; }
        if ((cls.holidays || []).includes(dateStr)) { info.holiday = true; info.state = 'holiday'; return info; }

        info.keys = window.DayCheck ? DayCheck.periodKeysFor(name, dateStr) : [];
        if (!info.keys.length) return info;

        const dayLog = logs[dateStr] || {};
        info.marks = info.keys.map(k => bucket(dayLog[k] || dayLog[k.split('_p')[0]]));
        const counted = info.marks.filter(m => m && m !== 'c');
        const unmarked = info.marks.filter(m => !m).length;

        const future = dateStr > today();
        if (future && unmarked === info.marks.length) info.state = 'future';
        else if (unmarked === info.marks.length) info.state = 'unmarked';
        else if (future && counted.length && counted.every(m => m === 'o')) info.state = 'odml'; // planned OD/ML
        else if (!counted.length) info.state = 'cancelled';
        else if (counted.every(m => m === 'p')) info.state = unmarked ? 'partial' : 'present';
        else if (counted.every(m => m === 'a')) info.state = unmarked ? 'partial' : 'absent';
        else if (counted.every(m => m === 'o')) info.state = 'odml';
        else info.state = unmarked ? 'partial' : 'mixed';
        return info;
    }

    function monthLabel(ym) {
        const [y, m] = ym.split('-').map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }

    function shiftMonth(ym, n) {
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(y, m - 1 + n, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    const STATE_LABEL = {
        present: 'All present', absent: 'All absent', mixed: 'Mixed', partial: 'Partly marked',
        odml: 'OD / ML', unmarked: 'Not marked', cancelled: 'Cancelled', future: 'Upcoming',
        holiday: 'Holiday', none: 'No classes'
    };

    function render() {
        const box = document.getElementById('attCalendar');
        if (!box) return;
        const name = className();
        if (!name) {
            box.querySelector('.ac-body').innerHTML = '<div class="ac-empty">Add a class to see its calendar.</div>';
            return;
        }
        const logs = getLogs();
        const [y, m] = viewMonth.split('-').map(Number);
        const first = new Date(y, m - 1, 1);
        const daysInMonth = new Date(y, m, 0).getDate();
        const lead = (first.getDay() + 6) % 7; // Monday first
        const t = today();

        let cells = '';
        for (let i = 0; i < lead; i++) cells += '<span class="ac-cell ac-pad"></span>';
        const summary = { classDays: 0, marked: 0, unmarked: 0, holidays: 0, exams: 0 };
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${viewMonth}-${String(d).padStart(2, '0')}`;
            const info = dayInfo(name, dateStr, logs);
            if (info.keys.length) summary.classDays++;
            if (['present', 'absent', 'mixed', 'odml', 'cancelled'].includes(info.state)) summary.marked++;
            if (info.state === 'unmarked' || info.state === 'partial') summary.unmarked++;
            if (info.holiday) summary.holidays++;
            if (info.exam) summary.exams++;
            const cls = [
                'ac-cell', `ac-${info.state}`,
                info.outside ? 'ac-outside' : '',
                info.exam ? 'ac-exam' : '',
                dateStr === t ? 'ac-today' : '',
                dateStr === selected ? 'ac-selected' : ''
            ].filter(Boolean).join(' ');
            const label = `${parseLocalDate(dateStr).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}: ${info.exam ? `exam (${info.exam.title}), ` : ''}${info.outside ? 'outside semester' : STATE_LABEL[info.state]}${info.keys.length ? `, ${info.keys.length} classes` : ''}`;
            cells += `
                <button class="${cls}" onclick="AttendanceCalendar.select('${dateStr}')" aria-label="${esc(label)}" ${dateStr === selected ? 'aria-pressed="true"' : ''}>
                    <span class="ac-num">${d}</span>
                    ${info.exam ? '<span class="ac-mark">📝</span>' : info.keys.length && !info.outside ? `<span class="ac-count">${info.keys.length}</span>` : ''}
                </button>`;
        }

        box.querySelector('.ac-body').innerHTML = `
            <div class="ac-nav">
                <button class="ac-nav-btn" onclick="AttendanceCalendar.month(-1)" aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button>
                <strong>${monthLabel(viewMonth)}</strong>
                <button class="ac-nav-btn" onclick="AttendanceCalendar.month(1)" aria-label="Next month"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
            ${viewMonth !== t.slice(0, 7) ? `<button class="ac-today-btn" onclick="AttendanceCalendar.goToday()">Back to today</button>` : ''}
            <div class="ac-grid ac-head">${DOW.map(d => `<span>${d}</span>`).join('')}</div>
            <div class="ac-grid">${cells}</div>
            <div class="ac-summary">
                <span><strong>${summary.classDays}</strong> class days</span>
                <span><strong>${summary.marked}</strong> marked</span>
                ${summary.unmarked ? `<span class="warn"><strong>${summary.unmarked}</strong> not marked</span>` : ''}
                ${summary.holidays ? `<span><strong>${summary.holidays}</strong> holiday${summary.holidays !== 1 ? 's' : ''}</span>` : ''}
                ${summary.exams ? `<span class="exam"><strong>${summary.exams}</strong> exam day${summary.exams !== 1 ? 's' : ''}</span>` : ''}
            </div>
            <div class="ac-legend">
                <span><i class="ac-present"></i>Present</span>
                <span><i class="ac-absent"></i>Absent</span>
                <span><i class="ac-mixed"></i>Mixed</span>
                <span><i class="ac-odml"></i>OD/ML</span>
                <span><i class="ac-unmarked"></i>Not marked</span>
                <span><i class="ac-holiday"></i>Holiday</span>
                <span>📝 Exam</span>
            </div>
            ${selected ? detailHtml(name, selected, logs) : '<p class="ac-hint">Tap a day to see its classes.</p>'}`;
    }

    function detailHtml(name, dateStr, logs) {
        const info = dayInfo(name, dateStr, logs);
        const cls = classes[name];
        const t = today();
        const title = parseLocalDate(dateStr).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
        const statusName = { p: 'Present', a: 'Absent', o: 'OD/ML', c: 'Cancelled' };

        let body = '';
        if (info.outside) body = '<p class="ac-detail-note">Outside the semester.</p>';
        else if (info.holiday) body = '<p class="ac-detail-note">🏖️ Holiday: no classes.</p>';
        else if (!info.keys.length) body = '<p class="ac-detail-note">No classes scheduled.</p>';
        else {
            const counter = {};
            body = `<div class="ac-periods">${info.keys.map((k, i) => {
                const code = k.split('_p')[0];
                counter[code] = (counter[code] || 0) + 1;
                const s = cls.subjects.find(x => x.code === code);
                const m = info.marks[i];
                return `<div class="ac-period"><span class="ac-pill ac-pill-${m || (dateStr > t ? 'future' : 'none')}">${m ? statusName[m] : dateStr > t ? 'Upcoming' : 'Not marked'}</span><span>${esc(s?.name || code)}</span></div>`;
            }).join('')}</div>`;

            body += dateStr <= t ? `
                <div class="ac-actions">
                    <button class="ac-act present" onclick="AttendanceCalendar.mark('${dateStr}', 'Attended')">✅ All Present</button>
                    <button class="ac-act absent" onclick="AttendanceCalendar.mark('${dateStr}', 'Skipped')">❌ All Absent</button>
                    <button class="ac-act" onclick="AttendanceCalendar.manual('${dateStr}')">✏️ Mark manually</button>
                </div>` : `
                <div class="ac-actions">
                    ${window.ProfileTools ? `<button class="ac-act" onclick="AttendanceCalendar.planLeave('${dateStr}')">📋 Plan OD / ML</button>` : ''}
                    ${window.amsOpenSuddenHoliday ? `<button class="ac-act" onclick="AttendanceCalendar.holiday('${dateStr}')">🏖️ Mark holiday</button>` : ''}
                </div>`;
        }

        return `
            <div class="ac-detail">
                <div class="ac-detail-head">
                    <strong>${title}</strong>
                    ${info.exam ? `<span class="ac-exam-badge">📝 ${esc(info.exam.title)}</span>` : ''}
                </div>
                ${body}
            </div>`;
    }

    function open() {
        let box = document.getElementById('attCalendar');
        if (!box) {
            box = document.createElement('div');
            box.id = 'attCalendar';
            box.className = 'ac-backdrop';
            box.innerHTML = `
                <div class="ac-panel" role="dialog" aria-label="Attendance calendar">
                    <header class="ac-top">
                        <h2><i class="fa-regular fa-calendar"></i> Calendar</h2>
                        <button class="ac-close" onclick="AttendanceCalendar.close()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                    </header>
                    <div class="ac-body"></div>
                </div>`;
            box.addEventListener('click', (e) => { if (e.target === box) close(); });
            document.body.appendChild(box);
        }
        viewMonth = today().slice(0, 7);
        selected = today();
        render();
        requestAnimationFrame(() => box.classList.add('open'));
    }

    function close() {
        document.getElementById('attCalendar')?.classList.remove('open');
    }

    function isOpen() {
        return document.getElementById('attCalendar')?.classList.contains('open');
    }

    function init() {
        const chip = document.querySelector('.dash-date-picker');
        if (!chip) return;
        chip.setAttribute('role', 'button');
        chip.setAttribute('tabindex', '0');
        chip.setAttribute('title', 'Open calendar');
        chip.addEventListener('click', open);
        chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.AttendanceCalendar = {
        open, close,
        refresh() { if (isOpen()) render(); },
        select(dateStr) { selected = dateStr; render(); },
        month(n) { viewMonth = shiftMonth(viewMonth, n); selected = null; render(); },
        goToday() { viewMonth = today().slice(0, 7); selected = today(); render(); },
        mark(dateStr, status) {
            if (window.DayCheck) DayCheck.mark(dateStr, status);
            setTimeout(render, 300);
        },
        manual(dateStr) { close(); if (window.DayCheck) DayCheck.manual(dateStr); },
        planLeave(dateStr) { close(); ProfileTools.openLeave({ from: dateStr, to: dateStr }); },
        holiday(dateStr) {
            close();
            if (typeof switchPage === 'function') switchPage('studentPortalPage');
            setTimeout(() => window.amsOpenSuddenHoliday(dateStr), 150);
        }
    };
})();
