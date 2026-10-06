// ============================================================
// SUBJECTS PAGE
// ============================================================
// Renders #subjectsRoot inside #subjectsPage. Lists only the subjects of
// the currently selected class, with live attendance for each one.
// Rebuilt on every visit; nothing here stores its own data.
// ============================================================

(function () {
    'use strict';

    let activeFilter = 'all';

    function esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function getClass() {
        if (typeof selectedClass !== 'undefined' && selectedClass) return selectedClass;
        const name = document.getElementById('classSelector')?.value;
        return name && typeof classes !== 'undefined' && classes[name] ? classes[name] : null;
    }

    function className() {
        const name = document.getElementById('classSelector')?.value;
        return name && name !== 'add_new_class' ? name : (getClass()?.name || '');
    }

    function minPercent() {
        return (typeof getMinAttendanceCriteria === 'function' ? getMinAttendanceCriteria() : 0.75) * 100;
    }

    function colorFor(index) {
        if (typeof getSubjectColor === 'function') return getSubjectColor(index);
        return ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'][index % 8];
    }

    function initials(name, code) {
        const ignore = ['and', 'of', 'the', 'in', 'for', 'to', 'a', 'an'];
        const words = String(name || '').split(/\s+/).filter(w => w && !ignore.includes(w.toLowerCase()));
        if (words.length > 1) return words.slice(0, 3).map(w => w[0].toUpperCase()).join('');
        return String(name || code || '?').substring(0, 2).toUpperCase();
    }

    // Classes per week, from the timetable arrangement or the subject schedule
    function weeklyCounts(cls) {
        const counts = {};
        const arrangement = typeof getTimetableArrangement === 'function' ? getTimetableArrangement(className()) : null;
        if (arrangement && Object.values(arrangement).some(d => Array.isArray(d) && d.some(Boolean))) {
            Object.values(arrangement).forEach(day => {
                (day || []).forEach(item => {
                    const code = typeof item === 'object' ? item?.code : item;
                    if (code) counts[code] = (counts[code] || 0) + 1;
                });
            });
            return counts;
        }
        cls.subjects.forEach(s => {
            counts[s.code] = (s.schedule || []).reduce((sum, v) => {
                if (!v || v === '0') return sum;
                if (typeof v === 'number') return sum + v;
                return sum + String(v).split(',').filter(x => x.trim() && x.trim() !== '0').length;
            }, 0);
        });
        return counts;
    }

    // One row per subject of the selected class, nothing else
    function buildRows(cls) {
        let source = [];
        if (window.SmartSearch?.computeClassAttendance) source = SmartSearch.computeClassAttendance() || [];
        if (typeof currentAnalysisData !== 'undefined' && currentAnalysisData.length) {
            const codes = new Set(cls.subjects.map(s => s.code));
            if (currentAnalysisData.every(d => codes.has(d.code))) source = currentAnalysisData;
        }
        const byCode = {};
        source.forEach(d => { byCode[d.code] = d; });
        const weekly = weeklyCounts(cls);
        const min = minPercent();

        return cls.subjects.map((subject, idx) => {
            const d = byCode[subject.code] || {};
            const attended = Number(d.attended) || 0;
            const totalHeld = Number(d.totalHeld) || 0;
            const remaining = Number(d.remaining) || 0;
            const odml = Math.min(Number(d.odml) || 0, attended);
            const stats = typeof getSubjectAnalysis === 'function'
                ? getSubjectAnalysis(attended, totalHeld, remaining, null, odml).stats
                : { currentPercent: totalHeld ? (attended / totalHeld) * 100 : 0, stillNeed: 0, maxSkippable: 0 };

            let status = 'none';
            if (totalHeld > 0) {
                if (stats.stillNeed > remaining) status = 'danger';
                else if (stats.currentPercent < min) status = 'warning';
                else status = 'safe';
            }

            return {
                code: subject.code,
                name: subject.name || subject.code,
                color: colorFor(idx),
                attended, totalHeld, remaining, odml,
                percent: stats.currentPercent,
                percentWithout: totalHeld ? ((attended - odml) / totalHeld) * 100 : 0,
                stillNeed: stats.stillNeed,
                canSkip: stats.maxSkippable,
                weekly: weekly[subject.code] || 0,
                status
            };
        });
    }

    function statusPill(r) {
        if (r.status === 'none') return `<span class="sp-pill sp-pill-none"><i class="fa-regular fa-circle"></i> No classes yet</span>`;
        if (r.status === 'danger') return `<span class="sp-pill sp-pill-danger"><i class="fa-solid fa-circle-exclamation"></i> Can't reach ${minPercent()}%</span>`;
        if (r.status === 'warning') return `<span class="sp-pill sp-pill-warning"><i class="fa-solid fa-arrow-trend-up"></i> Attend ${r.stillNeed} more</span>`;
        return `<span class="sp-pill sp-pill-safe"><i class="fa-solid fa-circle-check"></i> Can skip ${r.canSkip}</span>`;
    }

    function subjectCard(r) {
        const pct = Math.max(0, Math.min(100, r.percent));
        const min = minPercent();
        return `
            <article class="sp-card" style="--sp-accent:${r.color}">
                <div class="sp-card-top">
                    <span class="sp-badge">${esc(initials(r.name, r.code))}</span>
                    <div class="sp-card-title">
                        <h3>${esc(r.name)}</h3>
                        <span class="sp-code">${esc(r.code)}</span>
                    </div>
                    <div class="sp-percent-wrap">
                        <div class="sp-percent sp-text-${r.status}">${r.totalHeld ? (window.OdmlView ? OdmlView.pair(pct.toFixed(1) + '%', r.percentWithout.toFixed(1) + '%') : pct.toFixed(1) + '%') : '—'}</div>
                        ${r.totalHeld ? `<div class="sp-percent-sub odv-both"><span class="odv-with">with OD/ML</span><span class="odv-orig">original · present only</span></div>` : ''}
                    </div>
                </div>
                <div class="sp-bar" role="progressbar" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100">
                    <span class="sp-bar-fill sp-fill-${r.status} odv-with" style="width:${pct}%"></span>
                    <span class="sp-bar-fill sp-fill-${r.status} odv-orig" style="width:${Math.max(0, Math.min(100, r.percentWithout))}%"></span>
                    <span class="sp-bar-mark" style="left:${min}%" title="Required ${min}%"></span>
                </div>
                <div class="sp-meta">
                    <span><strong>${r.attended}</strong>/${r.totalHeld} attended${r.odml ? ` (${r.attended - r.odml} present + ${r.odml} OD/ML)` : ''}</span>
                    <span><i class="fa-regular fa-calendar"></i> ${r.weekly}/week</span>
                    <span><i class="fa-regular fa-hourglass-half"></i> ${r.remaining} left</span>
                </div>
                <div class="sp-card-foot">${statusPill(r)}</div>
            </article>`;
    }

    function emptyState(title, text, action) {
        return `
            <div class="sp-empty">
                <div class="sp-empty-icon"><i class="fa-solid fa-book-open"></i></div>
                <h3>${title}</h3>
                <p>${text}</p>
                ${action || ''}
            </div>`;
    }

    function render() {
        renderInner();
        if (window.OdmlView) OdmlView.refresh();
    }

    function renderInner() {
        const root = document.getElementById('subjectsRoot');
        if (!root) return;
        const cls = getClass();

        if (!cls) {
            root.innerHTML = header('Subjects', 'No class selected') + emptyState('Pick a class first',
                'Select a class on the Home tab to see its subjects here.',
                `<button class="sp-btn sp-btn-primary" onclick="switchPage('dashboardPage')"><i class="fa-solid fa-house"></i> Go to Home</button>`);
            return;
        }
        if (!cls.subjects || cls.subjects.length === 0) {
            root.innerHTML = header('Subjects', esc(className())) + emptyState('No subjects in this class',
                'Add subjects to this class to track them here.',
                typeof editSelectedClass === 'function' ? `<button class="sp-btn sp-btn-primary" onclick="editSelectedClass()"><i class="fa-solid fa-pen"></i> Edit class</button>` : '');
            return;
        }

        const rows = buildRows(cls);
        const counts = { all: rows.length, safe: 0, warning: 0, danger: 0 };
        let att = 0, held = 0, odml = 0;
        rows.forEach(r => {
            if (counts[r.status] !== undefined) counts[r.status]++;
            att += r.attended; held += r.totalHeld; odml += r.odml;
        });
        const overall = held ? (att / held) * 100 : 0;
        const overallWithout = held ? ((att - odml) / held) * 100 : 0;
        const atRisk = counts.warning + counts.danger;

        const filters = [
            { key: 'all', label: 'All', n: counts.all },
            { key: 'safe', label: 'Safe', n: counts.safe },
            { key: 'risk', label: 'At risk', n: atRisk }
        ];
        const visible = rows.filter(r => activeFilter === 'all'
            || (activeFilter === 'safe' && r.status === 'safe')
            || (activeFilter === 'risk' && (r.status === 'warning' || r.status === 'danger')));

        root.innerHTML = `
            ${header('Subjects', `${esc(className())} · ${rows.length} subject${rows.length !== 1 ? 's' : ''}`)}
            ${window.OdmlView ? `<div class="sp-odml-switch">${OdmlView.toggleHTML()}</div>` : ''}
            <section class="sp-summary">
                <div class="sp-summary-item">
                    <span class="sp-summary-value">${held ? (window.OdmlView ? OdmlView.pair(overall.toFixed(1) + '%', overallWithout.toFixed(1) + '%') : overall.toFixed(1) + '%') : '—'}</span>
                    <span class="sp-summary-label"><span class="odv-plain">Overall</span><span class="odv-both"><span class="odv-with">Overall · with OD/ML</span><span class="odv-orig">Overall · original</span></span></span>
                </div>
                <div class="sp-summary-item">
                    <span class="sp-summary-value sp-text-safe">${counts.safe}</span>
                    <span class="sp-summary-label">Safe</span>
                </div>
                <div class="sp-summary-item">
                    <span class="sp-summary-value sp-text-danger">${atRisk}</span>
                    <span class="sp-summary-label">At risk</span>
                </div>
                <div class="sp-summary-item">
                    <span class="sp-summary-value">${minPercent()}%</span>
                    <span class="sp-summary-label">Required</span>
                </div>
            </section>
            <div class="sp-filters" role="tablist">
                ${filters.map(f => `<button class="sp-filter ${activeFilter === f.key ? 'active' : ''}" role="tab" aria-selected="${activeFilter === f.key}" onclick="SubjectsPage.filter('${f.key}')">${f.label} <span>${f.n}</span></button>`).join('')}
            </div>
            <section class="sp-grid">
                ${visible.length ? visible.map(subjectCard).join('') : `<p class="sp-none">No subjects in this group.</p>`}
            </section>
            <button class="sp-link" onclick="switchPage('longWeekendPage')">
                <span class="sp-link-icon"><i class="fa-solid fa-umbrella-beach"></i></span>
                <span class="sp-link-text"><strong>Long weekends</strong><span>Find the best days to take off</span></span>
                <i class="fa-solid fa-chevron-right"></i>
            </button>
            <p class="sp-credit">Developed by <strong>Faisal Khan and Sheikh Hemayoou</strong></p>`;
    }

    function header(title, sub) {
        return `
            <header class="sp-header">
                <div>
                    <h1>${title}</h1>
                    <p>${sub}</p>
                </div>
            </header>`;
    }

    // Switching class while this page is open shows the new class's subjects
    document.addEventListener('change', e => {
        if (e.target?.id !== 'classSelector') return;
        if (!document.getElementById('subjectsPage')?.classList.contains('active')) return;
        activeFilter = 'all';
        setTimeout(render, 0);
    });

    window.SubjectsPage = {
        render,
        filter(key) {
            activeFilter = key;
            render();
        }
    };
})();
