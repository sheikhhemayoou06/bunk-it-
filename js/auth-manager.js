// Auth Manager - Handles Supabase Authentication

const AuthManager = {
    user: null,
    profile: null,

    isReady: false, // Track if initial check is done

    async init() {
        // if (!window.supabaseClient) return; // Allow running without Supabase for Guest Mode

        let session = null;

        // Check current session only if client is initialized
        if (window.supabaseClient) {
            const { data } = await supabaseClient.auth.getSession();
            session = data.session;
        }

        // Handle Login Screen
        if (session) {
            this.toggleLoginScreen(false);
            await this.updateUser(session.user); // Await this to ensure Sync starts before we say "Ready"
        } else {
            // If checking for guest mode preference
            const isGuest = localStorage.getItem('guest_mode_active');
            if (isGuest) {
                this.toggleLoginScreen(false);
                this.updateUser(null);
            } else {
                this.toggleLoginScreen(true);
                this.updateUser(null);
            }
        }

        this.isReady = true;
        window.dispatchEvent(new CustomEvent('auth-initialized', { detail: { user: this.user } }));

        // Listen for auth changes
        if (window.supabaseClient) {
            supabaseClient.auth.onAuthStateChange((_event, session) => {
                let wasGuest = false;
                if (session) {
                    this.toggleLoginScreen(false);
                    // Check if converting from Guest Mode
                    if (localStorage.getItem('guest_mode_active')) {
                        wasGuest = true;
                        localStorage.removeItem('guest_mode_active');
                    }
                } else {
                    // Determine if we should show login screen (e.g. after explicit sign out)
                }
                this.updateUser(session?.user, wasGuest);
            });
        }
    },


    toggleLoginScreen(show) {
        // GUARD: Block hiding the login screen if we are in the middle of a reset flow
        if (!show) {
            if (localStorage.getItem('pending_password_reset') === 'true' || window.isVerifyingOtp) {
                console.log('🔒 AuthManager.toggleLoginScreen blocked (Hide Mode) due to pending reset.');
                // HIDE Login Screen so Modal can be seen (Backdrop protects content)
                const screen = document.getElementById('loginScreen');
                if (screen) screen.style.display = 'none';
                return;
            }
        }

        const screen = document.getElementById('loginScreen');
        if (screen) screen.style.display = show ? 'flex' : 'none';
    },

    continueAsGuest() {
        this.toggleLoginScreen(false);
        this.updateUser(null, false);
        localStorage.setItem('guest_mode_active', 'true');
    },

    async signInWithGoogle() {
        if (!window.supabaseClient) return;
        const { data, error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin, // Redirect back to this page
            }
        });
        if (error) console.error('Google Sign-in mismatched:', error);
    },

    async updateUser(user, wasGuest = false) {
        this.user = user;
        if (user) {
            console.log('👤 Authorised as:', user.email);
            if (wasGuest) console.log('🔄 Converting from Guest Mode');

            document.body.classList.add('logged-in');
            document.body.classList.remove('guest-mode');

            // Try fetch profile
            this.fetchProfile();

            // Trigger Sync (Await it to prevent empty UI / Onboarding race condition)
            if (window.SyncManager) {
                // Show a temporary loading state if needed, or just rely on the sync status in sidebar
                // But for first load, we MUST wait.
                const loadingOverlay = document.createElement('div');
                loadingOverlay.id = 'authLoadingOverlay';
                loadingOverlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(255,255,255,0.9); z-index:9999; display:flex; justify-content:center; align-items:center; flex-direction:column; font-family:sans-serif;';
                loadingOverlay.innerHTML = '<div style="font-size:1.5rem; margin-bottom:10px;"><i class="fa-solid fa-cloud-arrow-down"></i></div><div>Syncing your data...</div>';
                document.body.appendChild(loadingOverlay);

                try {
                    await SyncManager.syncOnLogin(wasGuest);
                } catch (e) {
                    console.error("Sync failed on login:", e);
                } finally {
                    loadingOverlay.remove();
                    // Force reload the class list from the newly synced localStorage
                    if (window.loadClasses) window.loadClasses();
                    if (window.renderDashboard) window.renderDashboard();

                    // CRITICAL: Re-enforce Password Reset Modal if pending
                    if (window.enforceResetPasswordModal && localStorage.getItem('pending_password_reset') === 'true') {
                        console.log('🔄 Re-enforcing Password Reset after Sync');
                        window.enforceResetPasswordModal();
                    }

                    // Check for Onboarding (First time user or Empty State)
                    if (window.checkFirstLoginPrompt) {
                        setTimeout(() => window.checkFirstLoginPrompt(), 500);
                    }
                }
            }

            this.updateUI(true);
        } else {
            console.log('👤 Guest Mode');
            document.body.classList.remove('logged-in');
            document.body.classList.add('guest-mode');
            this.profile = null;
            this.updateUI(false);
        }
    },

    async fetchProfile() {
        if (!this.user) return;
        try {
            const { data, error } = await supabaseClient
                .from('profiles')
                .select('*')
                .eq('id', this.user.id)
                .single();

            if (data) {
                this.profile = data;
                // [NEW] Sync to LocalStorage for offline/onboarding consistency
                if (data.full_name) {
                    localStorage.setItem('userProfileName', data.full_name);
                }

                // Update UI with name/avatar if needed
                const nameDisplay = document.getElementById('sidebarUserName');
                if (nameDisplay && data.full_name) nameDisplay.textContent = data.full_name;

                const emailDisplay = document.getElementById('sidebarUserEmail');
                if (emailDisplay) emailDisplay.textContent = this.user.email;
            }
        } catch (e) {
            console.warn('Error fetching profile:', e);
        }
    },

    updateUI(isLoggedIn) {
        // Update Sidebar/Header buttons
        const loginBtn = document.getElementById('sidebarSignInBtn');
        const logoutBtn = document.getElementById('sidebarSignOutBtn');
        const syncStatus = document.getElementById('sidebarSyncStatus');

        // Update Guest Banner
        const guestBanner = document.getElementById('guestModeBanner');
        if (guestBanner) {
            const isGuest = localStorage.getItem('guest_mode_active');
            guestBanner.style.display = (!isLoggedIn && isGuest) ? 'block' : 'none';
        }

        if (isLoggedIn) {
            if (loginBtn) loginBtn.style.display = 'none';
            if (logoutBtn) logoutBtn.style.display = 'block';
            if (syncStatus) syncStatus.style.display = 'block';
        } else {
            if (loginBtn) loginBtn.style.display = 'block';
            if (logoutBtn) logoutBtn.style.display = 'none';
            if (syncStatus) syncStatus.style.display = 'none';
        }

        const deleteBtn = document.getElementById('sidebarDeleteBtn');
        if (deleteBtn) deleteBtn.style.display = isLoggedIn ? 'block' : 'none';

        // FORCE Global Sidebar Update (fixes Mobile Guest User issue)
        if (window.updateSidebarAccountUI) {
            window.updateSidebarAccountUI();
        }
    },

    async signIn(email, password) {
        if (!window.supabaseClient) return { error: { message: "Supabase not initialized" } };
        return await supabaseClient.auth.signInWithPassword({ email, password });
    },

    async signUp(email, password, fullName) {
        if (!window.supabaseClient) return { error: { message: "Supabase not initialized" } };

        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                data: { full_name: fullName }
            }
        });
        return { data, error };
    },

    async signOut() {
        if (!window.supabaseClient) return;

        // Sync before logout to prevent data loss
        if (window.SyncManager && this.user) {
            console.log('🔄 Syncing before logout...');

            // Show a visual indicator since this might take a second
            const logoutBtn = document.getElementById('sidebarSignOutBtn');
            if (logoutBtn) logoutBtn.textContent = 'Syncing...';

            try {
                // Wait for any pending saves in queue first
                if (window.SyncManager.syncPromise) {
                    await Promise.race([
                        window.SyncManager.syncPromise,
                        new Promise(resolve => setTimeout(resolve, 2000)) // 2s timeout for pending
                    ]);
                }

                // Force a final upload check with timeout
                await Promise.race([
                    window.SyncManager.uploadAll(),
                    new Promise(resolve => setTimeout(resolve, 5000)) // 5s max timeout for final sync
                ]);
            } catch (e) {
                console.warn('Logout sync warning:', e);
            }
        }

        // Remove guest mode flag just in case
        localStorage.removeItem('guest_mode_active');

        try {
            await supabaseClient.auth.signOut();
        } catch (e) {
            console.warn("Supabase sign out failed (Offline?):", e);
        } finally {
            // FORCE CLEAN RESET regardless of network
            window.location.reload();
        }
    },

    async sendPasswordReset(email) {
        if (!window.supabaseClient) return { error: { message: "Supabase not initialized" } };
        return await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + window.location.pathname + '?reset=true',
        });
    },

    async sendOtp(email) {
        if (!window.supabaseClient) return { error: { message: "Supabase not initialized" } };
        // Use signInWithOtp which sends a magic link or code
        return await supabaseClient.auth.signInWithOtp({ email });
    },

    async verifyOtp(email, token, type = 'email') {
        if (!window.supabaseClient) return { error: { message: "Supabase not initialized" } };
        return await supabaseClient.auth.verifyOtp({
            email,
            token,
            type
        });
    },

    async updatePassword(newPassword) {
        if (!window.supabaseClient) return { error: { message: "Supabase not initialized" } };
        return await supabaseClient.auth.updateUser({ password: newPassword });
    },

    async deleteAccount() {
        if (!window.supabaseClient || !this.user) return;

        if (!confirm("DANGER ZONE\n\nAre you sure you want to PERMANENTLY delete your account?\n\nThis will wipe all your synced classes, logs, and settings immediately. This action cannot be undone.")) {
            return;
        }

        if (!confirm("Final Confirmation: All your data will be lost forever.\n\nPress OK to delete everything.")) {
            return;
        }

        try {
            // Delete Profile -> Triggers CASCADE to delete Classes, Logs, Settings
            const { error } = await supabaseClient
                .from('profiles')
                .delete()
                .eq('id', this.user.id);

            if (error) throw error;

            alert("Account deleted without mercy. Goodbye!");
            await this.signOut();

        } catch (e) {
            console.error('Delete failed:', e);
            alert("Error deleting account: " + e.message);
        }
    }
};

// Global expose
window.continueAsGuest = () => AuthManager.continueAsGuest();
window.signInWithGoogle = () => AuthManager.signInWithGoogle();

// Auto-init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AuthManager.init());
} else {
    AuthManager.init();
}

window.AuthManager = AuthManager;

// Global Reset Password Enforcement (Moved here for early availability)
window.enforceResetPasswordModal = function () {
    const isPending = localStorage.getItem('pending_password_reset') === 'true';
    if (!isPending) return;

    if (window.resetModalEnforcer) clearInterval(window.resetModalEnforcer);
    console.log('🔒 Starting strict enforcement of Reset Password Modal');

    window.resetModalEnforcer = setInterval(() => {
        if (localStorage.getItem('pending_password_reset') !== 'true') {
            clearInterval(window.resetModalEnforcer);
            return;
        }

        const modal = document.getElementById('resetPasswordModal');
        if (window.showResetPasswordModal) {
            if (!modal || !modal.classList.contains('rp-visible') || modal.style.display === 'none') {
                console.log('🔒 Enforcing Reset Password Modal Visibility');
                window.showResetPasswordModal();
                if (modal) {
                    modal.style.display = 'flex';
                    modal.style.zIndex = '99999999';
                }
            }
        }

        const cancelBtns = document.querySelectorAll('#resetPasswordModal .fp-btn-cancel, #resetPasswordModal .close-btn');
        cancelBtns.forEach(btn => btn.style.display = 'none');
    }, 100);
};
