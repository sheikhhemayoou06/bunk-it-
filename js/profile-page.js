// ============================================================
// PROFILE & SETTINGS PAGE
// ============================================================
// Renders #profileRoot inside #accountPage. Rebuilt on every visit so
// account, class and theme state are always current. Every action calls
// an existing app function; nothing here stores its own data.
// ============================================================

(function () {
    'use strict';

    const LEGAL_LINKS = [
        { href: 'about.html', icon: 'fa-circle-info', title: 'About Bunkit' },
        { href: 'faq.html', icon: 'fa-circle-question', title: 'FAQ' },
        { href: 'support.html', icon: 'fa-life-ring', title: 'Help & Support' },
        { href: 'contact.html', icon: 'fa-envelope', title: 'Contact Us' },
        { href: 'privacy.html', icon: 'fa-shield-halved', title: 'Privacy Policy' },
        { href: 'terms.html', icon: 'fa-file-contract', title: 'Terms of Service' }
    ];

    function esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function currentClassName() {
        const name = document.getElementById('classSelector')?.value;
        return name && typeof classes !== 'undefined' && classes[name] ? name : null;
    }

    function isDark() {
        return document.body.classList.contains('dark-mode');
    }

    function fmtDate(dateStr) {
        if (!dateStr) return '';
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function odmlDesc() {
        const v = localStorage.getItem('calcSettings_odmlCap') || 'min';
        if (v === 'none') return 'All OD/ML hours count as attended';
        const pct = v === 'min' ? (typeof getMinAttendanceCriteria === 'function' ? Math.round(getMinAttendanceCriteria() * 1000) / 10 : 75) : v;
        return `OD/ML lifts attendance only up to ${pct}%${v === 'min' ? ' (the minimum)' : ''}`;
    }

    // "2 upcoming · next Mid-term 1 on 12 Oct"
    function examDesc() {
        const name = currentClassName();
        const today = formatLocalDate(new Date());
        const upcoming = (classes[name]?.examDays || []).filter(e => (e.to || e.from) >= today).sort((a, b) => a.from.localeCompare(b.from));
        if (!upcoming.length) return 'Compulsory days, never suggested for leave';
        return `${upcoming.length} upcoming · next ${esc(upcoming[0].title || 'Exam')} on ${fmtDate(upcoming[0].from)}`;
    }

    // One settings row
    function row({ icon, tone = 'indigo', title, desc = '', action = '', href = '', danger = false, trailing = '' }) {
        const inner = `
            <span class="pf-row-icon pf-tone-${tone}"><i class="fa-solid ${icon}"></i></span>
            <span class="pf-row-text">
                <span class="pf-row-title">${title}</span>
                ${desc ? `<span class="pf-row-desc">${desc}</span>` : ''}
            </span>
            ${trailing || `<i class="fa-solid ${href ? 'fa-arrow-up-right-from-square' : 'fa-chevron-right'} pf-row-arrow"></i>`}`;
        if (href) {
            return `<a class="pf-row ${danger ? 'pf-danger' : ''}" href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        }
        return `<button type="button" class="pf-row ${danger ? 'pf-danger' : ''}" onclick="${action}">${inner}</button>`;
    }

    function group(label, rows) {
        return `
            <section class="pf-group">
                <h3 class="pf-group-label">${label}</h3>
                <div class="pf-card pf-list">${rows.join('')}</div>
            </section>`;
    }

    // ---------- Profile data ----------
    function getProfile() {
        try { return JSON.parse(localStorage.getItem('studentProfile') || '{}') || {}; } catch (e) { return {}; }
    }

    function displayName() {
        const user = window.AuthManager?.user;
        const p = getProfile();
        return p.name || user?.user_metadata?.full_name || localStorage.getItem('userProfileName') || '';
    }

    function fmtPhone(phone) {
        const d = String(phone || '').replace(/\D/g, '');
        if (d.length === 10) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
        if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
        return phone || '';
    }

    // Editable fields: one place for labels, input types and validation
    const FIELDS = {
        name: { label: 'Full name', icon: 'fa-user', type: 'text', placeholder: 'e.g. Aarav Sharma', max: 60, auto: 'name', required: true,
            help: 'Shown on your dashboard and to classmates in shared classes.',
            validate: v => v.length < 2 ? 'Please enter your full name.' : '' },
        phone: { label: 'Phone number', icon: 'fa-phone', type: 'tel', placeholder: '10-digit mobile number', max: 16, auto: 'tel', mode: 'tel',
            help: 'Only used to identify your account. Never shared.',
            normalize: v => { let d = v.replace(/[^\d]/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return d; },
            validate: v => v && !/^[6-9]\d{9}$/.test(v) ? 'Enter a valid 10-digit Indian mobile number.' : '',
            show: fmtPhone },
        regNo: { label: 'Registration number', icon: 'fa-id-card', type: 'text', placeholder: 'e.g. RA2411003030476', max: 30,
            normalize: v => v.toUpperCase().replace(/\s+/g, ''),
            validate: v => v && !/^[A-Z0-9/-]{4,30}$/.test(v) ? 'Use letters and numbers only.' : '' },
        college: { label: 'College / university', icon: 'fa-building-columns', type: 'text', placeholder: 'e.g. SRM Institute of Science and Technology', max: 80 },
        branch: { label: 'Branch / department', icon: 'fa-sitemap', type: 'text', placeholder: 'e.g. Computer Science (CSE)', max: 40 },
        semester: { label: 'Semester', icon: 'fa-layer-group', type: 'select', options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
            show: v => v ? `Semester ${v}` : '' }
    };

    function profileCompletion() {
        const p = getProfile();
        const keys = ['name', 'phone', 'regNo', 'college', 'branch', 'semester'];
        const done = keys.filter(k => k === 'name' ? !!displayName() : !!p[k]).length + (window.AuthManager?.user ? 1 : 0);
        return { done, total: keys.length + 1 };
    }

    function accountCard() {
        const user = window.AuthManager?.user;
        const name = displayName() || (user ? user.email.split('@')[0] : 'Guest');
        const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'G';
        const { done, total } = profileCompletion();
        const pct = Math.round(done / total * 100);

        return `
            <section class="pf-card pf-hero">
                <div class="pf-hero-avatar">${esc(initials)}</div>
                <h2 class="pf-hero-name">${esc(name)}</h2>
                <p class="pf-hero-sub">${user ? esc(user.email) : 'Guest · data saved on this device only'}</p>
                <span class="pf-status ${user ? 'ok' : 'guest'}">
                    <i class="fa-solid ${user ? 'fa-circle-check' : 'fa-mobile-screen'}"></i> ${user ? 'Signed in · synced to cloud' : 'Not signed in'}
                </span>
                ${pct < 100 ? `
                <div class="pf-complete">
                    <div class="pf-complete-head"><span>Profile ${pct}% complete</span><span>${done}/${total}</span></div>
                    <div class="pf-complete-bar"><i style="width:${pct}%"></i></div>
                </div>` : ''}
                <div class="pf-hero-actions">
                    ${user
                        ? `<button class="pf-btn" onclick="ProfilePage.syncNow(this)"><i class="fa-solid fa-rotate"></i> Sync now</button>`
                        : `<button class="pf-btn pf-btn-primary" onclick="ProfilePage.signIn()"><i class="fa-solid fa-right-to-bracket"></i> Sign in to sync</button>`}
                </div>
            </section>`;
    }

    // One "label / value" row that opens the editor
    function infoRow(key) {
        const f = FIELDS[key];
        const raw = key === 'name' ? displayName() : getProfile()[key];
        const shown = raw ? (f.show ? f.show(raw) : raw) : '';
        return `
            <button type="button" class="pf-info-row" onclick="ProfilePage.editField('${key}')">
                <span class="pf-info-icon"><i class="fa-solid ${f.icon}"></i></span>
                <span class="pf-info-text">
                    <span class="pf-info-label">${f.label}</span>
                    <span class="pf-info-value ${shown ? '' : 'empty'}">${shown ? esc(shown) : 'Add'}</span>
                </span>
                <i class="fa-solid fa-chevron-right pf-row-arrow"></i>
            </button>`;
    }

    function detailsCard() {
        return `
            <section class="pf-group" id="pfDetails">
                <h3 class="pf-group-label">Personal info</h3>
                <div class="pf-card pf-list">${['name', 'phone'].map(infoRow).join('')}</div>
            </section>
            <section class="pf-group">
                <h3 class="pf-group-label">Academic details</h3>
                <div class="pf-card pf-list">${['regNo', 'college', 'branch', 'semester'].map(infoRow).join('')}</div>
            </section>`;
    }

    function securityCard() {
        const user = window.AuthManager?.user;
        if (!user) {
            return `
                <section class="pf-group">
                    <h3 class="pf-group-label">Login & security</h3>
                    <div class="pf-card pf-security-guest">
                        <i class="fa-solid fa-lock"></i>
                        <div>
                            <strong>No account yet</strong>
                            <span>Create an account to add an email and password, and back up your data.</span>
                        </div>
                        <button class="pf-btn pf-btn-primary" onclick="ProfilePage.signIn()">Create account</button>
                    </div>
                </section>`;
        }
        const google = (user.app_metadata?.providers || [user.app_metadata?.provider]).includes('google');
        return `
            <section class="pf-group">
                <h3 class="pf-group-label">Login & security</h3>
                <div class="pf-card pf-list">
                    <button type="button" class="pf-info-row" onclick="ProfilePage.editEmail()">
                        <span class="pf-info-icon"><i class="fa-solid fa-envelope"></i></span>
                        <span class="pf-info-text">
                            <span class="pf-info-label">Email</span>
                            <span class="pf-info-value">${esc(user.email)}${user.email_confirmed_at ? ' <i class="fa-solid fa-circle-check pf-verified" title="Verified"></i>' : ''}</span>
                        </span>
                        <i class="fa-solid fa-chevron-right pf-row-arrow"></i>
                    </button>
                    <button type="button" class="pf-info-row" onclick="ProfilePage.editPassword()">
                        <span class="pf-info-icon"><i class="fa-solid fa-key"></i></span>
                        <span class="pf-info-text">
                            <span class="pf-info-label">Password</span>
                            <span class="pf-info-value">${google ? 'Set a password to also sign in with email' : '••••••••'}</span>
                        </span>
                        <i class="fa-solid fa-chevron-right pf-row-arrow"></i>
                    </button>
                </div>
            </section>`;
    }

    function classCard() {
        const name = currentClassName();
        if (!name) {
            return `
                <section class="pf-card pf-class pf-class-empty">
                    <div class="pf-class-icon"><i class="fa-solid fa-graduation-cap"></i></div>
                    <div class="pf-class-text">
                        <h3>No class yet</h3>
                        <p>Add your class, or scan a classmate's class QR code to import it.</p>
                    </div>
                    <div class="pf-class-actions">
                        <button class="pf-btn pf-btn-primary" onclick="ProfilePage.run('openAddClassModal')"><i class="fa-solid fa-plus"></i> Add class</button>
                        <button class="pf-btn" onclick="ProfilePage.run('openQRScanner')"><i class="fa-solid fa-camera"></i> Scan QR</button>
                    </div>
                </section>`;
        }
        const cls = classes[name];
        const mode = cls.timetableMode;
        const modeLabel = mode && window.TT_MODE_LABELS ? TT_MODE_LABELS[mode] : 'Timetable mode not set';
        const dates = [cls.portalSetup?.semesterStartDate ? fmtDate(cls.portalSetup.semesterStartDate) : null, cls.lastDate ? fmtDate(cls.lastDate) : null];
        return `
            <section class="pf-card pf-class">
                <div class="pf-class-icon"><i class="fa-solid fa-graduation-cap"></i></div>
                <div class="pf-class-text">
                    <span class="pf-overline">Current class</span>
                    <h3>${esc(name)}</h3>
                    <p>${(cls.subjects || []).length} subjects${dates[1] ? ` · ${dates[0] ? `${dates[0]} – ` : 'until '}${dates[1]}` : ''}</p>
                    <span class="pf-chip"><i class="fa-solid fa-calendar-week"></i> ${esc(modeLabel)}</span>
                </div>
                <div class="pf-quick">
                    <button onclick="ProfilePage.run('editSelectedClass')"><i class="fa-solid fa-pen-to-square"></i><span>Edit</span></button>
                    <button onclick="ProfilePage.run('openTimetablePage')"><i class="fa-solid fa-table-cells"></i><span>Timetable</span></button>
                    <button onclick="ProfilePage.run('openClassQR')"><i class="fa-solid fa-qrcode"></i><span>Class QR</span></button>
                    <button onclick="ProfilePage.run('openQRScanner')"><i class="fa-solid fa-camera"></i><span>Scan QR</span></button>
                </div>
            </section>`;
    }

    function render() {
        const root = document.getElementById('profileRoot');
        if (!root) return;
        const user = window.AuthManager?.user;
        const hasClass = !!currentClassName();
        const mode = hasClass ? classes[currentClassName()].timetableMode : null;
        const hasKey = !!localStorage.getItem('personalGeminiKey');

        const classRows = hasClass ? [
            row({ icon: 'fa-pen-to-square', tone: 'amber', title: 'Edit class', desc: 'Subjects, dates, holidays and timetable', action: "ProfilePage.run('editSelectedClass')" }),
            row({ icon: 'fa-calendar-week', tone: 'violet', title: 'Timetable mode', desc: mode && window.TT_MODE_LABELS ? TT_MODE_LABELS[mode] : 'Choose how your timetable works', action: "ProfilePage.run('TimetableModes.openModeEditor')" }),
            row({ icon: 'fa-graduation-cap', tone: 'green', title: 'Portal settings', desc: 'Baseline attendance and semester start', action: "ProfilePage.run('openPortalSetup')" }),
            row({ icon: 'fa-trash-can', tone: 'red', title: 'Delete class', desc: 'Remove this class and its attendance', action: "ProfilePage.run('deleteSelectedClass')", danger: true })
        ] : [
            row({ icon: 'fa-plus', tone: 'indigo', title: 'Add class', desc: 'Set up subjects, dates and timetable', action: "ProfilePage.run('openAddClassModal')" })
        ];

        const darkToggle = `<span class="pf-switch ${isDark() ? 'on' : ''}" role="switch" aria-checked="${isDark()}"><span></span></span>`;

        root.innerHTML = `
            <header class="pf-header">
                <h1>Profile & Settings</h1>
                <p>Manage your account, class and preferences</p>
            </header>

            ${accountCard()}
            ${detailsCard()}
            ${securityCard()}
            ${classCard()}

            ${group('Class', classRows)}

            ${currentClassName() ? group('Attendance tools', [
                row({ icon: 'fa-briefcase-medical', tone: 'cyan', title: 'Mark OD / Medical leave', desc: 'Mark every class between two dates at once', action: 'ProfileTools.openLeave()' }),
                row({ icon: 'fa-file-pen', tone: 'red', title: 'Exam days', desc: examDesc(), action: 'ProfileTools.openExams()' })
            ]) : ''}

            ${group('Preferences', [
                row({ icon: 'fa-briefcase-medical', tone: 'cyan', title: 'OD / ML rule', desc: window.ProfileTools ? ProfileTools.ruleSummary() : odmlDesc(), action: 'ProfileTools.openOdmlLimit()' }),
                row({ icon: 'fa-bullseye', tone: 'green', title: 'Minimum attendance required', desc: `${typeof getMinAttendanceCriteria === 'function' ? Math.round(getMinAttendanceCriteria() * 1000) / 10 : 75}% · used in every calculation`, action: 'ProfileTools.openMinAttendance()', trailing: `<span class="pf-value-pill">${typeof getMinAttendanceCriteria === 'function' ? Math.round(getMinAttendanceCriteria() * 1000) / 10 : 75}%</span><i class="fa-solid fa-chevron-right pf-row-arrow"></i>` }),
                row({ icon: 'fa-bell', tone: 'orange', title: 'Notifications', desc: 'Daily attendance reminders', action: "ProfilePage.run('showNotificationPermissionModal')" }),
                row({ icon: 'fa-moon', tone: 'slate', title: 'Dark mode', desc: isDark() ? 'On' : 'Off', action: 'ProfilePage.toggleTheme()', trailing: darkToggle }),
                row({ icon: 'fa-key', tone: 'violet', title: 'Gemini API key', desc: hasKey ? 'Personal key added' : 'Optional · for AI screenshot reading', action: "ProfilePage.run('openAPISettings')" })
            ])}

            ${group('Data & backup', [
                row({ icon: 'fa-download', tone: 'green', title: 'Backup data', desc: 'Download, share or copy a backup file', action: "ProfilePage.run('openBackupModal')" }),
                row({ icon: 'fa-upload', tone: 'cyan', title: 'Restore data', desc: 'Load a backup file', action: 'ProfilePage.restore()' })
            ])}

            ${group('Legal & info', LEGAL_LINKS.map(l => row({ icon: l.icon, tone: 'slate', title: l.title, href: l.href })))}

            ${group('Account', user ? [
                row({ icon: 'fa-right-from-bracket', tone: 'red', title: 'Sign out', desc: 'Your data stays synced to your account', action: 'ProfilePage.signOut()', danger: true }),
                row({ icon: 'fa-user-xmark', tone: 'red', title: 'Delete account', desc: 'Permanently delete your account and cloud data', action: 'ProfilePage.deleteAccount()', danger: true })
            ] : [
                row({ icon: 'fa-right-to-bracket', tone: 'indigo', title: 'Sign in or create account', desc: 'Back up and sync across devices', action: 'ProfilePage.signIn()' })
            ])}

            <footer class="pf-footer">
                <img src="icon-96x96.png" alt="" width="28" height="28">
                <span>Bunkit · Smart Attendance Manager</span>
                <span class="pf-credit">Developed by <strong>Faisal Khan and Sheikh Hemayoou</strong></span>
            </footer>`;
    }

    // --- Actions ---
    // Calls an app function by name (supports "Obj.method"); reports instead of failing silently
    function run(path) {
        const parts = path.split('.');
        let ctx = window, fn = window;
        for (const p of parts) { ctx = fn; fn = fn?.[p]; }
        if (typeof fn === 'function') {
            try { return fn.call(ctx); } catch (e) { console.error(`Profile action ${path} failed:`, e); }
        }
        if (typeof showToast === 'function') showToast('Not available right now', 'Please reload the app and try again', { duration: 3000 });
    }

    function toggleTheme() {
        const cb = document.getElementById('theme-checkbox');
        if (cb) {
            cb.checked = !isDark();
            cb.dispatchEvent(new Event('change')); // existing handler saves + syncs
        } else {
            const dark = !isDark();
            document.body.classList.toggle('dark-mode', dark);
            localStorage.setItem('theme', dark ? 'dark' : 'light');
        }
        render();
    }

    function restore() {
        const input = document.getElementById('restoreInput');
        if (input) input.click();
        else run('restoreData');
    }

    function signIn() {
        if (window.AuthManager) AuthManager.toggleLoginScreen(true);
    }

    async function syncNow(btn) {
        if (!window.SyncManager) return;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Syncing…'; }
        try {
            await SyncManager.syncOnLogin();
            if (typeof showToast === 'function') showToast('Synced', 'Your data is up to date', { duration: 2500 });
        } catch (e) {
            if (typeof showToast === 'function') showToast('Sync failed', 'Check your connection and try again', { duration: 3500 });
        }
        render();
    }

    function signOut() {
        if (!confirm('Sign out of Bunkit?\n\nYour data is synced to your account and will be restored when you sign in again.')) return;
        AuthManager.signOut();
    }

    function deleteAccount() {
        AuthManager.deleteAccount(); // has its own double confirmation
    }

    // ---------- Editor sheet ----------
    let sheetSave = null;

    function sheetEl() {
        let el = document.getElementById('pfSheet');
        if (!el) {
            el = document.createElement('div');
            el.id = 'pfSheet';
            el.className = 'pf-sheet-wrap';
            el.addEventListener('click', e => { if (e.target === el) closeSheet(); });
            el.addEventListener('keydown', e => {
                if (e.key === 'Escape') closeSheet();
                if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); el.querySelector('.pf-sheet-save')?.click(); }
            });
            document.body.appendChild(el);
        }
        return el;
    }

    function openSheet({ title, sub = '', body, saveLabel = 'Save', onSave }) {
        const el = sheetEl();
        el.classList.toggle('dark', isDark());
        el.innerHTML = `
            <div class="pf-sheet" role="dialog" aria-modal="true" aria-labelledby="pfSheetTitle">
                <div class="pf-sheet-grip"></div>
                <h3 id="pfSheetTitle">${title}</h3>
                ${sub ? `<p class="pf-sheet-sub">${sub}</p>` : ''}
                <div class="pf-sheet-body">${body}</div>
                <p class="pf-sheet-msg" id="pfSheetMsg" role="status"></p>
                <div class="pf-sheet-actions">
                    <button type="button" class="pf-btn" onclick="ProfilePage.closeSheet()">Cancel</button>
                    <button type="button" class="pf-btn pf-btn-primary pf-sheet-save" onclick="ProfilePage.submitSheet(this)">${saveLabel}</button>
                </div>
            </div>`;
        sheetSave = onSave;
        el.classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => { const i = el.querySelector('input, select'); if (i) { i.focus(); if (i.select && i.type !== 'tel') i.select(); } }, 120);
    }

    function closeSheet() {
        const el = document.getElementById('pfSheet');
        if (el) el.classList.remove('open');
        document.body.style.overflow = '';
        sheetSave = null;
    }

    function sheetMsg(text, ok) {
        const el = document.getElementById('pfSheetMsg');
        if (!el) return;
        el.textContent = text;
        el.className = 'pf-sheet-msg ' + (ok ? 'ok' : 'err');
    }

    async function submitSheet(btn) {
        if (!sheetSave) return;
        const label = btn.textContent;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        let keepOpen = false;
        try { keepOpen = await sheetSave(); } catch (e) { sheetMsg(e.message || 'Something went wrong. Try again.', false); keepOpen = true; }
        btn.disabled = false;
        btn.textContent = label;
        if (!keepOpen) closeSheet();
    }

    function input(id, f, value) {
        if (f.type === 'select') {
            return `<label class="pf-field"><span class="pf-field-label">${f.label}</span>
                <select id="${id}"><option value="">Select</option>${f.options.map(o => `<option value="${o}" ${String(value) === o ? 'selected' : ''}>Semester ${o}</option>`).join('')}</select></label>`;
        }
        return `<label class="pf-field"><span class="pf-field-label">${f.label}</span>
            <input id="${id}" type="${f.type}" value="${esc(value)}" placeholder="${esc(f.placeholder || '')}" maxlength="${f.max || 80}"
                ${f.auto ? `autocomplete="${f.auto}"` : ''} ${f.mode ? `inputmode="${f.mode}"` : ''}></label>`;
    }

    // Saves the profile locally and, when signed in, to the account
    async function persistProfile(profile) {
        localStorage.setItem('studentProfile', JSON.stringify(profile));
        if (profile.name) localStorage.setItem('userProfileName', profile.name);
        if (typeof updateNavAvatar === 'function') { try { updateNavAvatar(); } catch (e) { /* not ready */ } }
        if (typeof renderProfileHeader === 'function') { try { renderProfileHeader(); } catch (e) { /* not ready */ } }

        const user = window.AuthManager?.user;
        if (!user || !window.supabaseClient) return 'Saved on this device';
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
        try {
            await Promise.race([Promise.all([
                supabaseClient.auth.updateUser({ data: { full_name: profile.name || '', phone: profile.phone || '' } }),
                supabaseClient.from('profiles').update({ full_name: profile.name || '' }).eq('id', user.id)
            ]), timeout]);
            if (window.SyncManager) { try { SyncManager.uploadAll(); } catch (e) { /* offline */ } }
            return 'Saved and synced';
        } catch (e) {
            if (window.SyncManager) { try { SyncManager.uploadAll(); } catch (e2) { /* offline */ } }
            return 'Saved · will sync when you are back online';
        }
    }

    function toast(title, text) {
        if (typeof showToast === 'function') showToast(title, text, { duration: 2500 });
    }

    function editField(key) {
        const f = FIELDS[key];
        if (!f) return;
        const current = key === 'name' ? displayName() : (getProfile()[key] || '');
        openSheet({
            title: current ? `Edit ${f.label.toLowerCase()}` : `Add ${f.label.toLowerCase()}`,
            sub: f.help || '',
            body: input('pfSheetInput', f, current),
            onSave: async () => {
                let v = (document.getElementById('pfSheetInput')?.value || '').trim().replace(/\s+/g, ' ');
                if (f.normalize) v = f.normalize(v);
                if (f.required && !v) { sheetMsg(`${f.label} can't be empty.`, false); return true; }
                const err = f.validate ? f.validate(v) : '';
                if (err) { sheetMsg(err, false); return true; }
                if (v === current) return false;
                const profile = { ...getProfile(), [key]: v };
                if (key !== 'name' && !profile.name && displayName()) profile.name = displayName();
                const result = await persistProfile(profile);
                render();
                toast(`${f.label} ${v ? 'updated' : 'removed'}`, result);
                return false;
            }
        });
    }

    function editDetails() {
        document.getElementById('pfDetails')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function editEmail() {
        const user = window.AuthManager?.user;
        if (!user) return signIn();
        openSheet({
            title: 'Change email',
            sub: `Current: <strong>${esc(user.email)}</strong>. We'll send a confirmation link to the new address — the change completes when you open it.`,
            body: input('pfSheetInput', { label: 'New email', type: 'email', placeholder: 'name@example.com', auto: 'email', mode: 'email' }, ''),
            saveLabel: 'Send link',
            onSave: async () => {
                const email = (document.getElementById('pfSheetInput')?.value || '').trim().toLowerCase();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { sheetMsg('Enter a valid email address.', false); return true; }
                if (email === user.email.toLowerCase()) { sheetMsg('That is already your email.', false); return true; }
                if (!window.supabaseClient || !navigator.onLine) { sheetMsg("You're offline. Connect to the internet and try again.", false); return true; }
                const { error } = await supabaseClient.auth.updateUser({ email });
                if (error) { sheetMsg(error.message || 'Could not change email.', false); return true; }
                sheetMsg(`Confirmation link sent to ${email}. Open it to finish.`, true);
                setTimeout(closeSheet, 2500);
                return true;
            }
        });
    }

    function editPassword() {
        const user = window.AuthManager?.user;
        if (!user) return signIn();
        const pw = (id, label, auto) => `
            <label class="pf-field"><span class="pf-field-label">${label}</span>
                <span class="pf-pw">
                    <input id="${id}" type="password" autocomplete="${auto}" placeholder="At least 8 characters">
                    <button type="button" onclick="ProfilePage.togglePw('${id}', this)" aria-label="Show password"><i class="fa-regular fa-eye"></i></button>
                </span>
            </label>`;
        openSheet({
            title: 'Change password',
            sub: 'Use at least 8 characters with a mix of letters and numbers.',
            body: pw('pfNewPw', 'New password', 'new-password') + pw('pfNewPw2', 'Confirm new password', 'new-password') +
                '<div class="pf-strength"><i id="pfStrengthBar"></i></div><span class="pf-field-hint" id="pfStrengthText"></span>',
            saveLabel: 'Update password',
            onSave: async () => {
                const a = document.getElementById('pfNewPw')?.value || '';
                const b = document.getElementById('pfNewPw2')?.value || '';
                if (a.length < 8) { sheetMsg('Password must be at least 8 characters.', false); return true; }
                if (!/[A-Za-z]/.test(a) || !/\d/.test(a)) { sheetMsg('Use both letters and numbers.', false); return true; }
                if (a !== b) { sheetMsg("Passwords don't match.", false); return true; }
                if (!navigator.onLine) { sheetMsg("You're offline. Connect to the internet and try again.", false); return true; }
                const { error } = await AuthManager.updatePassword(a);
                if (error) { sheetMsg(error.message || 'Could not update password.', false); return true; }
                toast('Password updated', 'Use it next time you sign in');
                return false;
            }
        });
        const first = document.getElementById('pfNewPw');
        first?.addEventListener('input', () => {
            const v = first.value;
            const score = (v.length >= 8) + (v.length >= 12) + (/[a-z]/.test(v) && /[A-Z]/.test(v)) + /\d/.test(v) + /[^A-Za-z0-9]/.test(v);
            const levels = [['', 0], ['Weak', 25], ['Weak', 25], ['Fair', 50], ['Good', 75], ['Strong', 100]];
            const [word, w] = levels[score];
            const bar = document.getElementById('pfStrengthBar');
            if (bar) { bar.style.width = (v ? w : 0) + '%'; bar.dataset.level = word.toLowerCase(); }
            const t = document.getElementById('pfStrengthText');
            if (t) t.textContent = v ? `Strength: ${word}` : '';
        });
    }

    function togglePw(id, btn) {
        const el = document.getElementById(id);
        if (!el) return;
        const show = el.type === 'password';
        el.type = show ? 'text' : 'password';
        btn.innerHTML = `<i class="fa-regular ${show ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    }

    window.ProfilePage = {
        render, run, toggleTheme, restore, signIn, syncNow, signOut, deleteAccount,
        editDetails, editField, editEmail, editPassword, togglePw, closeSheet, submitSheet
    };

    // Keep the page current when it is visible
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && document.getElementById('accountPage')?.classList.contains('active')) render();
    });
})();
