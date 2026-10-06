// ============================================================
// SCREENSHOT SCAN: animated waiting screen + modern results view
// ============================================================
// Full-screen view (#scanView) that replaces the old calculator page after a
// screenshot is read. Shows only "Attendance Analysis & Projections".
// Uses app globals: currentAnalysisData, getSubjectAnalysis, attendanceSplit,
// getMinAttendanceCriteria, getActiveClassKey, OdmlView, switchPage.
// ============================================================
(function () {
    'use strict';

    let timers = [];
    let thumbUrl = null;

    function esc(t) {
        return String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function clearTimers() {
        timers.forEach(t => clearInterval(t));
        timers = [];
    }

    function root() {
        let el = document.getElementById('scanView');
        if (!el) {
            el = document.createElement('div');
            el.id = 'scanView';
            el.className = 'sv-screen';
            el.setAttribute('role', 'dialog');
            el.setAttribute('aria-modal', 'true');
            document.body.appendChild(el);
        }
        return el;
    }

    function open() {
        const el = root();
        el.classList.add('sv-open');
        document.body.classList.add('sv-lock');
        return el;
    }

    function close(goHome = true) {
        clearTimers();
        const el = document.getElementById('scanView');
        if (el) el.classList.remove('sv-open');
        document.body.classList.remove('sv-lock');
        if (thumbUrl) { URL.revokeObjectURL(thumbUrl); thumbUrl = null; }
        if (goHome && typeof switchPage === 'function') { try { switchPage('dashboardPage'); } catch (e) { /* ignore */ } }
    }

    // ---------- Waiting animation ----------
    const STEPS = [
        { icon: 'fa-image', text: 'Reading your screenshot' },
        { icon: 'fa-table-list', text: 'Finding subjects and numbers' },
        { icon: 'fa-calculator', text: 'Calculating skips and projections' }
    ];

    function loaderHTML(files) {
        const file = files && files[0];
        if (file && file instanceof Blob) {
            if (thumbUrl) URL.revokeObjectURL(thumbUrl);
            thumbUrl = URL.createObjectURL(file);
        }
        const count = files ? files.length : 1;
        return `
            <div class="sv-loader">
                <div class="sv-scan">
                    ${thumbUrl ? `<img src="${thumbUrl}" alt="Your screenshot">` : '<div class="sv-scan-ph"><i class="fa-regular fa-image"></i></div>'}
                    <span class="sv-scan-line"></span>
                    <span class="sv-corner tl"></span><span class="sv-corner tr"></span><span class="sv-corner bl"></span><span class="sv-corner br"></span>
                </div>
                <h2>Analysing ${count > 1 ? `${count} screenshots` : 'your screenshot'}</h2>
                <p class="sv-loader-sub">This usually takes 5–15 seconds</p>
                <div class="sv-progress"><i class="sv-progress-fill"></i></div>
                <ul class="sv-steps">
                    ${STEPS.map((s, i) => `<li class="${i === 0 ? 'active' : ''}"><span class="sv-step-dot"><i class="fa-solid ${s.icon}"></i></span>${s.text}</li>`).join('')}
                </ul>
                <p class="sv-elapsed"><i class="fa-regular fa-clock"></i> <span class="sv-secs">0</span>s</p>
            </div>`;
    }

    // Animates any loader inside `scope` (steps, progress, seconds)
    function animateLoader(scope) {
        const start = Date.now();
        const steps = [...scope.querySelectorAll('.sv-steps li')];
        const fill = scope.querySelector('.sv-progress-fill');
        const secs = scope.querySelector('.sv-secs');
        const t = setInterval(() => {
            if (!scope.isConnected) { clearInterval(t); return; }
            const s = (Date.now() - start) / 1000;
            if (secs) secs.textContent = Math.floor(s);
            // Progress eases towards 92% and waits there for the result
            if (fill) fill.style.width = `${Math.min(92, 92 * (1 - Math.exp(-s / 6)))}%`;
            const idx = s < 3 ? 0 : s < 7 ? 1 : 2;
            steps.forEach((li, i) => { li.classList.toggle('active', i === idx); li.classList.toggle('done', i < idx); });
        }, 200);
        timers.push(t);
    }

    function loading(files) {
        clearTimers();
        const el = open();
        el.innerHTML = `
            <div class="sv-top"><button class="sv-icon-btn" onclick="ScanResults.close(false)" aria-label="Cancel"><i class="fa-solid fa-xmark"></i></button></div>
            ${loaderHTML(files)}`;
        animateLoader(el);
    }

    function error(message) {
        clearTimers();
        const el = open();
        el.innerHTML = `
            <div class="sv-top"><button class="sv-icon-btn" onclick="ScanResults.close(false)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
            <div class="sv-loader sv-error">
                <div class="sv-error-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <h2>Couldn't read this screenshot</h2>
                <p class="sv-loader-sub">${esc(message || 'Use a clear screenshot that shows the attendance table.')}</p>
                <div class="sv-actions">
                    <button class="sv-btn" onclick="ScanResults.close(false)">Close</button>
                    <button class="sv-btn sv-btn-primary" onclick="ScanResults.retry()"><i class="fa-solid fa-camera"></i> Try another</button>
                </div>
            </div>`;
    }

    function retry() {
        close(false);
        document.getElementById('imageInput')?.click();
    }

    // ---------- Results ----------
    function fmt(p) { return `${(Number(p) || 0).toFixed(1)}%`; }
    function pair(withP, ownP) {
        return window.OdmlView ? OdmlView.pair(fmt(withP), fmt(ownP)) : fmt(withP);
    }

    function show() {
        const data = (typeof currentAnalysisData !== 'undefined' && currentAnalysisData) || [];
        if (!data.length) { error(); return; }
        clearTimers();
        const minC = typeof getMinAttendanceCriteria === 'function' ? getMinAttendanceCriteria() : 0.75;
        const min = Math.round(minC * 1000) / 10;
        const dateLabel = (() => {
            const v = document.getElementById('currentDate')?.value;
            const d = v ? new Date(v + 'T00:00:00') : new Date();
            return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        })();
        const className = (typeof getActiveClassKey === 'function' && getActiveClassKey()) || document.getElementById('classSelector')?.value || '';

        let tAtt = 0, tPres = 0, tHeld = 0, tEff = 0, tRem = 0, tSkip = 0, atRisk = 0, lowest = null;
        const cards = data.map((sub, i) => {
            const sp = attendanceSplit(sub.attended, sub.totalHeld, sub.odml, sub.remaining);
            const { stats } = getSubjectAnalysis(sub.attended, sub.totalHeld, sub.remaining, null, sub.odml);
            const pct = sp.withPct, own = sp.withoutPct;
            const held = sp.totalHeld;
            tAtt += sp.attended; tPres += sp.present; tHeld += held; tEff += pct / 100 * held; tRem += Number(sub.remaining) || 0;
            const skip = held ? Math.max(0, stats.maxSkippable) : 0;
            tSkip += skip;
            if (held && (!lowest || skip < lowest.skip)) lowest = { name: sub.name, skip };
            let tone, pill;
            if (!held) { tone = 'none'; pill = 'No data'; }
            else if (stats.stillNeed > stats.remaining) { tone = 'danger'; pill = `Can't reach ${min}%`; atRisk++; }
            else if (pct < min) { tone = 'warn'; pill = `Attend ${stats.stillNeed} more`; atRisk++; }
            else { tone = 'safe'; pill = skip <= 2 ? 'Tight' : 'Safe'; }
            const need = Math.max(0, Math.min(stats.stillNeed, stats.remaining));
            return `
                <article class="sv-card sv-tone-${tone}" style="animation-delay:${120 + i * 70}ms">
                    <div class="sv-card-head">
                        <div class="sv-card-title">
                            <strong>${esc(sub.name)}</strong>
                            <span>${esc(sub.code)} · ${sp.present}${sp.odml ? `<span class="odv-both"> + ${sp.odml} OD/ML</span>` : ''} / ${held} attended</span>
                        </div>
                        <div class="sv-card-pct">
                            <b>${held ? pair(pct, own) : '—'}</b>
                            <em class="sv-pill sv-pill-${tone}">${pill}</em>
                        </div>
                    </div>
                    <div class="sv-bar"><i class="odv-with" style="width:${Math.min(100, pct)}%"></i><i class="odv-orig" style="width:${Math.min(100, own)}%"></i><u style="left:${min}%"></u></div>
                    <div class="sv-metrics">
                        <div><span>Can skip</span><strong class="sv-num-${skip === 0 ? 'bad' : skip <= 2 ? 'mid' : 'good'}">${skip}</strong></div>
                        <div><span>Must attend</span><strong>${need}</strong></div>
                        <div><span>Attend all</span><strong>${fmt(stats.projectedMaxPercent)}</strong></div>
                        <div><span>Skip all</span><strong>${fmt(stats.projectedMinPercent)}</strong></div>
                    </div>
                    <p class="sv-card-foot">${stats.remaining} classes left this semester${stats.allowancePlan && sp.odml ? ` · OD/ML ${Math.min(sp.odml, stats.allowancePlan.allowance)}/${stats.allowancePlan.allowance} h` : ''}</p>
                </article>`;
        }).join('');

        const overall = tHeld ? (tEff / tHeld) * 100 : 0;
        const overallOwn = tHeld ? (tPres / tHeld) * 100 : 0;
        const tone = overall >= min ? 'safe' : overall >= min - 5 ? 'warn' : 'danger';
        const headline = atRisk === 0
            ? `You can skip <strong>${tSkip}</strong> class${tSkip !== 1 ? 'es' : ''} this semester`
            : `<strong>${atRisk}</strong> subject${atRisk !== 1 ? 's need' : ' needs'} attention`;
        const subline = lowest
            ? (lowest.skip === 0 ? `No safe skips left in ${esc(lowest.name)}` : `Lowest margin: ${esc(lowest.name)} · ${lowest.skip} skip${lowest.skip !== 1 ? 's' : ''}`)
            : '';
        const ringPct = Math.max(0, Math.min(100, overall));
        const ringOwn = Math.max(0, Math.min(100, overallOwn));

        const el = open();
        el.innerHTML = `
            <div class="sv-top">
                <button class="sv-icon-btn" onclick="ScanResults.close()" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
                <div class="sv-top-text">
                    <h1>Attendance Analysis &amp; Projections</h1>
                    <p>${esc(className)}${className ? ' · ' : ''}as of ${dateLabel} · minimum ${min}%</p>
                </div>
            </div>
            <div class="sv-body">
                <section class="sv-hero sv-hero-${tone}">
                    <div class="sv-ring">
                        <div class="odv-with sv-ring-in" style="--p:${ringPct}"><span>${fmt(overall)}</span></div>
                        <div class="odv-orig sv-ring-in" style="--p:${ringOwn}"><span>${fmt(overallOwn)}</span></div>
                        <small><span class="odv-plain">Overall</span><span class="odv-both"><span class="odv-with">With OD/ML</span><span class="odv-orig">Original</span></span></small>
                    </div>
                    <div class="sv-hero-text">
                        <p class="sv-headline">${headline}</p>
                        ${subline ? `<p class="sv-subline">${subline}</p>` : ''}
                        <div class="sv-chips">
                            <span><i class="fa-solid fa-user-check"></i> <span><span class="odv-with">${tAtt}</span><span class="odv-orig">${tPres}</span>/${tHeld} attended</span></span>
                            <span><i class="fa-solid fa-hourglass-half"></i> ${tRem} left</span>
                            <span><i class="fa-solid fa-layer-group"></i> ${data.length} subjects</span>
                        </div>
                    </div>
                </section>
                ${window.OdmlView ? `<div class="sv-switch">${OdmlView.toggleHTML()}</div>` : ''}
                <div class="sv-cards">${cards}</div>
                <p class="sv-note"><i class="fa-solid fa-circle-info"></i> "Can skip" and projections count your timetable up to the last working day. "Attend all" / "Skip all" = your final % if you attend or miss every remaining class.</p>
            </div>
            <div class="sv-footer">
                <button class="sv-btn" onclick="ScanResults.retry()"><i class="fa-solid fa-camera"></i> Scan again</button>
                <button class="sv-btn sv-btn-primary" onclick="ScanResults.close()"><i class="fa-solid fa-check"></i> Done</button>
            </div>`;
        if (window.OdmlView) OdmlView.refresh(data);
        el.scrollTop = 0;
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && document.getElementById('scanView')?.classList.contains('sv-open')) close(false);
    });

    window.ScanResults = { loading, show, error, close, retry, loaderHTML, animateLoader };
})();
