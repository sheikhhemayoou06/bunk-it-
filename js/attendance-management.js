// ============================================================
// ATTENDANCE MANAGEMENT SYSTEM - JavaScript Module
// ============================================================
// Self-contained module that renders a complete attendance management
// system inside #studentPortalContentPlaceholder.
// Reads/writes the same localStorage keys as the existing Portal Mode.
// ============================================================

(function () {
    'use strict';

    // --- Constants ---
    const STATUS_MAP = {
        'Attended': { label: '✅ Present', css: 'present', icon: '✅' },
        'Skipped': { label: '❌ Absent', css: 'absent', icon: '❌' },
        'Cancelled': { label: '🔘 Cancelled', css: 'cancelled', icon: '🔘' },
        'Medical Leave (ML)': { label: '🏥 Medical Leave', css: 'medical', icon: '🏥' },
        'Duty Leave (OD)': { label: '📋 Duty Leave', css: 'duty-leave', icon: '📋' },
        'Default': { label: '⬜ Not Marked', css: 'not-marked', icon: '⬜' }
    };

    const SUBJECT_COLORS = [
        '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6',
        '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#06b6d4',
        '#84cc16', '#e11d48', '#0ea5e9', '#a855f7', '#22c55e'
    ];

    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const ITEMS_PER_PAGE = 20;

    // --- State ---
    let amsCurrentView = 'menu'; // 'menu', 'period_wise', 'course_wise', 'cumulative', 'detailed'
    let amsMode = 'classwise'; // 'daywise' or 'classwise' (kept for legacy if needed)
    let amsSelectedDate = formatDate(new Date());
    let amsSelectedSubject = null;
    let amsFilterOpen = false;
    let amsCurrentPage = 1;
    let amsScrollToDate = null;   // Period-wise: row to scroll to (from Cumulative "Open day")
    let amsCumDetail = null;      // Cumulative: { month, status } being inspected
    let amsFilters = { subject: '', date: '', dateFrom: '', dateTo: '', month: '', classType: '', status: '' };

    // --- Utility Functions ---
    function formatDate(d) {
        if (typeof d === 'string') d = new Date(d + 'T00:00:00');
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function parseDate(s) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function getDayName(dateStr) {
        return DAYS[parseDate(dateStr).getDay()];
    }

    function getDayShort(dateStr) {
        return DAYS_SHORT[parseDate(dateStr).getDay()];
    }

    function formatDateDisplay(dateStr) {
        const d = parseDate(dateStr);
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function getSubjectColor(index) {
        return SUBJECT_COLORS[index % SUBJECT_COLORS.length];
    }

    function getSelectedClass() {
        // `selectedClass` is a top-level `let` in index.html, so it is NOT on `window`
        if (typeof selectedClass !== 'undefined' && selectedClass) {
            return selectedClass;
        }
        const classes = JSON.parse(localStorage.getItem('attendanceClasses_v2') || '{}');
        const className = document.getElementById('classSelector')?.value;
        if (className && className !== 'add_new_class' && className !== '') {
            if (classes[className]) return classes[className];
        }

        return null; // no class selected -> "No Class Selected" screen
    }

    function getLogs() {
        try {
            return JSON.parse(localStorage.getItem('attendance_logs') || '{}') || {};
        } catch (e) {
            return {};
        }
    }

    function saveLogs(logs) {
        localStorage.setItem('attendance_logs', JSON.stringify(logs));
    }

    // --- Class date range (from class setup) ---
    // Start = semester start date entered in class setup, End = class last date.
    function getClassDateRange(sc) {
        const today = formatDate(new Date());
        let start = sc.portalSetup?.semesterStartDate || sc.startDate || sc.portalSetup?.baselineDate;
        if (!start) {
            const logDates = Object.keys(getLogs()).sort();
            start = logDates[0] || today;
        }
        const end = sc.lastDate || today;
        return { start, end, today };
    }

    // All dates in the class range that have classes scheduled (holidays and
    // no-class days skipped). Free periods are kept as null to preserve columns.
    function getClassDates(sc, endOverride) {
        const { start, end } = getClassDateRange(sc);
        const last = endOverride && endOverride < end ? endOverride : end;
        const dates = [];
        const cur = parseDate(start);
        const endD = parseDate(last);
        while (cur <= endD) {
            const dateStr = formatDate(cur);
            const periods = getPeriodsForDate(dateStr, true);
            if (periods.some(Boolean)) dates.push({ date: dateStr, periods });
            cur.setDate(cur.getDate() + 1);
        }
        return dates;
    }

    function showAmsToast(msg) {
        let toast = document.getElementById('amsToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'amsToast';
            toast.className = 'ams-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // --- Get timetable for a given date ---
    // keepFree: return free periods as null (so period numbers line up with the timetable)
    function getPeriodsForDate(dateStr, keepFree = false) {
        const sc = getSelectedClass();
        if (!sc || !sc.subjects) return [];

        const d = parseDate(dateStr);
        const dow = d.getDay();
        const dayIndex = dow === 0 ? 6 : dow - 1;

        // Check holiday
        if ((sc.holidays || []).includes(dateStr)) return [];

        // Check custom schedule
        const className = document.getElementById('classSelector')?.value;
        const customSchedules = JSON.parse(localStorage.getItem(`custom_schedules_${className}`) || '{}');
        const custom = customSchedules[dateStr];

        if (custom && custom._periods) {
            const periods = custom._periods.map((code, idx) => {
                if (!code) return null;
                const subj = sc.subjects.find(s => s.code === code);
                return subj ? { code: subj.code, name: subj.name, shortName: subj.shortName || subj.code, period: idx + 1 } : null;
            });
            return keepFree ? trimTrailingFree(periods) : periods.filter(Boolean);
        }

        // Use timetable arrangement
        if (typeof getTimetableArrangement === 'function') {
            const arrangement = getTimetableArrangement(className, dateStr) || {};
            const dayArr = arrangement[dayIndex] || [];
            // A timetable version dated for this day is authoritative, even when the day is empty
            const datedVersion = typeof getTimetableHistory === 'function' && getTimetableHistory(className)
                .some(v => dateStr >= v.effectiveFrom && (!v.effectiveTo || dateStr <= v.effectiveTo));
            if (dayArr.length > 0 || datedVersion) {
                const periods = dayArr.map((item, idx) => {
                    const code = typeof item === 'object' ? item?.code : item;
                    if (!code) return null;
                    const subj = sc.subjects.find(s => s.code === code);
                    return subj ? { code: subj.code, name: subj.name, shortName: subj.shortName || subj.code, period: idx + 1 } : null;
                });
                return keepFree ? trimTrailingFree(periods) : periods.filter(Boolean);
            }
        }

        // Fallback to schedule counts
        const result = [];
        let periodNum = 1;
        sc.subjects.forEach(subj => {
            const count = typeof parseScheduleValue === 'function'
                ? parseScheduleValue(subj.schedule ? subj.schedule[dayIndex] : 0)
                : (parseInt(subj.schedule?.[dayIndex]) || 0);
            for (let i = 0; i < count; i++) {
                result.push({ code: subj.code, name: subj.name, shortName: subj.shortName || subj.code, period: periodNum++ });
            }
        });
        return result;
    }

    function trimTrailingFree(periods) {
        let end = periods.length;
        while (end > 0 && !periods[end - 1]) end--;
        return periods.slice(0, end);
    }

    // --- Calculate attendance stats from logs ---
    function calculateStats() {
        const sc = getSelectedClass();
        if (!sc || !sc.subjects) return { subjects: [], overall: {} };

        const logs = getLogs();
        const baseline = sc.portalSetup?.baselineData || {};
        const baselineDate = sc.portalSetup?.baselineDate;

        const subjectStats = {};
        sc.subjects.forEach((subj, idx) => {
            subjectStats[subj.code] = {
                code: subj.code,
                name: subj.name,
                shortName: subj.shortName || subj.code,
                color: getSubjectColor(idx),
                present: 0,
                absent: 0,
                cancelled: 0,
                medical: 0,
                dutyLeave: 0,
                notMarked: 0,
                totalHeld: 0,
                attended: 0
            };
        });

        // Base data
        sc.subjects.forEach(subj => {
            const base = baseline[subj.code];
            if (base) {
                subjectStats[subj.code].attended = base.attended || 0;
                subjectStats[subj.code].totalHeld = base.total || 0;
                subjectStats[subj.code].present = base.attended || 0;
                subjectStats[subj.code].absent = (base.total || 0) - (base.attended || 0);
            }
        });

        const baselineDateObj = baselineDate ? parseDate(baselineDate) : null;

        Object.keys(logs).forEach(dateStr => {
            const logDate = parseDate(dateStr);
            if (baselineDateObj && logDate <= baselineDateObj) return;

            const dayLog = logs[dateStr];
            Object.keys(dayLog).forEach(key => {
                const code = key.split('_p')[0];
                if (!subjectStats[code]) return;

                const status = dayLog[key];
                if (status === 'Attended' || status === 'Present' || status === 'P') {
                    subjectStats[code].present++;
                    subjectStats[code].attended++;
                    subjectStats[code].totalHeld++;
                } else if (status === 'Skipped' || status === 'Absent' || status === 'A') {
                    subjectStats[code].absent++;
                    subjectStats[code].totalHeld++;
                } else if (status === 'Cancelled' || status === 'C') {
                    subjectStats[code].cancelled++;
                    // Cancelled doesn't count towards totalHeld or attended
                } else if (status === 'Medical Leave (ML)' || status === 'ML') {
                    subjectStats[code].medical++;
                    subjectStats[code].attended++;
                    subjectStats[code].totalHeld++;
                } else if (status === 'Duty Leave (OD)' || status === 'OD') {
                    subjectStats[code].dutyLeave++;
                    subjectStats[code].attended++;
                    subjectStats[code].totalHeld++;
                }
            });
        });

        let totalPresent = 0, totalAbsent = 0, totalHeld = 0, totalAttended = 0;
        let totalCancelled = 0, totalMedical = 0, totalDutyLeave = 0;

        const subjectsArr = Object.values(subjectStats);
        subjectsArr.forEach(s => {
            totalPresent += s.present;
            totalAbsent += s.absent;
            totalHeld += s.totalHeld;
            totalAttended += s.attended;
            totalCancelled += s.cancelled;
            totalMedical += s.medical;
            totalDutyLeave += s.dutyLeave;
        });

        // Overall % with the OD/ML limit applied per subject (as the college portal does)
        const effective = subjectsArr.reduce((sum, sub) => sum + (typeof cappedWithPct === 'function'
            ? (cappedWithPct(sub.attended, sub.totalHeld, sub.medical + sub.dutyLeave, remainingFor(sub.code)) / 100) * sub.totalHeld
            : sub.attended), 0);
        const percentage = totalHeld > 0 ? ((effective / totalHeld) * 100) : 0;
        const min = minPct();
        const m = min / 100;
        const canMiss = percentage >= min ? Math.floor((totalAttended - m * totalHeld) / m) : 0;
        const mustAttend = percentage < min && m < 1 ? Math.ceil((m * totalHeld - totalAttended) / (1 - m)) : 0;

        let statusText = '', statusClass = '';
        if (totalHeld === 0) { statusText = 'No Data'; statusClass = 'not-marked'; }
        else statusClass = getStatusBadgeClass(percentage), statusText = { 'extremely-safe': 'Extremely Safe', safe: 'Safe', borderline: 'Borderline', danger: 'Danger' }[statusClass];

        return {
            subjects: subjectsArr,
            overall: {
                present: totalPresent,
                absent: totalAbsent,
                totalHeld,
                attended: totalAttended,
                percentage: percentage.toFixed(2),
                canMiss,
                mustAttend,
                statusText,
                statusClass,
                cancelled: totalCancelled,
                medical: totalMedical,
                dutyLeave: totalDutyLeave
            }
        };
    }

    // --- Build flat records from logs ---
    function buildRecords() {
        const sc = getSelectedClass();
        if (!sc || !sc.subjects) return [];

        const logs = getLogs();
        const records = [];

        const subjectMap = {};
        sc.subjects.forEach((s, idx) => {
            subjectMap[s.code] = { ...s, color: getSubjectColor(idx) };
        });

        Object.keys(logs).sort().reverse().forEach(dateStr => {
            const dayLog = logs[dateStr];
            const periods = getPeriodsForDate(dateStr);
            const dayName = getDayName(dateStr);

            // Track which period keys we've handled
            const handledKeys = new Set();

            // First pass: match logged keys to timetable periods
            const periodCounts = {};
            periods.forEach(p => {
                periodCounts[p.code] = (periodCounts[p.code] || 0) + 1;
                const periodKey = `${p.code}_p${periodCounts[p.code]}`;
                const status = dayLog[periodKey] || dayLog[p.code] || 'Default';
                handledKeys.add(periodKey);
                handledKeys.add(p.code);

                const subj = subjectMap[p.code];
                const totalForSubj = periods.filter(pp => pp.code === p.code).length;
                records.push({
                    date: dateStr,
                    day: dayName,
                    subject: subj ? subj.name : p.code,
                    subjectCode: p.code,
                    period: p.period,
                    classType: totalForSubj > 1 ? 'Lab/Tutorial' : 'Lecture',
                    status: status,
                    statusInfo: STATUS_MAP[status] || STATUS_MAP['Default'],
                    color: subj ? subj.color : '#6b7280',
                    remarks: status === 'Medical Leave (ML)' ? 'Medical leave' : (status === 'Duty Leave (OD)' ? 'On duty' : '')
                });
            });

            // Second pass: any logged keys not in timetable (extra classes)
            Object.keys(dayLog).forEach(key => {
                if (handledKeys.has(key)) return;
                const code = key.split('_p')[0];
                const subj = subjectMap[code];
                if (!subj) return;

                records.push({
                    date: dateStr,
                    day: dayName,
                    subject: subj.name,
                    subjectCode: code,
                    period: '-',
                    classType: 'Extra',
                    status: dayLog[key],
                    statusInfo: STATUS_MAP[dayLog[key]] || STATUS_MAP['Default'],
                    color: subj.color,
                    remarks: ''
                });
            });
        });

        return records;
    }

    // --- Apply filters to records ---
    function applyFilters(records) {
        return records.filter(r => {
            if (amsFilters.subject && r.subjectCode !== amsFilters.subject) return false;
            if (amsFilters.date && r.date !== amsFilters.date) return false;
            if (amsFilters.dateFrom && r.date < amsFilters.dateFrom) return false;
            if (amsFilters.dateTo && r.date > amsFilters.dateTo) return false;
            if (amsFilters.month) {
                const monthKey = r.date.substring(0, 7); // "2026-08"
                if (monthKey !== amsFilters.month) return false;
            }
            if (amsFilters.classType && r.classType !== amsFilters.classType) return false;
            if (amsFilters.status && r.status !== amsFilters.status) return false;
            return true;
        });
    }

    // --- SVG Circular Progress ---
    function renderProgressRing(pct, color) {
        const r = 20;
        const circ = 2 * Math.PI * r;
        const offset = circ - (pct / 100) * circ;
        return `<div class="ams-progress-ring">
            <svg width="52" height="52" viewBox="0 0 52 52">
                <circle class="ring-bg" cx="26" cy="26" r="${r}"/>
                <circle class="ring-fill" cx="26" cy="26" r="${r}" 
                    stroke="${color}" 
                    stroke-dasharray="${circ}" 
                    stroke-dashoffset="${offset}"/>
                <text class="ring-text" x="26" y="26" transform="rotate(90 26 26)">${pct}%</text>
            </svg>
        </div>`;
    }

    // Classes left this semester for a subject (from the main calculation)
    function remainingFor(code) {
        const d = (typeof currentAnalysisData !== 'undefined' ? currentAnalysisData : []).find(x => x.code === code);
        return d ? Number(d.remaining) || 0 : 0;
    }

    // Minimum attendance required (Profile → Minimum attendance), in %
    function minPct() {
        return typeof getMinAttendanceCriteria === 'function' ? Math.round(getMinAttendanceCriteria() * 1000) / 10 : 75;
    }

    // --- Get status color for percentage ---
    // Bands follow the minimum: extremely safe = min + 15, borderline = min − 10
    function getPctColor(pct) {
        const min = minPct();
        if (pct >= Math.min(100, min + 15)) return 'var(--ams-success)';
        if (pct >= min) return 'var(--ams-primary)';
        if (pct >= min - 10) return 'var(--ams-warning)';
        return 'var(--ams-danger)';
    }

    function getStatusBadgeClass(pct) {
        const min = minPct();
        if (pct >= Math.min(100, min + 15)) return 'extremely-safe';
        if (pct >= min) return 'safe';
        if (pct >= min - 10) return 'borderline';
        return 'danger';
    }

    // ===============================================
    // RENDER FUNCTIONS
    // ===============================================

    function renderAll() {
        const container = document.getElementById('studentPortalContentPlaceholder');
        if (!container) return;

        const sc = getSelectedClass();
        if (!sc || !sc.subjects || sc.subjects.length === 0) {
            container.innerHTML = `
                <div class="ams-container ams-animate-in">
                    <div class="ams-empty-state" style="padding: 60px 20px;">
                        <div class="ams-empty-icon">📚</div>
                        <h4>No Class Selected</h4>
                        <p>Please select a class from the Home tab to start tracking attendance.</p>
                    </div>
                </div>`;
            return;
        }

        let content = '';

        if (amsCurrentView === 'menu') {
            content = renderMenu();
        } else if (amsCurrentView === 'period_wise') {
            content = renderPeriodWiseView(sc);
        } else if (amsCurrentView === 'course_wise') {
            content = renderCourseWiseView(sc);
        } else if (amsCurrentView === 'cumulative') {
            content = renderCumulativeView();
        } else if (amsCurrentView === 'detailed') {
            content = renderDetailedView(sc);
        }

        container.innerHTML = `
            <div class="ams-container ams-animate-in">
                ${content}
            </div>`;

        attachEvents();
        populateMarkAttendance();

        // Grid runs from class start to class end; bring today's row into view
        if (amsCurrentView === 'period_wise') {
            const target = amsScrollToDate;
            amsScrollToDate = null;
            setTimeout(() => {
                const row = target ? document.querySelector(`tr[data-date="${target}"]`) : null;
                (row || document.getElementById('pgRowToday'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (row) row.classList.add('pg-row-flash');
            }, 100);
        }
    }
    
    function renderMenu() {
        return `
        <div class="ams-menu-header">
            <button class="ams-back-btn" onclick="switchPage('dashboardPage', document.querySelector('.dash-nav-item.active'))">
                <i class="fa-solid fa-arrow-left"></i> My Portal
            </button>
        </div>
        <div class="ams-menu-content">
            <div class="ams-menu-title">
                <div class="ams-menu-icon-box">
                    <i class="fa-regular fa-calendar-check" style="color: #10b981;"></i>
                </div>
                <div>
                    <h2>Attendance</h2>
                    <p>View and manage your attendance records</p>
                </div>
            </div>
            
            <div class="ams-menu-list">
                <div class="ams-menu-card" onclick="window.amsNavigate('period_wise')">
                    <div class="ams-card-icon" style="background: #eef2ff; color: #3b82f6;">
                        <i class="fa-solid fa-chart-simple"></i>
                    </div>
                    <div class="ams-card-text">
                        <h3>Period-wise Attendance</h3>
                        <p>View attendance by individual periods</p>
                    </div>
                    <div class="ams-card-arrow"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
                
                <div class="ams-menu-card" onclick="window.amsNavigate('course_wise')">
                    <div class="ams-card-icon" style="background: #f3e8ff; color: #8b5cf6;">
                        <i class="fa-solid fa-book-open"></i>
                    </div>
                    <div class="ams-card-text">
                        <h3>Course-wise Attendance</h3>
                        <p>View attendance for each subject</p>
                    </div>
                    <div class="ams-card-arrow"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
                
                <div class="ams-menu-card" onclick="window.amsNavigate('cumulative')">
                    <div class="ams-card-icon" style="background: #dcfce7; color: #22c55e;">
                        <i class="fa-solid fa-arrow-trend-up"></i>
                    </div>
                    <div class="ams-card-text">
                        <h3>Cumulative Attendance</h3>
                        <p>View monthly/overall attendance</p>
                    </div>
                    <div class="ams-card-arrow"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
                
                <div class="ams-menu-card" onclick="window.amsNavigate('detailed')">
                    <div class="ams-card-icon" style="background: #ffedd5; color: #f97316;">
                        <i class="fa-solid fa-file-lines"></i>
                    </div>
                    <div class="ams-card-text">
                        <h3>Detailed Attendance</h3>
                        <p>View detailed records with filters</p>
                    </div>
                    <div class="ams-card-arrow"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
            </div>
        </div>`;
    }
    
    function renderPeriodWiseView(sc) {
        // Ensure classwise mode is active for period grid
        amsMode = 'classwise';
        return `
            ${renderHeader('Period-wise Attendance')}
            ${renderMarkSection()}
        `;
    }
    
    function renderCourseWiseView(sc) {
        const stats = calculateStats();
        return `
            ${renderHeader('Course-wise Attendance')}
            ${renderStatsGrid(stats.overall)}
            ${renderThresholdRow(stats.overall)}
            ${renderSubjectSummary(stats.subjects)}
        `;
    }
    
    function renderCumulativeView() {
        return `
            ${renderHeader('Cumulative Attendance')}
            ${typeof renderCumulativeStats === 'function' ? renderCumulativeStats() : ''}
        `;
    }
    
    function renderDetailedView(sc) {
        const records = buildRecords();
        const filtered = applyFilters(records);
        return `
            ${renderHeader('Detailed Attendance')}
            ${renderFilterSection(sc)}
            ${renderRecordsTable(filtered)}
        `;
    }

    function renderHeader(title) {
        return `
        <div class="ams-page-header">
            <div class="ams-header-left">
                <button class="ams-back-btn" onclick="window.amsNavigate('menu')">
                    <i class="fa-solid fa-arrow-left"></i> Attendance Menu
                </button>
                <h2 style="margin-top: 10px;">${title}</h2>
            </div>
            <div class="ams-header-actions">
                <!-- Removed mode toggle as it's now handled by the menu structure -->
            </div>
        </div>`;
    }

    function renderStatsGrid(o) {
        return `
        <div class="ams-stats-grid">
            <div class="ams-stat-card overall">
                <div class="ams-stat-label">Overall Attendance</div>
                <div class="ams-stat-row">
                    <div>
                        <div class="ams-stat-value">${o.percentage}%</div>
                        <div class="ams-stat-sub">${o.attended} / ${o.totalHeld} classes</div>
                    </div>
                    ${renderProgressRing(parseFloat(o.percentage), getPctColor(parseFloat(o.percentage)))}
                </div>
            </div>
            <div class="ams-stat-card present">
                <div class="ams-stat-label">Present Classes</div>
                <div class="ams-stat-row">
                    <div>
                        <div class="ams-stat-value">${o.present}</div>
                        <div class="ams-stat-sub">Attended + ML + OD</div>
                    </div>
                    <div class="ams-stat-icon"><i class="fa-solid fa-check"></i></div>
                </div>
            </div>
            <div class="ams-stat-card absent">
                <div class="ams-stat-label">Absent Classes</div>
                <div class="ams-stat-row">
                    <div>
                        <div class="ams-stat-value">${o.absent}</div>
                        <div class="ams-stat-sub">Bunked / Missed</div>
                    </div>
                    <div class="ams-stat-icon"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div class="ams-stat-card total">
                <div class="ams-stat-label">Total Classes</div>
                <div class="ams-stat-row">
                    <div>
                        <div class="ams-stat-value">${o.totalHeld}</div>
                        <div class="ams-stat-sub">${o.cancelled} cancelled</div>
                    </div>
                    <div class="ams-stat-icon"><i class="fa-solid fa-calendar-days"></i></div>
                </div>
            </div>
        </div>`;
    }

    function renderThresholdRow(o) {
        const pct = parseFloat(o.percentage);
        return `
        <div class="ams-threshold-row">
            <div class="ams-threshold-card can-miss">
                <div class="ams-threshold-icon"><i class="fa-solid fa-umbrella-beach"></i></div>
                <div class="ams-threshold-info">
                    <div class="label">Can Miss</div>
                    <div class="value">${o.canMiss > 0 ? o.canMiss : 0} Classes</div>
                    <div class="hint">While maintaining ${minPct()}%</div>
                </div>
            </div>
            <div class="ams-threshold-card must-attend">
                <div class="ams-threshold-icon"><i class="fa-solid fa-bullseye"></i></div>
                <div class="ams-threshold-info">
                    <div class="label">Must Attend</div>
                    <div class="value">${o.mustAttend > 0 ? o.mustAttend : 0} Classes</div>
                    <div class="hint">To reach ${minPct()}%</div>
                </div>
            </div>
            <div class="ams-threshold-card status">
                <div class="ams-threshold-icon"><i class="fa-solid fa-shield-halved"></i></div>
                <div class="ams-threshold-info">
                    <div class="label">Attendance Status</div>
                    <div class="value"><span class="ams-status-badge ${o.statusClass}">${o.statusText}</span></div>
                    <div class="hint">${pct >= minPct() ? 'Above threshold ✓' : `Below ${minPct()}% threshold`}</div>
                </div>
            </div>
        </div>`;
    }

    function renderSubjectSummary(subjects) {
        if (!subjects || subjects.length === 0) return '';

        let rows = '';
        
        let tMax = 0, tAtt = 0, tAbs = 0, tOdMl = 0, tEff = 0;
        
        subjects.forEach(s => {
            const maxHours = s.totalHeld;
            const attHours = s.present; // Just present
            const odMlHours = s.medical + s.dutyLeave;
            const absHours = s.absent;
            
            tMax += maxHours;
            tAtt += attHours;
            tAbs += absHours;
            tOdMl += odMlHours;
            
            const avgPct = maxHours > 0 ? (attHours / maxHours) * 100 : 0;
            const odMlPct = maxHours > 0 ? (odMlHours / maxHours) * 100 : 0;
            // Total follows the OD/ML limit, like the college portal
            const totalPct = typeof cappedWithPct === 'function'
                ? cappedWithPct(attHours + odMlHours, maxHours, odMlHours, remainingFor(s.code))
                : (maxHours > 0 ? ((attHours + odMlHours) / maxHours) * 100 : 0);
            tEff += (totalPct / 100) * maxHours;
            
            const color = getPctColor(totalPct);

            rows += `
            <tr>
                <td><strong>${s.code}</strong></td>
                <td>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div style="width:24px;height:24px;border-radius:4px;background:${s.color};display:flex;align-items:center;justify-content:center;color:white;font-size:0.6rem;font-weight:bold;">
                            ${s.shortName ? s.shortName.substring(0,2) : s.code.substring(0,2)}
                        </div>
                        ${s.name}
                    </div>
                </td>
                <td style="text-align:center;">${maxHours}</td>
                <td style="text-align:center;color:var(--ams-success);font-weight:600;">${attHours}</td>
                <td style="text-align:center;color:var(--ams-danger);font-weight:600;">${absHours}</td>
                <td style="text-align:center;">${avgPct.toFixed(2)}</td>
                <td style="text-align:center;">${odMlPct.toFixed(2)}</td>
                <td style="text-align:center;font-weight:bold;color:${color}">${totalPct.toFixed(2)}</td>
            </tr>`;
        });
        
        // Total row
        const tAvgPct = tMax > 0 ? (tAtt / tMax) * 100 : 0;
        const tOdMlPct = tMax > 0 ? (tOdMl / tMax) * 100 : 0;
        const tTotalPct = tMax > 0 ? (tEff / tMax) * 100 : 0;
        
        rows += `
        <tr style="background:var(--light-bg);font-weight:bold;border-top:2px solid var(--border-color);">
            <td colspan="2" style="text-align:right;">Total</td>
            <td style="text-align:center;">${tMax}</td>
            <td style="text-align:center;color:var(--ams-success);">${tAtt}</td>
            <td style="text-align:center;color:var(--ams-danger);">${tAbs}</td>
            <td style="text-align:center;">${tAvgPct.toFixed(2)}</td>
            <td style="text-align:center;">${tOdMlPct.toFixed(2)}</td>
            <td style="text-align:center;color:${getPctColor(tTotalPct)}">${tTotalPct.toFixed(2)}</td>
        </tr>`;

        return `
        <div class="ams-subject-summary" style="margin-top:24px;">
            <div class="ams-subject-summary-header">
                <h4>📚 Course-wise Attendance</h4>
            </div>
            <div class="ams-table-wrapper">
                <table class="ams-summary-table">
                    <thead>
                        <tr>
                            <th>Code</th>
                            <th>Description</th>
                            <th style="text-align:center;">Max. Hours</th>
                            <th style="text-align:center;">Att. Hours</th>
                            <th style="text-align:center;">Absent Hours</th>
                            <th style="text-align:center;">Average %</th>
                            <th style="text-align:center;">OD/ML %</th>
                            <th style="text-align:center;">Total %</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
    }

    function renderMarkSection() {
        if (amsMode === 'daywise') {
            return `
            <div class="ams-mark-section">
                <div class="ams-section-header">
                    <div>
                        <div class="ams-section-title">📅 Mark Attendance — Day-wise</div>
                        <div class="ams-section-subtitle">Select a date and mark attendance for each period</div>
                    </div>
                </div>
                <div class="ams-mark-controls">
                    <label for="amsDatePicker">Date:</label>
                    <input type="date" id="amsDatePicker" value="${amsSelectedDate}" onchange="window.amsDateChanged(this.value)">
                </div>
                <div id="amsSubjectList"></div>
                <button class="ams-save-btn" id="amsSaveBtn" onclick="window.amsSaveAttendance()">
                    <i class="fa-solid fa-floppy-disk"></i> Save Attendance
                </button>
            </div>`;
        } else {
            // Class-wise mode -> Period-wise Grid
            return renderPeriodGridModal();
        }
    }
    
    // "Formal Language and Automata" -> "FLA", "Computer Networks" -> "CN" (max 4 letters)
    function cellLabel(p) {
        const short = String(p.shortName || '').trim();
        if (short && short.length <= 5 && short !== p.code) return short;
        const ignore = ['and', 'of', 'the', 'in', 'for', 'to', 'a', 'an', '&'];
        const words = String(p.name || p.code).split(/\s+/).filter(w => w && !ignore.includes(w.toLowerCase()));
        const acr = words.length > 1 ? words.map(w => w[0]).join('') : String(p.name || p.code).slice(0, 4);
        return acr.toUpperCase().slice(0, 4);
    }

    function renderPeriodGridModal() {
        const sc = getSelectedClass();
        if (!sc || !sc.subjects) return '';

        const logs = getLogs();
        const { start, end, today } = getClassDateRange(sc);

        // Every scheduled date from class start to class end (chronological)
        const dates = getClassDates(sc);

        // Find max periods
        let maxPeriods = 6;
        dates.forEach(d => { if (d.periods.length > maxPeriods) maxPeriods = d.periods.length; });

        let headerRow = '<tr><th>Date</th>';
        for(let i=1; i<=maxPeriods; i++) headerRow += `<th>${i}</th>`;
        headerRow += '</tr>';

        let bodyRows = '';
        let anchorSet = false;
        dates.forEach(dObj => {
            const dateStr = dObj.date;
            const dayLog = logs[dateStr] || {};
            
            const dispDate = getDayShort(dateStr) + ' ' + parseDate(dateStr).toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
            
            const rowClass = dateStr === today ? 'pg-row-today' : (dateStr > today ? 'pg-row-future' : '');
            // Scroll anchor: today, or the next class day if today has no classes
            const rowId = (!anchorSet && dateStr >= today) ? (anchorSet = true, ' id="pgRowToday"') : '';
            const exam = typeof getExamOn === 'function' ? getExamOn(dateStr) : null;
            const dayPart = getDayShort(dateStr);
            const datePart = parseDate(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
            let rowHtml = `<tr class="${rowClass}${exam ? ' pg-row-exam' : ''}"${rowId} data-date="${dateStr}"><td class="pg-date-cell" style="white-space:nowrap;font-weight:600;cursor:pointer;" onclick="window.amsOpenBulkDatePopup(event, '${dateStr}')" title="${exam ? `Exam: ${String(exam.title).replace(/"/g, '&quot;')} · ` : ''}Click for bulk actions on ${dispDate}"><span class="pg-dw">${dayPart}</span> <span class="pg-dd">${datePart}</span>${exam ? ' <span class="pg-exam-tag">📝 Exam</span>' : ''}</td>`;
            
            const periodCounts = {};
            for(let i=0; i<maxPeriods; i++) {
                const p = dObj.periods[i];
                if (p) {
                    periodCounts[p.code] = (periodCounts[p.code] || 0) + 1;
                    const periodKey = `${p.code}_p${periodCounts[p.code]}`;
                    const status = dayLog[periodKey] || dayLog[p.code] || 'Default';
                    
                    let shortStatus = '?';
                    let cssClass = 'pg-null';
                    if (status === 'Attended' || status === 'Present' || status === 'P') { shortStatus = 'P'; cssClass = 'pg-present'; }
                    else if (status === 'Skipped' || status === 'Absent' || status === 'A') { shortStatus = 'A'; cssClass = 'pg-absent'; }
                    else if (status === 'Cancelled' || status === 'C') { shortStatus = 'C'; cssClass = 'pg-cancelled'; }
                    else if (status === 'Medical Leave (ML)' || status === 'ML') { shortStatus = 'ML'; cssClass = 'pg-medical'; }
                    else if (status === 'Duty Leave (OD)' || status === 'OD') { shortStatus = 'OD'; cssClass = 'pg-duty'; }
                    
                    // Subject color glow (like portal mode)
                    const subjIdx = sc.subjects.findIndex(s => s.code === p.code);
                    const subjColor = getSubjectColor(subjIdx >= 0 ? subjIdx : 0);
                    const glowStyle = `--sc:${subjColor}; box-shadow: 0 0 8px 2px ${subjColor}40, inset 0 0 0 2px ${subjColor};`;
                    const safeName = p.name.replace(/'/g, "\\'");
                    // Short subject label so each cell says which class it is (e.g. "FLA")
                    const abbr = cellLabel(p);
                    
                    rowHtml += `<td class="pg-cell ${cssClass}" 
                                style="${glowStyle}"
                                onclick="window.amsOpenPeriodPopup(event, '${dateStr}', '${periodKey}', '${safeName}')"
                                title="${p.name} | ${status}">
                                <span class="pg-sub">${abbr}</span><span class="pg-st">${shortStatus}</span>
                                </td>`;
                } else {
                    rowHtml += `<td class="pg-cell pg-empty" title="${i < dObj.periods.length ? 'Free period' : 'No class'}">-</td>`;
                }
            }
            rowHtml += '</tr>';
            bodyRows += rowHtml;
        });
        
        return `
        <style>
            .period-grid-container { display: flex; gap: 20px; align-items: flex-start; margin-top: 20px; min-width: 0; max-width: 100%; }
            .period-grid-container > * { min-width: 0; }
            .ams-mark-section { min-width: 0; max-width: 100%; }
            /* Grid scrolls inside its own box; date column and period numbers stay put */
            .pg-table-wrapper { max-width: 100%; max-height: 72vh; overflow: auto; -webkit-overflow-scrolling: touch; }
            .pg-table thead th { position: sticky; top: 0; z-index: 2; }
            .pg-table th:first-child, .pg-table td.pg-date-cell { position: sticky; left: 0; z-index: 1; background: var(--card-bg); }
            .pg-table thead th:first-child { z-index: 3; background: var(--light-bg); }
            .pg-table tr.pg-row-today td.pg-date-cell { background: var(--primary-grad-start, #4f46e5); color: #fff; }
            .pg-start-missing { display: flex; align-items: center; gap: 12px; margin: 12px 0; padding: 12px 14px; border-radius: 14px; border: 1px solid rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.10); }
            .pg-start-missing > i { color: #d97706; font-size: 1.2rem; }
            .pg-start-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 0.85rem; text-align: left; }
            .pg-start-text span { opacity: 0.8; }
            .pg-start-missing button { flex-shrink: 0; border: none; border-radius: 10px; padding: 9px 14px; font: inherit; font-weight: 600; color: #fff; background: linear-gradient(135deg, #4f46e5, #3b82f6); cursor: pointer; }
            @media (max-width: 560px) { .pg-start-missing { flex-wrap: wrap; } .pg-start-missing button { width: 100%; } }
            .pg-cell { line-height: 1.05; }
            .pg-cell .pg-sub { display: block; font-size: 0.62rem; font-weight: 800; letter-spacing: 0.2px; opacity: 0.85; }
            .pg-cell .pg-st { display: block; font-size: 0.82rem; font-weight: 800; }
            .pg-null .pg-st { opacity: 0.6; }
            .pg-bulk-actions { background: var(--card-bg); padding: 15px; border-radius: 12px; min-width: 200px; box-shadow: var(--card-shadow); border: 1px solid var(--border-color); }
            .pg-bulk-actions button { display: block; width: 100%; text-align: left; padding: 10px; margin-bottom: 8px; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; font-family: 'Outfit'; color: white; transition: 0.2s;}
            .pg-bulk-actions button:active { transform: scale(0.96); }
            .pg-btn-present { background: #4CAF50; }
            .pg-btn-absent { background: #f44336; }
            .pg-btn-cancelled { background: #9e9e9e; }
            .pg-btn-duty { background: #2196F3; }
            .pg-btn-medical { background: #FF9800; }
            .pg-btn-reset { background: var(--light-bg); color: var(--dark-text) !important; border: 1px solid var(--border-color) !important; }
            .pg-btn-shift { background: #7c3aed; }
            .pg-btn-holiday { background: #0d9488; }
            .pg-bulk-divider { grid-column: 1 / -1; margin: 10px 0 8px; padding-top: 10px; border-top: 1px solid var(--border-color); font-size: 0.8rem; font-weight: 700; color: var(--medium-text); text-transform: uppercase; letter-spacing: 0.4px; }
            
            .pg-table-wrapper { flex: 1; overflow-x: auto; background: var(--card-bg); border-radius: 12px; box-shadow: var(--card-shadow); border: 1px solid var(--border-color); }
            .pg-table { width: 100%; border-collapse: separate; border-spacing: 3px; min-width: ${110 + maxPeriods * 54}px; }
            .pg-table th, .pg-table td { padding: 10px 8px; text-align: center; }
            .pg-table th { background: var(--light-bg); font-weight: 700; color: var(--medium-text); border-bottom: 2px solid var(--border-color); }
            .pg-cell { cursor: pointer; user-select: none; font-weight: 700; font-size: 0.8rem; border-radius: 6px; min-width: 42px; min-height: 30px; transition: transform 0.2s, box-shadow 0.2s, filter 0.2s; }
            .pg-cell:hover { transform: scale(1.12); filter: brightness(1.1); }
            .pg-empty { cursor: default; color: var(--medium-text); background: rgba(200, 200, 200, 0.3) !important; box-shadow: none !important; }
            .pg-empty:hover { transform: none; filter: none; }
            
            .pg-present { background: rgba(76, 175, 80, 0.85); color: white; }
            .pg-absent { background: rgba(229, 115, 115, 0.9); color: white; }
            .pg-cancelled { background: rgba(158, 158, 158, 0.8); color: white; }
            .pg-duty { background: rgba(100, 181, 246, 0.9); color: white; }
            .pg-medical { background: rgba(255, 183, 77, 0.9); color: #333; }
            .pg-null { background: rgba(200, 200, 200, 0.4); color: var(--dark-text); border: 2px dashed var(--medium-text); }
            body.dark-mode .pg-null { background: rgba(100, 100, 100, 0.4); color: var(--light-text); border-color: rgba(200, 200, 200, 0.5); }
            body.dark-mode .pg-present { background: rgba(102, 187, 106, 0.75); }
            body.dark-mode .pg-absent { background: rgba(239, 154, 154, 0.75); color: #1a1a1a; }
            body.dark-mode .pg-cancelled { background: rgba(189, 189, 189, 0.6); color: #1a1a1a; }
            body.dark-mode .pg-duty { background: rgba(144, 202, 249, 0.75); color: #1a1a1a; }
            body.dark-mode .pg-medical { background: rgba(255, 213, 79, 0.75); color: #1a1a1a; }
            
            .pg-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 15px; padding: 10px 15px; background: var(--light-bg); border-radius: 8px; font-size: 0.85rem; justify-content: center; }
            .pg-leg-item { display: flex; align-items: center; gap: 6px; }
            .pg-leg-box { width: 16px; height: 16px; border-radius: 4px; }
            .pg-leg-box.pg-null { border: 2px dashed #888; background: rgba(200, 200, 200, 0.6); width: 12px; height: 12px; }
            
            /* Edit popup (matching portal mode) */
            .pg-edit-popup { position: fixed; background: var(--card-bg); border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 12px; z-index: 1100; min-width: 180px; animation: pgPopIn 0.15s ease-out; }
            @keyframes pgPopIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
            .pg-edit-popup .pg-popup-header { font-weight: 600; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border-color); font-size: 0.85rem; }
            .pg-edit-popup .pg-popup-header small { color: var(--medium-text); display: block; margin-top: 2px; }
            .pg-edit-popup button { display: block; width: 100%; padding: 9px 14px; margin: 4px 0; border: none; border-radius: 6px; cursor: pointer; text-align: left; font-size: 0.85rem; font-weight: 600; font-family: 'Outfit', sans-serif; transition: filter 0.15s, transform 0.15s; }
            .pg-edit-popup button:hover { filter: brightness(0.9); transform: translateX(2px); }
            .pg-edit-popup button:active { transform: scale(0.97); }
            
            /* Bulk action per-date popup */
            .pg-bulk-date-popup { position: fixed; background: var(--card-bg); border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 12px; z-index: 1100; min-width: 190px; animation: pgPopIn 0.15s ease-out; }
            .pg-bulk-date-popup .pg-popup-header { font-weight: 700; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border-color); font-size: 0.9rem; }
            .pg-bulk-date-popup .pg-popup-header small { color: var(--medium-text); display: block; margin-top: 2px; }
            .pg-bulk-date-popup button { display: block; width: 100%; padding: 9px 14px; margin: 4px 0; border: none; border-radius: 6px; cursor: pointer; text-align: left; font-size: 0.85rem; font-weight: 600; font-family: 'Outfit', sans-serif; transition: filter 0.15s, transform 0.15s; }
            .pg-bulk-date-popup button:hover { filter: brightness(0.9); transform: translateX(2px); }
            .pg-bulk-date-popup button:active { transform: scale(0.97); }
            
            .pg-date-cell { cursor: pointer; }
            .pg-row-future .pg-cell:not(.pg-empty) { opacity: 0.5; }
            .pg-row-today .pg-date-cell { background: var(--primary-grad-start); color: white; border-radius: 6px; }
            .pg-range-info { text-align: center; font-size: 0.85rem; color: var(--medium-text); margin: -6px 0 14px; }
            .pg-date-cell:hover { background: var(--primary-grad-start) !important; color: white !important; border-radius: 6px; }
            
            @media (max-width: 768px) {
                .period-grid-container { flex-direction: column; align-items: stretch; }
                .pg-bulk-actions { width: 100%; min-width: 0; box-sizing: border-box; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px; }
                .pg-bulk-actions button { margin-bottom: 0; padding: 9px 10px; font-size: 0.82rem; }
                .pg-bulk-actions > div:first-child { grid-column: 1 / -1; margin-bottom: 2px !important; }
                .pg-table-wrapper { width: 100%; }
                .pg-table { border-spacing: 2px; min-width: ${92 + maxPeriods * 48}px; }
                .pg-table th, .pg-table td { padding: 6px 4px; }
                .pg-table td.pg-date-cell { font-size: 0.78rem; padding-left: 6px; padding-right: 6px; }
                .pg-cell { min-width: 40px; }
                .pg-legend { gap: 8px 12px; font-size: 0.78rem; padding: 8px 10px; }
                .pg-range-info { font-size: 0.78rem; }
            }
            /* ---------- Phones: whole day fits, clean cells, compact controls ---------- */
            @media (max-width: 560px) {
                #studentPortalPage .ams-container { padding: 0 12px; }
                .ams-mark-section { margin-top: 12px !important; }
                .period-grid-container { gap: 12px; margin-top: 12px; }
                .pg-range-info { margin: -2px 0 10px; line-height: 1.45; }

                /* Legend: one tidy row */
                .pg-legend { flex-wrap: nowrap; overflow-x: auto; justify-content: flex-start; gap: 6px; padding: 6px; margin-bottom: 10px; border-radius: 12px; scrollbar-width: none; }
                .pg-legend::-webkit-scrollbar { display: none; }
                .pg-leg-item { flex: 0 0 auto; gap: 5px; padding: 4px 9px; border-radius: 999px; background: var(--card-bg); border: 1px solid var(--border-color); font-size: 0.72rem; white-space: nowrap; }
                .pg-leg-box { width: 10px !important; height: 10px !important; border-radius: 3px; border-width: 1.5px !important; }

                /* Bulk actions: small chips instead of big coloured blocks */
                .pg-bulk-actions { display: flex !important; flex-wrap: wrap; gap: 6px !important; padding: 12px !important; border-radius: 16px; }
                .pg-bulk-actions .pg-bulk-title { flex-basis: 100%; margin: 0 0 2px !important; font-size: 0.72rem !important; letter-spacing: 0.5px; text-transform: uppercase; }
                .pg-bulk-actions .pg-bulk-divider { flex-basis: 100%; margin: 6px 0 2px; padding-top: 8px; font-size: 0.72rem; }
                .pg-bulk-actions button { flex: 0 0 auto; width: auto; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px !important; border-radius: 999px; font-size: 0.78rem !important; font-weight: 600; color: var(--dark-text) !important; background: var(--light-bg) !important; border: 1px solid var(--border-color) !important; }
                .pg-bulk-actions button::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
                .pg-bulk-actions .pg-btn-present::before { background: #22c55e; }
                .pg-bulk-actions .pg-btn-absent::before { background: #ef4444; }
                .pg-bulk-actions .pg-btn-cancelled::before { background: #9ca3af; }
                .pg-bulk-actions .pg-btn-duty::before { background: #3b82f6; }
                .pg-bulk-actions .pg-btn-medical::before { background: #f59e0b; }
                .pg-bulk-actions .pg-btn-reset::before { background: transparent; border: 1.5px solid var(--medium-text); box-sizing: border-box; }
                .pg-bulk-actions .pg-btn-shift::before { background: #7c3aed; }
                .pg-bulk-actions .pg-btn-holiday::before { background: #0d9488; }

                /* Grid: no sideways scroll for a normal day (up to 7 periods) */
                .pg-table-wrapper { border-radius: 16px; max-height: 70vh; }
                .pg-table { min-width: ${maxPeriods > 7 ? 56 + maxPeriods * 42 : 0}px !important; width: 100%; table-layout: fixed; border-spacing: 3px; }
                .pg-table th { padding: 8px 0 !important; font-size: 0.72rem; border-bottom-width: 1px; }
                .pg-table th:first-child, .pg-table td.pg-date-cell { width: 52px; }
                .pg-table td { padding: 0 !important; }
                .pg-table td.pg-date-cell { padding: 5px 2px !important; white-space: normal !important; line-height: 1.15; border-radius: 10px; }
                .pg-dw { display: block; font-size: 0.62rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.7; }
                .pg-dd { display: block; font-size: 0.78rem; font-weight: 700; }
                .pg-exam-tag { display: block; font-size: 0.55rem; }
                .pg-cell { min-width: 0 !important; height: 42px; border-radius: 10px; border: none !important; box-shadow: inset 0 0 0 1.5px var(--sc, transparent) !important; }
                .pg-cell:hover { transform: none; }
                .pg-cell:active { transform: scale(0.94); }
                .pg-cell .pg-sub { font-size: 0.54rem; letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 2px; }
                .pg-cell .pg-st { font-size: 0.8rem; margin-top: 1px; }
                .pg-present, .pg-absent, .pg-cancelled, .pg-duty, .pg-medical { box-shadow: none !important; }
                .pg-null { background: color-mix(in srgb, var(--sc, #94a3b8) 9%, var(--card-bg, #fff)) !important; color: var(--dark-text); }
                .pg-empty { height: 42px; border-radius: 10px; background: transparent !important; color: var(--border-color); font-size: 0.8rem; }
                .pg-row-today td.pg-date-cell { box-shadow: 0 4px 12px -4px rgba(79, 70, 229, 0.55); }
                .pg-row-future .pg-cell:not(.pg-empty) { opacity: 0.45; }

                /* Tap pop-ups: bottom sheet, thumb-friendly */
                .pg-edit-popup, .pg-bulk-date-popup { left: 0 !important; right: 0 !important; top: auto !important; bottom: 0 !important; width: auto !important; min-width: 0; border-radius: 20px 20px 0 0; padding: 14px 16px calc(16px + env(safe-area-inset-bottom)); animation: pgSheetUp 0.22s cubic-bezier(.2,.8,.2,1); box-shadow: 0 -12px 40px rgba(0,0,0,0.25); }
                .pg-edit-popup, .pg-bulk-date-popup { box-shadow: 0 0 0 100vmax rgba(15, 23, 42, 0.45), 0 -12px 40px rgba(0,0,0,0.25) !important; }
                .pg-edit-popup .pg-popup-header, .pg-bulk-date-popup .pg-popup-header { font-size: 0.98rem; padding-bottom: 10px; margin-bottom: 10px; }
                .pg-edit-popup .pg-popup-header::before, .pg-bulk-date-popup .pg-popup-header::before { content: ''; display: block; width: 40px; height: 4px; margin: -4px auto 12px; border-radius: 999px; background: var(--border-color); }
                .pg-edit-popup button, .pg-bulk-date-popup button { padding: 12px 14px; font-size: 0.92rem; border-radius: 12px; }
                .pg-edit-popup button:hover, .pg-bulk-date-popup button:hover { transform: none; }
                @keyframes pgSheetUp { from { transform: translateY(100%); } to { transform: none; } }
            }
        </style>
        
        <div class="ams-mark-section" style="margin-top: 24px;">
            <div class="ams-section-header" style="justify-content: center; text-align: center; display: block;">
                <div class="ams-section-subtitle">Tap a cell to change its status · tap a date for the whole day.</div>
            </div>
            ${!(sc.portalSetup?.semesterStartDate || sc.startDate) ? `
            <div class="pg-start-missing">
                <i class="fa-solid fa-calendar-plus"></i>
                <div class="pg-start-text">
                    <strong>Semester start date not set</strong>
                    <span>Showing from ${formatDateDisplay(start)}. Add the date your classes began to mark every day from the start.</span>
                </div>
                <button type="button" onclick="window.askSemesterStart && askSemesterStart({ force: true })">Set start date</button>
            </div>` : ''}
            
            <div class="pg-range-info">
                <i class="fa-regular fa-calendar"></i> ${formatDateDisplay(start)} &rarr; ${formatDateDisplay(end)}
                &middot; ${dates.length} class days (holidays &amp; no-class days skipped)
            </div>

            <div class="pg-legend">
                <div class="pg-leg-item"><div class="pg-leg-box pg-null" style="background: rgba(200, 200, 200, 0.6); border: 2px dashed #888; width:12px; height:12px;"></div> Not Logged (?)</div>
                <div class="pg-leg-item"><div class="pg-leg-box" style="background: #4CAF50;"></div> Present (P)</div>
                <div class="pg-leg-item"><div class="pg-leg-box" style="background: #f44336;"></div> Absent (A)</div>
                <div class="pg-leg-item"><div class="pg-leg-box" style="background: #9e9e9e;"></div> Cancelled (C)</div>
                <div class="pg-leg-item"><div class="pg-leg-box" style="background: #2196F3;"></div> Duty Leave (OD)</div>
                <div class="pg-leg-item"><div class="pg-leg-box" style="background: #FF9800;"></div> Medical (ML)</div>
            </div>
            
            <div class="period-grid-container">
                <div class="pg-bulk-actions">
                    <div class="pg-bulk-title" style="font-size: 0.9rem; font-weight: bold; margin-bottom: 12px; color: var(--medium-text);">Bulk Actions (Up to Today)</div>
                    <button class="pg-btn-present" onclick="window.amsBulkPeriod('Attended')">✓ All Attended</button>
                    <button class="pg-btn-absent" onclick="window.amsBulkPeriod('Skipped')">✗ All Skipped</button>
                    <button class="pg-btn-cancelled" onclick="window.amsBulkPeriod('Cancelled')">× All Cancelled</button>
                    <button class="pg-btn-duty" onclick="window.amsBulkPeriod('Duty Leave (OD)')">📋 All Duty Leave</button>
                    <button class="pg-btn-medical" onclick="window.amsBulkPeriod('Medical Leave (ML)')">🏥 All Medical Leave</button>
                    <button class="pg-btn-reset" onclick="window.amsBulkPeriod('Default')">↻ Reset All (Default)</button>
                    <div class="pg-bulk-divider">Day changes</div>
                    <button class="pg-btn-shift" onclick="window.amsOpenShiftDay()">🔁 Day shifted to weekend</button>
                    <button class="pg-btn-holiday" onclick="window.amsOpenSuddenHoliday()">🏖️ Sudden holiday</button>
                </div>
                
                <div class="pg-table-wrapper">
                    <table class="pg-table">
                        <thead>${headerRow}</thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
    }
    
    // Add cumulative function at the end
    // Normalised status bucket for a raw log status
    function statusBucket(status) {
        const st = String(status || '').toUpperCase().trim();
        if (st === 'ATTENDED' || st === 'PRESENT' || st === 'P') return 'p';
        if (st === 'SKIPPED' || st === 'ABSENT' || st === 'A') return 'a';
        if (st === 'DUTY LEAVE (OD)' || st === 'OD') return 'od';
        if (st === 'MEDICAL LEAVE (ML)' || st === 'ML') return 'ml';
        return null;
    }

    // Every counted mark, one entry per class hour, for the selected class only
    function cumulativeEntries() {
        const sc = getSelectedClass();
        const logs = getLogs();
        const names = {};
        (sc?.subjects || []).forEach(sub => { names[sub.code] = sub.name; });
        const entries = [];
        Object.keys(logs).sort().forEach(dateStr => {
            Object.keys(logs[dateStr] || {}).forEach(key => {
                const bucket = statusBucket(logs[dateStr][key]);
                if (!bucket) return;
                const code = key.split('_p')[0];
                if (!names[code]) return; // marks for subjects not in this class are not counted
                const isLegacy = !key.includes('_p');
                // Old whole-day marks (no period) stand for every class of that subject that day
                const hours = isLegacy && typeof getClassCountOnDate === 'function'
                    ? Math.max(1, getClassCountOnDate(dateStr, code)) : 1;
                entries.push({ date: dateStr, code, name: names[code], period: isLegacy ? null : Number(key.split('_p')[1]), bucket, hours, legacy: isLegacy });
            });
        });
        return entries;
    }

    function renderCumulativeStats() {
        const entries = cumulativeEntries();
        const monthMap = {};
        entries.forEach(e => {
            const monthKey = e.date.substring(0, 7);
            if (!monthMap[monthKey]) {
                monthMap[monthKey] = { label: parseDate(monthKey + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }), p: 0, a: 0, od: 0, ml: 0 };
            }
            monthMap[monthKey][e.bucket] += e.hours;
        });

        const sortedMonths = Object.keys(monthMap).sort().reverse();
        if (!sortedMonths.length) return '';

        const cell = (m, key, color, value) => {
            const active = amsCumDetail && amsCumDetail.month === m && amsCumDetail.status === key;
            return value > 0
                ? `<td><button class="ams-cum-num ${active ? 'active' : ''}" style="color:${color};" onclick="window.amsCumShow('${m}', '${key}')" title="See which days">${value}</button></td>`
                : `<td style="color:${color};font-weight:bold;">0</td>`;
        };

        let rows = '';
        sortedMonths.forEach(m => {
            const d = monthMap[m];
            rows += `<tr>
                <td style="font-weight:bold;">${d.label.toUpperCase()}</td>
                ${cell(m, 'p', 'var(--ams-success)', d.p)}
                ${cell(m, 'a', 'var(--ams-danger)', d.a)}
                ${cell(m, 'od', 'var(--ams-primary)', d.od)}
                ${cell(m, 'ml', 'var(--ams-warning)', d.ml)}
            </tr>`;
        });

        return `
        <div class="ams-subject-summary" style="margin-top:24px;">
            <div class="ams-subject-summary-header">
                <h4>📈 Cumulative Attendance</h4>
            </div>
            <p class="ams-cum-hint">Tap a number to see exactly which days and classes it comes from.</p>
            <div class="ams-table-wrapper">
                <table class="ams-summary-table">
                    <thead>
                        <tr>
                            <th>Month / Year</th>
                            <th>Present</th>
                            <th>Absent</th>
                            <th>OD Present</th>
                            <th>ML</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            ${renderCumulativeDetail(entries)}
        </div>`;
    }

    function renderCumulativeDetail(entries) {
        if (!amsCumDetail) return '';
        const { month, status } = amsCumDetail;
        const labels = { p: 'Present', a: 'Absent', od: 'OD (Duty Leave)', ml: 'ML (Medical Leave)' };
        const list = entries.filter(e => e.date.startsWith(month) && e.bucket === status);
        if (!list.length) return '';

        // Group by date, then subject
        const byDate = {};
        list.forEach(e => {
            byDate[e.date] = byDate[e.date] || {};
            const g = byDate[e.date][e.code] = byDate[e.date][e.code] || { name: e.name, periods: [], hours: 0, legacy: false };
            if (e.period) g.periods.push(e.period);
            g.hours += e.hours;
            g.legacy = g.legacy || e.legacy;
        });
        const total = list.reduce((n, e) => n + e.hours, 0);
        const monthLabel = parseDate(month + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

        return `
            <div class="ams-cum-detail">
                <div class="ams-cum-detail-head">
                    <strong>${labels[status]} · ${monthLabel} · ${total} class${total !== 1 ? 'es' : ''}</strong>
                    <button class="ams-cum-close" onclick="window.amsCumShow(null)" aria-label="Close">×</button>
                </div>
                ${Object.keys(byDate).sort().map(date => `
                    <div class="ams-cum-day">
                        <div class="ams-cum-date">${parseDate(date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                        <div class="ams-cum-subjects">
                            ${Object.values(byDate[date]).map(g => `
                                <span>${g.name} · ${g.periods.length ? g.periods.sort((x, y) => x - y).map(p => 'P' + p).join(', ') : `${g.hours} class${g.hours !== 1 ? 'es' : ''}`}${g.legacy ? ' <em title="Marked from the old Daily Log screen for the whole day">(whole day)</em>' : ''}</span>`).join('')}
                        </div>
                        <button class="ams-cum-open" onclick="window.amsOpenDay('${date}')">Open day →</button>
                    </div>`).join('')}
            </div>`;
    }

    window.amsCumShow = function (month, status) {
        amsCumDetail = month ? { month, status } : null;
        renderAll();
    };

    window.amsOpenDay = function (dateStr) {
        amsScrollToDate = dateStr;
        amsCumDetail = null;
        window.amsNavigate('period_wise');
    };
    
function renderFilterSection(sc) {
        const subjects = sc.subjects || [];
        let subjectOptions = '<option value="">All Subjects</option>';
        subjects.forEach(s => {
            subjectOptions += `<option value="${s.code}" ${amsFilters.subject === s.code ? 'selected' : ''}>${s.name}</option>`;
        });

        // Generate month options from logs
        const logs = getLogs();
        const months = new Set();
        Object.keys(logs).forEach(d => months.add(d.substring(0, 7)));
        let monthOptions = '<option value="">All Months</option>';
        Array.from(months).sort().reverse().forEach(m => {
            const [y, mo] = m.split('-');
            const label = new Date(y, mo - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
            monthOptions += `<option value="${m}" ${amsFilters.month === m ? 'selected' : ''}>${label}</option>`;
        });

        const activeFilters = [];
        if (amsFilters.subject) { const s = subjects.find(x => x.code === amsFilters.subject); activeFilters.push(s ? s.name : amsFilters.subject); }
        if (amsFilters.date) activeFilters.push(`Date: ${amsFilters.date}`);
        if (amsFilters.dateFrom || amsFilters.dateTo) activeFilters.push(`Range: ${amsFilters.dateFrom || '...'} to ${amsFilters.dateTo || '...'}`);
        if (amsFilters.month) activeFilters.push(`Month: ${amsFilters.month}`);
        if (amsFilters.classType) activeFilters.push(`Type: ${amsFilters.classType}`);
        if (amsFilters.status) activeFilters.push(`Status: ${(STATUS_MAP[amsFilters.status] || {}).label || amsFilters.status}`);

        let filterTags = '';
        if (activeFilters.length > 0) {
            filterTags = `<div class="ams-active-filters">
                ${activeFilters.map(f => `<span class="ams-filter-tag">${f} <span class="remove" onclick="window.amsClearFilters()">×</span></span>`).join('')}
            </div>`;
        }

        return `
        <div class="ams-filter-section">
            <div class="ams-filter-toggle" onclick="window.amsToggleFilter()">
                <h4><i class="fa-solid fa-filter"></i> Filter Records</h4>
                <i class="fa-solid fa-chevron-down ams-filter-chevron ${amsFilterOpen ? 'open' : ''}"></i>
            </div>
            ${filterTags}
            <div class="ams-filter-grid ${amsFilterOpen ? '' : 'collapsed'}" id="amsFilterGrid">
                <div class="ams-filter-group">
                    <label>Subject</label>
                    <select id="amsFilterSubject">${subjectOptions}</select>
                </div>
                <div class="ams-filter-group">
                    <label>Date</label>
                    <input type="date" id="amsFilterDate" value="${amsFilters.date}">
                </div>
                <div class="ams-filter-group">
                    <label>From Date</label>
                    <input type="date" id="amsFilterDateFrom" value="${amsFilters.dateFrom}">
                </div>
                <div class="ams-filter-group">
                    <label>To Date</label>
                    <input type="date" id="amsFilterDateTo" value="${amsFilters.dateTo}">
                </div>
                <div class="ams-filter-group">
                    <label>Month</label>
                    <select id="amsFilterMonth">${monthOptions}</select>
                </div>
                <div class="ams-filter-group">
                    <label>Class Type</label>
                    <select id="amsFilterClassType">
                        <option value="">All Types</option>
                        <option value="Lecture" ${amsFilters.classType === 'Lecture' ? 'selected' : ''}>Lecture</option>
                        <option value="Lab/Tutorial" ${amsFilters.classType === 'Lab/Tutorial' ? 'selected' : ''}>Lab/Tutorial</option>
                        <option value="Extra" ${amsFilters.classType === 'Extra' ? 'selected' : ''}>Extra</option>
                    </select>
                </div>
                <div class="ams-filter-group">
                    <label>Status</label>
                    <select id="amsFilterStatus">
                        <option value="">All Statuses</option>
                        <option value="Attended" ${amsFilters.status === 'Attended' ? 'selected' : ''}>✅ Present</option>
                        <option value="Skipped" ${amsFilters.status === 'Skipped' ? 'selected' : ''}>❌ Absent</option>
                        <option value="Cancelled" ${amsFilters.status === 'Cancelled' ? 'selected' : ''}>🔘 Cancelled</option>
                        <option value="Medical Leave (ML)" ${amsFilters.status === 'Medical Leave (ML)' ? 'selected' : ''}>🏥 Medical Leave</option>
                        <option value="Duty Leave (OD)" ${amsFilters.status === 'Duty Leave (OD)' ? 'selected' : ''}>📋 Duty Leave</option>
                        <option value="Default" ${amsFilters.status === 'Default' ? 'selected' : ''}>⬜ Not Marked</option>
                    </select>
                </div>
                <div class="ams-filter-actions" style="grid-column: 1 / -1;">
                    <button class="ams-filter-apply-btn" onclick="window.amsApplyFilters()">
                        <i class="fa-solid fa-check"></i> Apply Filters
                    </button>
                    <button class="ams-filter-clear-btn" onclick="window.amsClearFilters()">
                        <i class="fa-solid fa-rotate-left"></i> Clear
                    </button>
                </div>
            </div>
        </div>`;
    }

    function renderRecordsTable(records) {
        if (records.length === 0) {
            return `
            <div class="ams-records-section">
                <div class="ams-records-header">
                    <h4>📋 Detailed Attendance Records</h4>
                    <span class="ams-records-count">0 records</span>
                </div>
                <div class="ams-empty-state">
                    <div class="ams-empty-icon">📝</div>
                    <h4>No Records Found</h4>
                    <p>Mark attendance using the section above or adjust your filters.</p>
                </div>
            </div>`;
        }

        // Pagination
        const totalPages = Math.ceil(records.length / ITEMS_PER_PAGE);
        if (amsCurrentPage > totalPages) amsCurrentPage = totalPages;
        const startIdx = (amsCurrentPage - 1) * ITEMS_PER_PAGE;
        const pageRecords = records.slice(startIdx, startIdx + ITEMS_PER_PAGE);

        let rows = '';
        pageRecords.forEach(r => {
            const si = r.statusInfo || STATUS_MAP['Default'];
            rows += `
            <tr>
                <td style="white-space:nowrap;">${formatDateDisplay(r.date)}</td>
                <td><span class="ams-day-badge">${getDayShort(r.date)}</span></td>
                <td>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div style="width:8px;height:8px;border-radius:50%;background:${r.color};flex-shrink:0;"></div>
                        ${r.subject}
                    </div>
                </td>
                <td>${r.period}</td>
                <td>${r.classType}</td>
                <td><span class="ams-cell-status ${si.css}">${si.label}</span></td>
                <td style="color:var(--ams-text-muted);font-size:0.82rem;">${r.remarks || '—'}</td>
            </tr>`;
        });

        // Build pagination
        let paginationHTML = '';
        if (totalPages > 1) {
            paginationHTML = `<div class="ams-pagination">
                <button class="ams-page-btn" onclick="window.amsGoPage(${amsCurrentPage - 1})" ${amsCurrentPage <= 1 ? 'disabled' : ''}>‹ Prev</button>`;

            for (let i = 1; i <= totalPages; i++) {
                if (i === 1 || i === totalPages || (i >= amsCurrentPage - 1 && i <= amsCurrentPage + 1)) {
                    paginationHTML += `<button class="ams-page-btn ${i === amsCurrentPage ? 'active' : ''}" onclick="window.amsGoPage(${i})">${i}</button>`;
                } else if (i === amsCurrentPage - 2 || i === amsCurrentPage + 2) {
                    paginationHTML += `<span class="ams-page-info">…</span>`;
                }
            }
            paginationHTML += `
                <button class="ams-page-btn" onclick="window.amsGoPage(${amsCurrentPage + 1})" ${amsCurrentPage >= totalPages ? 'disabled' : ''}>Next ›</button>
            </div>`;
        }

        return `
        <div class="ams-records-section">
            <div class="ams-records-header">
                <h4>📋 Detailed Attendance Records</h4>
                <span class="ams-records-count">${records.length} record${records.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="ams-table-wrapper">
                <table class="ams-records-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Day</th>
                            <th>Subject</th>
                            <th>Period</th>
                            <th>Class Type</th>
                            <th>Status</th>
                            <th>Remarks</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            ${paginationHTML}
        </div>`;
    }

    // --- Populate mark attendance subjects for day-wise ---
    function populateMarkAttendance() {
        if (amsMode === 'daywise') {
            populateDaywise();
        }
    }

    function populateDaywise() {
        const list = document.getElementById('amsSubjectList');
        if (!list) return;

        const periods = getPeriodsForDate(amsSelectedDate);
        if (periods.length === 0) {
            list.innerHTML = `
                <div class="ams-noclass-state">
                    <i class="fa-solid fa-calendar-xmark"></i>
                    <span>No classes scheduled on <strong>${formatDateDisplay(amsSelectedDate)}</strong> (${getDayName(amsSelectedDate)})</span>
                </div>`;
            const saveBtn = document.getElementById('amsSaveBtn');
            if (saveBtn) saveBtn.style.display = 'none';
            return;
        }

        const saveBtn = document.getElementById('amsSaveBtn');
        if (saveBtn) saveBtn.style.display = 'flex';

        const logs = getLogs();
        const dayLog = logs[amsSelectedDate] || {};

        // Bulk actions
        let html = `
        <div class="ams-bulk-actions">
            <span class="ams-bulk-label">Quick Actions</span>
            <button class="ams-bulk-btn present" onclick="window.amsBulk('Attended')">✅ All Present</button>
            <button class="ams-bulk-btn absent" onclick="window.amsBulk('Skipped')">❌ All Absent</button>
            <button class="ams-bulk-btn cancel" onclick="window.amsBulk('Cancelled')">🔘 All Cancelled</button>
            <button class="ams-bulk-btn" onclick="window.amsBulk('Medical Leave (ML)')">🏥 All ML</button>
            <button class="ams-bulk-btn" onclick="window.amsBulk('Default')">⬜ Reset All</button>
        </div>
        <div class="ams-subject-list">`;

        const sc = getSelectedClass();
        const periodCounts = {};

        periods.forEach((p, idx) => {
            periodCounts[p.code] = (periodCounts[p.code] || 0) + 1;
            const periodKey = `${p.code}_p${periodCounts[p.code]}`;
            const currentStatus = dayLog[periodKey] || dayLog[p.code] || 'Default';
            const color = getSubjectColor(sc.subjects.findIndex(s => s.code === p.code));
            const statusCss = getSelectStatusClass(currentStatus);

            html += `
            <div class="ams-subject-entry">
                <div class="ams-subj-icon" style="background:${color};">
                    ${(p.shortName || p.code).substring(0, 2).toUpperCase()}
                </div>
                <div class="ams-subj-info">
                    <div class="ams-subj-name">${p.name}</div>
                    <div class="ams-subj-code">${p.code} · Period ${p.period}</div>
                </div>
                <select class="ams-status-select ${statusCss}" data-key="${periodKey}" data-code="${p.code}" onchange="window.amsStatusChanged(this)">
                    <option value="Default" ${currentStatus === 'Default' ? 'selected' : ''}>⬜ Not Marked</option>
                    <option value="Attended" ${currentStatus === 'Attended' ? 'selected' : ''}>✅ Present</option>
                    <option value="Skipped" ${currentStatus === 'Skipped' ? 'selected' : ''}>❌ Absent</option>
                    <option value="Cancelled" ${currentStatus === 'Cancelled' ? 'selected' : ''}>🔘 Cancelled</option>
                    <option value="Medical Leave (ML)" ${currentStatus === 'Medical Leave (ML)' ? 'selected' : ''}>🏥 Medical Leave</option>
                    <option value="Duty Leave (OD)" ${currentStatus === 'Duty Leave (OD)' ? 'selected' : ''}>📋 Duty Leave</option>
                </select>
            </div>`;
        });

        html += '</div>';
        list.innerHTML = html;
    }

    function getSelectStatusClass(status) {
        if (status === 'Attended') return 'status-present';
        if (status === 'Skipped') return 'status-absent';
        if (status === 'Cancelled') return 'status-cancelled';
        if (status === 'Medical Leave (ML)') return 'status-medical';
        if (status === 'Duty Leave (OD)') return 'status-duty';
        return 'status-null';
    }

    // --- Populate class-wise dates for a subject ---
    function populateClasswiseDates(subjectCode) {
        const container = document.getElementById('amsClasswiseDates');
        if (!container || !subjectCode) {
            if (container) container.innerHTML = `
                <div class="ams-empty-state" style="padding:24px;">
                    <div class="ams-empty-icon">👆</div>
                    <h4>Select a Subject Above</h4>
                    <p>Choose a subject to see its scheduled dates and mark attendance.</p>
                </div>`;
            return;
        }

        const sc = getSelectedClass();
        if (!sc) return;

        const logs = getLogs();
        const baselineDate = sc.portalSetup?.baselineDate;
        const semStart = sc.portalSetup?.semesterStartDate;
        const startDate = baselineDate || semStart || formatDate(new Date());
        const today = formatDate(new Date());

        // Find all dates from start to today that have this subject
        const dates = [];
        let current = parseDate(startDate);
        const todayDate = parseDate(today);

        while (current <= todayDate) {
            const dateStr = formatDate(current);
            const periods = getPeriodsForDate(dateStr);
            const subjectPeriods = periods.filter(p => p.code === subjectCode);
            if (subjectPeriods.length > 0) {
                dates.push({ date: dateStr, periods: subjectPeriods });
            }
            current.setDate(current.getDate() + 1);
        }

        dates.reverse(); // Most recent first

        if (dates.length === 0) {
            container.innerHTML = `
                <div class="ams-empty-state" style="padding:24px;">
                    <div class="ams-empty-icon">📭</div>
                    <h4>No Scheduled Dates</h4>
                    <p>This subject has no scheduled classes from the baseline to today.</p>
                </div>`;
            return;
        }

        const subj = sc.subjects.find(s => s.code === subjectCode);
        const color = getSubjectColor(sc.subjects.indexOf(subj));

        let html = `
        <div style="margin-top:16px;">
            <div class="ams-section-header" style="margin-bottom:12px;">
                <div class="ams-section-title" style="font-size:0.95rem;">
                    <span style="width:24px;height:24px;border-radius:6px;background:${color};display:inline-flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:0.7rem;">
                        ${(subj?.shortName || subjectCode).substring(0, 2).toUpperCase()}
                    </span>
                    ${subj ? subj.name : subjectCode} — Attendance by Date
                </div>
            </div>
            <div class="ams-subject-list">`;

        dates.forEach(({ date, periods }) => {
            const dayLog = logs[date] || {};
            periods.forEach(p => {
                const periodCounts = {};
                const allPeriods = getPeriodsForDate(date).filter(pp => pp.code === subjectCode);
                allPeriods.forEach((pp, idx) => { periodCounts[pp.code] = idx + 1; });

                const periodNum = periods.indexOf(p) + 1;
                const periodKey = `${p.code}_p${periodNum}`;
                const currentStatus = dayLog[periodKey] || dayLog[p.code] || 'Default';
                const statusCss = getSelectStatusClass(currentStatus);

                html += `
                <div class="ams-subject-entry">
                    <div class="ams-subj-info" style="flex:1;">
                        <div class="ams-subj-name">${formatDateDisplay(date)}</div>
                        <div class="ams-subj-code">${getDayName(date)} · Period ${p.period}</div>
                    </div>
                    <select class="ams-status-select ams-cw-select ${statusCss}" data-date="${date}" data-key="${periodKey}" data-code="${p.code}" onchange="window.amsCwStatusChanged(this)">
                        <option value="Default" ${currentStatus === 'Default' ? 'selected' : ''}>⬜ Not Marked</option>
                        <option value="Attended" ${currentStatus === 'Attended' ? 'selected' : ''}>✅ Present</option>
                        <option value="Skipped" ${currentStatus === 'Skipped' ? 'selected' : ''}>❌ Absent</option>
                        <option value="Cancelled" ${currentStatus === 'Cancelled' ? 'selected' : ''}>🔘 Cancelled</option>
                        <option value="Medical Leave (ML)" ${currentStatus === 'Medical Leave (ML)' ? 'selected' : ''}>🏥 Medical Leave</option>
                        <option value="Duty Leave (OD)" ${currentStatus === 'Duty Leave (OD)' ? 'selected' : ''}>📋 Duty Leave</option>
                    </select>
                </div>`;
            });
        });

        html += `</div>
            <button class="ams-save-btn" onclick="window.amsSaveCwAttendance()" style="margin-top:16px;">
                <i class="fa-solid fa-floppy-disk"></i> Save All Changes
            </button>
        </div>`;
        container.innerHTML = html;
    }

    // ===============================================
    // EVENT HANDLERS (exposed on window)
    // ===============================================

    window.amsRefresh = function () { renderAll(); };

    window.amsNavigate = function(view) {
        amsCurrentView = view;
        amsCurrentPage = 1;
        renderAll();
    };

    window.amsSetMode = function (mode) {
        amsMode = mode;
        amsSelectedSubject = null;
        renderAll();
    };

    window.amsDateChanged = function (val) {
        amsSelectedDate = val;
        populateDaywise();
    };

    window.amsStatusChanged = function (el) {
        const status = el.value;
        el.className = 'ams-status-select ' + getSelectStatusClass(status);
    };

    window.amsBulk = function (status) {
        document.querySelectorAll('.ams-status-select:not(.ams-cw-select)').forEach(sel => {
            sel.value = status;
            sel.className = 'ams-status-select ' + getSelectStatusClass(status);
        });
    };

    window.amsSaveAttendance = function () {
        const selects = document.querySelectorAll('.ams-status-select:not(.ams-cw-select)');
        if (selects.length === 0) return;

        const logs = getLogs();
        if (!logs[amsSelectedDate]) logs[amsSelectedDate] = {};

        selects.forEach(sel => {
            const key = sel.dataset.key;
            const status = sel.value;
            logs[amsSelectedDate][key] = status;
        });

        saveLogs(logs);
        showAmsToast('✅ Attendance saved for ' + formatDateDisplay(amsSelectedDate));

        // Re-trigger portal calculation if available
        if (typeof calculateFromPortal === 'function') {
            try { calculateFromPortal(); } catch (e) { /* ignore */ }
        }
        if (typeof renderPortalDashboard === 'function') {
            try { renderPortalDashboard(); } catch (e) { /* ignore */ }
        }
        // Sync to cloud
        if (window.SyncManager) {
            try { window.SyncManager.uploadAll(); } catch (e) { /* ignore */ }
        }

        // Animate save button
        const btn = document.getElementById('amsSaveBtn');
        if (btn) {
            btn.classList.add('saved');
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!';
            setTimeout(() => {
                btn.classList.remove('saved');
                btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Attendance';
            }, 1500);
        }

        // Refresh stats and records
        refreshStatsAndRecords();
    };

    window.amsSelectSubject = function (code) {
        amsSelectedSubject = code;
        // Update card selection UI
        document.querySelectorAll('.ams-classwise-card').forEach(card => {
            card.classList.remove('selected');
        });
        event.currentTarget.classList.add('selected');
        populateClasswiseDates(code);
    };

    window.amsCwStatusChanged = function (el) {
        const status = el.value;
        el.className = 'ams-status-select ams-cw-select ' + getSelectStatusClass(status);
    };

    window.amsSaveCwAttendance = function () {
        const selects = document.querySelectorAll('.ams-cw-select');
        if (selects.length === 0) return;

        const logs = getLogs();

        selects.forEach(sel => {
            const date = sel.dataset.date;
            const key = sel.dataset.key;
            const status = sel.value;

            if (!logs[date]) logs[date] = {};
            logs[date][key] = status;
        });

        saveLogs(logs);
        showAmsToast('✅ Class-wise attendance saved!');

        if (typeof calculateFromPortal === 'function') {
            try { calculateFromPortal(); } catch (e) { /* ignore */ }
        }
        if (window.SyncManager) {
            try { window.SyncManager.uploadAll(); } catch (e) { /* ignore */ }
        }

        refreshStatsAndRecords();
    };

    window.amsToggleFilter = function () {
        amsFilterOpen = !amsFilterOpen;
        const grid = document.getElementById('amsFilterGrid');
        const chevron = document.querySelector('.ams-filter-chevron');
        if (grid) grid.classList.toggle('collapsed', !amsFilterOpen);
        if (chevron) chevron.classList.toggle('open', amsFilterOpen);
    };

    window.amsApplyFilters = function () {
        amsFilters.subject = document.getElementById('amsFilterSubject')?.value || '';
        amsFilters.date = document.getElementById('amsFilterDate')?.value || '';
        amsFilters.dateFrom = document.getElementById('amsFilterDateFrom')?.value || '';
        amsFilters.dateTo = document.getElementById('amsFilterDateTo')?.value || '';
        amsFilters.month = document.getElementById('amsFilterMonth')?.value || '';
        amsFilters.classType = document.getElementById('amsFilterClassType')?.value || '';
        amsFilters.status = document.getElementById('amsFilterStatus')?.value || '';
        amsCurrentPage = 1;
        renderAll();
    };

    window.amsClearFilters = function () {
        amsFilters = { subject: '', date: '', dateFrom: '', dateTo: '', month: '', classType: '', status: '' };
        amsCurrentPage = 1;
        renderAll();
    };

    window.amsGoPage = function (p) {
        const records = applyFilters(buildRecords());
        const totalPages = Math.ceil(records.length / ITEMS_PER_PAGE);
        if (p < 1 || p > totalPages) return;
        amsCurrentPage = p;
        // Only re-render the records table
        const sc = getSelectedClass();
        const filtered = applyFilters(buildRecords());
        const tableHTML = renderRecordsTable(filtered);
        const section = document.querySelector('.ams-records-section');
        if (section) {
            section.outerHTML = tableHTML;
        }
    };

    // --- Refresh just stats + records without full re-render ---
    function refreshStatsAndRecords() {
        const stats = calculateStats();
        const records = buildRecords();
        const filtered = applyFilters(records);

        // Update stats grid
        const statsContainer = document.querySelector('.ams-stats-grid');
        if (statsContainer) {
            statsContainer.outerHTML = renderStatsGrid(stats.overall);
        }

        // Update threshold row
        const thresholdContainer = document.querySelector('.ams-threshold-row');
        if (thresholdContainer) {
            thresholdContainer.outerHTML = renderThresholdRow(stats.overall);
        }

        // Update subject summary
        const summaryContainer = document.querySelector('.ams-subject-summary');
        if (summaryContainer) {
            summaryContainer.outerHTML = renderSubjectSummary(stats.subjects);
        }

        // Update records table
        const recordsContainer = document.querySelector('.ams-records-section');
        if (recordsContainer) {
            recordsContainer.outerHTML = renderRecordsTable(filtered);
        }
    }

    // --- Attach events ---
    function attachEvents() {
        // Nothing extra needed — events are inline onclick handlers
    }

    // --- Period-wise Grid Handlers ---
    
    // Close any open popup
    function closePgPopup() {
        const existing = document.querySelector('.pg-edit-popup');
        if (existing) existing.remove();
        const existingBulk = document.querySelector('.pg-bulk-date-popup');
        if (existingBulk) existingBulk.remove();
    }
    
    // Open edit popup on cell click (matching portal mode)
    window.amsOpenPeriodPopup = function (event, dateStr, periodKey, subjectName) {
        event.stopPropagation();
        closePgPopup();
        
        const popup = document.createElement('div');
        popup.className = 'pg-edit-popup';
        popup.innerHTML = `
            <div class="pg-popup-header">
                ${subjectName}
                <small>${formatDateDisplay(dateStr)} · ${getDayName(dateStr)}</small>
            </div>
            <button style="background: #4CAF50; color: white;" onclick="window.amsUpdatePeriodStatus('${dateStr}', '${periodKey}', 'Attended')">✓ Attended</button>
            <button style="background: #f44336; color: white;" onclick="window.amsUpdatePeriodStatus('${dateStr}', '${periodKey}', 'Skipped')">✗ Skipped</button>
            <button style="background: #9e9e9e; color: white;" onclick="window.amsUpdatePeriodStatus('${dateStr}', '${periodKey}', 'Cancelled')">⨯ Cancelled</button>
            <button style="background: #2196F3; color: white;" onclick="window.amsUpdatePeriodStatus('${dateStr}', '${periodKey}', 'Duty Leave (OD)')">📋 Duty Leave</button>
            <button style="background: #FF9800; color: white;" onclick="window.amsUpdatePeriodStatus('${dateStr}', '${periodKey}', 'Medical Leave (ML)')">🏥 Medical Leave</button>
            <button style="background: var(--light-bg); color: var(--dark-text);" onclick="window.amsUpdatePeriodStatus('${dateStr}', '${periodKey}', 'Default')">↺ Reset (Default)</button>
        `;
        
        document.body.appendChild(popup);
        
        // Position near click
        const rect = event.target.getBoundingClientRect();
        const popupWidth = 200;
        const popupHeight = 280;
        let left = Math.min(rect.left, window.innerWidth - popupWidth - 10);
        let top = rect.bottom + 5;
        if (top + popupHeight > window.innerHeight) {
            top = Math.max(10, rect.top - popupHeight - 5);
        }
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
        
        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', closePgPopup, { once: true });
        }, 100);
    };
    
    // Update a single period's status (called from popup)
    // Old whole-day marks are stored without a period ("CODE": status) and count for
    // every class of that subject that day. Split them into per-period marks before
    // editing, otherwise the old mark keeps counting next to the new one.
    function expandLegacyMarks(logs, dateStr, onlyCode = null) {
        const dayLog = logs[dateStr];
        if (!dayLog) return;
        const periods = getPeriodsForDate(dateStr);
        Object.keys(dayLog).forEach(key => {
            if (key.includes('_p') || (onlyCode && key !== onlyCode)) return;
            const status = dayLog[key];
            let n = 0;
            periods.forEach(p => {
                if (p.code !== key) return;
                n++;
                const periodKey = `${key}_p${n}`;
                if (!dayLog[periodKey]) dayLog[periodKey] = status;
            });
            if (n > 0) delete dayLog[key];
        });
    }

    window.amsUpdatePeriodStatus = function (dateStr, periodKey, status) {
        closePgPopup();
        
        const logs = getLogs();
        if (!logs[dateStr]) logs[dateStr] = {};
        expandLegacyMarks(logs, dateStr, periodKey.split('_p')[0]);
        
        if (status === 'Default') {
            delete logs[dateStr][periodKey];
            if (Object.keys(logs[dateStr]).length === 0) {
                delete logs[dateStr];
            }
        } else {
            logs[dateStr][periodKey] = status;
        }
        
        saveLogs(logs);
        showAmsToast('✅ Status updated');
        
        if (window.SyncManager) {
            try { window.SyncManager.uploadAll(); } catch (e) { /* ignore */ }
        }
        if (typeof calculateFromPortal === 'function') {
            try { calculateFromPortal(); } catch (e) { /* ignore */ }
        }
        
        refreshStatsAndRecords();
        const gridContainer = document.querySelector('.period-grid-container');
        if (gridContainer) {
             const newGridHTML = renderPeriodGridModal();
             const wrapper = document.createElement('div');
             wrapper.innerHTML = newGridHTML;
             const newGrid = wrapper.querySelector('.period-grid-container');
             if (newGrid) gridContainer.outerHTML = newGrid.outerHTML;
        }
    };
    
    // Open bulk action popup for a specific date row
    window.amsOpenBulkDatePopup = function (event, dateStr) {
        event.stopPropagation();
        closePgPopup();
        
        const dispDate = getDayShort(dateStr) + ' ' + parseDate(dateStr).toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
        
        const popup = document.createElement('div');
        popup.className = 'pg-bulk-date-popup';
        popup.innerHTML = `
            <div class="pg-popup-header">
                Bulk Actions (All Periods)
                <small>${formatDateDisplay(dateStr)} · ${getDayName(dateStr)}</small>
            </div>
            <button style="background: #4CAF50; color: white;" onclick="window.amsBulkDate('${dateStr}', 'Attended')">✓ All Attended</button>
            <button style="background: #f44336; color: white;" onclick="window.amsBulkDate('${dateStr}', 'Skipped')">✗ All Skipped</button>
            <button style="background: #9e9e9e; color: white;" onclick="window.amsBulkDate('${dateStr}', 'Cancelled')">⨯ All Cancelled</button>
            <button style="background: #2196F3; color: white;" onclick="window.amsBulkDate('${dateStr}', 'Duty Leave (OD)')">📋 All Duty Leave</button>
            <button style="background: #FF9800; color: white;" onclick="window.amsBulkDate('${dateStr}', 'Medical Leave (ML)')">🏥 All Medical Leave</button>
            <button style="background: var(--light-bg); color: var(--dark-text);" onclick="window.amsBulkDate('${dateStr}', 'Default')">↻ Reset All (Default)</button>
            <button style="background: #7c3aed; color: white;" onclick="window.amsOpenShiftDay('${dateStr}')">🔁 Shift this day to weekend</button>
            <button style="background: #0d9488; color: white;" onclick="window.amsOpenSuddenHoliday('${dateStr}')">🏖️ Mark as holiday</button>
        `;
        
        document.body.appendChild(popup);
        
        const rect = event.target.getBoundingClientRect();
        const popupWidth = 210;
        const popupHeight = 400;
        let left = Math.min(rect.right + 5, window.innerWidth - popupWidth - 10);
        let top = rect.top;
        if (top + popupHeight > window.innerHeight) {
            top = Math.max(10, window.innerHeight - popupHeight - 10);
        }
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
        
        setTimeout(() => {
            document.addEventListener('click', closePgPopup, { once: true });
        }, 100);
    };
    
    // Apply a status to all periods on a specific date
    window.amsBulkDate = function (dateStr, targetStatus) {
        closePgPopup();
        
        const logs = getLogs();
        const periods = getPeriodsForDate(dateStr);
        if (!periods || periods.length === 0) return;
        
        if (!logs[dateStr]) logs[dateStr] = {};
        expandLegacyMarks(logs, dateStr);
        
        const periodCounts = {};
        periods.forEach(p => {
            periodCounts[p.code] = (periodCounts[p.code] || 0) + 1;
            const periodKey = `${p.code}_p${periodCounts[p.code]}`;
            if (targetStatus === 'Default') {
                delete logs[dateStr][periodKey];
            } else {
                logs[dateStr][periodKey] = targetStatus;
            }
        });
        
        if (targetStatus === 'Default' && Object.keys(logs[dateStr]).length === 0) {
            delete logs[dateStr];
        }
        
        saveLogs(logs);
        showAmsToast(`✅ All periods on ${dateStr} updated`);
        
        if (window.SyncManager) {
            try { window.SyncManager.uploadAll(); } catch (e) { /* ignore */ }
        }
        if (typeof calculateFromPortal === 'function') {
            try { calculateFromPortal(); } catch (e) { /* ignore */ }
        }
        
        refreshStatsAndRecords();
        const gridContainer = document.querySelector('.period-grid-container');
        if (gridContainer) {
             const newGridHTML = renderPeriodGridModal();
             const wrapper = document.createElement('div');
             wrapper.innerHTML = newGridHTML;
             const newGrid = wrapper.querySelector('.period-grid-container');
             if (newGrid) gridContainer.outerHTML = newGrid.outerHTML;
        }
    };
    
    // Keep old function name for backward compatibility
    window.amsTogglePeriodCell = function (el, dateStr, periodKey) {
        // Redirect to popup-based approach
        window.amsOpenPeriodPopup({ stopPropagation: ()=>{}, target: el }, dateStr, periodKey, '');
    };
    
    window.amsBulkPeriod = function (targetStatus) {
        if (!confirm('Apply this status to every class from the class start date up to today?')) return;
        
        const logs = getLogs();
        const sc = getSelectedClass();
        if (!sc || !sc.subjects) return;
        
        // Same dates the grid shows, but never mark future classes
        const { today } = getClassDateRange(sc);
        getClassDates(sc, today).forEach(({ date: dateStr, periods }) => {
            if (!logs[dateStr]) logs[dateStr] = {};
            expandLegacyMarks(logs, dateStr);
            const periodCounts = {};
            periods.forEach(p => {
                if (!p) return;
                periodCounts[p.code] = (periodCounts[p.code] || 0) + 1;
                const periodKey = `${p.code}_p${periodCounts[p.code]}`;
                if (targetStatus === 'Default') delete logs[dateStr][periodKey];
                else logs[dateStr][periodKey] = targetStatus;
            });
            if (Object.keys(logs[dateStr]).length === 0) delete logs[dateStr];
        });

        saveLogs(logs);
        showAmsToast('Bulk action applied & saving...');
        
        if (window.SyncManager) {
            try { window.SyncManager.uploadAll(); } catch (e) { /* ignore */ }
        }
        
        if (typeof calculateFromPortal === 'function') {
            try { calculateFromPortal(); } catch (e) { /* ignore */ }
        }
        
        refreshStatsAndRecords();
        
        const gridContainer = document.querySelector('.period-grid-container');
        if (gridContainer) {
             const newGridHTML = renderPeriodGridModal();
             const wrapper = document.createElement('div');
             wrapper.innerHTML = newGridHTML;
             const newGrid = wrapper.querySelector('.period-grid-container');
             if (newGrid) gridContainer.outerHTML = newGrid.outerHTML;
        }
    };


    // ===============================================
    // DAY CHANGES: day shifted to weekend, sudden holiday
    // ===============================================
    // Shift:   a weekday is called off and its timetable is held on a Sat/Sun.
    //          Off day -> holiday; weekend day -> custom schedule with the off
    //          day's exact periods.
    // Holiday: date(s) added to the class holiday list.
    // Logs on days that become holidays are removed (no class was held) and kept
    // in class.dayChanges so every change can be undone exactly.

    function amsClassName() {
        return document.getElementById('classSelector')?.value || getSelectedClass()?.name || '';
    }

    function amsClassRecord() {
        const name = amsClassName();
        return (typeof classes !== 'undefined' && classes[name]) ? classes[name] : null;
    }

    function amsFmt(dateStr) {
        return parseDate(dateStr).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    }

    function amsDayFull(dateStr) {
        return parseDate(dateStr).toLocaleDateString('en-IN', { weekday: 'long' });
    }

    function getCustomSchedules() {
        return JSON.parse(localStorage.getItem(`custom_schedules_${amsClassName()}`) || '{}');
    }

    function setCustomSchedules(all) {
        localStorage.setItem(`custom_schedules_${amsClassName()}`, JSON.stringify(all));
    }

    // Update holidays/dayChanges on both the stored class and the working copy
    function updateClass(mutator) {
        const rec = amsClassRecord();
        const sc = getSelectedClass();
        [rec, sc].forEach(c => {
            if (!c) return;
            c.holidays = Array.isArray(c.holidays) ? c.holidays : [];
            c.dayChanges = Array.isArray(c.dayChanges) ? c.dayChanges : [];
        });
        if (rec) mutator(rec);
        if (sc && sc !== rec) {
            sc.holidays = rec ? rec.holidays.slice() : sc.holidays;
            sc.dayChanges = rec ? rec.dayChanges.slice() : sc.dayChanges;
            if (!rec) mutator(sc);
        }
        if (typeof saveToStorage === 'function') saveToStorage();
    }

    function afterDayChange(message) {
        if (window.SyncManager) { try { window.SyncManager.uploadAll(); } catch (e) { /* offline */ } }
        if (typeof calculateFromPortal === 'function') { try { calculateFromPortal(); } catch (e) { /* ignore */ } }
        if (typeof recalculateEverything === 'function') { try { recalculateEverything(); } catch (e) { /* ignore */ } }
        if (typeof closeModal === 'function') closeModal('amsDayChangeModal');
        showAmsToast(message);
        renderAll();
    }

    function ensureDayChangeModal() {
        let modal = document.getElementById('amsDayChangeModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'amsDayChangeModal';
            modal.className = 'modal';
            document.body.appendChild(modal);
        }
        return modal;
    }

    function recentChangesHtml() {
        const changes = (getSelectedClass()?.dayChanges || []).slice(-5).reverse();
        if (!changes.length) return '';
        return `
            <div class="dc-recent">
                <div class="dc-recent-title">Recent day changes</div>
                ${changes.map(c => `
                    <div class="dc-recent-row">
                        <span>${c.type === 'shift'
                            ? `🔁 ${amsFmt(c.off)} → held on ${amsFmt(c.on)}`
                            : `🏖️ Holiday: ${c.dates.length > 1 ? `${amsFmt(c.dates[0])} → ${amsFmt(c.dates[c.dates.length - 1])}` : amsFmt(c.dates[0])}`}${c.reason ? ` · ${c.reason.replace(/</g, '&lt;')}` : ''}</span>
                        <button onclick="window.amsUndoDayChange('${c.id}')">Undo</button>
                    </div>`).join('')}
            </div>`;
    }

    // ---------- Day shifted to weekend ----------
    window.amsOpenShiftDay = function (offDate) {
        closePgPopup();
        const sc = getSelectedClass();
        if (!sc) return;
        const today = formatDate(new Date());
        const off = offDate || today;
        // Default makeup day: the next Saturday after the off day
        const d = parseDate(off);
        d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
        const on = formatDate(d);

        const modal = ensureDayChangeModal();
        modal.innerHTML = `
            <div class="modal-content dc-modal">
                <button class="modal-close" onclick="closeModal('amsDayChangeModal')">&times;</button>
                <div class="dc-icon">🔁</div>
                <h2>Day shifted to weekend</h2>
                <p class="dc-lead">A weekday was called off and its classes were held on a Saturday or Sunday instead.</p>
                <div class="dc-dates">
                    <label><span>Day called off</span><input type="date" id="dcOff" value="${off}"></label>
                    <label><span>Classes held on</span><input type="date" id="dcOn" value="${on}"></label>
                </div>
                <div class="dc-preview" id="dcPreview"></div>
                <div class="form-actions" style="justify-content: space-between;">
                    <button class="btn secondary-btn" onclick="closeModal('amsDayChangeModal')">Cancel</button>
                    <button class="btn primary-btn" onclick="window.amsSaveShiftDay()">Save</button>
                </div>
                ${recentChangesHtml()}
            </div>`;
        const update = () => {
            const offV = document.getElementById('dcOff').value;
            const onV = document.getElementById('dcOn').value;
            const el = document.getElementById('dcPreview');
            if (!offV || !onV) { el.innerHTML = 'Pick both dates.'; return; }
            const periods = shiftSourcePeriods(offV);
            const names = periods.map((p, i) => p ? `P${i + 1} ${p.shortName || p.code}` : null).filter(Boolean);
            const onDow = parseDate(onV).getDay();
            el.innerHTML = `
                <div><strong>${amsFmt(offV)}</strong> becomes a holiday.</div>
                <div><strong>${amsFmt(onV)}</strong> follows <strong>${amsDayFull(offV)}'s</strong> timetable:</div>
                <div class="dc-chips">${names.length ? names.map(n => `<span>${n}</span>`).join('') : '<em>No classes on that day</em>'}</div>
                ${onDow !== 0 && onDow !== 6 ? '<div class="dc-warn">Note: the "held on" date is not a Saturday or Sunday.</div>' : ''}`;
        };
        modal.querySelectorAll('input[type="date"]').forEach(i => i.addEventListener('change', update));
        update();
        openModal('amsDayChangeModal');
    };

    // The off day's periods as they were scheduled (ignores it being a holiday already)
    function shiftSourcePeriods(offDate) {
        const sc = getSelectedClass();
        const wasHoliday = (sc.holidays || []).includes(offDate);
        if (wasHoliday) sc.holidays = sc.holidays.filter(h => h !== offDate);
        const periods = getPeriodsForDate(offDate, true);
        if (wasHoliday) sc.holidays.push(offDate);
        return periods;
    }

    window.amsSaveShiftDay = function () {
        const off = document.getElementById('dcOff').value;
        const on = document.getElementById('dcOn').value;
        if (!off || !on) { alert('Please pick both dates.'); return; }
        if (off === on) { alert('The two dates must be different.'); return; }

        const periods = shiftSourcePeriods(off);
        if (!periods.some(Boolean)) { alert(`No classes are scheduled on ${amsFmt(off)}, so there is nothing to shift.`); return; }

        const logs = getLogs();
        const all = getCustomSchedules();
        const onHasClasses = getPeriodsForDate(on).length > 0;
        if (onHasClasses && !confirm(`${amsFmt(on)} already has classes. Replace them with ${amsDayFull(off)}'s timetable?`)) return;
        if (logs[off] && !confirm(`Attendance is already marked on ${amsFmt(off)}. It will be removed because that day was called off. Continue?`)) return;

        const sc = getSelectedClass();
        const change = {
            id: 'dc' + Date.now(),
            type: 'shift', off, on,
            prevOnSchedule: all[on] || null,
            prevOnHoliday: (sc.holidays || []).includes(on),
            prevOffHoliday: (sc.holidays || []).includes(off),
            prevOffSchedule: all[off] || null,
            removedLogs: logs[off] ? { [off]: logs[off] } : {},
            savedAt: new Date().toISOString()
        };

        // Weekend day: same periods, same order as the called-off day
        const codes = periods.map(p => p ? p.code : null);
        const counts = {};
        codes.forEach(c => { if (c) counts[c] = (counts[c] || 0) + 1; });
        all[on] = { ...counts, _periods: codes };
        delete all[off];
        setCustomSchedules(all);

        if (logs[off]) { delete logs[off]; saveLogs(logs); }

        updateClass(c => {
            if (!c.holidays.includes(off)) c.holidays.push(off);
            c.holidays = c.holidays.filter(h => h !== on).sort();
            c.dayChanges.push(change);
        });
        afterDayChange(`✅ ${amsFmt(off)} off · classes on ${amsFmt(on)}`);
    };

    // ---------- Sudden holiday ----------
    window.amsOpenSuddenHoliday = function (date) {
        closePgPopup();
        const day = date || formatDate(new Date());
        const modal = ensureDayChangeModal();
        modal.innerHTML = `
            <div class="modal-content dc-modal">
                <button class="modal-close" onclick="closeModal('amsDayChangeModal')">&times;</button>
                <div class="dc-icon">🏖️</div>
                <h2>Sudden holiday</h2>
                <p class="dc-lead">College declared a holiday? It is added to your holiday list and its classes stop counting.</p>
                <div class="dc-dates">
                    <label><span>From</span><input type="date" id="dcHolFrom" value="${day}"></label>
                    <label><span>Until (optional)</span><input type="date" id="dcHolTo" value=""></label>
                </div>
                <label class="dc-reason"><span>Reason (optional)</span><input type="text" id="dcHolReason" maxlength="40" placeholder="e.g. Rain, festival, elections"></label>
                <div class="dc-preview" id="dcHolPreview"></div>
                <div class="form-actions" style="justify-content: space-between;">
                    <button class="btn secondary-btn" onclick="closeModal('amsDayChangeModal')">Cancel</button>
                    <button class="btn primary-btn" onclick="window.amsSaveSuddenHoliday()">Add holiday</button>
                </div>
                ${recentChangesHtml()}
            </div>`;
        const update = () => {
            const dates = holidayDates();
            const el = document.getElementById('dcHolPreview');
            if (!dates) { el.innerHTML = 'Pick a valid date.'; return; }
            const classesLost = dates.reduce((n, d) => n + getPeriodsForDate(d).length, 0);
            const logs = getLogs();
            const marked = dates.filter(d => logs[d]).length;
            el.innerHTML = `
                <div><strong>${dates.length}</strong> day${dates.length > 1 ? 's' : ''} added as holiday${dates.length > 1 ? 's' : ''}: ${dates.length > 1 ? `${amsFmt(dates[0])} → ${amsFmt(dates[dates.length - 1])}` : amsFmt(dates[0])}</div>
                <div><strong>${classesLost}</strong> scheduled class${classesLost !== 1 ? 'es' : ''} will not be counted.</div>
                ${marked ? `<div class="dc-warn">${marked} of these days already have attendance marked. It will be removed.</div>` : ''}`;
        };
        modal.querySelectorAll('input[type="date"]').forEach(i => i.addEventListener('change', update));
        update();
        openModal('amsDayChangeModal');
    };

    function holidayDates() {
        const from = document.getElementById('dcHolFrom').value;
        const to = document.getElementById('dcHolTo').value || from;
        if (!from || to < from) return null;
        const dates = [];
        for (let d = parseDate(from); d <= parseDate(to); d.setDate(d.getDate() + 1)) dates.push(formatDate(d));
        return dates.length > 366 ? null : dates;
    }

    window.amsSaveSuddenHoliday = function () {
        const dates = holidayDates();
        if (!dates) { alert('Please pick a valid date (the "until" date must be after "from").'); return; }
        const reason = document.getElementById('dcHolReason').value.trim();

        const logs = getLogs();
        const marked = dates.filter(d => logs[d]);
        if (marked.length && !confirm(`${marked.length} of these days already have attendance marked. It will be removed because there were no classes. Continue?`)) return;

        const sc = getSelectedClass();
        const change = {
            id: 'dc' + Date.now(),
            type: 'holiday', dates, reason,
            alreadyHoliday: dates.filter(d => (sc.holidays || []).includes(d)),
            removedLogs: {},
            savedAt: new Date().toISOString()
        };
        marked.forEach(d => { change.removedLogs[d] = logs[d]; delete logs[d]; });
        if (marked.length) saveLogs(logs);

        updateClass(c => {
            dates.forEach(d => { if (!c.holidays.includes(d)) c.holidays.push(d); });
            c.holidays.sort();
            c.dayChanges.push(change);
        });
        afterDayChange(`✅ Holiday added${dates.length > 1 ? ` (${dates.length} days)` : ''}`);
    };

    // ---------- Undo ----------
    window.amsUndoDayChange = function (id) {
        const sc = getSelectedClass();
        const change = (sc?.dayChanges || []).find(c => c.id === id);
        if (!change) return;

        const logs = getLogs();
        Object.keys(change.removedLogs || {}).forEach(d => { logs[d] = change.removedLogs[d]; });
        saveLogs(logs);

        if (change.type === 'shift') {
            const all = getCustomSchedules();
            if (change.prevOnSchedule) all[change.on] = change.prevOnSchedule; else delete all[change.on];
            if (change.prevOffSchedule) all[change.off] = change.prevOffSchedule;
            setCustomSchedules(all);
        }

        updateClass(c => {
            if (change.type === 'shift') {
                if (!change.prevOffHoliday) c.holidays = c.holidays.filter(h => h !== change.off);
                if (change.prevOnHoliday && !c.holidays.includes(change.on)) c.holidays.push(change.on);
            } else {
                const keep = new Set(change.alreadyHoliday || []);
                c.holidays = c.holidays.filter(h => !change.dates.includes(h) || keep.has(h));
            }
            c.holidays.sort();
            c.dayChanges = c.dayChanges.filter(x => x.id !== id);
        });
        afterDayChange('↩️ Day change undone');
    };

    // ===============================================
    // ===============================================
    window.initAttendanceManagement = function () {
        amsCurrentView = 'menu';
        amsSelectedDate = formatDate(new Date());
        renderAll();
    };

    // Auto-init if the page is already visible
    if (document.getElementById('studentPortalPage')?.classList.contains('active')) {
        window.initAttendanceManagement();
    }

})();
