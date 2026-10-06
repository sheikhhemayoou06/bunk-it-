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

    // ============================================================
    // Instagram-style layout: main view + detail pages with a ⋯ menu
    // ============================================================
    let view = 'main';

    function overallStats() {
        let data = [];
        try {
            if (typeof currentAnalysisData !== 'undefined' && currentAnalysisData.length) data = currentAnalysisData;
            else if (window.SmartSearch?.computeClassAttendance) data = SmartSearch.computeClassAttendance() || [];
        } catch (e) { data = []; }
        let held = 0, eff = 0, skip = 0;
        data.forEach(sub => {
            try {
                const sp = attendanceSplit(sub.attended, sub.totalHeld, sub.odml, sub.remaining);
                const st = getSubjectAnalysis(sub.attended, sub.totalHeld, sub.remaining, null, sub.odml).stats;
                held += sp.totalHeld; eff += sp.withPct / 100 * sp.totalHeld;
                if (sp.totalHeld) skip += Math.max(0, st.maxSkippable);
            } catch (e) { /* ignore */ }
        });
        return { pct: held ? eff / held * 100 : null, subjects: data.length, skip };
    }

    // A read-only "label / value" line (editing lives in the ⋯ menu)
    function infoLine(icon, label, value, empty = 'Not added') {
        return `
            <div class="pf-info-row pf-static">
                <span class="pf-info-icon"><i class="fa-solid ${icon}"></i></span>
                <span class="pf-info-text">
                    <span class="pf-info-label">${label}</span>
                    <span class="pf-info-value ${value ? '' : 'muted'}">${value ? esc(value) : empty}</span>
                </span>
            </div>`;
    }
    function fieldLine(key) {
        const f = FIELDS[key];
        const raw = key === 'name' ? displayName() : getProfile()[key];
        return infoLine(f.icon, f.label, raw ? (f.show ? f.show(raw) : raw) : '');
    }

    // Menu entries on the main page → detail pages
    function navRow(id, icon, tone, title, desc) {
        return `<button type="button" class="pf-row" onclick="ProfilePage.go('${id}')">
            <span class="pf-row-icon pf-tone-${tone}"><i class="fa-solid ${icon}"></i></span>
            <span class="pf-row-text"><span class="pf-row-title">${title}</span>${desc ? `<span class="pf-row-desc">${desc}</span>` : ''}</span>
            <i class="fa-solid fa-chevron-right pf-row-arrow"></i>
        </button>`;
    }

    function renderMain() {
        const user = window.AuthManager?.user;
        const name = displayName() || (user ? user.email.split('@')[0] : 'Guest');
        const p = getProfile();
        const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'G';
        const handle = (displayName() || (user ? user.email.split('@')[0] : '') || p.regNo || 'student').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'student';
        const st = overallStats();
        const cls = currentClassName();
        const bio = [p.branch, p.semester ? `Semester ${p.semester}` : '', p.college].filter(Boolean).join(' · ');
        const { done, total } = profileCompletion();
        const hl = (icon, label, action) => `<button type="button" class="pf-hl" onclick="${action}"><span class="pf-hl-ring"><span class="pf-hl-in"><i class="fa-solid ${icon}"></i></span></span><span>${label}</span></button>`;

        return `
            <header class="pf-ig-top">
                <h1>${esc(handle)}${user ? ' <i class="fa-solid fa-circle-check pf-verified" title="Signed in"></i>' : ''}</h1>
                <button class="pf-dots" onclick="ProfilePage.menu('main')" aria-label="More options"><i class="fa-solid fa-ellipsis"></i></button>
            </header>

            <section class="pf-ig-head">
                <div class="pf-ig-avatar ${user ? 'ring' : ''}"><span>${esc(initials)}</span></div>
                <div class="pf-ig-stats">
                    <div><strong>${st.pct === null ? '—' : st.pct.toFixed(1) + '%'}</strong><span>Attendance</span></div>
                    <div><strong>${st.subjects}</strong><span>Subjects</span></div>
                    <div><strong>${st.pct === null ? '—' : st.skip}</strong><span>Can skip</span></div>
                </div>
            </section>
            <section class="pf-ig-bio">
                <strong>${esc(name)}</strong>
                ${p.regNo ? `<span>${esc(p.regNo)}</span>` : ''}
                ${bio ? `<span>${esc(bio)}</span>` : ''}
                ${cls ? `<span class="pf-ig-class"><i class="fa-solid fa-graduation-cap"></i> ${esc(cls)}</span>` : ''}
                <span class="pf-ig-sub">${user ? esc(user.email) : 'Guest · data saved on this device'}</span>
            </section>
            <div class="pf-ig-btns">
                <button class="pf-ig-btn" onclick="ProfilePage.go('personal')">Edit profile</button>
                <button class="pf-ig-btn" onclick="${cls ? "ProfilePage.run('openClassQR')" : "ProfilePage.run('openAddClassModal')"}">${cls ? 'Share class' : 'Add class'}</button>
                ${user ? `<button class="pf-ig-btn pf-ig-icon" onclick="ProfilePage.syncNow(this)" aria-label="Sync now"><i class="fa-solid fa-rotate"></i></button>`
                       : `<button class="pf-ig-btn pf-ig-primary" onclick="ProfilePage.signIn()">Sign in</button>`}
            </div>
            ${done < total ? `<button class="pf-ig-complete" onclick="ProfilePage.go('personal')"><span>Complete your profile</span><b>${done}/${total}</b><i style="--w:${Math.round(done / total * 100)}%"></i></button>` : ''}

            <div class="pf-hls">
                ${hl('fa-table-cells', 'Timetable', "ProfilePage.run('openTimetablePage')")}
                ${cls ? hl('fa-qrcode', 'Class QR', "ProfilePage.run('openClassQR')") : ''}
                ${hl('fa-camera', 'Scan QR', "ProfilePage.run('openQRScanner')")}
                ${hl('fa-wand-magic-sparkles', 'Ask', "switchPage('smartSearchPage')")}
                ${hl('fa-bell', 'Alerts', "window.NotificationCenter && NotificationCenter.open()")}
            </div>

            <section class="pf-group">
                <h3 class="pf-group-label">Your account</h3>
                <div class="pf-card pf-list">
                    ${navRow('personal', 'fa-user', 'indigo', 'Personal details', 'Name, phone number')}
                    ${navRow('academic', 'fa-id-card', 'blue', 'Academic details', 'Registration no., college, branch, semester')}
                    ${navRow('security', 'fa-shield-halved', 'green', 'Login & security', user ? 'Email, password' : 'Create an account')}
                </div>
            </section>
            <section class="pf-group">
                <h3 class="pf-group-label">Class & attendance</h3>
                <div class="pf-card pf-list">
                    ${navRow('class', 'fa-graduation-cap', 'amber', 'Class', cls ? esc(cls) : 'No class yet')}
                    ${cls ? navRow('tools', 'fa-briefcase-medical', 'cyan', 'Attendance tools', 'OD / Medical leave, exam days') : ''}
                </div>
            </section>
            <section class="pf-group">
                <h3 class="pf-group-label">App</h3>
                <div class="pf-card pf-list">
                    ${navRow('prefs', 'fa-sliders', 'violet', 'Preferences', 'Minimum %, OD/ML rule, notifications, theme')}
                    ${navRow('data', 'fa-cloud-arrow-down', 'green', 'Data & backup', 'Backup and restore')}
                    ${navRow('legal', 'fa-circle-info', 'slate', 'Legal & info', 'About, FAQ, privacy, terms')}
                </div>
            </section>
            <section class="pf-group">
                <div class="pf-card pf-list">
                    ${user
                        ? row({ icon: 'fa-right-from-bracket', tone: 'red', title: 'Sign out', action: 'ProfilePage.signOut()', danger: true })
                        : row({ icon: 'fa-right-to-bracket', tone: 'indigo', title: 'Sign in or create account', desc: 'Back up and sync across devices', action: 'ProfilePage.signIn()' })}
                </div>
            </section>
            <footer class="pf-footer">
                <img src="icon-96x96.png" alt="" width="28" height="28">
                <span>Bunkit · Smart Attendance Manager</span>
                <span class="pf-credit">Developed by <strong>Faisal Khan and Sheikh Hemayoou</strong></span>
            </footer>`;
    }

    const PAGES = {
        personal: { title: 'Personal details', body: () => `
            <div class="pf-card pf-list">${fieldLine('name')}${fieldLine('phone')}</div>
            <p class="pf-page-note">Tap <i class="fa-solid fa-ellipsis"></i> to edit your details.</p>` },
        academic: { title: 'Academic details', body: () => `
            <div class="pf-card pf-list">${['regNo', 'college', 'branch', 'semester'].map(fieldLine).join('')}</div>
            <p class="pf-page-note">Tap <i class="fa-solid fa-ellipsis"></i> to edit.</p>` },
        security: { title: 'Login & security', body: () => {
            const user = window.AuthManager?.user;
            if (!user) return `<div class="pf-card pf-security-guest"><i class="fa-solid fa-lock"></i><div><strong>No account yet</strong><span>Create an account to add an email and password, and back up your data.</span></div><button class="pf-btn pf-btn-primary" onclick="ProfilePage.signIn()">Create account</button></div>`;
            const google = (user.app_metadata?.providers || [user.app_metadata?.provider]).includes('google');
            return `<div class="pf-card pf-list">
                ${infoLine('fa-envelope', 'Email', user.email + (user.email_confirmed_at ? ' ✓' : ''))}
                ${infoLine('fa-key', 'Password', google ? 'Signed in with Google' : '••••••••')}
                ${infoLine('fa-calendar', 'Member since', user.created_at ? fmtDate(user.created_at.slice(0, 10)) : '')}
            </div>
            <p class="pf-page-note">Tap <i class="fa-solid fa-ellipsis"></i> to change your email or password.</p>
            <section class="pf-group"><div class="pf-card pf-list">${row({ icon: 'fa-user-xmark', tone: 'red', title: 'Delete account', desc: 'Permanently delete your account and cloud data', action: 'ProfilePage.deleteAccount()', danger: true })}</div></section>`;
        } },
        class: { title: 'Class', body: () => {
            const name = currentClassName();
            if (!name) return `<div class="pf-card pf-empty-card"><i class="fa-solid fa-graduation-cap"></i><strong>No class yet</strong><span>Add your class or scan a classmate's class QR.</span>
                <div class="pf-empty-btns"><button class="pf-btn pf-btn-primary" onclick="ProfilePage.run('openAddClassModal')">Add class</button><button class="pf-btn" onclick="ProfilePage.run('openQRScanner')">Scan QR</button></div></div>`;
            const c = classes[name];
            const mode = c.timetableMode && window.TT_MODE_LABELS ? TT_MODE_LABELS[c.timetableMode] : 'Not set';
            return `<div class="pf-card pf-list">
                ${infoLine('fa-graduation-cap', 'Class name', name)}
                ${infoLine('fa-book', 'Subjects', `${(c.subjects || []).length} subjects`)}
                ${infoLine('fa-calendar-day', 'Semester', c.lastDate ? `${c.portalSetup?.semesterStartDate ? fmtDate(c.portalSetup.semesterStartDate) : 'Start not set'} → ${fmtDate(c.lastDate)}` : '')}
                ${infoLine('fa-calendar-week', 'Timetable mode', mode)}
            </div>
            <section class="pf-group"><div class="pf-card pf-list">
                ${row({ icon: 'fa-table-cells', tone: 'indigo', title: 'Timetable & class timings', action: "ProfilePage.run('openTimetablePage')" })}
                ${row({ icon: 'fa-graduation-cap', tone: 'green', title: 'Portal settings', desc: 'Baseline attendance and semester start', action: "ProfilePage.run('openPortalSetup')" })}
            </div></section>
            <p class="pf-page-note">Tap <i class="fa-solid fa-ellipsis"></i> to edit, share or delete this class.</p>`;
        } },
        tools: { title: 'Attendance tools', body: () => `<div class="pf-card pf-list">
            ${row({ icon: 'fa-briefcase-medical', tone: 'cyan', title: 'Mark OD / Medical leave', desc: 'Mark every class between two dates at once', action: 'ProfileTools.openLeave()' })}
            ${row({ icon: 'fa-file-pen', tone: 'red', title: 'Exam days', desc: examDesc(), action: 'ProfileTools.openExams()' })}
        </div>` },
        prefs: { title: 'Preferences', body: () => {
            const minPct = typeof getMinAttendanceCriteria === 'function' ? Math.round(getMinAttendanceCriteria() * 1000) / 10 : 75;
            const hasKey = !!localStorage.getItem('personalGeminiKey');
            const darkToggle = `<span class="pf-switch ${isDark() ? 'on' : ''}" role="switch" aria-checked="${isDark()}"><span></span></span>`;
            return `<div class="pf-card pf-list">
                ${row({ icon: 'fa-bullseye', tone: 'green', title: 'Minimum attendance required', desc: 'Used in every calculation', action: 'ProfileTools.openMinAttendance()', trailing: `<span class="pf-value-pill">${minPct}%</span><i class="fa-solid fa-chevron-right pf-row-arrow"></i>` })}
                ${row({ icon: 'fa-briefcase-medical', tone: 'cyan', title: 'OD / ML rule', desc: window.ProfileTools ? ProfileTools.ruleSummary() : odmlDesc(), action: 'ProfileTools.openOdmlLimit()' })}
                ${row({ icon: 'fa-bell', tone: 'orange', title: 'Notifications', desc: 'Daily and after-class reminders', action: "ProfilePage.run('showNotificationPermissionModal')" })}
                ${row({ icon: 'fa-moon', tone: 'slate', title: 'Dark mode', desc: isDark() ? 'On' : 'Off', action: 'ProfilePage.toggleTheme()', trailing: darkToggle })}
                ${row({ icon: 'fa-key', tone: 'violet', title: 'Gemini API key', desc: hasKey ? 'Personal key added' : 'Optional · for AI screenshot reading', action: "ProfilePage.run('openAPISettings')" })}
            </div>`;
        } },
        data: { title: 'Data & backup', body: () => `<div class="pf-card pf-list">
            ${row({ icon: 'fa-download', tone: 'green', title: 'Backup data', desc: 'Download, share or copy a backup file', action: "ProfilePage.run('openBackupModal')" })}
            ${row({ icon: 'fa-upload', tone: 'cyan', title: 'Restore data', desc: 'Load a backup file', action: 'ProfilePage.restore()' })}
        </div>` },
        legal: { title: 'Legal & info', body: () => `<div class="pf-card pf-list">${LEGAL_LINKS.map(l => row({ icon: l.icon, tone: 'slate', title: l.title, href: l.href })).join('')}</div>` }
    };

    // ⋯ menu entries for each page
    function menuItems(page) {
        const user = window.AuthManager?.user;
        const cls = currentClassName();
        const p = getProfile();
        switch (page) {
            case 'main': return [
                { icon: 'fa-pen', label: 'Edit profile', fn: () => go('personal') },
                cls && { icon: 'fa-qrcode', label: 'Share class QR', fn: () => run('openClassQR') },
                { icon: 'fa-moon', label: isDark() ? 'Switch to light mode' : 'Switch to dark mode', fn: () => toggleTheme() },
                { icon: 'fa-sliders', label: 'Settings', fn: () => go('prefs') },
                user ? { icon: 'fa-right-from-bracket', label: 'Sign out', fn: () => signOut(), danger: true }
                     : { icon: 'fa-right-to-bracket', label: 'Sign in', fn: () => signIn() }
            ];
            case 'personal': return [
                { icon: 'fa-user', label: displayName() ? 'Edit full name' : 'Add full name', fn: () => editField('name') },
                { icon: 'fa-phone', label: p.phone ? 'Edit phone number' : 'Add phone number', fn: () => editField('phone') },
                p.phone && { icon: 'fa-trash-can', label: 'Remove phone number', fn: () => clearField('phone'), danger: true }
            ];
            case 'academic': return [
                { icon: 'fa-id-card', label: 'Edit registration number', fn: () => editField('regNo') },
                { icon: 'fa-building-columns', label: 'Edit college / university', fn: () => editField('college') },
                { icon: 'fa-sitemap', label: 'Edit branch / department', fn: () => editField('branch') },
                { icon: 'fa-layer-group', label: 'Edit semester', fn: () => editField('semester') }
            ];
            case 'security': return user ? [
                { icon: 'fa-envelope', label: 'Change email', fn: () => editEmail() },
                { icon: 'fa-key', label: 'Change password', fn: () => editPassword() },
                { icon: 'fa-user-xmark', label: 'Delete account', fn: () => deleteAccount(), danger: true }
            ] : [{ icon: 'fa-right-to-bracket', label: 'Create account / sign in', fn: () => signIn() }];
            case 'class': return cls ? [
                { icon: 'fa-pen-to-square', label: 'Edit class', fn: () => run('editSelectedClass') },
                { icon: 'fa-calendar-week', label: 'Timetable mode', fn: () => run('TimetableModes.openModeEditor') },
                { icon: 'fa-qrcode', label: 'Share class QR', fn: () => run('openClassQR') },
                { icon: 'fa-trash-can', label: 'Delete class', fn: () => run('deleteSelectedClass'), danger: true }
            ] : [
                { icon: 'fa-plus', label: 'Add class', fn: () => run('openAddClassModal') },
                { icon: 'fa-camera', label: 'Scan class QR', fn: () => run('openQRScanner') }
            ];
            case 'data': return [
                { icon: 'fa-download', label: 'Backup now', fn: () => run('openBackupModal') },
                { icon: 'fa-upload', label: 'Restore from file', fn: () => restore() }
            ];
            default: return [];
        }
    }

    let menuFns = [];
    function menu(page) {
        const items = menuItems(page).filter(Boolean);
        if (!items.length) return;
        menuFns = items.map(i => i.fn);
        let el = document.getElementById('pfMenu');
        if (!el) {
            el = document.createElement('div');
            el.id = 'pfMenu';
            el.className = 'pf-sheet-wrap pf-menu-wrap';
            el.addEventListener('click', e => { if (e.target === el) closeMenu(); });
            document.body.appendChild(el);
        }
        el.classList.toggle('dark', isDark());
        el.innerHTML = `
            <div class="pf-sheet pf-menu" role="menu">
                <div class="pf-sheet-grip"></div>
                ${items.map((it, i) => `<button type="button" class="pf-menu-item ${it.danger ? 'danger' : ''}" role="menuitem" onclick="ProfilePage._pick(${i})"><i class="fa-solid ${it.icon}"></i><span>${esc(it.label)}</span></button>`).join('')}
                <button type="button" class="pf-menu-item pf-menu-cancel" onclick="ProfilePage.closeMenu()">Cancel</button>
            </div>`;
        el.classList.add('open');
    }
    function closeMenu() { document.getElementById('pfMenu')?.classList.remove('open'); }
    function pick(i) { closeMenu(); const fn = menuFns[i]; if (fn) setTimeout(fn, 160); }

    async function clearField(key) {
        const profile = { ...getProfile(), [key]: '' };
        const result = await persistProfile(profile);
        render();
        toast(`${FIELDS[key].label} removed`, result);
    }

    function go(page) {
        view = PAGES[page] ? page : 'main';
        render();
        document.getElementById('accountPage')?.scrollIntoView({ block: 'start' });
        window.scrollTo(0, 0);
    }

    function render() {
        const root = document.getElementById('profileRoot');
        if (!root) return;
        if (view !== 'main' && PAGES[view]) {
            const pg = PAGES[view];
            const hasMenu = menuItems(view).filter(Boolean).length > 0;
            root.innerHTML = `
                <div class="pf-subpage">
                    <header class="pf-sub-top">
                        <button class="pf-dots" onclick="ProfilePage.go('main')" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
                        <h1>${pg.title}</h1>
                        ${hasMenu ? `<button class="pf-dots" onclick="ProfilePage.menu('${view}')" aria-label="More options"><i class="fa-solid fa-ellipsis"></i></button>` : '<span class="pf-dots-ph"></span>'}
                    </header>
                    <div class="pf-sub-body">${pg.body()}</div>
                </div>`;
            return;
        }
        root.innerHTML = `<div class="pf-mainview">${renderMain()}</div>`;
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

    function editDetails() { go('personal'); }

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
        editDetails, editField, editEmail, editPassword, togglePw, closeSheet, submitSheet,
        go, menu, closeMenu, _pick: pick
    };

    // Keep the page current when it is visible
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && document.getElementById('accountPage')?.classList.contains('active')) render();
    });
})();
