/* ============================================================
   ATTENDANCE INTELLIGENCE - Smart Search Engine
   ============================================================
   A client-side natural language query engine for attendance data.
   No API calls needed — all computations are local.
   ============================================================ */

(function () {
    'use strict';

    // --- Search History ---
    const HISTORY_KEY = 'si_search_history';
    const MAX_HISTORY = 10;

    function getSearchHistory() {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
    }

    function saveToHistory(query) {
        let history = getSearchHistory();
        history = history.filter(h => h.toLowerCase() !== query.toLowerCase());
        history.unshift(query);
        if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        renderHistory();
    }

    function clearHistory() {
        localStorage.removeItem(HISTORY_KEY);
        renderHistory();
    }

    function renderHistory() {
        const container = document.getElementById('siHistoryList');
        const section = document.getElementById('siHistorySection');
        if (!container || !section) return;
        const history = getSearchHistory();
        if (history.length === 0) {
            section.style.display = 'none';
            return;
        }
        section.style.display = 'block';
        container.innerHTML = history.map(q =>
            `<div class="si-history-item" onclick="window.SmartSearch.runQuery('${q.replace(/'/g, "\\'")}')">
                <i class="fa-solid fa-clock-rotate-left"></i>
                <span>${q}</span>
            </div>`
        ).join('');
    }

    // --- Data Helpers ---
    function getAttendanceData() {
        // First try the already-computed data
        if (typeof currentAnalysisData !== 'undefined' && currentAnalysisData.length > 0) {
            return currentAnalysisData;
        }

        // Auto-compute from selectedClass + portal/logs
        return autoComputeAttendanceData();
    }

    function autoComputeAttendanceData() {
        const cls = getSelectedClassObj();
        if (!cls || !cls.subjects || cls.subjects.length === 0) return [];

        const isPortalMode = cls.portalSetup && cls.portalSetup.active;
        const logs = JSON.parse(localStorage.getItem('attendance_logs') || '{}');
        const results = [];

        // Get today and last date
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = formatLocalDateSI(today);

        const lastDateStr = cls.lastDate || cls.portalSetup?.lastWorkingDay || '';
        const lastDate = lastDateStr ? new Date(lastDateStr + 'T00:00:00') : new Date(today.getTime() + 60 * 86400000);

        // Holidays
        const holidayDates = (cls.holidays || []).map(h => new Date(h + 'T00:00:00'));

        // Parse schedule value helper (handles "1,3,4" or number formats)
        function parseSchedVal(val) {
            if (!val || val === '0') return 0;
            if (typeof val === 'number') return val;
            return String(val).split(',').filter(v => v.trim() !== '0' && v.trim() !== '').length;
        }

        // Count remaining classes for a subject
        function countRemaining(schedule, subjectCode) {
            let count = 0;
            const startDate = new Date(today.getTime() + 86400000); // tomorrow
            for (let d = new Date(startDate); d <= lastDate; d.setDate(d.getDate() + 1)) {
                const dayOfWeek = d.getDay();
                const schedIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
                // Check if it's a holiday
                const dTime = d.getTime();
                const isHoliday = holidayDates.some(h => h.getTime() === dTime);
                if (isHoliday) continue;

                const classesOnDay = typeof getClassCountOnDate === 'function'
                    ? getClassCountOnDate(formatLocalDateSI(d), subjectCode)
                    : parseSchedVal(schedule[schedIndex]);
                count += classesOnDay;
            }
            return count;
        }

        if (isPortalMode) {
            // Portal Mode: baseline + logs
            const baseline = cls.portalSetup.baselineData || {};
            const baselineDate = cls.portalSetup.baselineDate ? new Date(cls.portalSetup.baselineDate + 'T00:00:00') : new Date(0);

            // Aggregate logs after baseline date
            const logStats = {};

            Object.keys(logs).forEach(dateStr => {
                const logDate = new Date(dateStr + 'T00:00:00');
                if (logDate > baselineDate && dateStr <= todayStr) {
                    const dayLog = logs[dateStr];
                    if (!dayLog || typeof dayLog !== 'object') return;
                    Object.keys(dayLog).forEach(key => {
                        const code = key.split('_p')[0];
                        if (!logStats[code]) logStats[code] = { attended: 0, total: 0, odml: 0 };
                        const status = dayLog[key];
                        const s = String(status || '').toUpperCase().trim();
                        const isPresent = status === 'Attended' || status === 'Present' ||
                            status === 'Duty Leave (OD)' || status === 'Medical Leave (ML)' ||
                            s === 'P' || s === 'PRESENT' || s === 'ATTENDED' ||
                            s === 'ML' || s === 'OD';
                        const isAbsent = status === 'Skipped' || status === 'Absent' ||
                            s === 'A' || s === 'ABSENT' || s === 'SKIPPED';
                        if (isPresent) {
                            logStats[code].attended++;
                            logStats[code].total++;
                            if (/^(DUTY LEAVE \(OD\)|MEDICAL LEAVE \(ML\)|OD|ML)$/.test(s)) logStats[code].odml++;
                        } else if (isAbsent) {
                            logStats[code].total++;
                        }
                    });
                }
            });

            cls.subjects.forEach(subject => {
                const base = baseline[subject.code] || { attended: 0, total: 0 };
                const logAdd = logStats[subject.code] || { attended: 0, total: 0, odml: 0 };
                const attended = (base.attended || 0) + logAdd.attended;
                const totalHeld = (base.total || 0) + logAdd.total;
                const remaining = countRemaining(subject.schedule, subject.code);

                results.push({
                    ...subject,
                    attended,
                    totalHeld,
                    remaining,
                    odml: logAdd.odml,
                    initialAttended: base.attended || 0,
                    initialTotal: base.total || 0
                });
            });

        } else {
            // Standard Mode: initialAttended/initialTotal + logs
            const logStats = {};
            Object.keys(logs).forEach(dateStr => {
                if (dateStr > todayStr) return; // future marks (planned OD/ML) count when the day comes
                const dayLog = logs[dateStr];
                if (!dayLog || typeof dayLog !== 'object') return;
                Object.keys(dayLog).forEach(key => {
                    const code = key.split('_p')[0];
                    if (!logStats[code]) logStats[code] = { attended: 0, total: 0, odml: 0 };
                    const status = dayLog[key];
                    const s = String(status || '').toUpperCase().trim();
                    const isPresent = status === 'Attended' || status === 'Present' ||
                        status === 'Duty Leave (OD)' || status === 'Medical Leave (ML)' ||
                        s === 'P' || s === 'PRESENT' || s === 'ATTENDED';
                    const isAbsent = status === 'Skipped' || status === 'Absent' ||
                        s === 'A' || s === 'ABSENT' || s === 'SKIPPED';
                    if (isPresent) {
                        logStats[code].attended++;
                        logStats[code].total++;
                        if (/^(DUTY LEAVE \(OD\)|MEDICAL LEAVE \(ML\)|OD|ML)$/.test(s)) logStats[code].odml++;
                    } else if (isAbsent) {
                        logStats[code].total++;
                    }
                });
            });

            cls.subjects.forEach(subject => {
                const baseAttended = Number(subject.initialAttended || subject.attended || 0);
                const baseTotal = Number(subject.initialTotal || subject.totalHeld || 0);
                const logAdd = logStats[subject.code] || { attended: 0, total: 0, odml: 0 };
                const attended = baseAttended + logAdd.attended;
                const totalHeld = baseTotal + logAdd.total;
                const remaining = countRemaining(subject.schedule, subject.code);

                results.push({
                    ...subject,
                    attended,
                    totalHeld,
                    remaining,
                    odml: logAdd.odml,
                    initialAttended: baseAttended,
                    initialTotal: baseTotal
                });
            });
        }

        return results;
    }

    // Format date helper (local, no timezone shift)
    function formatLocalDateSI(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function getSelectedClassObj() {
        if (typeof selectedClass !== 'undefined' && selectedClass) return selectedClass;
        // Fallback: try to load from storage
        try {
            const lastClass = localStorage.getItem('lastOpenedClass') || localStorage.getItem('selectedClass');
            if (lastClass) {
                const classes = JSON.parse(localStorage.getItem('attendanceClasses_v2') || '{}');
                if (classes[lastClass]) return classes[lastClass];
            }
            // If still nothing, try first available class
            const classes = JSON.parse(localStorage.getItem('attendanceClasses_v2') || '{}');
            const classNames = Object.keys(classes);
            if (classNames.length > 0) return classes[classNames[0]];
        } catch (e) { }
        return null;
    }

    function getMinCriteria() {
        if (typeof getMinAttendanceCriteria === 'function') return getMinAttendanceCriteria();
        // Try reading from DOM
        try {
            const input = document.getElementById('minAttendanceInput');
            if (input && input.value) return parseFloat(input.value) / 100;
        } catch (e) { }
        return 0.75;
    }

    function noDataResponse() {
        const cls = getSelectedClassObj();
        if (!cls) {
            return {
                icon: '📭', iconClass: 'warning',
                title: 'No Class Selected',
                body: `<div class="si-empty-state">
                    <div class="si-empty-icon"><i class="fa-solid fa-graduation-cap"></i></div>
                    <h3>Add a class first</h3>
                    <p>Create a class with your subjects and timetable to start using Attendance Intelligence.</p>
                </div>`
            };
        }
        return {
            icon: '📭', iconClass: 'warning',
            title: 'No Attendance Data Yet',
            body: `<div class="si-empty-state">
                <div class="si-empty-icon"><i class="fa-solid fa-calendar-check"></i></div>
                <h3>Start marking attendance</h3>
                <p>Your class <strong>${cls.name || 'Untitled'}</strong> has no attendance records yet. Mark a few days of attendance and come back!</p>
            </div>`
        };
    }

    function parseScheduleVal(val) {
        if (!val || val === '0') return 0;
        if (typeof val === 'number') return val;
        return String(val).split(',').filter(v => v.trim() !== '0' && v.trim() !== '').length;
    }

    function analyzeSubject(sub, minCriteria) {
        const attended = Number(sub.attended) || 0;
        const totalHeld = Number(sub.totalHeld) || 0;
        const remaining = Number(sub.remaining) || 0;
        const finalTotal = totalHeld + remaining;
        const minRequired = finalTotal > 0 ? Math.ceil(minCriteria * finalTotal) : 0;
        const stillNeed = Math.max(0, minRequired - attended);
        const maxSkippable = Math.max(0, remaining - stillNeed);
        const odml = Math.min(Number(sub.odml) || 0, attended);
        // Percentages follow the OD/ML limit (Profile → OD / ML limit)
        const pct = (a, t) => typeof cappedWithPct === 'function' ? cappedWithPct(a, t, odml, remaining) : (t ? (a / t) * 100 : 0);
        const currentPercent = pct(attended, totalHeld);
        const withoutPercent = totalHeld === 0 ? 0 : ((attended - odml) / totalHeld) * 100;
        const projectedMax = pct(attended + remaining, finalTotal);
        const projectedMin = pct(attended, finalTotal);

        // Use the app's shared rules (OD/ML allowance + own-attendance minimum) when available
        if (typeof getSubjectAnalysis === 'function') {
            const st = getSubjectAnalysis(attended, totalHeld, remaining, minCriteria, odml).stats;
            let status = 'safe';
            if (st.stillNeed > remaining) status = 'danger';
            else if (st.currentPercent < minCriteria * 100) status = 'warning';
            return {
                attended, totalHeld, remaining, finalTotal, minRequired, odml, withoutPercent, status,
                stillNeed: st.stillNeed, maxSkippable: st.maxSkippable, currentPercent: st.currentPercent,
                projectedMax: st.projectedMaxPercent, projectedMin: st.projectedMinPercent, allowancePlan: st.allowancePlan
            };
        }

        let status = 'safe';
        if (stillNeed > remaining) status = 'danger';
        else if (currentPercent < minCriteria * 100) status = 'warning';

        return { attended, totalHeld, remaining, finalTotal, minRequired, stillNeed, maxSkippable, currentPercent, withoutPercent, odml, projectedMax, projectedMin, status };
    }

    // ============================================================
    // NATURAL LANGUAGE DATE PARSING
    // Understands: "3 oct to 5 oct", "3-5 oct", "oct 3 till 5", "3rd october",
    // "03/10 to 05/10", "2026-10-03", "today", "tomorrow", "day after tomorrow",
    // "next friday", "monday to wednesday", "next week", "this week",
    // "next 3 days", "from 10 oct for 3 days", "3 days from 10 oct",
    // "whole november", lists like "3, 4 and 7 oct".
    // ============================================================
    const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const WEEKDAY_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
    const ORD = '(?:st|nd|rd|th)?';
    const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30 };

    function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
    function monthIdx(word) { return MONTHS[word.slice(0, 3)]; }
    function weekdayIdx(word) { return WEEKDAYS[word.slice(0, 3)]; }

    // Pick the year for a day+month without a year: prefer the class semester,
    // otherwise the nearest upcoming occurrence (allowing recent past dates).
    function inferYear(day, month, today, cls) {
        const y = today.getFullYear();
        const candidates = [y, y + 1, y - 1].map(yy => new Date(yy, month, day));
        const start = cls?.portalSetup?.semesterStartDate ? new Date(cls.portalSetup.semesterStartDate + 'T00:00:00') : null;
        const end = cls?.lastDate ? new Date(cls.lastDate + 'T00:00:00') : null;
        if (start && end) {
            const inSem = candidates.find(c => c >= start && c <= end);
            if (inSem) return inSem;
        }
        return candidates[0] >= addDays(today, -30) ? candidates[0] : candidates[1];
    }

    function makeDate(day, month, year, today, cls) {
        if (month < 0 || month > 11 || day < 1 || day > 31) return null;
        let d;
        if (year != null) {
            if (year < 100) year += 2000;
            d = new Date(year, month, day);
        } else {
            d = inferYear(day, month, today, cls);
        }
        return d.getMonth() === month ? d : null; // rejects 31 Feb etc.
    }

    // "monday" -> next occurrence on/after today; "next monday" -> strictly after today
    function resolveWeekday(word, modifier, today) {
        const target = weekdayIdx(word);
        let diff = (target - today.getDay() + 7) % 7;
        if (modifier === 'next' && diff === 0) diff = 7;
        return addDays(today, diff);
    }

    function parseDateQuery(query, cls) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let q = ' ' + query.toLowerCase()
            .replace(/[’']/g, '')
            .replace(/\s+/g, ' ') + ' ';
        // number words -> digits ("three days" -> "3 days")
        q = q.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty)\b/g, w => NUM_WORDS[w]);
        q = q.replace(/\ba week\b/g, '7 days').replace(/\bfortnight\b/g, '14 days');
        q = q.replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+/g, '$1 ');

        // "3-5 oct" / "3 to 5 october 2026"  -> "3 oct to 5 oct 2026"
        q = q.replace(new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:-|–|to|till|until|through|thru)\\s*(\\d{1,2})${ORD}\\s+${MONTH_RE}(?:\\s+(\\d{4}))?\\b`, 'g'),
            (m, a, b, mon, yr) => `${a} ${mon}${yr ? ' ' + yr : ''} to ${b} ${mon}${yr ? ' ' + yr : ''}`);
        // "oct 3-5" / "october 3 to 5" -> "oct 3 to oct 5"
        q = q.replace(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})${ORD}\\s*(?:-|–|to|till|until|through|thru)\\s*(\\d{1,2})${ORD}\\b(?!\\s*${MONTH_RE})`, 'g'),
            (m, mon, a, b) => `${mon} ${a} to ${mon} ${b}`);
        // "3, 4 and 7 oct" -> "3 oct , 4 oct and 7 oct"
        q = q.replace(new RegExp(`\\b((?:\\d{1,2}${ORD}\\s*(?:,|and|&)\\s*)+)(\\d{1,2})${ORD}\\s+${MONTH_RE}\\b`, 'g'),
            (m, list, last, mon) => list.split(/\s*(,|and|&)\s*/).map(t => /^\d/.test(t) ? `${parseInt(t)} ${mon}` : ` ${t} `).join('') + `${last} ${mon}`);

        const mentions = []; // { start, end, from: Date, to: Date }
        const add = (m, from, to) => { if (from) mentions.push({ start: m.index, end: m.index + m[0].length, from, to: to || from }); };
        const scan = (re, fn) => { let m; const g = new RegExp(re, 'g'); while ((m = g.exec(q))) fn(m); };

        scan('\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b', m => add(m, makeDate(+m[3], +m[2] - 1, +m[1], today, cls)));
        scan('\\b(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?\\b', m => add(m, makeDate(+m[1], +m[2] - 1, m[3] ? +m[3] : null, today, cls)));
        scan(`\\b(\\d{1,2})${ORD}\\s+${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, m => add(m, makeDate(+m[1], monthIdx(m[2]), m[3] ? +m[3] : null, today, cls)));
        scan(`\\b${MONTH_RE}\\s+(\\d{1,2})${ORD}\\b(?:,?\\s+(\\d{4}))?`, m => add(m, makeDate(+m[2], monthIdx(m[1]), m[3] ? +m[3] : null, today, cls)));
        scan('\\bday after tomorrow\\b', m => add(m, addDays(today, 2)));
        scan('\\b(?:tomorrow|tmrw?|tmr)\\b', m => add(m, addDays(today, 1)));
        scan('\\btoday\\b', m => add(m, today));
        scan('\\byesterday\\b', m => add(m, addDays(today, -1)));
        scan(`\\b(?:(next|this|coming)\\s+)?${WEEKDAY_RE}\\b`, m => add(m, resolveWeekday(m[2], m[1], today)));
        scan('\\bnext week\\b', m => { const mon = resolveWeekday('mon', 'next', today); add(m, mon, addDays(mon, 6)); });
        scan('\\bthis week\\b', m => add(m, today, addDays(today, (7 - today.getDay()) % 7)));
        scan('\\b(?:next|coming|upcoming)\\s+(\\d{1,3})\\s+days?\\b', m => add(m, addDays(today, 1), addDays(today, +m[1])));
        scan(`\\b(?:whole|entire|full|all)\\s+(?:of\\s+)?(?:the\\s+)?(?:month\\s+of\\s+)?${MONTH_RE}\\b`, m => {
            const first = makeDate(1, monthIdx(m[1]), null, today, cls);
            if (first) add(m, first, new Date(first.getFullYear(), first.getMonth() + 1, 0));
        });
        scan('\\b(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s*(?:class|period|lecture|lab))', m => {
            // bare ordinal "the 5th" -> this month, or next month if already past
            let d = new Date(today.getFullYear(), today.getMonth(), +m[1]);
            if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, +m[1]);
            add(m, d);
        });

        // Remove overlapping mentions (keep the longest)
        mentions.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
        const picked = [];
        mentions.forEach(m => {
            const last = picked[picked.length - 1];
            if (!last || m.start >= last.end) picked.push(m);
            else if ((m.end - m.start) > (last.end - last.start)) picked[picked.length - 1] = m;
        });
        if (picked.length === 0) return null;

        // Join mentions into ranges / separate dates
        const ranges = [];
        for (let i = 0; i < picked.length; i++) {
            const cur = picked[i];
            const next = picked[i + 1];
            const between = next ? q.slice(cur.end, next.start).trim() : '';
            const before = q.slice(Math.max(0, cur.start - 10), cur.start);
            const isRange = next && (/^(?:-|–|to|till|until|upto|up to|through|thru|to the)$/.test(between) ||
                (between === 'and' && /between\s*$/.test(before)));
            if (isRange) {
                let to = new Date(next.to);
                // "fri to mon" rolls over a week; "28 dec to 3 jan" rolls over a year
                const weekdayEnd = new RegExp(`^(?:(?:next|this|coming)\\s+)?${WEEKDAY_RE}$`).test(q.slice(next.start, next.end).trim());
                while (to < cur.from) {
                    if (weekdayEnd) to = addDays(to, 7);
                    else to.setFullYear(to.getFullYear() + 1);
                }
                ranges.push({ from: cur.from, to });
                i++;
            } else {
                // "from 10 oct for 3 days" / "10 oct + 3 days"
                const after = q.slice(cur.end, cur.end + 25);
                const dur = after.match(/^\s*(?:for|\+)\s*(\d{1,3})\s*days?\b/);
                if (dur && cur.from.getTime() === cur.to.getTime()) {
                    ranges.push({ from: cur.from, to: addDays(cur.from, +dur[1] - 1) });
                } else {
                    // "3 days from 10 oct" / "3 days starting 10 oct"
                    const pre = q.slice(Math.max(0, cur.start - 30), cur.start).match(/(\d{1,3})\s*days?\s+(?:[a-z]+\s+){0,2}?(?:from|starting|starting from|beginning|after)\s*$/);
                    if (pre && cur.from.getTime() === cur.to.getTime()) {
                        const startD = /after\s*$/.test(pre[0]) ? addDays(cur.from, 1) : cur.from;
                        ranges.push({ from: startD, to: addDays(startD, +pre[1] - 1) });
                    } else {
                        ranges.push({ from: cur.from, to: cur.to });
                    }
                }
            }
        }

        // Expand to a sorted list of unique date strings (cap at 1 year)
        const set = new Set();
        ranges.forEach(r => {
            for (let d = new Date(r.from), n = 0; d <= r.to && n < 366; d = addDays(d, 1), n++) set.add(formatLocalDateSI(d));
        });
        const dates = [...set].sort();
        return dates.length ? { dates, ranges, today: formatLocalDateSI(today) } : null;
    }

    // --- Count scheduled classes per subject on a date (timetable-aware) ---
    function classesOnDate(cls, dateStr) {
        const counts = {};
        if (!cls || !cls.subjects) return counts;
        if ((cls.holidays || []).includes(dateStr)) return counts;
        const semStart = cls.portalSetup?.semesterStartDate;
        if (semStart && dateStr < semStart) return counts;
        if (cls.lastDate && dateStr > cls.lastDate) return counts;

        // Timetable that applied on this exact date (handles timetable changes)
        if (typeof getClassCountsForDate === 'function') return getClassCountsForDate(dateStr);

        const className = document.getElementById('classSelector')?.value || cls.name;
        const dow = new Date(dateStr + 'T00:00:00').getDay();
        const dayIndex = dow === 0 ? 6 : dow - 1;

        // 1. Custom schedule for this exact date
        let custom = null;
        try { custom = JSON.parse(localStorage.getItem(`custom_schedules_${className}`) || '{}')[dateStr]; } catch (e) { }
        if (custom) {
            if (custom._periods) {
                custom._periods.forEach(code => { if (code) counts[code] = (counts[code] || 0) + 1; });
            } else {
                Object.keys(custom).forEach(code => { if (custom[code] > 0) counts[code] = custom[code]; });
            }
            return counts;
        }

        // 2. Weekly timetable arrangement
        let arrangement = null;
        try {
            arrangement = typeof getTimetableArrangement === 'function'
                ? getTimetableArrangement(className, dateStr)
                : JSON.parse(localStorage.getItem(`timetable_arrangement_${className}`) || 'null');
        } catch (e) { }
        const dayArr = arrangement && arrangement[dayIndex];
        if (dayArr && dayArr.length > 0) {
            dayArr.forEach(item => {
                const code = item && typeof item === 'object' ? item.code : item;
                if (code) counts[code] = (counts[code] || 0) + 1;
            });
            return counts;
        }

        // 3. Fallback: per-subject weekly schedule counts
        cls.subjects.forEach(sub => {
            const n = parseScheduleVal(sub.schedule ? sub.schedule[dayIndex] : 0);
            if (n > 0) counts[sub.code] = n;
        });
        return counts;
    }

    function fmtShort(dateStr) {
        return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
    }

    function describeRanges(ranges) {
        return ranges.map(r => {
            const a = formatLocalDateSI(r.from), b = formatLocalDateSI(r.to);
            return a === b ? fmtShort(a) : `${fmtShort(a)} → ${fmtShort(b)}`;
        }).join(', ');
    }

    // Subject mentioned in the query ("skip maths on 5 oct") -> filter
    function findSubjectsInQuery(query, data) {
        const q = ' ' + query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';
        return data.filter(sub => {
            const keys = [sub.code, sub.shortName, sub.name].filter(Boolean).map(k => k.toLowerCase().trim());
            return keys.some(k => k.length >= 2 && q.includes(' ' + k + ' '));
        });
    }

    // --- Handler: impact of taking leave on specific dates ---
    function handleDateLeaveImpact(query, parsed) {
        const data = getAttendanceData();
        const cls = getSelectedClassObj();
        if (!data.length || !cls) return noDataResponse();

        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;
        const todayStr = parsed.today;

        // Today's classes count as "upcoming" only if today isn't logged yet
        let logs = {};
        try { logs = JSON.parse(localStorage.getItem('attendance_logs') || '{}'); } catch (e) { }
        const todayLogged = logs[todayStr] && Object.keys(logs[todayStr]).length > 0;
        const windowStart = todayLogged ? formatLocalDateSI(addDays(new Date(todayStr + 'T00:00:00'), 1)) : todayStr;
        const endStr = cls.lastDate || parsed.dates[parsed.dates.length - 1];

        const pastDates = parsed.dates.filter(d => d < windowStart);
        const outsideSem = parsed.dates.filter(d => d >= windowStart && ((cls.lastDate && d > cls.lastDate) ||
            (cls.portalSetup?.semesterStartDate && d < cls.portalSetup.semesterStartDate)));
        const leaveDates = parsed.dates.filter(d => d >= windowStart && !outsideSem.includes(d));
        const leaveSet = new Set(leaveDates);
        const firstLeave = leaveDates[0];

        // Walk every upcoming day once: remaining (R), missed (m), before-break (b)
        const per = {};
        data.forEach(sub => { per[sub.code] = { R: 0, m: 0, b: 0 }; });
        const classDays = [];
        const noClassDays = [];
        for (let d = new Date(windowStart + 'T00:00:00'); formatLocalDateSI(d) <= endStr; d = addDays(d, 1)) {
            const ds = formatLocalDateSI(d);
            const counts = classesOnDate(cls, ds);
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            if (leaveSet.has(ds)) (total > 0 ? classDays : noClassDays).push(ds);
            Object.keys(counts).forEach(code => {
                if (!per[code]) return;
                per[code].R += counts[code];
                if (leaveSet.has(ds)) per[code].m += counts[code];
                else if (firstLeave && ds < firstLeave) per[code].b += counts[code];
            });
        }

        const notes = [];
        const examHits = typeof getExamOn === 'function' ? leaveDates.map(d => ({ d, exam: getExamOn(d) })).filter(x => x.exam) : [];
        if (examHits.length) notes.push(`<span style="color:var(--si-danger, #ef4444);font-weight:700;"><i class="fa-solid fa-file-pen"></i> Exam day${examHits.length > 1 ? 's' : ''}: ${examHits.map(x => `${fmtShort(x.d)} (${x.exam.title})`).join(', ')}. Attendance is compulsory, don't take leave then.</span>`);
        if (pastDates.length) notes.push(`<i class="fa-solid fa-clock-rotate-left"></i> ${pastDates.length} date(s) already passed (${pastDates.map(fmtShort).join(', ')}) — mark those on the Attendance page instead.`);
        if (outsideSem.length) notes.push(`<i class="fa-solid fa-calendar-xmark"></i> ${outsideSem.length} date(s) fall outside your semester and were ignored.`);
        if (noClassDays.length) notes.push(`<i class="fa-solid fa-mug-hot"></i> No classes on ${noClassDays.map(fmtShort).join(', ')} (holiday / off day) — free leave!`);
        const notesHtml = notes.length ? `<div class="si-notes" style="margin-top:12px;font-size:0.85rem;color:var(--si-text-secondary, #64748b);display:flex;flex-direction:column;gap:6px;">${notes.map(n => `<div>${n}</div>`).join('')}</div>` : '';

        const rangeLabel = describeRanges(parsed.ranges);

        if (leaveDates.length === 0 || classDays.length === 0) {
            return {
                icon: pastDates.length && !leaveDates.length ? '🕒' : '🎉',
                iconClass: pastDates.length && !leaveDates.length ? 'info' : 'safe',
                title: pastDates.length && !leaveDates.length ? 'Those Dates Have Passed' : 'No Classes on Those Days',
                body: `<p><strong>${rangeLabel}</strong>: ${leaveDates.length === 0 ? 'there are no upcoming class days to analyse.' : 'you have <strong>no scheduled classes</strong>, so this leave has <strong>zero impact</strong> on your attendance.'}</p>${notesHtml}`
            };
        }

        // Optional subject filter ("skip maths on 5 oct")
        const onlySubs = findSubjectsInQuery(query, data);
        if (onlySubs.length) {
            // Other subjects are attended as usual during the leave
            data.forEach(sub => {
                if (!onlySubs.includes(sub) && per[sub.code]) { per[sub.code].b += per[sub.code].m; per[sub.code].m = 0; }
            });
        }

        let totA = 0, totT = 0, totM = 0, totB = 0, totR = 0;
        let atRisk = 0;
        const rows = data.filter(sub => per[sub.code].m > 0 || !onlySubs.length).map(sub => {
            const A = Number(sub.attended) || 0;
            const T = Number(sub.totalHeld) || 0;
            const { R, m, b } = per[sub.code];
            totA += A; totT += T; totM += m; totB += b; totR += R;

            const current = T > 0 ? (A / T) * 100 : 0;
            const afterBreak = (T + b + m) > 0 ? ((A + b) / (T + b + m)) * 100 : 0;
            const finalPct = (T + R) > 0 ? ((A + R - m) / (T + R)) * 100 : 0;
            const minNeeded = Math.ceil(minCriteria * (T + R) - 1e-9);
            const skipsAllowed = Math.max(0, A + R - minNeeded);
            const skipsLeft = skipsAllowed - m;
            const ok = skipsLeft >= 0;
            if (m > 0 && !ok) atRisk++;

            const badge = m === 0 ? '<span class="si-badge safe">No class</span>'
                : ok ? `<span class="si-badge ${skipsLeft <= 2 ? 'warning' : 'safe'}">✅ ${skipsLeft} left</span>`
                    : `<span class="si-badge danger">❌ Short by ${-skipsLeft}</span>`;
            return `<tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td style="text-align:center;">${m}</td>
                <td>${current.toFixed(1)}%</td>
                <td>${afterBreak.toFixed(1)}%</td>
                <td style="color:${finalPct >= minPercent ? 'var(--si-success, #10b981)' : 'var(--si-danger, #ef4444)'};font-weight:600;">${finalPct.toFixed(1)}%</td>
                <td>${badge}</td>
            </tr>`;
        }).join('');

        const overallNow = totT > 0 ? (totA / totT) * 100 : 0;
        const overallAfter = (totT + totB + totM) > 0 ? ((totA + totB) / (totT + totB + totM)) * 100 : 0;
        const overallFinal = (totT + totR) > 0 ? ((totA + totR - totM) / (totT + totR)) * 100 : 0;
        const safe = atRisk === 0;

        return {
            icon: examHits.length ? '📝' : safe ? '✅' : '⚠️',
            iconClass: safe && !examHits.length ? 'safe' : 'danger',
            title: examHits.length ? `Not allowed: exam on ${rangeLabel}` : safe ? `Safe to take leave: ${rangeLabel}` : `Risky leave: ${rangeLabel}`,
            body: `
                <div class="si-stats-grid">
                    <div class="si-stat-tile">
                        <div class="si-stat-value warning">${totM}</div>
                        <div class="si-stat-label">Classes missed (${classDays.length} day${classDays.length > 1 ? 's' : ''})</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value ${overallAfter >= minPercent ? 'safe' : 'danger'}">${overallAfter.toFixed(1)}%</div>
                        <div class="si-stat-label">Right after leave</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value ${overallFinal >= minPercent ? 'safe' : 'danger'}">${overallFinal.toFixed(1)}%</div>
                        <div class="si-stat-label">Semester end*</div>
                    </div>
                </div>
                <p style="margin-top:14px;">
                    Taking leave on <strong>${rangeLabel}</strong>${onlySubs.length ? ` (only ${onlySubs.map(s => s.name || s.code).join(', ')})` : ''} means missing
                    <strong>${totM}</strong> class${totM !== 1 ? 'es' : ''} across ${classDays.length} class day${classDays.length > 1 ? 's' : ''}.
                    Overall attendance goes from <strong>${overallNow.toFixed(1)}%</strong> now to <strong>${overallAfter.toFixed(1)}%</strong> right after the leave
                    (if you attend every class until then).
                    ${safe
                        ? `<span style="color:var(--si-success, #10b981);font-weight:600;">All subjects can still finish at or above ${minPercent}%.</span>`
                        : `<span style="color:var(--si-danger, #ef4444);font-weight:600;">${atRisk} subject${atRisk > 1 ? 's' : ''} cannot reach ${minPercent}% by semester end after this leave.</span>`}
                </p>
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>Missed</th><th>Now</th><th>After leave</th><th>Sem end*</th><th>Skips left</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <p style="font-size:0.78rem;margin-top:8px;opacity:0.75;">* Semester end % assumes you attend every other class until ${fmtShort(endStr)}. "Skips left" = classes you can still miss after this leave and stay at ${minPercent}%.</p>
                ${notesHtml}
            `
        };
    }

    // Words that signal "what if I'm absent on these dates"
    const LEAVE_INTENT_RE = /\b(leave|leaves|break|off|skip|skipping|miss|missing|bunk|bunking|absent|absence|vacation|vacay|holiday|holidays|trip|travel|travelling|traveling|home|going|go|attend|impact|effect|affect|happen|happens|what if|can i|should i|safe|plan|not come|wont|won't|cant|can't|sick|ill)\b/i;

    // ============================================================
    // HINDI / HINGLISH → the English the parser understands
    // ============================================================
    // Voice in Hindi returns Devanagari ("क्या मैं कल छुट्टी ले सकता हूँ?"); people
    // also type Hinglish ("kal chutti le sakta hu?"). Whole phrases are mapped to
    // the English intents first, then dates, numbers and leave words.
    const HI_DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
    const HI_NUMBERS = {
        'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'छे': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
        'ग्यारह': 11, 'बारह': 12, 'तेरह': 13, 'चौदह': 14, 'पंद्रह': 15, 'पन्द्रह': 15, 'सोलह': 16, 'सत्रह': 17, 'अठारह': 18,
        'उन्नीस': 19, 'बीस': 20, 'इक्कीस': 21, 'बाईस': 22, 'तेईस': 23, 'चौबीस': 24, 'पच्चीस': 25, 'छब्बीस': 26,
        'सत्ताईस': 27, 'अट्ठाईस': 28, 'अठ्ठाईस': 28, 'उनतीस': 29, 'तीस': 30, 'इकतीस': 31
    };
    const HI_WORDS = [
        // your data: holidays, OD/ML, exams, timetable, profile, semester
        [/अगली\s*छुट्टी\s*(?:कब)?/g, ' next holiday '],
        [/(?:छुट्टियों|छुट्टियाँ|छुट्टियां)\s*(?:की\s*)?(?:लिस्ट|सूची)|कौन\s*(?:कौन\s*)?सी\s*छुट्टि\S*|(?:छुट्टियाँ|छुट्टियां)\s*कब/g, ' holiday list '],
        [/(?:क्या\s*)?(\S+\s+\S+)?\s*(?:को)?\s*छुट्टी\s*है/g, ' $1 is holiday '],
        [/परीक्षा|एग्जाम|इम्तिहान/g, ' exam '],
        [/मेडिकल/g, ' medical '], [/ओडी|ड्यूटी\s*लीव/g, ' od '],
        [/टाइम\s*टेबल|टाइमटेबल|समय\s*सारणी/g, ' timetable '],
        [/(?:मेरी|मेरा)\s*(?:प्रोफाइल|प्रोफ़ाइल|जानकारी|डिटेल्स|डिटेल|नाम|अकाउंट)/g, ' my profile '],
        [/सेमेस्टर\s*कब\s*(?:खत्म|ख़त्म|समाप्त)\S*/g, ' semester end '],
        [/(?:कितने|कितना)\s*दिन\s*(?:बचे|बाकी)/g, ' days left '],
        [/(?:मार्क\s*नहीं|बिना\s*मार्क)/g, ' not marked '],
        // phrases → intents (longest first)
        [/(?:मेरी|मेरा)?\s*(?:कुल\s*)?(?:अटेंडेंस|उपस्थिति|हाजिरी|हाज़िरी)\s*(?:कितनी|कितना|क्या|कैसी)\s*(?:है)?/g, ' overall attendance '],
        [/(?:कुल\s*(?:अटेंडेंस|उपस्थिति)|सारांश|समरी)/g, ' overall summary '],
        [/कितनी\s*(?:क्लास|क्लासेस|कक्षाएं|कक्षा)?\s*(?:छोड़|छोड़|बंक|मिस)\S*\s*(?:सकता|सकती|सकते)?/g, ' how many can i skip '],
        [/कितनी\s*(?:क्लास|क्लासेस|कक्षाएं)?\s*(?:अटेंड|जानी|जाना)\s*(?:करनी|पड़ेगी|पड़ेंगी|होगी|है)?/g, ' how many classes do i need to attend '],
        [/सबसे\s*(?:खराब|ख़राब|कमज़ोर|कमजोर|कम)/g, ' worst subjects '],
        [/(?:किस|कौन\s*से?)\s*(?:विषय|सब्जेक्ट)\s*(?:में)?\s*(?:कम|खतरा|ख़तरा|खराब)/g, ' worst subjects '],
        [/सबसे\s*(?:अच्छ[ाेी]|ज़्यादा|ज्यादा|बेहतर)/g, ' best subjects '],
        [/(?:लंबा|लम्बा)\s*(?:वीकेंड|वीकएंड|सप्ताहांत)|(?:लंबी|लम्बी)\s*छुट्टी/g, ' long weekend '],
        [/(\d+)\s*(?:%|प्रतिशत|परसेंट)\s*(?:तक|पाने|पहुँचने|पहुंचने|लाने)/g, ' reach $1% '],
        [/(?:भविष्यवाणी|अनुमान|प्रेडिक्शन|सेमेस्टर\s*के\s*(?:अंत|आखिर))/g, ' prediction '],
        [/(?:रिकवरी|सुधार)/g, ' recovery plan '],
        [/मदद/g, ' help '],
        [/आज\s*(?:क्लास\s*)?(?:छोड़|छोड़|बंक|मिस|न\s*जाऊं|न\s*जाऊँ|ना\s*जाऊं|नहीं\s*जाऊं|नहीं\s*जाऊँ)\S*/g, ' skip today '],
        [/अगर\s*(?:मैं)?\s*(\d+)\s*(?:क्लास|क्लासेस|कक्षाएं)?\s*(?:छोड़|छोड़|मिस|बंक)\S*/g, ' if i miss $1 '],
        [/(\d+)\s*से\s*(\d+)/g, ' $1 to $2 '],
        [/\s+से\s+/g, ' to '],
        // dates
        [/जनवरी/g, ' january '], [/फ़?फरवरी|फ़रवरी/g, ' february '], [/मार्च/g, ' march '], [/अप्रैल|अप्रेल/g, ' april '],
        [/मई/g, ' may '], [/जून/g, ' june '], [/जुलाई/g, ' july '], [/अगस्त/g, ' august '],
        [/सितंबर|सितम्बर/g, ' september '], [/अक्टूबर|अक्तूबर/g, ' october '], [/नवंबर|नवम्बर/g, ' november '], [/दिसंबर|दिसम्बर/g, ' december '],
        [/सोमवार/g, ' monday '], [/मंगलवार/g, ' tuesday '], [/बुधवार/g, ' wednesday '], [/गुरुवार|बृहस्पतिवार/g, ' thursday '],
        [/शुक्रवार/g, ' friday '], [/शनिवार/g, ' saturday '], [/रविवार|इतवार/g, ' sunday '],
        [/परसों/g, ' day after tomorrow '], [/आज/g, ' today '], [/कल/g, ' tomorrow '],
        [/अगले|अगला|अगली|आने\s*वाले/g, ' next '], [/इस\s+(?=हफ्ते|हफ़्ते|सप्ताह|महीने)/g, ' this '],
        [/हफ्ते|हफ़्ते|हफ्ता|हफ़्ता|सप्ताह/g, ' week '], [/महीने|महीना/g, ' month '], [/दिनों|दिन/g, ' days '],
        [/तक/g, ' '],
        // leave words
        [/छुट्टियां|छुट्टियाँ|छुट्टी|अवकाश/g, ' leave '], [/छोड़|छोड़/g, ' skip '], [/बंक/g, ' bunk '], [/मिस/g, ' miss '],
        [/अनुपस्थित|गैरहाज़िर|गैरहाजिर/g, ' absent '], [/बीमार/g, ' sick '], [/घर/g, ' home '],
        [/अटेंडेंस|उपस्थिति|हाजिरी|हाज़िरी/g, ' attendance '], [/क्लासेस|क्लास|कक्षाएं|कक्षा/g, ' classes '],
        [/विषय|सब्जेक्ट/g, ' subject '], [/क्या/g, ' can '], [/मैं/g, ' i '],
        [/जाऊं|जाऊँ|जाना|जाओ/g, ' go '], [/लूं|लूँ|लेना|ले/g, ' take '], [/नहीं|(?:^|\s)ना(?=\s|$)/g, ' not ']
    ];
    // Hinglish typed in English letters
    const HINGLISH_WORDS = [
        [/\bagli\s+chh?utt?i\s*(?:kab)?\b/gi, 'next holiday'],
        [/\bchh?utt?iy(?:on|an|aan)\s+(?:ki\s+)?(?:list|kab)\b/gi, 'holiday list'],
        [/\b(?:mera|meri)\s+(?:naam|profile|details?|jankari|account)\b/gi, 'my profile'],
        [/\bsem(?:ester)?\s+kab\s+(?:khatam|khtm|end)\b/gi, 'semester end'],
        [/\b(\d+)\s+se\s+(\d+)\b/gi, '$1 to $2'], [/\bse\b/gi, 'to'], [/\btak\b/gi, ''],
        [/\bpars?o+n?\b/gi, 'day after tomorrow'], [/\bkal\b/gi, 'tomorrow'], [/\baaj\b/gi, 'today'],
        [/\bag(?:le|la|li)\b/gi, 'next'], [/\bhaf(?:te|ta|tey)\b/gi, 'week'], [/\bmahin[ae]\b/gi, 'month'], [/\bdin\b/gi, 'days'],
        [/\bc?hh?ut+i(?:yan|yaan)?\b/gi, 'leave'], [/\bchh?od(?:u|un|na|oon)?\b/gi, 'skip'],
        [/\bsomvaa?r\b/gi, 'monday'], [/\bmangalvaa?r\b/gi, 'tuesday'], [/\bbudhvaa?r\b/gi, 'wednesday'], [/\bguruvaa?r\b/gi, 'thursday'],
        [/\bshukravaa?r\b/gi, 'friday'], [/\bshanivaa?r\b/gi, 'saturday'], [/\bravivaa?r\b/gi, 'sunday'],
        [/\bkitn[aie]\b/gi, 'how many']
    ];

    function normalizeIndic(query) {
        let q = String(query || '');
        const hasDevanagari = /[\u0900-\u097F]/.test(q);
        if (hasDevanagari) {
            q = q.replace(/[०-९]/g, d => HI_DIGITS[d]);
            q = q.replace(/[\u0900-\u097F]+/g, w => (HI_NUMBERS[w] !== undefined ? ` ${HI_NUMBERS[w]} ` : w));
            HI_WORDS.forEach(([re, to]) => { q = q.replace(re, to); });
            q = q.replace(/[\u0900-\u097F]+/g, ' '); // drop leftover Hindi filler words (है, को, का…)
            q = q.replace(/[।?!]/g, ' ');
        }
        HINGLISH_WORDS.forEach(([re, to]) => { q = q.replace(re, to); });
        return q.replace(/\s+/g, ' ').trim();
    }

    // --- Query Pattern Matching Engine ---
    const QUERY_PATTERNS = [
        // MISS/SKIP IMPACT
        {
            patterns: [
                /(?:if\s+i\s+)?(?:miss|skip|bunk|absent)\s+(?:the\s+)?(?:next\s+)?(\d+)/i,
                /impact\s+(?:of\s+)?(?:missing|skipping|bunking)\s+(\d+)/i,
                /what\s+(?:happens|if)\s+.*(?:miss|skip|bunk)\s+(\d+)/i
            ],
            handler: 'handleMissImpact'
        },
        // LONG WEEKEND / BEST BREAK
        {
            patterns: [
                /long\s*week\s*end/i,
                /best\s+break/i,
                /extended\s+(?:break|weekend|leave)/i,
                /when\s+.*(?:take\s+)?(?:a\s+)?break/i,
                /find\s+.*(?:break|weekend|holiday)/i
            ],
            handler: 'handleLongWeekend'
        },
        // MAX SAFE SKIP
        {
            patterns: [
                /max(?:imum)?\s*(?:safe)?\s*(?:skip|bunk|miss|leave|absent)/i,
                /how\s+many\s+(?:can\s+i\s+)?(?:skip|miss|bunk|leave)/i,
                /safe\s+(?:to\s+)?(?:skip|bunk|miss)/i,
                /can\s+i\s+(?:safely?\s+)?(?:skip|miss|bunk)/i,
                /how\s+many\s+classes?\s+can\s+i/i
            ],
            handler: 'handleMaxSafeSkip'
        },
        // CAN I SKIP TODAY
        {
            patterns: [
                /can\s+i\s+(?:skip|bunk|miss)\s+today/i,
                /skip\s+today/i,
                /bunk\s+today/i,
                /today(?:'s)?\s+(?:skip|bunk|impact)/i,
                /should\s+i\s+go\s+today/i
            ],
            handler: 'handleCanISkipToday'
        },
        // WORST / WEAKEST / AT RISK SUBJECTS
        {
            patterns: [
                /(?:worst|weakest|lowest|at\s+risk|risky|danger(?:ous)?|critical|bad)\s*(?:subject|class|course)?s?/i,
                /which\s+(?:subject|class).*(?:worst|bad|low|risk|danger)/i,
                /subjects?\s+(?:at\s+)?risk/i,
                /danger\s+zone/i,
                /below\s+(?:\d+|threshold|limit|required)/i
            ],
            handler: 'handleWorstSubjects'
        },
        // BEST / STRONGEST SUBJECTS
        {
            patterns: [
                /(?:best|strongest|highest|top|safest|good)\s*(?:subject|class|course)?s?/i,
                /which\s+(?:subject|class).*(?:best|good|high|safe)/i
            ],
            handler: 'handleBestSubjects'
        },
        // OVERALL ATTENDANCE / SUMMARY
        {
            patterns: [
                /overall\s+(?:attendance|summary|status|report)/i,
                /my\s+(?:overall|total|current)\s+(?:attendance|status)/i,
                /attendance\s+(?:summary|report|overview|status)/i,
                /how\s+(?:am\s+i\s+doing|is\s+my\s+attendance)/i,
                /^(?:summary|overview|report|status)$/i
            ],
            handler: 'handleOverallSummary'
        },
        // SUBJECT SPECIFIC
        {
            patterns: [
                /(?:about|for|show|tell|info|details?|status\s+of)\s+(.+?)(?:\s+(?:subject|class|course))?$/i,
                /(.+?)\s+(?:attendance|status|details?|info)/i
            ],
            handler: 'handleSubjectQuery'
        },
        // CLASSES TO ATTEND / RECOVERY
        {
            patterns: [
                /how\s+many\s+(?:more\s+)?(?:classes?\s+)?(?:do\s+i\s+)?(?:need|must|have)\s+(?:to\s+)?attend/i,
                /recover(?:y)?\s*(?:plan)?/i,
                /(?:need|must|have)\s+to\s+attend/i,
                /classes?\s+(?:needed|required)/i
            ],
            handler: 'handleRecoveryPlan'
        },
        // TARGET PERCENTAGE
        {
            patterns: [
                /(?:reach|get|achieve|maintain|target)\s+(\d+)\s*%/i,
                /(\d+)\s*%\s+(?:target|goal|reach)/i,
                /what\s+(?:do\s+i\s+)?need\s+(?:for|to\s+reach)\s+(\d+)/i
            ],
            handler: 'handleTargetPercent'
        },
        // PREDICT / FORECAST / TREND
        {
            patterns: [
                /predict(?:ion)?/i,
                /forecast/i,
                /trend/i,
                /end\s+of\s+(?:semester|term)/i,
                /semester\s+end/i,
                /projected\s+(?:attendance|percentage)/i
            ],
            handler: 'handlePrediction'
        },
        // HELP
        {
            patterns: [
                /help/i,
                /what\s+can\s+(?:you|i)\s+(?:ask|do|search)/i,
                /how\s+(?:to\s+use|does\s+this\s+work)/i,
                /example/i,
                /commands?/i
            ],
            handler: 'handleHelp'
        }
    ];

    // --- Query Handlers ---

    function handleMissImpact(query, match) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        let numMiss = 5;
        for (const pattern of QUERY_PATTERNS[0].patterns) {
            const m = query.match(pattern);
            if (m && m[1]) { numMiss = parseInt(m[1]); break; }
        }

        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;

        let subjectRows = '';
        let totalAttended = 0, totalHeld = 0, totalRemaining = 0;
        let subjectsAffected = 0;

        data.forEach(sub => {
            const s = analyzeSubject(sub, minCriteria);
            totalAttended += s.attended;
            totalHeld += s.totalHeld;
            totalRemaining += s.remaining;

            const classesPerDay = sub.schedule ? sub.schedule.reduce((sum, v) => sum + parseScheduleVal(v), 0) / 7 : 1;
            const missForSubject = Math.round(numMiss * (classesPerDay > 0 ? classesPerDay / data.reduce((a, b) => a + (b.schedule ? b.schedule.reduce((s, v) => s + parseScheduleVal(v), 0) / 7 : 1), 0) : 1 / data.length) * data.length);

            const newTotal = s.totalHeld + missForSubject;
            const newPercent = newTotal > 0 ? (s.attended / newTotal) * 100 : 0;
            const drop = s.currentPercent - newPercent;
            const status = newPercent >= minPercent ? (newPercent >= 85 ? 'safe' : 'warning') : 'danger';

            if (newPercent < minPercent) subjectsAffected++;

            subjectRows += `<tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td>${s.currentPercent.toFixed(1)}%</td>
                <td>${newPercent.toFixed(1)}%</td>
                <td><span class="si-badge ${status}">${drop > 0 ? '↓' : '→'} ${drop.toFixed(1)}%</span></td>
            </tr>`;
        });

        const overallCurrent = totalHeld > 0 ? (totalAttended / totalHeld) * 100 : 0;
        const overallNew = (totalHeld + numMiss) > 0 ? (totalAttended / (totalHeld + numMiss)) * 100 : 0;
        const overallDrop = overallCurrent - overallNew;
        const overallStatus = overallNew >= minPercent ? 'safe' : 'danger';

        return {
            icon: subjectsAffected > 0 ? '⚠️' : '✅',
            iconClass: subjectsAffected > 0 ? 'warning' : 'safe',
            title: `Impact of Missing ${numMiss} Classes`,
            body: `
                <div class="si-stats-grid">
                    <div class="si-stat-tile">
                        <div class="si-stat-value ${overallStatus}">${overallNew.toFixed(1)}%</div>
                        <div class="si-stat-label">New Overall</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value danger">↓ ${overallDrop.toFixed(1)}%</div>
                        <div class="si-stat-label">Drop</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value ${subjectsAffected > 0 ? 'warning' : 'safe'}">${subjectsAffected}</div>
                        <div class="si-stat-label">At Risk</div>
                    </div>
                </div>
                <p style="margin-top:14px;">If you miss the next <strong>${numMiss}</strong> classes, your overall attendance drops from <strong>${overallCurrent.toFixed(1)}%</strong> to <strong>${overallNew.toFixed(1)}%</strong>. ${subjectsAffected > 0 ? `<span style="color:var(--si-danger);font-weight:600;">${subjectsAffected} subject(s) will fall below ${minPercent}%!</span>` : `You'll still be above the ${minPercent}% threshold.`}</p>
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>Current</th><th>After</th><th>Impact</th></tr></thead>
                    <tbody>${subjectRows}</tbody>
                </table>
            `
        };
    }

    function handleLongWeekend(query) {
        const cls = getSelectedClassObj();
        const data = getAttendanceData();
        if (!cls || !cls.subjects) return noDataResponse();

        const holidays = (cls.holidays || []).map(h => new Date(h + 'T00:00:00'));
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Try to read lastDate from DOM or class
        let lastDateStr = cls.lastDate;
        const lastDateInput = document.getElementById('lastDate');
        if (lastDateInput && lastDateInput.value) lastDateStr = lastDateInput.value;
        if (!lastDateStr) {
            return {
                icon: '⚠️', iconClass: 'warning',
                title: 'Long Weekend Finder',
                body: '<p>Please set a semester end date in your class settings to find long weekends.</p>'
            };
        }

        const lastDate = new Date(lastDateStr + 'T00:00:00');
        const totalClassesPerDay = Array(7).fill(0);
        cls.subjects.forEach(subject => {
            if (subject.schedule) {
                subject.schedule.forEach((numClasses, dayIndex) => {
                    totalClassesPerDay[dayIndex] += parseScheduleVal(numClasses);
                });
            }
        });

        const nonWorkingDays = new Set(holidays.map(d => d.getTime()));
        for (let d = new Date(today); d <= lastDate; d.setDate(d.getDate() + 1)) {
            const dayOfWeek = d.getDay();
            const scheduleIndex = (dayOfWeek === 0) ? 6 : dayOfWeek - 1;
            if (totalClassesPerDay[scheduleIndex] === 0) {
                nonWorkingDays.add(new Date(d).setHours(0, 0, 0, 0));
            }
        }

        const results = [];
        for (let numLeave = 1; numLeave <= 3; numLeave++) {
            const timeline = [];
            for (let d = new Date(today); d <= lastDate; d.setDate(d.getDate() + 1)) {
                const time = new Date(d).setHours(0, 0, 0, 0);
                timeline.push({ date: new Date(time), isWorking: !nonWorkingDays.has(time) });
            }

            let bestBreak = { length: 0, startDate: null, endDate: null, leaveDates: [] };
            for (let i = 0; i < timeline.length; i++) {
                let leavesUsed = 0;
                let currentLength = 0;
                let leaveDatesInBreak = [];
                for (let j = i; j < timeline.length; j++) {
                    if (!timeline[j].isWorking) {
                        currentLength++;
                    } else {
                        if (leavesUsed < numLeave) {
                            leavesUsed++;
                            currentLength++;
                            leaveDatesInBreak.push(timeline[j].date);
                        } else {
                            break;
                        }
                    }
                }
                if (currentLength > bestBreak.length) {
                    bestBreak = {
                        length: currentLength,
                        startDate: timeline[i].date,
                        endDate: timeline[i + currentLength - 1]?.date || timeline[i].date,
                        leaveDates: leaveDatesInBreak
                    };
                }
            }
            if (bestBreak.length > 0) results.push({ numLeave, ...bestBreak });
        }

        if (results.length === 0) {
            return {
                icon: '😢', iconClass: 'neutral',
                title: 'No Long Weekends Found',
                body: '<p>No long weekend opportunities were found before the semester ends.</p>'
            };
        }

        const best = results[results.length - 1];
        const formatDate = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

        let cardsHtml = results.map(r => `
            <div class="si-weekend-card">
                <div class="si-weekend-icon">🏖️</div>
                <div class="si-weekend-info">
                    <h4>${r.length}-Day Break (${r.numLeave} leave${r.numLeave > 1 ? 's' : ''})</h4>
                    <p>${formatDate(r.startDate)} → ${formatDate(r.endDate)}</p>
                    <div class="si-weekend-dates">
                        ${r.leaveDates.map(d => `<span class="si-date-chip">📅 ${formatDate(d)}</span>`).join('')}
                    </div>
                </div>
            </div>
        `).join('');

        return {
            icon: '🏝️', iconClass: 'info',
            title: `Best Long Weekends Found!`,
            body: `<p>Here are the optimal breaks you can take by using <strong>1 to 3 leaves</strong>. The algorithm finds the longest continuous break by combining holidays, weekends, and off-days.</p>${cardsHtml}`
        };
    }

    function handleMaxSafeSkip(query) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;

        let subjectRows = '';
        let totalCanSkip = 0;
        let minCanSkip = Infinity;
        let bottleneck = '';

        data.forEach(sub => {
            const s = analyzeSubject(sub, minCriteria);
            const status = s.maxSkippable > 3 ? 'safe' : (s.maxSkippable > 0 ? 'warning' : 'danger');
            totalCanSkip += s.maxSkippable;
            if (s.maxSkippable < minCanSkip) {
                minCanSkip = s.maxSkippable;
                bottleneck = sub.name || sub.code;
            }

            subjectRows += `<tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td>${s.currentPercent.toFixed(1)}%</td>
                <td><span class="si-badge ${status}">${s.maxSkippable} classes</span></td>
                <td>${s.remaining}</td>
            </tr>`;
        });

        return {
            icon: '🛡️', iconClass: minCanSkip > 0 ? 'safe' : 'danger',
            title: `Maximum Safe Skips`,
            body: `
                <div class="si-stats-grid">
                    <div class="si-stat-tile">
                        <div class="si-stat-value ${minCanSkip > 3 ? 'safe' : minCanSkip > 0 ? 'warning' : 'danger'}">${minCanSkip}</div>
                        <div class="si-stat-label">Min Safe Skip</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value info">${totalCanSkip}</div>
                        <div class="si-stat-label">Total Across All</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value warning">${minPercent}%</div>
                        <div class="si-stat-label">Target</div>
                    </div>
                </div>
                <p style="margin-top:14px;">Your <strong>bottleneck subject</strong> is <strong>${bottleneck}</strong> — you can safely skip only <strong>${minCanSkip}</strong> classes in it without falling below ${minPercent}%.</p>
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>Current %</th><th>Can Skip</th><th>Remaining</th></tr></thead>
                    <tbody>${subjectRows}</tbody>
                </table>
            `
        };
    }

    function handleCanISkipToday(query) {
        const data = getAttendanceData();
        const cls = getSelectedClassObj();
        if (!data.length || !cls || !cls.subjects) return noDataResponse();

        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;
        const today = new Date();
        const dayOfWeek = today.getDay();
        const scheduleIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

        const todayCounts = classesOnDate(cls, formatLocalDateSI(today));
        let todaySubjects = [];
        cls.subjects.forEach(sub => {
            if (todayCounts[sub.code]) {
                const classCount = todayCounts[sub.code];
                if (classCount > 0) {
                    const matchData = data.find(d => d.code === sub.code);
                    if (matchData) {
                        const analysis = analyzeSubject(matchData, minCriteria);
                        todaySubjects.push({
                            ...sub,
                            classCount,
                            analysis,
                            canSkip: analysis.maxSkippable > 0
                        });
                    }
                }
            }
        });

        const examToday = typeof getExamOn === 'function' ? getExamOn(formatLocalDateSI(today)) : null;
        if (examToday) {
            return {
                icon: '📝', iconClass: 'danger',
                title: `No, today is an exam day`,
                body: `<p><strong>${examToday.title}</strong> is today. Attendance is compulsory, so don't skip.</p>`
            };
        }

        if (todaySubjects.length === 0) {
            return {
                icon: '🎉', iconClass: 'safe',
                title: 'No Classes Today!',
                body: `<p>You have <strong>no scheduled classes</strong> today. Enjoy your day off! 🎊</p>`
            };
        }

        const allCanSkip = todaySubjects.every(s => s.canSkip);
        const noneCanSkip = todaySubjects.every(s => !s.canSkip);

        let subjectRows = todaySubjects.map(sub => `
            <tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td>${sub.classCount} class${sub.classCount > 1 ? 'es' : ''}</td>
                <td>${sub.analysis.currentPercent.toFixed(1)}%</td>
                <td><span class="si-badge ${sub.canSkip ? 'safe' : 'danger'}">${sub.canSkip ? '✅ Yes' : '❌ No'}</span></td>
            </tr>
        `).join('');

        return {
            icon: allCanSkip ? '🟢' : noneCanSkip ? '🔴' : '🟡',
            iconClass: allCanSkip ? 'safe' : noneCanSkip ? 'danger' : 'warning',
            title: allCanSkip ? 'Yes, You Can Skip Today! 🎉' : noneCanSkip ? "Don't Skip Today! ⚠️" : 'Selective Skip Possible',
            body: `
                <p>${allCanSkip
                    ? `All <strong>${todaySubjects.length}</strong> classes today can be safely skipped without dropping below ${minPercent}%.`
                    : noneCanSkip
                        ? `<span style="color:var(--si-danger);font-weight:600;">None of today's ${todaySubjects.length} classes can be skipped</span> — you'll fall below ${minPercent}%.`
                        : `Some classes can be skipped, others can't. Check the breakdown below.`
                }</p>
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>Classes</th><th>Current %</th><th>Safe to Skip?</th></tr></thead>
                    <tbody>${subjectRows}</tbody>
                </table>
            `
        };
    }

    function handleWorstSubjects(query) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;

        const sorted = [...data].map(sub => ({
            ...sub,
            analysis: analyzeSubject(sub, minCriteria)
        })).sort((a, b) => a.analysis.currentPercent - b.analysis.currentPercent);

        const atRisk = sorted.filter(s => s.analysis.currentPercent < minPercent);
        const borderline = sorted.filter(s => s.analysis.currentPercent >= minPercent && s.analysis.currentPercent < minPercent + 5);

        let subjectRows = sorted.map(sub => {
            const s = sub.analysis;
            const status = s.currentPercent >= minPercent ? (s.currentPercent >= 85 ? 'safe' : 'warning') : 'danger';
            return `<tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td>${s.currentPercent.toFixed(1)}%</td>
                <td>${s.withoutPercent.toFixed(1)}%</td>
                <td>${s.attended}/${s.totalHeld}</td>
                <td><span class="si-badge ${status}">${s.stillNeed > 0 ? `Need ${s.stillNeed}` : '✅ Safe'}</span></td>
            </tr>`;
        }).join('');

        return {
            icon: '🚨', iconClass: atRisk.length > 0 ? 'danger' : 'warning',
            title: `${atRisk.length} Subject${atRisk.length !== 1 ? 's' : ''} at Risk`,
            body: `
                <div class="si-stats-grid">
                    <div class="si-stat-tile">
                        <div class="si-stat-value danger">${atRisk.length}</div>
                        <div class="si-stat-label">Below ${minPercent}%</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value warning">${borderline.length}</div>
                        <div class="si-stat-label">Borderline</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value safe">${sorted.length - atRisk.length - borderline.length}</div>
                        <div class="si-stat-label">Safe</div>
                    </div>
                </div>
                ${atRisk.length > 0 ? `<p style="margin-top:14px;color:var(--si-danger);font-weight:600;">⚠️ ${atRisk.map(s => s.name || s.code).join(', ')} ${atRisk.length > 1 ? 'are' : 'is'} below the required ${minPercent}%!</p>` : '<p style="margin-top:14px;">No subjects are currently below the threshold. Keep it up! 💪</p>'}
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>With OD/ML</th><th>Without</th><th>Attended</th><th>Status</th></tr></thead>
                    <tbody>${subjectRows}</tbody>
                </table>
            `
        };
    }

    function handleBestSubjects(query) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        const minCriteria = getMinCriteria();
        const sorted = [...data].map(sub => ({
            ...sub,
            analysis: analyzeSubject(sub, minCriteria)
        })).sort((a, b) => b.analysis.currentPercent - a.analysis.currentPercent);

        let subjectRows = sorted.map(sub => {
            const s = sub.analysis;
            return `<tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td style="color:var(--si-safe);font-weight:600;">${s.currentPercent.toFixed(1)}%</td>
                <td>${s.withoutPercent.toFixed(1)}%</td>
                <td>${s.attended}/${s.totalHeld}</td>
                <td><span class="si-badge safe">Can skip ${s.maxSkippable}</span></td>
            </tr>`;
        }).join('');

        return {
            icon: '🏆', iconClass: 'safe',
            title: 'Your Strongest Subjects',
            body: `
                <p>Here are your best-performing subjects ranked by attendance percentage. These have the most room for safe skips.</p>
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>With OD/ML</th><th>Without</th><th>Attended</th><th>Buffer</th></tr></thead>
                    <tbody>${subjectRows}</tbody>
                </table>
            `
        };
    }

    function handleOverallSummary(query) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;

        let totalAttended = 0, totalHeld = 0, totalRemaining = 0, totalOdml = 0;
        let safe = 0, warning = 0, danger = 0;
        let totalCanSkip = 0;

        data.forEach(sub => {
            const s = analyzeSubject(sub, minCriteria);
            totalAttended += s.attended;
            totalHeld += s.totalHeld;
            totalRemaining += s.remaining;
            totalOdml += s.odml;
            totalCanSkip += s.maxSkippable;
            if (s.status === 'safe') safe++;
            else if (s.status === 'warning') warning++;
            else danger++;
        });

        const overallPercent = totalHeld > 0 ? (totalAttended / totalHeld) * 100 : 0;
        const overallWithout = totalHeld > 0 ? ((totalAttended - totalOdml) / totalHeld) * 100 : 0;
        const projectedMax = (totalHeld + totalRemaining) > 0 ? ((totalAttended + totalRemaining) / (totalHeld + totalRemaining)) * 100 : 0;
        const overallStatus = overallPercent >= minPercent ? (overallPercent >= 85 ? 'safe' : 'info') : 'danger';

        return {
            icon: overallPercent >= minPercent ? '📊' : '📉',
            iconClass: overallStatus,
            title: `Overall Attendance: ${overallPercent.toFixed(1)}%`,
            body: `
                <div class="si-progress-bar">
                    <div class="si-progress-fill ${overallStatus}" style="width: ${Math.min(overallPercent, 100)}%"></div>
                </div>
                <p style="margin:10px 0 0;"><strong>${overallPercent.toFixed(1)}%</strong> with OD/ML · <strong>${overallWithout.toFixed(1)}%</strong> without OD/ML${totalOdml ? ` (${totalOdml} OD/ML hours)` : ''}</p>
                <div class="si-stats-grid" style="margin-top:16px;">
                    <div class="si-stat-tile">
                        <div class="si-stat-value">${totalAttended}/${totalHeld}</div>
                        <div class="si-stat-label">Attended</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value info">${totalRemaining}</div>
                        <div class="si-stat-label">Remaining</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value safe">${totalCanSkip}</div>
                        <div class="si-stat-label">Can Skip</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value">${projectedMax.toFixed(1)}%</div>
                        <div class="si-stat-label">Max Possible</div>
                    </div>
                </div>
                <p style="margin-top:14px;">You have <strong>${data.length}</strong> subjects: <span style="color:var(--si-safe);font-weight:600;">${safe} safe</span>${warning > 0 ? `, <span style="color:var(--si-warning);font-weight:600;">${warning} borderline</span>` : ''}${danger > 0 ? `, <span style="color:var(--si-danger);font-weight:600;">${danger} at risk</span>` : ''}.</p>
            `
        };
    }

    function handleSubjectQuery(query, match) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        // Try to extract subject name from query
        let searchTerm = query.toLowerCase()
            .replace(/(?:about|for|show|tell|info|details?|status\s+of|attendance|subject|class|course)\s*/gi, '')
            .trim();

        const found = data.find(sub =>
            (sub.name && sub.name.toLowerCase().includes(searchTerm)) ||
            (sub.code && sub.code.toLowerCase().includes(searchTerm)) ||
            (sub.shortName && sub.shortName.toLowerCase().includes(searchTerm))
        );

        if (!found) {
            // Fallback: try overall summary
            return handleOverallSummary(query);
        }

        const minCriteria = getMinCriteria();
        const s = analyzeSubject(found, minCriteria);
        const status = s.status;
        const minPercent = minCriteria * 100;

        return {
            icon: status === 'safe' ? '✅' : status === 'warning' ? '⚠️' : '🔴',
            iconClass: status,
            title: `${found.name || found.code}`,
            body: `
                <div class="si-progress-bar">
                    <div class="si-progress-fill ${status}" style="width: ${Math.min(s.currentPercent, 100)}%"></div>
                </div>
                <div class="si-stats-grid" style="margin-top:16px;">
                    <div class="si-stat-tile">
                        <div class="si-stat-value ${status}">${s.currentPercent.toFixed(1)}%</div>
                        <div class="si-stat-label">With OD/ML</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value">${s.withoutPercent.toFixed(1)}%</div>
                        <div class="si-stat-label">Without OD/ML</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value">${s.attended}/${s.totalHeld}</div>
                        <div class="si-stat-label">Attended</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value ${s.maxSkippable > 0 ? 'safe' : 'danger'}">${s.maxSkippable}</div>
                        <div class="si-stat-label">Can Skip</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value info">${s.remaining}</div>
                        <div class="si-stat-label">Remaining</div>
                    </div>
                </div>
                <p style="margin-top:14px;">
                    ${s.stillNeed > 0
                    ? `You need to attend <strong>${s.stillNeed} more classes</strong> to reach ${minPercent}%.`
                    : `You can safely miss up to <strong>${s.maxSkippable} classes</strong> and still stay above ${minPercent}%.`
                }
                    ${s.projectedMax < minPercent
                    ? ` <span style="color:var(--si-danger);font-weight:600;">⚠️ Even attending all remaining classes, you'll max out at ${s.projectedMax.toFixed(1)}%.</span>`
                    : ''}
                </p>
                ${(() => {
                    const plan = s.odml && typeof odmlPlanText === 'function' ? odmlPlanText(found.name || found.code, s.allowancePlan, s.remaining, minPercent) : null;
                    return plan ? `<div class="si-notes" style="margin-top:12px;"><p><strong>OD / ML plan</strong></p>${plan.lines.map(l => `<p>${l}</p>`).join('')}</div>` : '';
                })()}
            `
        };
    }

    function handleRecoveryPlan(query) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;

        const needRecovery = data.map(sub => ({
            ...sub,
            analysis: analyzeSubject(sub, minCriteria)
        })).filter(s => s.analysis.stillNeed > 0).sort((a, b) => b.analysis.stillNeed - a.analysis.stillNeed);

        if (needRecovery.length === 0) {
            return {
                icon: '🎉', iconClass: 'safe',
                title: 'All Subjects on Track!',
                body: `<p>Great news! All your subjects are already above <strong>${minPercent}%</strong>. No recovery needed. 🎊</p>`
            };
        }

        let rows = needRecovery.map(sub => {
            const s = sub.analysis;
            const canRecover = s.stillNeed <= s.remaining;
            return `<tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td>${s.currentPercent.toFixed(1)}%</td>
                <td style="font-weight:600;color:${canRecover ? 'var(--si-warning)' : 'var(--si-danger)'};">${s.stillNeed} classes</td>
                <td><span class="si-badge ${canRecover ? 'warning' : 'danger'}">${canRecover ? 'Recoverable' : 'Unrecoverable'}</span></td>
            </tr>`;
        }).join('');

        const unrecoverable = needRecovery.filter(s => s.analysis.stillNeed > s.analysis.remaining);

        return {
            icon: '📋', iconClass: unrecoverable.length > 0 ? 'danger' : 'warning',
            title: `Recovery Plan — ${needRecovery.length} Subject${needRecovery.length > 1 ? 's' : ''} Need Attention`,
            body: `
                ${unrecoverable.length > 0 ? `<p style="color:var(--si-danger);font-weight:600;">⚠️ ${unrecoverable.length} subject(s) cannot reach ${minPercent}% even with perfect attendance!</p>` : ''}
                <p>Here's what you need to attend to get back on track:</p>
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>Current</th><th>Need to Attend</th><th>Status</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            `
        };
    }

    function handleTargetPercent(query, match) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        let targetPercent = 75;
        for (const pattern of QUERY_PATTERNS.find(p => p.handler === 'handleTargetPercent').patterns) {
            const m = query.match(pattern);
            if (m) {
                const val = parseInt(m[1] || m[2]);
                if (val) { targetPercent = val; break; }
            }
        }

        const targetDecimal = targetPercent / 100;

        let rows = data.map(sub => {
            const s = analyzeSubject(sub, targetDecimal);
            const canReach = s.projectedMax >= targetPercent;
            return `<tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td>${s.currentPercent.toFixed(1)}%</td>
                <td>${s.stillNeed > 0 ? `${s.stillNeed} more` : '✅ Already there'}</td>
                <td><span class="si-badge ${canReach ? (s.stillNeed > 0 ? 'warning' : 'safe') : 'danger'}">${canReach ? (s.maxSkippable > 0 ? `Can skip ${s.maxSkippable}` : 'Tight') : 'Cannot reach'}</span></td>
            </tr>`;
        }).join('');

        return {
            icon: '🎯', iconClass: 'info',
            title: `Target: ${targetPercent}% Attendance`,
            body: `
                <p>Here's what each subject needs to reach <strong>${targetPercent}%</strong>:</p>
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>Current</th><th>Need</th><th>Status</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            `
        };
    }

    function handlePrediction(query) {
        const data = getAttendanceData();
        if (!data.length) return noDataResponse();

        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;

        let rows = '';
        let totalAttended = 0, totalHeld = 0, totalRemaining = 0;

        data.forEach(sub => {
            const s = analyzeSubject(sub, minCriteria);
            totalAttended += s.attended;
            totalHeld += s.totalHeld;
            totalRemaining += s.remaining;

            // Realistic projection: assume current trend continues
            const trendRate = s.totalHeld > 0 ? s.attended / s.totalHeld : 0.75;
            const projectedAttend = Math.round(s.remaining * trendRate);
            const projectedPercent = s.finalTotal > 0 ? ((s.attended + projectedAttend) / s.finalTotal) * 100 : 0;
            const status = projectedPercent >= minPercent ? (projectedPercent >= 85 ? 'safe' : 'info') : 'danger';

            rows += `<tr>
                <td><strong>${sub.name || sub.code}</strong></td>
                <td>${s.currentPercent.toFixed(1)}%</td>
                <td style="font-weight:600;color:var(--si-${status});">${projectedPercent.toFixed(1)}%</td>
                <td>${s.projectedMax.toFixed(1)}%</td>
            </tr>`;
        });

        const overallTrend = totalHeld > 0 ? totalAttended / totalHeld : 0.75;
        const projectedAttendAll = Math.round(totalRemaining * overallTrend);
        const projectedOverall = (totalHeld + totalRemaining) > 0 ? ((totalAttended + projectedAttendAll) / (totalHeld + totalRemaining)) * 100 : 0;

        return {
            icon: '🔮', iconClass: projectedOverall >= minPercent ? 'info' : 'danger',
            title: `Semester End Prediction`,
            body: `
                <div class="si-stats-grid">
                    <div class="si-stat-tile">
                        <div class="si-stat-value ${projectedOverall >= minPercent ? 'info' : 'danger'}">${projectedOverall.toFixed(1)}%</div>
                        <div class="si-stat-label">Predicted Final</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value">${(overallTrend * 100).toFixed(0)}%</div>
                        <div class="si-stat-label">Current Trend</div>
                    </div>
                    <div class="si-stat-tile">
                        <div class="si-stat-value info">${totalRemaining}</div>
                        <div class="si-stat-label">Classes Left</div>
                    </div>
                </div>
                <p style="margin-top:14px;">Based on your current attendance trend (<strong>${(overallTrend * 100).toFixed(0)}%</strong> rate), here's the predicted end-of-semester attendance:</p>
                <table class="si-subject-table">
                    <thead><tr><th>Subject</th><th>Current</th><th>Predicted</th><th>Max Possible</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            `
        };
    }

    function handleHelp(query) {
        return {
            icon: '💡', iconClass: 'info',
            title: 'What Can You Ask?',
            body: `
                <p>Ask anything about your attendance! Here are some examples:</p>
                <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px;">
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('If I take a break from 3 Oct to 5 Oct, what is the impact?')" style="cursor:pointer;">
                        <i class="fa-solid fa-plane-departure"></i> "If I take a break from 3 Oct to 5 Oct?"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Can I skip next Friday?')" style="cursor:pointer;">
                        <i class="fa-solid fa-calendar-xmark"></i> "Can I skip next Friday?"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('If I miss next 5 classes what happens?')" style="cursor:pointer;">
                        <i class="fa-solid fa-forward"></i> "If I miss 5 classes, what happens?"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Can I skip today?')" style="cursor:pointer;">
                        <i class="fa-solid fa-calendar-day"></i> "Can I skip today?"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Max safe skip')" style="cursor:pointer;">
                        <i class="fa-solid fa-shield-halved"></i> "How many classes can I safely skip?"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Find long weekends')" style="cursor:pointer;">
                        <i class="fa-solid fa-umbrella-beach"></i> "Find long weekends"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Worst subjects')" style="cursor:pointer;">
                        <i class="fa-solid fa-triangle-exclamation"></i> "Which subjects are at risk?"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Overall summary')" style="cursor:pointer;">
                        <i class="fa-solid fa-chart-pie"></i> "Overall attendance summary"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Prediction')" style="cursor:pointer;">
                        <i class="fa-solid fa-crystal-ball"></i> "Predict my semester end attendance"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Recovery plan')" style="cursor:pointer;">
                        <i class="fa-solid fa-road"></i> "Recovery plan"
                    </div>
                    <div class="si-chip" onclick="window.SmartSearch.runQuery('Reach 80%')" style="cursor:pointer;">
                        <i class="fa-solid fa-bullseye"></i> "What do I need to reach 80%?"
                    </div>
                </div>
                <p style="margin-top:16px;"><strong>Your data</strong></p>
                <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
                    ${[
                        ['fa-umbrella-beach', 'Holiday list', 'Upcoming holidays'],
                        ['fa-briefcase-medical', 'OD and medical leave used', 'OD / medical leave used'],
                        ['fa-file-pen', 'Exam dates', 'Exam dates'],
                        ['fa-calendar-day', "Today's timetable", "Today's timetable"],
                        ['fa-user', 'My profile', 'My profile & settings'],
                        ['fa-hourglass-half', 'When does the semester end', 'Semester end & days left'],
                        ['fa-list-check', 'Unmarked days', 'Days not marked yet']
                    ].map(([icon, q, label]) => `<div class="si-chip" onclick="window.SmartSearch.runQuery('${q.replace(/'/g, "\\'")}')" style="cursor:pointer;"><i class="fa-solid ${icon}"></i> "${label}"</div>`).join('')}
                </div>
                <p style="margin-top:12px;font-size:0.85rem;">You can also ask in Hindi or Hinglish, by typing or with the 🎤.</p>
            `
        };
    }



    // --- Main Query Processor ---
    // ============================================================
    // INFO ANSWERS: holidays, OD/ML, exams, timetable, profile, semester, missed days
    // ============================================================
    const INFO_RULES = [
        { handler: 'handleProfileInfo', re: /\b(?:my\s+(?:profile|details|account|info|information|name|reg(?:istration)?(?:\s+(?:no|number))?|roll(?:\s+(?:no|number))?|college|branch|department|semester|sem|email|phone|number|class)|who\s+am\s+i|account\s+(?:info|details|information)|profile)\b/i },
        { handler: 'handleSemesterInfo', re: /\b(?:semester|sem|classes?)\s+(?:end|ends|start|starts|dates?|over|finish(?:es)?|left)\b|\b(?:last|final)\s+(?:working\s+)?day\b|\b(?:how\s+many\s+)?(?:days|weeks|class\s+days)\s+(?:are\s+)?left\b|\bwhen\s+does\s+(?:the\s+)?(?:semester|sem|classes?)\b/i },
        { handler: 'handleExamInfo', re: /\b(?:exams?|examinations?|mid\s*-?\s*terms?|mid\s*-?\s*sems?|end\s*-?\s*sems?|practical\s+exams?|test\s+dates?|compulsory\s+days?)\b/i },
        { handler: 'handleOdmlInfo', re: /\b(?:od\s*\/\s*ml|odml|duty\s+leaves?|medical(?:\s+leaves?)?|ods|od\s+(?:used|left|hours|dates|taken|count|status|details|allowance|remaining)|ml\s+(?:used|left|hours|dates|taken|count|status|details|allowance|remaining)|allowance)\b/i },
        { handler: 'handleMissedDays', re: /\b(?:unmarked|not\s+marked|missed\s+days?|pending\s+(?:days?|marks?|attendance)|forgot\s+to\s+mark|days?\s+(?:i\s+)?(?:have\s+)?not\s+marked)\b/i },
        { handler: 'handleHolidayInfo', re: /\b(?:holidays?|shifted\s+days?|compensat\w*|make\s*-?\s*up\s+days?)\b/i },
        { handler: 'handleTimetableInfo', re: /\b(?:time\s*-?\s*table|schedule)\b|\bwhat\s+(?:classes|periods|lectures)\b|\b(?:today'?s?|tomorrow'?s?)\s+(?:classes|periods|lectures)\b|\b(?:classes|periods|lectures)\s+(?:on|for|today|tomorrow)\b/i }
    ];
    // Questions that plan a leave go to leave planning, not to the info answers
    const PLANNING_RE = /\b(?:can\s+i|should\s+i|what\s+if|if\s+i|take|taking|apply|skip|miss|bunk|plan|impact|safe\s+to)\b/i;

    function infoHandlerFor(query, parsed) {
        for (const rule of INFO_RULES) {
            if (!rule.re.test(query)) continue;
            // "can I take medical leave on 5 oct?" / "can I skip on the holiday?" → planning
            if (PLANNING_RE.test(query) && parsed && ['handleOdmlInfo', 'handleHolidayInfo', 'handleExamInfo'].includes(rule.handler)) return null;
            if (rule.handler === 'handleTimetableInfo' && /\b(?:skip|miss|bunk|leave|can\s+i)\b/i.test(query)) return null;
            return rule.handler;
        }
        return null;
    }

    function clsName() {
        return document.getElementById('classSelector')?.value || getSelectedClassObj()?.name || '';
    }

    function todayStrSI() {
        const t = new Date(); t.setHours(0, 0, 0, 0);
        return formatLocalDateSI(t);
    }

    function shiftDays(dateStr, n) {
        return formatLocalDateSI(addDays(new Date(dateStr + 'T00:00:00'), n));
    }

    function fmtLong(dateStr) {
        return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }

    function daysBetween(a, b) {
        return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
    }

    function subjectName(cls, code) {
        const s = (cls.subjects || []).find(x => x.code === code);
        return s ? (s.name || code) : code;
    }

    // Group sorted dates into ranges: [{from, to, days}]
    function toRanges(dates) {
        const out = [];
        dates.slice().sort().forEach(d => {
            const last = out[out.length - 1];
            if (last && shiftDays(last.to, 1) === d) { last.to = d; last.days++; }
            else out.push({ from: d, to: d, days: 1 });
        });
        return out;
    }

    function rangeText(r) {
        return r.from === r.to ? fmtShort(r.from) : `${fmtShort(r.from)} → ${fmtShort(r.to)} (${r.days} days)`;
    }

    // Ordered periods on a date: [{ code, name }] (null = free period)
    function periodsOn(cls, dateStr) {
        if ((cls.holidays || []).includes(dateStr)) return [];
        const name = clsName();
        let custom = null;
        try { custom = JSON.parse(localStorage.getItem(`custom_schedules_${name}`) || '{}')[dateStr]; } catch (e) { /* none */ }
        const map = (codes) => codes.map(c => (c ? { code: c, name: subjectName(cls, c) } : null));
        if (custom && Array.isArray(custom._periods)) return map(custom._periods);
        const dow = new Date(dateStr + 'T00:00:00').getDay();
        const dayIndex = dow === 0 ? 6 : dow - 1;
        const arrangement = typeof getTimetableArrangement === 'function' ? getTimetableArrangement(name, dateStr) : null;
        const dayArr = arrangement && arrangement[dayIndex];
        if (Array.isArray(dayArr) && dayArr.length) {
            const codes = dayArr.map(i => (i && typeof i === 'object' ? i.code : i) || null);
            while (codes.length && !codes[codes.length - 1]) codes.pop();
            return map(codes);
        }
        const list = [];
        const count = (v) => (!v || v === '0') ? 0 : typeof v === 'number' ? v : String(v).split(',').filter(x => x.trim() && x.trim() !== '0').length;
        (cls.subjects || []).forEach(s => { for (let i = 0; i < count(s.schedule ? s.schedule[dayIndex] : 0); i++) list.push(s.code); });
        return map(list);
    }

    function dayChangeFor(cls, dateStr) {
        return (cls.dayChanges || []).find(c => (c.type === 'shift' && (c.off === dateStr || c.on === dateStr)) || (c.type === 'holiday' && c.dates.includes(dateStr))) || null;
    }

    function examOn(dateStr) {
        return typeof getExamOn === 'function' ? getExamOn(dateStr) : null;
    }

    function noClassResponse() {
        return noDataResponse();
    }

    // ---------- Holidays ----------
    function handleHolidayInfo(query) {
        const cls = getSelectedClassObj();
        if (!cls) return noClassResponse();
        const t = todayStrSI();
        const holidays = (cls.holidays || []).slice().sort();
        const parsed = parseDateQuery(query, cls);
        const monthMatch = query.toLowerCase().match(new RegExp(`\\b(?:in|of|during)?\\s*${MONTH_RE}\\b`));
        const asksList = /\b(list|all|upcoming|next|when|how\s+many|which|show|kab)\b/i.test(query) || !parsed;

        // "Is 2 Oct a holiday?" → status of each date
        if (parsed && !/\b(list|all|upcoming|how\s+many)\b/i.test(query) && !(monthMatch && /\bholidays\b/i.test(query))) {
            const rows = parsed.dates.slice(0, 14).map(d => {
                const change = dayChangeFor(cls, d);
                const exam = examOn(d);
                let status;
                if ((cls.holidays || []).includes(d)) status = `🏖️ <strong>Holiday</strong>${change?.reason ? ` (${escapeHtml(change.reason)})` : change?.type === 'shift' ? ` (classes moved to ${fmtShort(change.on)})` : ''}`;
                else if ((cls.portalSetup?.semesterStartDate && d < cls.portalSetup.semesterStartDate) || (cls.lastDate && d > cls.lastDate)) status = 'Outside the semester';
                else {
                    const n = periodsOn(cls, d).filter(Boolean).length;
                    status = n ? `📚 Class day · ${n} class${n !== 1 ? 'es' : ''}${change?.type === 'shift' && change.on === d ? ` (shifted from ${fmtShort(change.off)})` : ''}` : 'No classes (off day)';
                }
                return `<tr><td><strong>${fmtShort(d)}</strong></td><td>${status}${exam ? ` · <span style="color:var(--si-danger);font-weight:700;">📝 ${escapeHtml(exam.title)}</span>` : ''}</td></tr>`;
            }).join('');
            const allHoliday = parsed.dates.every(d => (cls.holidays || []).includes(d));
            return {
                icon: '🏖️', iconClass: allHoliday ? 'safe' : 'info',
                title: parsed.dates.length === 1 ? (allHoliday ? `${fmtShort(parsed.dates[0])} is a holiday` : `${fmtShort(parsed.dates[0])} is not a holiday`) : `Holiday check: ${describeRanges(parsed.ranges)}`,
                body: `<table class="si-subject-table"><thead><tr><th>Date</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
            };
        }

        let list = holidays;
        let scope = '';
        if (monthMatch && asksList) {
            const m = monthIdx(monthMatch[1]);
            list = holidays.filter(d => new Date(d + 'T00:00:00').getMonth() === m);
            scope = ` in ${new Date(2000, m, 1).toLocaleDateString('en-IN', { month: 'long' })}`;
        }
        const upcoming = list.filter(d => d >= t);
        const past = list.filter(d => d < t);
        const next = holidays.find(d => d >= t);
        const ranges = toRanges(upcoming);
        const shifts = (cls.dayChanges || []).filter(c => c.type === 'shift');
        const reasons = {};
        (cls.dayChanges || []).filter(c => c.type === 'holiday' && c.reason).forEach(c => c.dates.forEach(d => { reasons[d] = c.reason; }));

        return {
            icon: '🏖️', iconClass: 'info',
            title: scope
                ? `${list.length} holiday${list.length !== 1 ? 's' : ''}${scope}${upcoming.length !== list.length ? ` (${upcoming.length} upcoming)` : ''}`
                : next ? `Next holiday: ${fmtShort(next)}${daysBetween(t, next) === 0 ? ' (today)' : daysBetween(t, next) === 1 ? ' (tomorrow)' : ` (in ${daysBetween(t, next)} days)`}` : 'No upcoming holidays',
            body: `
                <div class="si-stats-grid">
                    <div class="si-stat-tile"><div class="si-stat-value info">${upcoming.length}</div><div class="si-stat-label">Upcoming${scope}</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value">${past.length}</div><div class="si-stat-label">Already passed</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value">${list.length}</div><div class="si-stat-label">Total${scope}</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value">${shifts.length}</div><div class="si-stat-label">Shifted days</div></div>
                </div>
                ${ranges.length ? `<table class="si-subject-table" style="margin-top:14px;"><thead><tr><th>Upcoming holidays${scope}</th><th>Note</th></tr></thead><tbody>
                    ${ranges.slice(0, 12).map(r => `<tr><td><strong>${rangeText(r)}</strong></td><td>${escapeHtml(reasons[r.from] || '')}</td></tr>`).join('')}
                </tbody></table>${ranges.length > 12 ? `<p>…and ${ranges.length - 12} more.</p>` : ''}` : `<p style="margin-top:14px;">No upcoming holidays${scope} in your class.</p>`}
                ${shifts.length ? `<p style="margin-top:12px;"><strong>Shifted days:</strong> ${shifts.map(c => `${fmtShort(c.off)} → classes on ${fmtShort(c.on)}`).join(', ')}</p>` : ''}
                <p style="margin-top:12px;font-size:0.85rem;">Add a sudden holiday or a shifted day from <strong>Attendance → Period-wise → Day changes</strong>.</p>`
        };
    }

    // ---------- OD / ML ----------
    function handleOdmlInfo(query) {
        const data = getAttendanceData();
        const cls = getSelectedClassObj();
        if (!data.length || !cls) return noDataResponse();
        const minCriteria = getMinCriteria();
        const minPercent = minCriteria * 100;
        const onlyMedical = /\b(medical|ml)\b/i.test(query) && !/\b(od|duty)\b/i.test(query);
        const onlyOd = /\b(od|duty)\b/i.test(query) && !/\b(medical|ml)\b/i.test(query);

        // Every OD/ML mark in the logs, by date
        let logs = {};
        try { logs = JSON.parse(localStorage.getItem('attendance_logs') || '{}'); } catch (e) { /* none */ }
        const codes = new Set((cls.subjects || []).map(s => s.code));
        const byDate = {};
        let odCount = 0, mlCount = 0;
        Object.keys(logs).sort().forEach(d => {
            Object.keys(logs[d] || {}).forEach(k => {
                const code = k.split('_p')[0];
                if (!codes.has(code)) return;
                const st = String(logs[d][k] || '').toUpperCase();
                const isOd = st.includes('(OD)') || st === 'OD';
                const isMl = st.includes('(ML)') || st === 'ML';
                if (!isOd && !isMl) return;
                if (isOd) odCount++; else mlCount++;
                if ((onlyMedical && !isMl) || (onlyOd && !isOd)) return;
                byDate[d] = byDate[d] || { od: 0, ml: 0, subjects: new Set() };
                byDate[d][isOd ? 'od' : 'ml']++;
                byDate[d].subjects.add(subjectName(cls, code));
            });
        });

        const rule = typeof getOdmlRule === 'function' ? getOdmlRule() : null;
        const ruleText = window.ProfileTools?.ruleSummary ? ProfileTools.ruleSummary() : '';
        const rows = data.map(sub => {
            const a = analyzeSubject(sub, minCriteria);
            const split = typeof attendanceSplit === 'function' ? attendanceSplit(sub.attended, sub.totalHeld, sub.odml, sub.remaining) : null;
            return { sub, a, split };
        });
        const tableRows = rows.filter(r => r.split).map(r => {
            const s = r.split;
            const allowanceCell = s.allowance !== null
                ? `${Math.min(s.odml, s.allowance)} / ${s.allowance}${s.odmlUnused ? ` <span style="color:var(--si-danger);">(+${s.odmlUnused} over)</span>` : ''}`
                : `${s.odmlCounted} of ${s.odml}`;
            return `<tr><td><strong>${escapeHtml(r.sub.name || r.sub.code)}</strong></td><td>${s.odml}</td><td>${allowanceCell}</td><td>${s.withoutPct.toFixed(1)}%</td><td>${s.withPct.toFixed(1)}%</td></tr>`;
        }).join('');

        const totalUsed = rows.reduce((n, r) => n + (r.split?.odml || 0), 0);
        const totalAllowance = rule?.mode === 'allowance' ? rows.reduce((n, r) => n + (r.split?.allowance || 0), 0) : null;
        const dates = Object.keys(byDate).sort().reverse();
        const plans = rows.filter(r => r.split?.odml && r.a.allowancePlan && typeof odmlPlanText === 'function')
            .map(r => odmlPlanText(r.sub.name || r.sub.code, r.a.allowancePlan, r.a.remaining, minPercent)).filter(Boolean);
        const records = (cls.leaveRecords || []).slice().reverse().slice(0, 5);
        const label = onlyMedical ? 'Medical leave' : onlyOd ? 'OD (duty leave)' : 'OD / Medical leave';

        return {
            icon: '🏥', iconClass: rows.some(r => r.split && !r.split.eligible && r.split.odml) ? 'danger' : 'info',
            title: `${label}: ${onlyMedical ? mlCount : onlyOd ? odCount : odCount + mlCount} hour${(onlyMedical ? mlCount : onlyOd ? odCount : odCount + mlCount) !== 1 ? 's' : ''} marked`,
            body: `
                <div class="si-stats-grid">
                    <div class="si-stat-tile"><div class="si-stat-value info">${odCount}</div><div class="si-stat-label">OD hours</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value info">${mlCount}</div><div class="si-stat-label">Medical hours</div></div>
                    ${totalAllowance !== null ? `<div class="si-stat-tile"><div class="si-stat-value">${totalUsed} / ${totalAllowance}</div><div class="si-stat-label">Allowance used</div></div>` : ''}
                    <div class="si-stat-tile"><div class="si-stat-value">${dates.length}</div><div class="si-stat-label">Days with ${onlyMedical ? 'ML' : onlyOd ? 'OD' : 'OD/ML'}</div></div>
                </div>
                ${ruleText ? `<p style="margin-top:12px;"><strong>Rule:</strong> ${escapeHtml(ruleText)}</p>` : ''}
                <table class="si-subject-table"><thead><tr><th>Subject</th><th>OD/ML</th><th>${rule?.mode === 'allowance' ? 'Allowance' : 'Counted'}</th><th>Own</th><th>With OD/ML</th></tr></thead><tbody>${tableRows}</tbody></table>
                ${dates.length ? `<p style="margin-top:14px;"><strong>Dates</strong></p>
                    <table class="si-subject-table"><tbody>${dates.slice(0, 10).map(d => `<tr><td><strong>${fmtShort(d)}</strong></td><td>${byDate[d].od ? `${byDate[d].od} OD` : ''}${byDate[d].od && byDate[d].ml ? ' + ' : ''}${byDate[d].ml ? `${byDate[d].ml} ML` : ''}</td><td>${[...byDate[d].subjects].map(escapeHtml).join(', ')}</td></tr>`).join('')}</tbody></table>
                    ${dates.length > 10 ? `<p>…and ${dates.length - 10} more days.</p>` : ''}` : `<p style="margin-top:12px;">No ${label.toLowerCase()} marked yet. Use <strong>Profile → Mark OD / Medical leave</strong> to add it for a date range.</p>`}
                ${plans.length ? `<div class="si-notes" style="margin-top:14px;">${plans.map(p => `<p><strong>${escapeHtml(p.title)}</strong></p>${p.lines.map(l => `<p>${l}</p>`).join('')}`).join('')}</div>` : ''}
                ${records.length ? `<p style="margin-top:12px;font-size:0.85rem;"><strong>Added from Profile:</strong> ${records.map(r => `${r.type === 'ml' ? 'ML' : 'OD'} ${fmtShort(r.from)}${r.to !== r.from ? `–${fmtShort(r.to)}` : ''} (${r.classes})`).join(', ')}</p>` : ''}`
        };
    }

    // ---------- Exams ----------
    function handleExamInfo() {
        const cls = getSelectedClassObj();
        if (!cls) return noClassResponse();
        const t = todayStrSI();
        const exams = (cls.examDays || []).slice().sort((a, b) => a.from.localeCompare(b.from));
        const upcoming = exams.filter(e => (e.to || e.from) >= t);
        const past = exams.filter(e => (e.to || e.from) < t);
        const next = upcoming[0];
        const when = (e) => {
            if (e.from <= t) return 'ongoing';
            const n = daysBetween(t, e.from);
            return n === 1 ? 'tomorrow' : `in ${n} days`;
        };
        return {
            icon: '📝', iconClass: next && daysBetween(t, next.from) <= 3 ? 'warning' : 'info',
            title: next ? `Next exam: ${next.title || 'Exam'} (${when(next)})` : 'No upcoming exams',
            body: `
                ${upcoming.length ? `<table class="si-subject-table"><thead><tr><th>Exam</th><th>Dates</th><th>When</th></tr></thead><tbody>
                    ${upcoming.map(e => `<tr><td><strong>${escapeHtml(e.title || 'Exam')}</strong></td><td>${fmtShort(e.from)}${e.to && e.to !== e.from ? ` → ${fmtShort(e.to)}` : ''}</td><td>${when(e)}</td></tr>`).join('')}
                </tbody></table>
                <p style="margin-top:12px;">Exam days are compulsory: leave planning and Smart Search never suggest them for leave.</p>`
                : `<p>No exam days saved. Add them in <strong>Profile → Exam days</strong> so they're never suggested for leave.</p>`}
                ${past.length ? `<p style="margin-top:10px;font-size:0.85rem;">Done: ${past.map(e => `${escapeHtml(e.title || 'Exam')} (${fmtShort(e.from)})`).join(', ')}</p>` : ''}`
        };
    }

    // ---------- Timetable ----------
    function handleTimetableInfo(query) {
        const cls = getSelectedClassObj();
        if (!cls) return noClassResponse();
        const parsed = parseDateQuery(query, cls);
        const t = todayStrSI();
        let dates = parsed ? parsed.dates.slice(0, 7) : [/\btomorrow\b/i.test(query) ? shiftDays(t, 1) : t];
        if (/\bweek\b/i.test(query) && dates.length < 3) dates = Array.from({ length: 7 }, (_, i) => shiftDays(t, i));

        const blocks = dates.map(d => {
            const periods = periodsOn(cls, d);
            const exam = examOn(d);
            const change = dayChangeFor(cls, d);
            const head = `<p style="margin:12px 0 6px;"><strong>${fmtLong(d)}</strong>${exam ? ` · <span style="color:var(--si-danger);font-weight:700;">📝 ${escapeHtml(exam.title)}</span>` : ''}${change?.type === 'shift' && change.on === d ? ` · shifted from ${fmtShort(change.off)}` : ''}</p>`;
            if ((cls.holidays || []).includes(d)) return head + `<p>🏖️ Holiday${change?.reason ? ` (${escapeHtml(change.reason)})` : ''}: no classes.</p>`;
            if ((cls.portalSetup?.semesterStartDate && d < cls.portalSetup.semesterStartDate) || (cls.lastDate && d > cls.lastDate)) return head + '<p>Outside the semester.</p>';
            if (!periods.some(Boolean)) return head + '<p>No classes.</p>';
            return head + `<table class="si-subject-table"><tbody>${periods.map((p, i) => `<tr><td style="width:56px;"><strong>P${i + 1}</strong></td><td>${p ? escapeHtml(p.name) : '<em>Free</em>'}</td></tr>`).join('')}</tbody></table>`;
        }).join('');
        const total = dates.reduce((n, d) => n + ((cls.holidays || []).includes(d) ? 0 : periodsOn(cls, d).filter(Boolean).length), 0);
        return {
            icon: '🗓️', iconClass: 'info',
            title: dates.length === 1 ? `${dates[0] === t ? 'Today' : dates[0] === shiftDays(t, 1) ? 'Tomorrow' : fmtShort(dates[0])}: ${total} class${total !== 1 ? 'es' : ''}` : `Timetable: ${total} classes in ${dates.length} days`,
            body: blocks
        };
    }

    // ---------- Profile / account ----------
    function handleProfileInfo() {
        const cls = getSelectedClassObj();
        let profile = {};
        try { profile = JSON.parse(localStorage.getItem('studentProfile') || '{}'); } catch (e) { /* none */ }
        const user = window.AuthManager?.user;
        const name = profile.name || user?.user_metadata?.full_name || localStorage.getItem('userProfileName') || 'Not set';
        const min = getMinCriteria() * 100;
        const row = (k, v) => v ? `<tr><td><strong>${k}</strong></td><td>${escapeHtml(v)}</td></tr>` : '';
        const cName = clsName();
        let notif = null;
        try { notif = JSON.parse(localStorage.getItem(`notificationSettings_${cName}`) || 'null'); } catch (e) { /* none */ }
        const modeLabels = { monthly: 'Changes every month', daily: 'Changes every day', fixed: 'Fixed timetable' };
        return {
            icon: '👤', iconClass: 'info',
            title: name !== 'Not set' ? name : 'Your profile',
            body: `
                <table class="si-subject-table"><tbody>
                    ${row('Name', name)}
                    ${row('Registration no.', profile.regNo)}
                    ${row('Email', user?.email)}
                    ${row('Phone', profile.phone)}
                    ${row('College', profile.college)}
                    ${row('Branch', profile.branch)}
                    ${row('Semester', profile.semester)}
                    ${row('Account', user ? 'Signed in · synced to cloud' : 'Guest · saved on this device only')}
                </tbody></table>
                ${cls ? `<p style="margin-top:14px;"><strong>Class</strong></p>
                <table class="si-subject-table"><tbody>
                    ${row('Class', cName)}
                    ${row('Subjects', `${(cls.subjects || []).length}: ${(cls.subjects || []).map(s => s.name || s.code).join(', ')}`)}
                    ${row('Semester', `${cls.portalSetup?.semesterStartDate ? fmtShort(cls.portalSetup.semesterStartDate) : '?'} → ${cls.lastDate ? fmtShort(cls.lastDate) : '?'}`)}
                    ${row('Mode', cls.portalSetup?.active ? `Portal mode (baseline ${cls.portalSetup.baselineDate ? fmtShort(cls.portalSetup.baselineDate) : '?'})` : 'Standard mode')}
                    ${row('Timetable', modeLabels[cls.timetableMode] || 'Not set')}
                    ${row('Holidays', String((cls.holidays || []).length))}
                    ${row('Exam days', String((cls.examDays || []).length))}
                </tbody></table>
                <p style="margin-top:14px;"><strong>Settings</strong></p>
                <table class="si-subject-table"><tbody>
                    ${row('Minimum attendance', `${min}%`)}
                    ${row('OD / ML rule', window.ProfileTools?.ruleSummary ? ProfileTools.ruleSummary() : '')}
                    ${row('Daily reminder', notif ? (notif.enabled ? `On at ${notif.time}` : 'Off') : 'On at 16:30')}
                </tbody></table>` : ''}
                <p style="margin-top:12px;font-size:0.85rem;">Change any of this in the <strong>Profile</strong> tab.</p>`
        };
    }

    // ---------- Semester ----------
    function handleSemesterInfo() {
        const cls = getSelectedClassObj();
        if (!cls) return noClassResponse();
        const t = todayStrSI();
        const start = cls.portalSetup?.semesterStartDate;
        const end = cls.lastDate;
        let classDaysLeft = 0, classesLeft = 0;
        if (end) {
            for (let d = shiftDays(t, 1); d <= end; d = shiftDays(d, 1)) {
                if ((cls.holidays || []).includes(d)) continue;
                const n = periodsOn(cls, d).filter(Boolean).length;
                if (n) { classDaysLeft++; classesLeft += n; }
            }
        }
        const daysLeft = end ? Math.max(0, daysBetween(t, end)) : null;
        const holidaysLeft = (cls.holidays || []).filter(d => d > t && (!end || d <= end)).length;
        const done = start && end ? Math.min(100, Math.max(0, (daysBetween(start, t) / Math.max(1, daysBetween(start, end))) * 100)) : null;
        return {
            icon: '📆', iconClass: 'info',
            title: end ? `Semester ends ${fmtShort(end)}${daysLeft !== null ? ` · ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left` : ''}` : 'Semester end date not set',
            body: `
                ${done !== null ? `<div class="si-progress-bar"><div class="si-progress-fill info" style="width:${done}%"></div></div><p style="margin-top:6px;font-size:0.85rem;">${done.toFixed(0)}% of the semester done</p>` : ''}
                <div class="si-stats-grid" style="margin-top:12px;">
                    <div class="si-stat-tile"><div class="si-stat-value">${start ? fmtShort(start) : '—'}</div><div class="si-stat-label">Started</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value">${end ? fmtShort(end) : '—'}</div><div class="si-stat-label">Ends</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value info">${classDaysLeft}</div><div class="si-stat-label">Class days left</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value info">${classesLeft}</div><div class="si-stat-label">Classes left</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value">${holidaysLeft}</div><div class="si-stat-label">Holidays left</div></div>
                </div>`
        };
    }

    // ---------- Missed days ----------
    function handleMissedDays() {
        const cls = getSelectedClassObj();
        if (!cls) return noClassResponse();
        const missed = window.NotificationCenter?._missedDays ? NotificationCenter._missedDays() : [];
        return {
            icon: missed.length ? '📋' : '✅', iconClass: missed.length ? 'warning' : 'safe',
            title: missed.length ? `${missed.length} class day${missed.length !== 1 ? 's' : ''} not marked` : 'Every class day is marked',
            body: missed.length ? `
                <table class="si-subject-table"><thead><tr><th>Date</th><th>Classes</th></tr></thead><tbody>
                    ${missed.slice(0, 12).map(m => `<tr><td><strong>${fmtShort(m.date)}</strong></td><td>${m.classes}</td></tr>`).join('')}
                </tbody></table>
                ${missed.length > 12 ? `<p>…and ${missed.length - 12} more.</p>` : ''}
                <p style="margin-top:12px;">Mark them quickly from the <strong>🔔 bell</strong> on Home (✅ All present / ❌ All absent per day) or the <strong>calendar</strong>.</p>`
                : '<p>Nothing pending. Your attendance numbers are up to date.</p>'
        };
    }

    function processQuery(query) {
        query = normalizeIndic(query.trim());
        if (!query) return null;

        // Date-based leave questions ("take a break from 3 oct to 5 oct") come first.
        // Plain "can I skip today?" keeps its dedicated handler.
        const parsed = parseDateQuery(query, getSelectedClassObj());

        // Questions about your data: holidays, OD/ML, exams, timetable, profile, semester, missed days
        const info = infoHandlerFor(query, parsed);
        if (info) {
            const fn = { handleProfileInfo, handleSemesterInfo, handleExamInfo, handleOdmlInfo, handleMissedDays, handleHolidayInfo, handleTimetableInfo }[info];
            const r = fn(query);
            if (r) return r;
        }
        if (parsed && LEAVE_INTENT_RE.test(query)) {
            const onlyToday = parsed.dates.length === 1 && parsed.dates[0] === parsed.today;
            return onlyToday ? handleCanISkipToday(query) : handleDateLeaveImpact(query, parsed);
        }

        for (const rule of QUERY_PATTERNS) {
            for (const pattern of rule.patterns) {
                const match = query.match(pattern);
                if (match) {
                    const handler = {
                        handleMissImpact,
                        handleLongWeekend,
                        handleMaxSafeSkip,
                        handleCanISkipToday,
                        handleWorstSubjects,
                        handleBestSubjects,
                        handleOverallSummary,
                        handleSubjectQuery,
                        handleRecoveryPlan,
                        handleTargetPercent,
                        handlePrediction,
                        handleHelp
                    }[rule.handler];
                    if (handler) return handler(query, match);
                }
            }
        }

        // Fallback: try to match a subject name
        const data = getAttendanceData();
        if (data.length > 0) {
            const found = data.find(sub =>
                (sub.name && sub.name.toLowerCase().includes(query.toLowerCase())) ||
                (sub.code && sub.code.toLowerCase().includes(query.toLowerCase())) ||
                (sub.shortName && sub.shortName.toLowerCase().includes(query.toLowerCase()))
            );
            if (found) return handleSubjectQuery(query);
        }

        // Ultimate fallback: show help
        return handleHelp(query);
    }

    // --- Render Answer ---
    const STATUS_ICONS = {
        safe: 'fa-circle-check',
        warning: 'fa-triangle-exclamation',
        danger: 'fa-circle-exclamation',
        info: 'fa-lightbulb',
        neutral: 'fa-circle-info'
    };
    const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Handlers return emoji-heavy titles/badges; render them with clean icons instead
    function polishBody(html) {
        return html
            .replace(/(<span class="si-badge[^"]*">)([^<]*)(<\/span>)/g, (m, open, text, close) => open + text.replace(EMOJI_RE, '').trim() + close)
            .replace(/<table class="si-subject-table"/g, '<div class="si-table-scroll"><table class="si-subject-table"')
            .replace(/<\/table>/g, '</table></div>');
    }

    // --- Chat thread ---
    const WHATSAPP_NUMBER = '916386854875';

    function whatsAppLink(question) {
        const text = question
            ? `Hi! I need help with Bunk it app.\n\nMy question: ${question}`
            : 'Hi! I need help with Bunk it app';
        return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
    }

    function getThread() {
        return document.getElementById('siAnswerSection');
    }

    function scrollThread(el) {
        const thread = getThread();
        if (!thread) return;
        // Show the start of the newest message (answers can be long)
        const top = el ? el.offsetTop - thread.offsetTop - 12 : thread.scrollHeight;
        thread.scrollTo({ top, behavior: 'smooth' });
    }

    function appendMessage(html, cls) {
        const thread = getThread();
        if (!thread) return null;
        const el = document.createElement('div');
        el.className = `si-msg ${cls}`;
        el.innerHTML = html;
        thread.appendChild(el);
        return el;
    }

    function appendUserMessage(text) {
        const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        return appendMessage(`
            <div class="si-bubble">${escapeHtml(text)}</div>
            <div class="si-msg-meta">${time}</div>`, 'si-msg-user');
    }

    function botMessage(inner) {
        return `<div class="si-msg-avatar"><i class="fa-solid fa-robot"></i></div><div class="si-msg-content">${inner}</div>`;
    }

    function appendThinking() {
        return appendMessage(botMessage(`
            <div class="si-thinking">
                <span class="si-thinking-dots"><span></span><span></span><span></span></span>
                Analyzing your attendance…
            </div>`), 'si-msg-bot');
    }

    function renderAnswer(result, target, query) {
        if (!result) { if (target) target.remove(); return; }

        const iconClass = STATUS_ICONS[result.iconClass] ? result.iconClass : 'info';
        const title = String(result.title || '').replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
        const html = botMessage(`
            <div class="si-answer-card">
                <div class="si-answer-header">
                    <div class="si-answer-icon ${iconClass}"><i class="fa-solid ${STATUS_ICONS[iconClass]}"></i></div>
                    <div class="si-answer-title">${title}</div>
                </div>
                <div class="si-answer-body">${polishBody(result.body || '')}</div>
                <div class="si-answer-footer">
                    ${canSpeak() ? `<button type="button" class="si-listen" onclick="SmartSearch.speakAnswer(this)" aria-label="Read this answer aloud"><i class="fa-solid fa-volume-high"></i> Listen</button>` : ''}
                    <span>Not what you needed?</span>
                    <a href="${whatsAppLink(query)}" target="_blank" rel="noopener noreferrer" class="si-wa-link">
                        <i class="fa-brands fa-whatsapp"></i> Ask on WhatsApp
                    </a>
                </div>
            </div>`);

        let el = target;
        if (el) { el.innerHTML = html; } else { el = appendMessage(html, 'si-msg-bot'); }
        scrollThread(el);

        // Asked by voice: answer by voice too
        if (askedByVoice) {
            askedByVoice = false;
            const card = el.querySelector('.si-answer-card');
            if (card) speakCard(card);
        }
    }

    // ============================================================
    // VOICE: ask by speaking (speech recognition) + read answers aloud
    // ============================================================
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const VOICE_LANGS = { 'en-IN': { short: 'EN', name: 'English', listening: 'Listening… ask your question' }, 'hi-IN': { short: 'हिं', name: 'Hindi', listening: 'सुन रहा हूँ… अपना सवाल बोलें' } };
    let voiceLang = (() => { try { return VOICE_LANGS[localStorage.getItem('si_voice_lang')] ? localStorage.getItem('si_voice_lang') : 'en-IN'; } catch (e) { return 'en-IN'; } })();
    let recognizer = null;
    let listening = false;
    let askedByVoice = false;

    function canSpeak() {
        return 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    }

    function setListeningUI(on, message) {
        const bar = document.querySelector('.si-search-bar');
        const btn = document.getElementById('siMicBtn');
        const input = document.getElementById('siSearchInput');
        if (bar) bar.classList.toggle('listening', on);
        if (btn) {
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', String(on));
            btn.innerHTML = `<i class="fa-solid ${on ? 'fa-stop' : 'fa-microphone'}"></i>`;
            btn.title = on ? 'Stop listening' : 'Ask by voice';
        }
        if (input) input.placeholder = message || (on ? VOICE_LANGS[voiceLang].listening : 'Ask about your attendance…');
    }

    function updateLangButton() {
        const btn = document.getElementById('siLangBtn');
        if (!btn) return;
        btn.hidden = !SpeechRec;
        btn.textContent = VOICE_LANGS[voiceLang].short;
        btn.title = `Voice language: ${VOICE_LANGS[voiceLang].name} (tap to switch)`;
        btn.setAttribute('aria-label', btn.title);
    }

    function setVoiceLang(lang) {
        voiceLang = VOICE_LANGS[lang] ? lang : (voiceLang === 'en-IN' ? 'hi-IN' : 'en-IN');
        try { localStorage.setItem('si_voice_lang', voiceLang); } catch (e) { /* ignore */ }
        updateLangButton();
        const input = document.getElementById('siSearchInput');
        if (input && !listening) {
            input.placeholder = voiceLang === 'hi-IN' ? 'Hindi voice on: 🎤 दबाएं और बोलें' : 'Ask about your attendance…';
            setTimeout(() => { if (!listening) input.placeholder = 'Ask about your attendance…'; }, 3000);
        }
    }

    function voiceNotice(text) {
        setListeningUI(false, text);
        setTimeout(() => {
            const input = document.getElementById('siSearchInput');
            if (input && !listening) input.placeholder = 'Ask about your attendance…';
        }, 4000);
    }

    function toggleVoice() {
        if (listening) { recognizer && recognizer.stop(); return; }
        if (!SpeechRec) { voiceNotice('Voice is not supported in this browser'); return; }
        if (canSpeak()) window.speechSynthesis.cancel();

        const input = document.getElementById('siSearchInput');
        let finalText = '';
        let submitted = false;
        const submit = (text) => {
            text = String(text || '').trim();
            if (submitted || !text) return;
            submitted = true;
            askedByVoice = true;
            runQuery(text);
        };

        recognizer = new SpeechRec();
        recognizer.lang = voiceLang;
        recognizer.interimResults = true;
        recognizer.continuous = false;
        recognizer.maxAlternatives = 1;

        recognizer.onstart = () => { listening = true; setListeningUI(true); if (input) input.value = ''; };
        recognizer.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const text = event.results[i][0].transcript;
                if (event.results[i].isFinal) finalText += text; else interim += text;
            }
            if (input) input.value = (finalText + interim).trim();
        };
        recognizer.onerror = (event) => {
            listening = false;
            const messages = {
                'not-allowed': 'Microphone blocked. Allow it in browser settings.',
                'service-not-allowed': 'Microphone blocked. Allow it in browser settings.',
                'no-speech': "Didn't hear anything. Tap the mic and try again.",
                'audio-capture': 'No microphone found.',
                'network': 'Voice needs an internet connection.'
            };
            if (event.error !== 'aborted') voiceNotice(messages[event.error] || 'Voice input stopped. Try again.');
        };
        recognizer.onend = () => {
            const wasListening = listening;
            listening = false;
            if (wasListening) setListeningUI(false);
            submit(finalText || (input && input.value));
        };

        try { recognizer.start(); } catch (e) { voiceNotice('Could not start the microphone.'); }
    }

    // Plain-text version of an answer: title + first lines of the body
    function answerText(card) {
        const title = card.querySelector('.si-answer-title')?.textContent || '';
        const body = card.querySelector('.si-answer-body');
        let text = '';
        if (body) {
            const parts = Array.from(body.querySelectorAll('p, .si-stat-tile')).map(el => {
                if (el.classList.contains('si-stat-tile')) {
                    const v = el.querySelector('.si-stat-value')?.textContent || '';
                    const l = el.querySelector('.si-stat-label')?.textContent || '';
                    return `${l}: ${v}`;
                }
                return el.textContent;
            });
            text = (parts.length ? parts : [body.textContent]).join('. ');
        }
        text = `${title}. ${text}`.replace(/\s+/g, ' ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
            .replace(/(\d+)\s*\/\s*(\d+)/g, '$1 of $2')   // "30/36" -> "30 of 36"
            .replace(/\s*[·•|]\s*/g, ', ')
            .replace(/→/g, ' to ')
            .trim();
        return text.length > 600 ? text.slice(0, 600).replace(/[^.]*$/, '') : text;
    }

    function speakCard(card, btn) {
        if (!canSpeak()) return;
        const synth = window.speechSynthesis;
        if (synth.speaking && btn && btn.classList.contains('speaking')) { synth.cancel(); return; }
        synth.cancel();
        document.querySelectorAll('.si-listen.speaking').forEach(b => b.classList.remove('speaking'));

        const utter = new SpeechSynthesisUtterance(answerText(card));
        utter.lang = 'en-IN';
        utter.rate = 1;
        const voice = synth.getVoices().find(v => v.lang === 'en-IN') || synth.getVoices().find(v => v.lang && v.lang.startsWith('en'));
        if (voice) utter.voice = voice;
        const button = btn || card.querySelector('.si-listen');
        if (button) {
            button.classList.add('speaking');
            button.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
            utter.onend = utter.onerror = () => {
                button.classList.remove('speaking');
                button.innerHTML = '<i class="fa-solid fa-volume-high"></i> Listen';
            };
        }
        synth.speak(utter);
    }

    function speakAnswer(btn) {
        const card = btn.closest('.si-answer-card');
        if (card) speakCard(card, btn);
    }

    function showWelcome() {
        const thread = getThread();
        if (!thread) return;
        thread.innerHTML = `
            <div class="si-chat-empty">
                <div class="si-chat-empty-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
                <h3>How can I help?</h3>
                <p>Ask about leaves, skips or any subject.</p>
            </div>`;
        updateNewChatBtn();
    }

    function updateNewChatBtn() {
        const btn = document.getElementById('siNewChatBtn');
        if (btn) btn.hidden = !getThread()?.querySelector('.si-msg');
    }

    // --- Public API ---
    function runQuery(query) {
        query = String(query || '').trim();
        if (!query) return;
        if (canSpeak()) window.speechSynthesis.cancel();

        const input = document.getElementById('siSearchInput');
        if (input) input.value = '';

        // Make sure the chat is visible (quick chips sit below it)
        const thread = getThread();
        if (thread && thread.getBoundingClientRect().top < 0) thread.scrollIntoView({ behavior: 'smooth', block: 'start' });

        getThread()?.querySelector('.si-chat-empty')?.remove();
        const userEl = appendUserMessage(query);
        updateNewChatBtn();
        const thinkingEl = appendThinking();
        scrollThread(userEl);
        saveToHistory(query);

        // Small delay for a natural chat feel
        setTimeout(() => {
            let result;
            try {
                result = processQuery(query);
            } catch (e) {
                console.error('Smart Search error:', e);
                result = {
                    iconClass: 'danger',
                    title: "Sorry, I couldn't work that out",
                    body: `<p>Something went wrong while answering this. Try rephrasing, or message us on WhatsApp and we'll help.</p>`
                };
            }
            renderAnswer(result, thinkingEl, query);
        }, 450);
    }

    function handleSearchSubmit(e) {
        if (e) e.preventDefault();
        const input = document.getElementById('siSearchInput');
        if (!input || !input.value.trim()) return;
        runQuery(input.value.trim());
    }

    function newChat() {
        showWelcome();
        document.getElementById('siSearchInput')?.focus();
    }

    function initSmartSearch() {
        const mic = document.getElementById('siMicBtn');
        if (mic) mic.hidden = !SpeechRec;
        updateLangButton();
        renderHistory();
        // Keep the conversation when returning to the page; only greet on first open
        const thread = getThread();
        if (thread && !thread.children.length) showWelcome();
    }

    // Expose to global scope
    window.SmartSearch = {
        runQuery,
        handleSearchSubmit,
        initSmartSearch,
        clearHistory,
        processQuery,
        newChat,
        toggleVoice,
        speakAnswer,
        setVoiceLang,
        normalizeIndic,
        computeClassAttendance: autoComputeAttendanceData
    };
})();
