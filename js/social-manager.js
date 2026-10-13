/**
 * social-manager.js
 * Handles Mass Bunk Prediction, Polling, and Class Update Propagation.
 */

const SocialManager = {
    _debounceTimers: {},

    // --- UTILS ---
    debounce(key, func, delay) {
        if (this._debounceTimers[key]) clearTimeout(this._debounceTimers[key]);
        this._debounceTimers[key] = setTimeout(func, delay);
    },

    // --- SHARED ID GENERATION ---
    async generateSharedClassId(classData) {
        if (!classData || !classData.subjects) return null;

        // 1. Timetable Fingerprint (Code + Schedule)
        // Normalize codes to Upper Case to prevent case-sensitivity fragmentation
        const subjects = classData.subjects || [];
        const validSubjects = subjects.filter(s => s.code && s.name);

        // Sort by Code to ensure order independence
        validSubjects.sort((a, b) => a.code.localeCompare(b.code));

        const timetableStr = validSubjects.map(s => {
            // Trim and Uppercase code
            const code = s.code ? s.code.trim().toUpperCase() : '';
            return `${code}:${JSON.stringify(s.schedule || [])}`;
        }).join('|');

        // 2. Meta Fingerprint
        const startDate = classData.startDate || '';
        const lastDate = classData.lastDate || '';
        const holidays = (classData.holidays || []).sort().join(',');

        // 3. Final String
        const fingerPrint = `${timetableStr}||${startDate}||${lastDate}||${holidays}`;

        // 4. Hash (SHA-256)
        const msgBuffer = new TextEncoder().encode(fingerPrint);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        return hashHex.substring(0, 16); // 16 chars is enough entropy
    },

    // --- ELIGIBILITY CHECK ---
    checkComparisonEligibility(classData) {
        if (!classData) return { eligible: false, reason: "No class selected" };

        // 1. Portal Mode Check
        if (!classData.portalSetup || !classData.portalSetup.active) {
            return { eligible: false, reason: "Enable Portal Mode to participate" };
        }

        // 2. Complete Logs Check
        // We use the helper from index.html if available, or re-implement simple check
        if (typeof window.checkIncompleteLogs === 'function') {
            const logStatus = window.checkIncompleteLogs();
            if (logStatus.hasGap) {
                return { eligible: false, reason: `Complete logs! (${logStatus.daysBehind} days missing)` };
            }
        }

        return { eligible: true };
    },

    // --- MASS BUNK PREDICTION ---
    async updateDailyStatus(classData) {
        // Debounce to prevent database spam on rapid input
        this.debounce('updateStatus', async () => {
            const eligibility = this.checkComparisonEligibility(classData);
            if (!eligibility.eligible) return; // Don't sync if not eligible

            const sharedId = classData.sharedId;
            if (!sharedId) return;

            // Calculate "Can I Skip Today?"
            const canSkipAllToday = await this.calculateSkipAllImpact(classData);

            // Push to Supabase
            if (window.supabase) {
                const today = new Date().toISOString().split('T')[0];
                const userId = (await window.supabase.auth.getUser()).data.user?.id;

                if (userId) {
                    const { error } = await window.supabase
                        .from('daily_class_status')
                        .upsert({
                            shared_class_id: sharedId,
                            user_id: userId,
                            date: today,
                            can_mass_bunk: canSkipAllToday,
                            updated_at: new Date()
                        }, { onConflict: 'user_id, date, shared_class_id' }); // key columns

                    if (error) console.error("Error updating daily status:", error);
                }
            }
        }, 2000); // 2 second delay
    },

    async calculateSkipAllImpact(classData) {
        // Placeholder until we can hook deeply into 'currentAnalysisData'
        if (window.currentAnalysisData) {
            return false;
        }
        return false;
    },

    // --- POLLING SYSTEM ---
    async initiatePoll(sharedId) {
        if (!navigator.onLine) {
            alert("You seem to be offline.\nPlease connect to the internet to start a poll.");
            return;
        }

        if (!window.supabaseClient) {
            console.error("Supabase client not initialized");
            return;
        }

        const today = new Date().toISOString().split('T')[0];

        // CHECK FOR EXISTING POLL
        const { data: existing, error: checkError } = await window.supabaseClient
            .from('mass_bunk_polls')
            .select('id')
            .eq('shared_class_id', sharedId)
            .eq('date', today)
            .limit(1);

        if (checkError) {
            console.error("Error checking existing polls:", checkError);
            alert("Cloud Error: Could not check for existing polls.");
            return;
        }

        if (existing && existing.length > 0) {
            alert("A poll for today already exists!");
            return;
        }

        const userId = (await window.supabaseClient.auth.getUser()).data.user?.id;
        const { error } = await window.supabaseClient
            .from('mass_bunk_polls')
            .insert([{
                shared_class_id: sharedId,
                date: today,
                initiator_uid: userId
            }]);

        if (error) {
            alert("Failed to start poll: " + error.message);
        } else {
            alert("Mass Bunk Poll Started! Your classmates will be notified.");
        }
    },

    async voteOnPoll(pollId, vote) {
        if (!navigator.onLine) {
            const btn = event.target;
            const originalText = btn.innerText;
            btn.innerText = "Offline";
            setTimeout(() => btn.innerText = originalText, 2000);
            return;
        }

        if (window.supabaseClient) {
            const userId = (await window.supabaseClient.auth.getUser()).data.user?.id;

            const { error } = await window.supabaseClient
                .from('mass_bunk_votes')
                .upsert({
                    poll_id: pollId,
                    user_id: userId,
                    vote: vote,
                    updated_at: new Date()
                });

            if (error) {
                console.error("Vote failed:", error);
                alert("Vote failed. Please try again.");
            }
        }
    },

    // --- CLASS UPDATE PROPAGATION ---
    async proposeUpdate(oldSharedId, newSharedId, fullClassData, summary) {
        if (!window.supabase) return;

        // Confirm Action
        if (!confirm("This edit changes the class version.\n\nDo you want to notify your classmates so they can update too?")) {
            return;
        }

        const userId = (await window.supabase.auth.getUser()).data.user?.id;

        await window.supabase.from('class_updates').insert([{
            old_shared_id: oldSharedId,
            new_shared_id: newSharedId,
            editor_uid: userId,
            changes_summary: summary || {},
            full_class_data: fullClassData
        }]);

        alert("Update notification sent to classmates!");
    },

    async checkForClassUpdates(currentSharedId, currentClassObj) {
        this.debounce('checkUpdates', async () => {
            if (!currentSharedId || !window.supabase) return;

            // Check for updates targeting THIS shared ID
            const { data, error } = await window.supabase
                .from('class_updates')
                .select('*')
                .eq('old_shared_id', currentSharedId)
                .order('created_at', { ascending: false })
                .limit(1);

            if (data && data.length > 0) {
                const update = data[0];
                const userId = (await window.supabase.auth.getUser()).data.user?.id;

                // Show only if I'm not the editor
                if (update.editor_uid !== userId) {
                    this.showUpdateProposalModal(update, currentClassObj);
                }
            }
        }, 5000); // Check every 5s max (or on load)
    },

    showUpdateProposalModal(update, currentClass) {
        // Prevent dupes
        if (document.getElementById('updateProposalModal')) return;

        const diffHtml = this.generateDiffHtml(currentClass, update.full_class_data);

        const modal = document.createElement('div');
        modal.id = 'updateProposalModal';
        modal.className = 'modal';
        modal.style.display = 'flex'; // Force open
        modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px; border-left: 5px solid var(--primary-grad-start);">
            <div class="modal-header">
                <h2>Class Update Available</h2>
                <p>A classmate has updated the class details.</p>
            </div>
            <div style="background: var(--light-bg); padding: 15px; border-radius: 8px; margin: 15px 0;">
                <p><strong>Version Change:</strong></p>
                <div style="font-family: monospace; font-size: 0.85rem; color: var(--medium-text); margin-bottom:10px;">
                    ${update.old_shared_id.substring(0, 8)}... ➔ ${update.new_shared_id.substring(0, 8)}...
                </div>
                
                <h4 style="margin: 0 0 8px 0; font-size: 0.95rem;">Changes Detected:</h4>
                <div style="max-height: 300px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 4px; background: #fff;">
                    ${diffHtml}
                </div>
            </div>
            <div class="form-actions">
                <button class="btn success-btn" onclick="SocialManager.applyClassUpdate('${update.id}')">Apply Changes</button>
                <button class="btn secondary-btn" onclick="document.getElementById('updateProposalModal').remove()">Ignore</button>
            </div>
        </div>`;
        document.body.appendChild(modal);
        // Store update data temporarily
        window._pendingClassUpdate = update;
    },

    generateDiffHtml(oldClass, newClass) {
        if (!oldClass || !newClass) return '<div>Cannot compare: Missing data</div>';

        let html = '<table style="width:100%; border-collapse:collapse; font-size:0.85rem;">';
        html += '<thead style="background:#f5f5f5;"><tr><th style="text-align:left; padding:6px;">Field</th><th style="text-align:left; padding:6px;">Yours (Old)</th><th style="text-align:left; padding:6px;">Update (New)</th></tr></thead><tbody>';

        let hasChanges = false;
        const rowStyle = 'border-bottom:1px solid #eee;';
        const cellStyle = 'padding:6px; vertical-align:top;';
        const diffStyle = 'background:rgba(46, 204, 113, 0.1); color:#1d8348;'; // Green highlight for new

        // 1. Dates
        if (oldClass.startDate !== newClass.startDate) {
            html += `<tr style="${rowStyle}"><td style="${cellStyle}"><strong>Start Date</strong></td><td style="${cellStyle}">${oldClass.startDate || '-'}</td><td style="${cellStyle} ${diffStyle}">${newClass.startDate || '-'}</td></tr>`;
            hasChanges = true;
        }
        if (oldClass.lastDate !== newClass.lastDate) {
            html += `<tr style="${rowStyle}"><td style="${cellStyle}"><strong>End Date</strong></td><td style="${cellStyle}">${oldClass.lastDate || '-'}</td><td style="${cellStyle} ${diffStyle}">${newClass.lastDate || '-'}</td></tr>`;
            hasChanges = true;
        }

        // 2. Holidays
        const oldHolidays = (oldClass.holidays || []).sort().join(', ');
        const newHolidays = (newClass.holidays || []).sort().join(', ');
        if (oldHolidays !== newHolidays) {
            const oldLen = (oldClass.holidays || []).length;
            const newLen = (newClass.holidays || []).length;
            html += `<tr style="${rowStyle}"><td style="${cellStyle}"><strong>Holidays</strong></td><td style="${cellStyle}">${oldLen} dates</td><td style="${cellStyle} ${diffStyle}">${newLen} dates<br><small>Check holiday list after applying</small></td></tr>`;
            hasChanges = true;
        }

        // 3. Subjects & Timetable
        // Simple count check first
        const oldSubCount = (oldClass.subjects || []).length;
        const newSubCount = (newClass.subjects || []).length;

        if (oldSubCount !== newSubCount) {
            html += `<tr style="${rowStyle}"><td style="${cellStyle}"><strong>Subjects</strong></td><td style="${cellStyle}">${oldSubCount} Subjects</td><td style="${cellStyle} ${diffStyle}">${newSubCount} Subjects</td></tr>`;
            hasChanges = true;
        }

        // Check schedule/code changes if counts match
        else if (JSON.stringify(oldClass.subjects) !== JSON.stringify(newClass.subjects)) {
            html += `<tr style="${rowStyle}"><td style="${cellStyle}"><strong>Timetable</strong></td><td style="${cellStyle}">Current Schedule</td><td style="${cellStyle} ${diffStyle}">Updated Schedule<br><small>Periods/Codes changed</small></td></tr>`;
            hasChanges = true;
        }

        html += '</tbody></table>';

        // Warn about Portal Setup
        if (oldClass.portalSetup && !newClass.portalSetup) {
            html += `<div style="margin-top:10px; padding:10px; background:#fff3cd; color:#856404; font-size:0.8rem; border-radius:4px;">
                <strong>Note:</strong> Your local Portal Mode setup (baseline data) will be preserved, but verify it after updating.
             </div>`;
        }

        if (!hasChanges) {
            return '<div style="padding:15px; text-align:center; color:#666;">No significant visible changes detected.<br>Internal version bump only.</div>';
        }

        return html;
    },

    async applyClassUpdate(updateId) {
        const update = window._pendingClassUpdate;
        if (!update || update.id !== updateId) return;

        if (confirm("Are you sure? This will overwrite your current class details (Subjects, Timetable, Dates). Your attendance logs will remain.")) {
            // Apply Update
            const currentClassName = document.getElementById('classSelector').value;
            const currentClass = window.classes[currentClassName];
            const newClassData = update.full_class_data;

            // PRESERVE LOCAL DATA (Critical Fix)
            // 1. Portal Setup (Personal Baseline)
            if (currentClass.portalSetup) {
                newClassData.portalSetup = currentClass.portalSetup;
            }

            // Apply
            window.classes[currentClassName] = newClassData;

            // Re-save and reload
            if (window.saveToStorage) window.saveToStorage();
            if (window.loadClass) window.loadClass(currentClassName);

            // Sync
            if (window.SyncManager) window.SyncManager.saveClass(currentClassName, newClassData);

            document.getElementById('updateProposalModal').remove();
            alert("Class updated successfully!");
        }
    },

    // --- UI DASHBOARD LOGIC ---
    openCommunityDashboard() {
        if (!window.AuthManager || !window.AuthManager.user) {
            alert("Access Denied\n\nCommunity features (Mass Bunk Stats, Polls) are only available for signed-in users.\n\nPlease sign in to continue.");
            return;
        }

        if (!document.getElementById('classSelector').value) {
            alert("Please select a class first!");
            return;
        }
        document.getElementById('classSelectedContent').style.display = 'none';
        document.getElementById('communityDashboardSection').style.display = 'block';
        this.renderDashboard();
    },

    closeCommunityDashboard() {
        document.getElementById('communityDashboardSection').style.display = 'none';
        document.getElementById('classSelectedContent').style.display = 'block';
    },

    async renderDashboard() {
        const className = document.getElementById('classSelector').value;
        const classData = window.classes[className];
        if (!classData) return;

        // AUTO-REPAIR: If sharedId is missing, generate it now.
        if (!classData.sharedId) {
            console.log("🛠️ Auto-Generating Shared ID for old class...");
            document.getElementById('massBunkStatus').innerHTML = "Connecting to Cloud...<br><small>One moment please</small>";

            try {
                classData.sharedId = await this.generateSharedClassId(classData);
                // Save immediately
                if (window.classes) window.classes[className] = classData;
                if (window.saveToStorage) window.saveToStorage();
                console.log("✅ Shared ID Generated: " + classData.sharedId);
            } catch (e) {
                console.error("Failed to auto-generate sharedId:", e);
                document.getElementById('massBunkStatus').innerHTML = "Cloud Error.<br><small>Try adding the class again.</small>";
                return;
            }
        }

        // 1. Mass Bunk Stats
        if (window.supabaseClient) {
            const today = new Date().toISOString().split('T')[0];
            const { data, error } = await window.supabaseClient
                .from('daily_class_status')
                .select('*')
                .eq('shared_class_id', classData.sharedId)
                .eq('date', today)
                .eq('can_mass_bunk', true);

            if (!error && data) {
                const count = data.length;
                // Simple algo: count * 10 (placeholder) or just raw count
                // In real app, we'd need total user count for this sharedId to calc %. 
                // For now, let's just show raw count impact.
                document.getElementById('activeBunkersCount').textContent = count;

                // visual flare
                let percentage = Math.min(count * 5, 100); // Assume 20 students = 100%
                document.getElementById('massBunkMeter').textContent = `${percentage}%`;
                document.getElementById('massBunkStatus').textContent = percentage > 50 ? "High Chance!" : "Low Chance";
            }
        }

        // 2. Polls
        this.fetchAndRenderPolls(classData.sharedId);
    },

    async fetchAndRenderPolls(sharedId) {
        if (!window.supabaseClient) return;
        const today = new Date().toISOString().split('T')[0];

        const { data: polls, error } = await window.supabaseClient
            .from('mass_bunk_polls')
            .select(`
                *,
                mass_bunk_votes ( user_id, vote )
            `)
            .eq('shared_class_id', sharedId)
            .eq('date', today);

        const container = document.getElementById('pollsContainer');
        container.innerHTML = '';

        if (!polls || polls.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px; grid-column: 1/-1;">No active polls. Start one?</div>';
            return;
        }

        const userId = (await window.supabaseClient.auth.getUser()).data.user?.id;

        polls.forEach(poll => {
            const yesVotes = poll.mass_bunk_votes.filter(v => v.vote === 'yes').length;
            const noVotes = poll.mass_bunk_votes.filter(v => v.vote === 'no').length;
            const total = yesVotes + noVotes;
            const yesPercent = total > 0 ? Math.round((yesVotes / total) * 100) : 0;

            const myVote = poll.mass_bunk_votes.find(v => v.user_id === userId)?.vote;

            const card = document.createElement('div');
            card.className = 'poll-card';
            card.style.cssText = 'background: #fff; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid var(--border-color);';

            card.innerHTML = `
                <h4 style="margin: 0 0 15px 0; color: var(--text-primary);">Mass Bunk Tomorrow?</h4>
                <div style="display: flex; gap: 10px; margin-bottom: 15px;">
                    <div style="flex: 1; text-align: center;">
                        <div style="font-size: 1.5rem; font-weight: 700; color: #1abc9c;">${yesVotes}</div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary);">YES</div>
                    </div>
                    <div style="flex: 1; text-align: center;">
                        <div style="font-size: 1.5rem; font-weight: 700; color: #e74c3c;">${noVotes}</div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary);">NO</div>
                    </div>
                </div>
                
                <div class="poll-bar" style="height: 6px; background: #eee; border-radius: 3px; overflow: hidden; margin-bottom: 20px;">
                    <div style="width: ${yesPercent}%; background: #1abc9c; height: 100%;"></div>
                </div>

                <div style="display: flex; gap: 10px;">
                    <button class="btn" onclick="SocialManager.voteOnPoll('${poll.id}', 'yes')" 
                        style="flex: 1; border: 1px solid #1abc9c; background: ${myVote === 'yes' ? '#1abc9c' : 'transparent'}; color: ${myVote === 'yes' ? '#fff' : '#1abc9c'};">
                        YES
                    </button>
                    <button class="btn" onclick="SocialManager.voteOnPoll('${poll.id}', 'no')" 
                        style="flex: 1; border: 1px solid #e74c3c; background: ${myVote === 'no' ? '#e74c3c' : 'transparent'}; color: ${myVote === 'no' ? '#fff' : '#e74c3c'};">
                        NO
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    },

    async createPollUI() {
        const className = document.getElementById('classSelector').value;
        const classData = window.classes[className];
        if (!classData || !classData.sharedId) {
            alert("This class is not connected to the cloud cannot create poll.");
            return;
        }

        if (confirm("Start a 'Mass Bunk' poll for tomorrow?")) {
            await this.initiatePoll(classData.sharedId);
            this.renderDashboard(); // Refresh
        }
    },
};

window.SocialManager = SocialManager;
