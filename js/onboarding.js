// ============================================================
// ONBOARDING: animated full-screen welcome for new users
// ============================================================
// Replaces the old "What should we call you?" and "Setup Your Class" popups.
//  Step 1  name (skipped when already known)
//  Step 2  set up the class: create · timetable photo (AI) · class QR ·
//          attendance screenshot · or try the example class
// Opened by checkFirstLoginPrompt() / openOnboardingClassModal() in index.html,
// only after the login screen has closed.
// ============================================================

(function () {
    'use strict';

    let opts = {};

    function esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function knownName() {
        let profile = {};
        try { profile = JSON.parse(localStorage.getItem('studentProfile') || '{}'); } catch (e) { /* none */ }
        return profile.name || localStorage.getItem('userProfileName') || window.AuthManager?.user?.user_metadata?.full_name || '';
    }

    function root() {
        let el = document.getElementById('onboarding');
        if (!el) {
            el = document.createElement('div');
            el.id = 'onboarding';
            el.className = 'ob-screen';
            el.setAttribute('role', 'dialog');
            el.setAttribute('aria-label', 'Welcome to Bunkit');
            el.innerHTML = `
                <div class="ob-bg" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
                <button class="ob-close" onclick="Onboarding.later()" aria-label="Set up later">Later</button>
                <div class="ob-stage"></div>
                <div class="ob-dots" aria-hidden="true"><span></span><span></span></div>
                <input type="file" id="obShotInput" accept="image/*" multiple hidden>`;
            document.body.appendChild(el);
            el.querySelector('#obShotInput').addEventListener('change', function () {
                if (!this.files || !this.files.length) return;
                finish();
                if (typeof window.startScreenshotUploadFromLogin === 'function') window.startScreenshotUploadFromLogin(this);
            });
        }
        return el;
    }

    function setDots(i) {
        root().querySelectorAll('.ob-dots span').forEach((d, k) => d.classList.toggle('on', k === i));
    }

    function show(html, step) {
        const stage = root().querySelector('.ob-stage');
        stage.classList.remove('ob-in');
        stage.classList.add('ob-out');
        setTimeout(() => {
            stage.innerHTML = html;
            stage.classList.remove('ob-out');
            void stage.offsetWidth; // restart the entrance animation
            stage.classList.add('ob-in');
            setDots(step);
            const input = stage.querySelector('input');
            if (input) setTimeout(() => input.focus(), 350);
        }, root().classList.contains('ob-open') ? 220 : 0);
    }

    // ---------- Step 1: name ----------
    function nameStep() {
        show(`
            <div class="ob-hero">
                <img src="icon-192x192.png" alt="" class="ob-logo">
                <h1>Welcome to <span>Bunkit</span></h1>
                <p>Know exactly how many classes you can miss, and never fall short.</p>
            </div>
            <label class="ob-field">
                <span>What should we call you?</span>
                <input type="text" id="obName" maxlength="40" placeholder="Your name" autocomplete="name" value="${esc(knownName())}">
            </label>
            <button class="ob-primary" onclick="Onboarding.saveName()">Continue <i class="fa-solid fa-arrow-right"></i></button>
        `, 0);
        setTimeout(() => {
            const input = document.getElementById('obName');
            if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
        }, 300);
    }

    function saveName() {
        const input = document.getElementById('obName');
        const name = (input?.value || '').trim();
        if (!name) {
            input?.classList.add('ob-shake');
            setTimeout(() => input?.classList.remove('ob-shake'), 500);
            return;
        }
        localStorage.setItem('userProfileName', name);
        try {
            const profile = JSON.parse(localStorage.getItem('studentProfile') || '{}');
            profile.name = name;
            localStorage.setItem('studentProfile', JSON.stringify(profile));
        } catch (e) { /* ignore */ }
        if (window.SyncManager?.saveSettings) { try { SyncManager.saveSettings(); } catch (e) { /* offline */ } }
        if (typeof updateSidebarAccountUI === 'function') { try { updateSidebarAccountUI(); } catch (e) { /* ignore */ } }
        if (typeof renderProfileHeader === 'function') { try { renderProfileHeader(); } catch (e) { /* ignore */ } }
        if (typeof updateNavAvatar === 'function') updateNavAvatar();

        // Came from a class share link: import it now
        if (opts.pendingImport) {
            const pending = opts.pendingImport;
            finish();
            setTimeout(() => { if (typeof importClassFromURL === 'function') importClassFromURL(pending); }, 350);
            return;
        }
        classStep();
    }

    // ---------- Step 2: set up the class ----------
    function classStep() {
        const name = knownName();
        const card = (action, icon, tone, title, desc) => `
            <button class="ob-option" onclick="Onboarding.pick('${action}')">
                <span class="ob-option-icon ob-${tone}">${icon}</span>
                <span class="ob-option-text"><strong>${title}</strong><small>${desc}</small></span>
                <i class="fa-solid fa-chevron-right"></i>
            </button>`;
        show(`
            <div class="ob-hero ob-hero-sm">
                <div class="ob-emoji">📚</div>
                <h1>${name ? `Hi ${esc(name.split(' ')[0])}, let's` : "Let's"} set up your class</h1>
                <p>Pick the easiest way. You can change everything later.</p>
            </div>
            <div class="ob-options">
                ${card('create', '✍️', 'indigo', 'Create my class', 'Add subjects and your weekly timetable')}
                ${card('ai', '✨', 'violet', 'From my timetable photo', 'AI reads subjects and periods for you')}
                ${card('qr', '📷', 'teal', "Scan a classmate's QR", 'Copy their class setup in seconds')}
                ${card('shot', '📸', 'amber', 'From my attendance screenshot', 'Read your portal and build the class')}
            </div>
            <button class="ob-link" onclick="Onboarding.pick('example')">Just exploring? Try an example class</button>
        `, 1);
    }

    function hasClass() {
        return typeof window.hasAnyClass === 'function' ? window.hasAnyClass()
            : (typeof classes !== 'undefined' && Object.keys(classes).length > 0);
    }

    // After a setup window closes without a class: remind (banner + toast)
    let watchTimer = null;
    function watchSetupWindow() {
        clearInterval(watchTimer);
        let sawOpen = false;
        const started = Date.now();
        watchTimer = setInterval(() => {
            if (hasClass()) { clearInterval(watchTimer); if (typeof renderClassReminder === 'function') renderClassReminder(); return; }
            const open = !!document.querySelector('.modal.active, .modal[style*="flex"], .modal[style*="block"], #qrScanModal.open, #onboarding.ob-open');
            if (open) { sawOpen = true; return; }
            if (!sawOpen && Date.now() - started < 3000) return; // window still opening
            clearInterval(watchTimer);
            if (typeof renderClassReminder === 'function') renderClassReminder();
            if (typeof showToast === 'function') showToast('No class yet', 'Your class isn\'t set up — tap "Set up class" on Home when you\'re ready.', { duration: 4500 });
        }, 700);
    }

    function pick(action) {
        if (action === 'shot') {
            document.getElementById('obShotInput')?.click();
            return;
        }
        finish();
        if (action !== 'example') setTimeout(watchSetupWindow, 400);
        setTimeout(() => {
            if (action === 'create' && typeof openAddClassModal === 'function') openAddClassModal();
            if (action === 'ai' && typeof openAddClassModal === 'function') {
                openAddClassModal();
                setTimeout(() => { if (typeof switchModalTab === 'function') switchModalTab('aiImport'); }, 200);
            }
            if (action === 'qr' && typeof openQRScanner === 'function') openQRScanner();
            if (action === 'example' && typeof useExampleClass === 'function') useExampleClass();
        }, 250);
    }

    // ---------- open / close ----------
    function start(options = {}) {
        opts = options;
        const el = root();
        // Already open: just move to the right step
        const needName = !knownName() || options.askName;
        if (options.step === 'class' && !needName) classStep();
        else if (needName) nameStep();
        else if (options.pendingImport) { finish(); setTimeout(() => importClassFromURL(options.pendingImport), 300); return; }
        else classStep();
        document.body.classList.add('ob-lock');
        requestAnimationFrame(() => el.classList.add('ob-open'));

        // A class arrived meanwhile (cloud sync, share link): close quietly
        clearInterval(start.timer);
        start.timer = setInterval(() => {
            if (!document.getElementById('onboarding')?.classList.contains('ob-open')) { clearInterval(start.timer); return; }
            if (!opts.pendingImport && hasClass()) { clearInterval(start.timer); finish(); }
        }, 1000);
    }

    function finish() {
        localStorage.setItem('hasCompletedOnboarding', 'true');
        const el = document.getElementById('onboarding');
        if (!el) return;
        el.classList.remove('ob-open');
        document.body.classList.remove('ob-lock');
        setTimeout(() => { if (!el.classList.contains('ob-open')) el.remove(); }, 450);
    }

    function later() {
        // Snooze for this visit only — it comes back next time while there's no class
        try { sessionStorage.setItem('ob_snoozed', '1'); } catch (e) { /* ignore */ }
        finish();
        if (typeof renderClassReminder === 'function') renderClassReminder();
        if (typeof showToast === 'function') showToast('Set up any time', 'We\'ll remind you until your class is set up. Tap "Set up class" on Home.', { duration: 4500 });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('onboarding')?.classList.contains('ob-open')) later();
    });

    window.Onboarding = { start, saveName, pick, later, finish };
})();
