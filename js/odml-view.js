// ============================================================
// ORIGINAL vs WITH OD/ML — one switch for the whole app
// ============================================================
// Markup convention (any screen):
//   .odv-with   shown in "With OD/ML" view
//   .odv-orig   shown in "Original" view
//   .odv-both   only when the class has OD/ML (legends, "own x%" lines, chips)
//   .odv-plain  only when the class has NO OD/ML (plain labels like "Overall")
// Body classes: odml-none (no OD/ML anywhere) · odml-view-with / odml-view-original
// When there is no OD/ML both values are equal, so the "with" value is shown alone.
// ============================================================
(function () {
    'use strict';

    const KEY = 'odml_view';
    let hasAny = false;

    function get() {
        try { return localStorage.getItem(KEY) === 'original' ? 'original' : 'with'; } catch (e) { return 'with'; }
    }

    function classData() {
        try {
            if (typeof currentAnalysisData !== 'undefined' && currentAnalysisData && currentAnalysisData.length) return currentAnalysisData;
        } catch (e) { /* not defined yet */ }
        try {
            if (window.SmartSearch?.computeClassAttendance) return SmartSearch.computeClassAttendance() || [];
        } catch (e) { /* not ready */ }
        return [];
    }

    // Any OD/ML hours in the current class (base numbers or marked days)
    function detect(data) {
        const rows = Array.isArray(data) && data.length ? data : classData();
        return rows.some(s => (Number(s.odml) || 0) > 0 || (Number(s.initialOdml) || 0) > 0);
    }

    function apply() {
        const b = document.body;
        if (!b) return;
        const view = get();
        b.classList.toggle('odml-none', !hasAny);
        b.classList.toggle('odml-view-with', view === 'with');
        b.classList.toggle('odml-view-original', view === 'original');
        document.querySelectorAll('.odml-toggle').forEach(t => {
            t.querySelectorAll('button').forEach(btn => {
                const on = btn.dataset.view === view;
                btn.classList.toggle('on', on);
                btn.setAttribute('aria-pressed', String(on));
            });
        });
    }

    // Re-check OD/ML presence (pass the data you just rendered when you have it)
    function refresh(data) {
        hasAny = detect(data);
        apply();
        return hasAny;
    }

    function set(view) {
        try { localStorage.setItem(KEY, view === 'original' ? 'original' : 'with'); } catch (e) { /* ignore */ }
        apply();
        window.dispatchEvent(new CustomEvent('odml-view-change', { detail: { view: get() } }));
    }

    // Segmented control; hidden automatically when there is no OD/ML
    function toggleHTML(extraClass = '') {
        const v = get();
        return `<div class="odml-toggle ${extraClass}" role="group" aria-label="Show attendance">
            <button type="button" data-view="with" class="${v === 'with' ? 'on' : ''}" aria-pressed="${v === 'with'}" onclick="OdmlView.set('with')"><i class="fa-solid fa-briefcase-medical"></i> With OD/ML</button>
            <button type="button" data-view="original" class="${v === 'original' ? 'on' : ''}" aria-pressed="${v === 'original'}" onclick="OdmlView.set('original')"><i class="fa-solid fa-user-check"></i> Original</button>
        </div>`;
    }

    // Two values -> one element per view (when equal, a single plain value)
    function pair(withHtml, origHtml) {
        return `<span class="odv-with">${withHtml}</span><span class="odv-orig">${origHtml}</span>`;
    }

    // Styles live here so every screen gets them
    const css = `
        body.odml-none .odv-both, body.odml-none .odml-toggle, body.odml-none .odv-orig { display: none !important; }
        body:not(.odml-none) .odv-plain { display: none !important; }
        body:not(.odml-none).odml-view-with .odv-orig { display: none !important; }
        body:not(.odml-none).odml-view-original .odv-with { display: none !important; }
        .odml-toggle { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: rgba(99, 102, 241, 0.10);
            border: 1px solid rgba(99, 102, 241, 0.18); flex-shrink: 0; }
        .odml-toggle button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: none; border-radius: 999px;
            background: transparent; color: inherit; opacity: 0.75; font: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;
            white-space: nowrap; transition: background 0.2s, color 0.2s, opacity 0.2s, box-shadow 0.2s; }
        .odml-toggle button i { font-size: 0.75rem; }
        .odml-toggle button.on { opacity: 1; color: #fff; background: linear-gradient(135deg, #6366f1, #3b82f6); box-shadow: 0 4px 12px -4px rgba(79, 70, 229, 0.6); }
        .odml-toggle button:not(.on):hover { opacity: 1; }
        .odml-toggle.odml-toggle-light { background: rgba(255, 255, 255, 0.16); border-color: rgba(255, 255, 255, 0.28); color: #fff; }
        .odml-toggle.odml-toggle-light button.on { background: #fff; color: #4338ca; box-shadow: 0 4px 12px -4px rgba(0, 0, 0, 0.35); }
        @media (max-width: 480px) { .odml-toggle button { padding: 6px 10px; font-size: 0.74rem; } }
    `;
    function injectCss() {
        if (document.getElementById('odmlViewCss')) return;
        const st = document.createElement('style');
        st.id = 'odmlViewCss';
        st.textContent = css;
        document.head.appendChild(st);
    }

    injectCss();
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply);
    window.addEventListener('load', () => refresh());

    window.OdmlView = { get, set, refresh, toggleHTML, pair, hasOdml: () => hasAny };
})();
