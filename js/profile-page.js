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

    function accountCard() {
        const user = window.AuthManager?.user;
        const profile = JSON.parse(localStorage.getItem('studentProfile') || '{}');
        const name = profile.name || user?.user_metadata?.full_name || localStorage.getItem('userProfileName') || (user ? user.email.split('@')[0] : 'Guest');
        const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'G';
        const meta = [profile.phone, profile.regNo, profile.branch, profile.semester ? `Sem ${profile.semester}` : '', profile.college].filter(Boolean).join(' · ');

        return `
            <section class="pf-card pf-account">
                <div class="pf-avatar">${esc(initials)}</div>
                <div class="pf-account-text">
                    <h2>${esc(name)}</h2>
                    <p>${user ? esc(user.email) : 'Guest · data is saved on this device only'}</p>
                    ${meta ? `<p class="pf-account-meta">${esc(meta)}</p>` : ''}
                    <span class="pf-status ${user ? 'ok' : 'guest'}">
                        <i class="fa-solid ${user ? 'fa-cloud' : 'fa-mobile-screen'}"></i> ${user ? 'Synced to cloud' : 'Not synced'}
                    </span>
                </div>
                <div class="pf-account-actions">
                    ${user
                        ? `<button class="pf-btn" onclick="ProfilePage.syncNow(this)"><i class="fa-solid fa-rotate"></i> Sync now</button>`
                        : `<button class="pf-btn pf-btn-primary" onclick="ProfilePage.signIn()"><i class="fa-solid fa-right-to-bracket"></i> Sign in to sync</button>`}
                    <button class="pf-btn" onclick="ProfilePage.editDetails()"><i class="fa-solid fa-pen"></i> Edit details</button>
                </div>
            </section>`;
    }

    function field(id, label, value, { type = 'text', placeholder = '', readonly = false, hint = '', attrs = '' } = {}) {
        return `
            <label class="pf-field">
                <span class="pf-field-label">${label}</span>
                <input id="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${readonly ? 'readonly' : ''} ${attrs}>
                ${hint ? `<span class="pf-field-hint">${hint}</span>` : ''}
            </label>`;
    }

    function detailsCard() {
        const user = window.AuthManager?.user;
        const p = JSON.parse(localStorage.getItem('studentProfile') || '{}');
        const name = p.name || user?.user_metadata?.full_name || localStorage.getItem('userProfileName') || '';
        const phone = p.phone || user?.user_metadata?.phone || '';
        return `
            <section class="pf-group" id="pfDetails">
                <h3 class="pf-group-label">Your details</h3>
                <div class="pf-card pf-form">
                    <div class="pf-form-grid">
                        ${field('pfName', 'Full name', name, { placeholder: 'e.g. Aarav Sharma', attrs: 'autocomplete="name" maxlength="60"' })}
                        ${field('pfPhone', 'Phone number', phone, { type: 'tel', placeholder: '10-digit mobile number', attrs: 'autocomplete="tel" inputmode="tel" maxlength="15"' })}
                        ${field('pfEmail', 'Email', user ? user.email : '', { type: 'email', readonly: true, placeholder: 'Sign in to add an email', hint: user ? 'Change it under Login & security' : 'Sign in to add an email and password' })}
                        ${field('pfRegNo', 'Registration no.', p.regNo || '', { placeholder: 'e.g. RA2111003010123', attrs: 'maxlength="30"' })}
                        ${field('pfCollege', 'College', p.college || '', { placeholder: 'Your college or university', attrs: 'maxlength="80"' })}
                        ${field('pfBranch', 'Branch / department', p.branch || '', { placeholder: 'e.g. CSE', attrs: 'maxlength="40"' })}
                        ${field('pfSemester', 'Semester', p.semester || '', { type: 'number', placeholder: 'e.g. 5', attrs: 'min="1" max="12" inputmode="numeric"' })}
                    </div>
                    <div class="pf-form-actions">
                        <span class="pf-form-msg" id="pfDetailsMsg"></span>
                        <button class="pf-btn pf-btn-primary" onclick="ProfilePage.saveDetails(this)"><i class="fa-solid fa-floppy-disk"></i> Save details</button>
                    </div>
                </div>
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
                            <span>Create an account to set your email and password, and back up your data.</span>
                        </div>
                        <button class="pf-btn pf-btn-primary" onclick="ProfilePage.signIn()">Create account</button>
                    </div>
                </section>`;
        }
        const pwField = (id, label) => `
            <label class="pf-field">
                <span class="pf-field-label">${label}</span>
                <span class="pf-pw">
                    <input id="${id}" type="password" autocomplete="new-password" minlength="6" placeholder="At least 6 characters">
                    <button type="button" onclick="ProfilePage.togglePw('${id}', this)" aria-label="Show password"><i class="fa-regular fa-eye"></i></button>
                </span>
            </label>`;
        return `
            <section class="pf-group">
                <h3 class="pf-group-label">Login & security</h3>
                <div class="pf-card pf-form">
                    <div class="pf-sec-row">
                        <div>
                            <span class="pf-field-label">Email</span>
                            <strong class="pf-sec-value">${esc(user.email)}</strong>
                        </div>
                        <button class="pf-btn" onclick="ProfilePage.toggleSection('pfEmailForm')"><i class="fa-solid fa-at"></i> Change email</button>
                    </div>
                    <div class="pf-sub-form" id="pfEmailForm" hidden>
                        ${field('pfNewEmail', 'New email', '', { type: 'email', placeholder: 'name@example.com', attrs: 'autocomplete="email"' })}
                        <div class="pf-form-actions">
                            <span class="pf-form-msg" id="pfEmailMsg"></span>
                            <button class="pf-btn pf-btn-primary" onclick="ProfilePage.changeEmail(this)">Send confirmation</button>
                        </div>
                    </div>

                    <div class="pf-sec-row">
                        <div>
                            <span class="pf-field-label">Password</span>
                            <strong class="pf-sec-value">••••••••</strong>
                        </div>
                        <button class="pf-btn" onclick="ProfilePage.toggleSection('pfPwForm')"><i class="fa-solid fa-key"></i> Change password</button>
                    </div>
                    <div class="pf-sub-form" id="pfPwForm" hidden>
                        <div class="pf-form-grid">
                            ${pwField('pfNewPw', 'New password')}
                            ${pwField('pfNewPw2', 'Confirm new password')}
                        </div>
                        <div class="pf-form-actions">
                            <span class="pf-form-msg" id="pfPwMsg"></span>
                            <button class="pf-btn pf-btn-primary" onclick="ProfilePage.changePassword(this)">Update password</button>
                        </div>
                    </div>
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

    function msg(id, text, ok) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        el.className = 'pf-form-msg ' + (ok ? 'ok' : 'err');
    }

    function val(id) {
        return (document.getElementById(id)?.value || '').trim();
    }

    function editDetails() {
        const sec = document.getElementById('pfDetails');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => document.getElementById('pfName')?.focus(), 300);
    }

    async function saveDetails(btn) {
        const name = val('pfName');
        const phoneRaw = val('pfPhone');
        const phone = phoneRaw.replace(/[\s-]/g, '');
        const semester = val('pfSemester');

        if (!name) return msg('pfDetailsMsg', 'Please enter your name.', false);
        if (phone && !/^(\+?\d{1,3})?\d{10}$/.test(phone)) return msg('pfDetailsMsg', 'Enter a valid 10-digit phone number.', false);
        if (semester && (!/^\d+$/.test(semester) || +semester < 1 || +semester > 12)) return msg('pfDetailsMsg', 'Semester must be between 1 and 12.', false);

        const profile = {
            ...JSON.parse(localStorage.getItem('studentProfile') || '{}'),
            name, phone,
            regNo: val('pfRegNo'),
            college: val('pfCollege'),
            branch: val('pfBranch'),
            semester
        };
        localStorage.setItem('studentProfile', JSON.stringify(profile));
        if (typeof updateNavAvatar === 'function') updateNavAvatar();
        localStorage.setItem('userProfileName', name);

        const user = window.AuthManager?.user;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }
        if (user && window.supabaseClient) {
            try {
                await supabaseClient.auth.updateUser({ data: { full_name: name, phone } });
                await supabaseClient.from('profiles').update({ full_name: name }).eq('id', user.id);
            } catch (e) { console.warn('Profile cloud update failed:', e); }
            if (window.SyncManager) { try { SyncManager.uploadAll(); } catch (e) { /* offline */ } }
        }
        if (typeof renderProfileHeader === 'function') { try { renderProfileHeader(); } catch (e) { /* dashboard not ready */ } }
        render();
        msg('pfDetailsMsg', user ? 'Saved and synced to your account.' : 'Saved on this device.', true);
    }

    function toggleSection(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.hidden = !el.hidden;
        if (!el.hidden) el.querySelector('input')?.focus();
    }

    function togglePw(id, btn) {
        const input = document.getElementById(id);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = `<i class="fa-regular ${show ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    }

    async function changeEmail(btn) {
        const email = val('pfNewEmail');
        const user = window.AuthManager?.user;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return msg('pfEmailMsg', 'Enter a valid email address.', false);
        if (user && email.toLowerCase() === user.email.toLowerCase()) return msg('pfEmailMsg', 'That is already your email.', false);
        if (!window.supabaseClient) return msg('pfEmailMsg', 'You are offline. Try again later.', false);
        btn.disabled = true;
        try {
            const { error } = await supabaseClient.auth.updateUser({ email });
            if (error) throw error;
            msg('pfEmailMsg', `Confirmation sent to ${email}. Open the link to finish the change.`, true);
        } catch (e) {
            msg('pfEmailMsg', e.message || 'Could not change email.', false);
        }
        btn.disabled = false;
    }

    async function changePassword(btn) {
        const pw = document.getElementById('pfNewPw')?.value || '';
        const pw2 = document.getElementById('pfNewPw2')?.value || '';
        if (pw.length < 6) return msg('pfPwMsg', 'Password must be at least 6 characters.', false);
        if (pw !== pw2) return msg('pfPwMsg', 'Passwords do not match.', false);
        btn.disabled = true;
        try {
            const { error } = await AuthManager.updatePassword(pw);
            if (error) throw error;
            document.getElementById('pfNewPw').value = '';
            document.getElementById('pfNewPw2').value = '';
            msg('pfPwMsg', 'Password updated.', true);
        } catch (e) {
            msg('pfPwMsg', e.message || 'Could not update password.', false);
        }
        btn.disabled = false;
    }

    window.ProfilePage = {
        render, run, toggleTheme, restore, signIn, syncNow, signOut, deleteAccount,
        editDetails, saveDetails, toggleSection, togglePw, changeEmail, changePassword
    };

    // Keep the page current when it is visible
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && document.getElementById('accountPage')?.classList.contains('active')) render();
    });
})();
