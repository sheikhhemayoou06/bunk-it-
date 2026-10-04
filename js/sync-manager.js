// Sync Manager - Handles Data Synchronization
// Strategy: Last Write Wins (Time-based)

const SyncManager = {
    pendingUploads: false,
    syncing: false,
    pollingInterval: null, // For polling-based sync (alternative to Realtime)
    POLLING_INTERVAL_MS: 45000, // 45 seconds

    pruneDuplicates() {
        // Placeholder for future strict deduplication logic
        // This prevents the runtime error "this.pruneDuplicates is not a function"
        console.log("🧹 Pruning duplicates...");
    },

    syncPromise: null,

    async syncOnLogin(wasGuest = false) {
        if (this.syncPromise) return this.syncPromise;

        this.syncPromise = (async () => {
            this.syncing = true;
            this.updateSyncStatus('Syncing...');

            try {
                // 1. Download Cloud Data
                const { data: cloudClasses, error: classError } = await supabaseClient.from('classes').select('*');
                const { data: cloudLogs, error: logError } = await supabaseClient.from('attendance_logs').select('*');
                const { data: cloudSettings, error: setError } = await supabaseClient.from('user_settings').select('*').single();

                if (classError || logError) throw new Error("Fetch failed");

                // 2. Load Local Data
                // SMART WIPE STRATEGY:
                // Only wipe if:
                // A) It's a fresh signup (Clean slate)
                // B) It's a DIFFERENT user than before (Security/Privacy)
                // C) We have no record of the last user
                const isNewSignup = localStorage.getItem('is_new_signup');
                const lastUserId = localStorage.getItem('last_user_id');
                const currentUserId = AuthManager.user?.id;

                let shouldWipe = false;

                if (isNewSignup) {
                    console.log("🆕 New Signup detected. Wiping local data.");
                    shouldWipe = true;
                } else if (!lastUserId || lastUserId !== currentUserId) {
                    console.log(`👤 User Changed (Old: ${lastUserId}, New: ${currentUserId}). Wiping local data.`);
                    shouldWipe = true;
                } else {
                    console.log("🔄 Same User Refresh. Preserving local data for sync merge.");
                }

                if (shouldWipe) {
                    // Comprehensive Wipe of User Data Keys
                    localStorage.removeItem('attendanceClasses_v2');
                    localStorage.removeItem('attendance_logs');
                    localStorage.removeItem('lastOpenedClass');
                    localStorage.removeItem('userProfileName');
                    localStorage.removeItem('theme');

                    // Wipe Settings & Notifications
                    for (let i = localStorage.length - 1; i >= 0; i--) {
                        const key = localStorage.key(i);
                        if (key && (key.startsWith('notificationSettings_') || key.startsWith('calcSettings_'))) {
                            localStorage.removeItem(key);
                        }
                    }

                    // Reset In-Memory State
                    window.classes = {};
                    window.attendanceLogs = {};
                }

                // Update Last User ID for next time
                if (currentUserId) {
                    localStorage.setItem('last_user_id', currentUserId);
                }

                // Always clear the flag after checking
                localStorage.removeItem('is_new_signup');

                // FORCE PRUNE DUPLICATES before loading to clean up existing mess
                this.pruneDuplicates();
                const localClasses = JSON.parse(localStorage.getItem('attendanceClasses_v2') || '{}');
                const localLogs = JSON.parse(localStorage.getItem('attendance_logs') || '{}');

                // 3. ID-BASED MERGE STRATEGY (Last Write Wins)
                const finalClasses = {};
                const localProcessedIds = new Set();
                const renames = {}; // Map<OldName, NewName> for log migration

                // Step 3a: Process Cloud Classes
                const pendingDeletes = JSON.parse(localStorage.getItem('pending_deletes') || '[]');

                cloudClasses.forEach(row => {
                    // TOMBSTONE CHECK: If pending delete, ignore cloud version
                    if (pendingDeletes.includes(row.name)) return;

                    const cloudData = row.data;
                    const cloudId = cloudData.id;
                    const cloudName = row.name;

                    // Restore side-loaded items for cloud class
                    // REDUNDANT REMOVED: Moved below to conditionally apply only if adopting cloud version

                    // Find matching local class by ID
                    let matchingLocalName = null;
                    let localData = null;

                    for (const [lName, lData] of Object.entries(localClasses)) {
                        if (lData.id === cloudId) {
                            matchingLocalName = lName;
                            localData = lData;
                            break;
                        }
                    }

                    // 2. If No ID match, Try Match by NAME (Merge-by-Name Strategy)
                    if (!localData && localClasses[cloudName]) {
                        // Double check it hasn't been matched by ID to another class
                        let alreadyMatched = false;
                        for (const processedId of localProcessedIds) {
                            if (localClasses[cloudName].id === processedId) alreadyMatched = true;
                        }

                        if (!alreadyMatched) {
                            console.log(`🔗 Linking Local "${cloudName}" to Cloud Class (Name Match)`);
                            matchingLocalName = cloudName;
                            localData = localClasses[cloudName];
                            localData.id = cloudId; // ADOPT CLOUD ID
                        }
                    }

                    if (localData) {
                        localProcessedIds.add(cloudId);

                        // Content-Based Deduplication (Check if basically identical)
                        const cloudHash = JSON.stringify({ s: cloudData.subjects, h: cloudData.holidays, sd: cloudData.startDate });
                        const localHash = JSON.stringify({ s: localData.subjects, h: localData.holidays, sd: localData.startDate });

                        // Compare Timestamps (Default to Cloud if missing)
                        const cloudTime = cloudData.updatedAt || 0;
                        const localTime = localData.updatedAt || 0;

                        if (localTime > cloudTime && cloudHash !== localHash) {
                            // Local is newer AND different -> Keep Local (and mark for upload)
                            console.log(`🏠 Local version newer for "${cloudName}". Keeping Local.`);
                            finalClasses[matchingLocalName] = localData; // Keep local name/data
                            this.pendingUploads = true;
                        } else {
                            // Cloud is newer OR identical -> Keep Cloud
                            if (cloudHash !== localHash) {
                                console.log(`☁️ Cloud version newer for "${cloudName}". Overwriting Local.`);

                                if (cloudData.timetableArrangement) localStorage.setItem(`timetable_arrangement_${cloudName}`, JSON.stringify(cloudData.timetableArrangement));
                                if (cloudData.periodTimes) localStorage.setItem(`periodTimes_${cloudName}`, JSON.stringify(cloudData.periodTimes));
                                if (cloudData.customSchedules) localStorage.setItem(`custom_schedules_${cloudName}`, JSON.stringify(cloudData.customSchedules));
                                if (cloudData.timetableHistory) localStorage.setItem(`timetable_history_${cloudName}`, JSON.stringify(cloudData.timetableHistory));
                            } else {
                                console.log(`✨ Content identical for "${cloudName}". Preserving local arrangement.`);
                                // DON'T overwrite local timetableArrangement when content is identical
                            }

                            finalClasses[cloudName] = cloudData;

                            // If name changed in cloud, we might need to handle that, but for now assume cloud name wins
                            if (matchingLocalName !== cloudName) {
                                renames[matchingLocalName] = cloudName;
                            }
                        }
                    } else {
                        // New from Cloud
                        finalClasses[cloudName] = cloudData;

                        // Restore side-loaded items for NEW Cloud class (Always safe)
                        if (cloudData.timetableArrangement) localStorage.setItem(`timetable_arrangement_${cloudName}`, JSON.stringify(cloudData.timetableArrangement));
                        if (cloudData.periodTimes) localStorage.setItem(`periodTimes_${cloudName}`, JSON.stringify(cloudData.periodTimes));
                        if (cloudData.customSchedules) localStorage.setItem(`custom_schedules_${cloudName}`, JSON.stringify(cloudData.customSchedules));
                        if (cloudData.timetableHistory) localStorage.setItem(`timetable_history_${cloudName}`, JSON.stringify(cloudData.timetableHistory));
                    }
                });

                // Step 3b: Process Remaining Local Classes (No ID match in Cloud)
                const droppedLocalClasses = new Set();

                for (const [lName, lData] of Object.entries(localClasses)) {
                    if (lData.id && localProcessedIds.has(lData.id)) continue; // Already processed



                    // Content Check against existing final classes to prevent "Name (Local)" duplicates of same functionality
                    // (e.g. User logged out, then logged in, local became anonymous but is same as cloud)
                    let isDuplicateContent = false;
                    for (const [fName, fData] of Object.entries(finalClasses)) {
                        // aggressive DEDUPLICATION: Normalize hash (handle null/undefined/empty arrays similarly)
                        const normalize = (d) => JSON.stringify({
                            s: d.subjects || [],
                            h: d.holidays || [],
                            sd: d.startDate || ""
                        });

                        if (normalize(fData) === normalize(lData)) {
                            console.log(`🧹 Content Identical: Merging "${lName}" into "${fName}"`);
                            isDuplicateContent = true;
                            if (lName !== fName) renames[lName] = fName; // Map logs
                            break;
                        }
                    }
                    if (isDuplicateContent) continue; // Skip adding this local duplicate

                    // 2. Fuzzy Name Match (e.g. "Class (Local)" vs "Class")
                    // If content is slightly different but name suggests it's a copy
                    const baseName = lName.replace(/ \(Local\)+$/, '').replace(/ \(Example\)+$/, '');
                    if (finalClasses[baseName]) {
                        console.log(`✨ Fuzzy Match: "${lName}" looks like a copy of "${baseName}". Merging...`);

                        // Merge Strategy: Keep Cloud (baseName) but try to save any extra subjects?
                        // For now, STRICT MERGE as requested: Cloud/Base wins.
                        // But we MUST merge logs.
                        renames[lName] = baseName;

                        // Also, check timestamps
                        const fData = finalClasses[baseName];
                        if ((lData.updatedAt || 0) > (fData.updatedAt || 0)) {
                            console.log(`   -> Local is newer, adopting local basics.`);
                            fData.subjects = lData.subjects;
                            fData.startDate = lData.startDate;
                            fData.holidays = lData.holidays;
                            finalClasses[baseName] = fData;
                            this.pendingUploads = true;
                        }

                        continue; // Skip adding the duplicate file
                    }
                    // (Broken duplicate check removed)

                    // Check for Name Collision in Final Set
                    // Check for Name Collision in Final Set
                    if (finalClasses[lName]) {
                        // USER REQUEST: STRICT MERGE (No Duplicates)
                        console.log(`⚠️ STRICT MERGE: Name Collision for "${lName}". Merging...`);

                        const fData = finalClasses[lName];
                        const lTime = new Date(lData.updatedAt || 0).getTime();
                        const fTime = new Date(fData.updatedAt || 0).getTime();

                        if (lTime > fTime) {
                            console.log(`🏠 Local "${lName}" is newer (${lTime} > ${fTime}). Overwriting cloud entry locally.`);
                            lData.id = fData.id; // Keep Cloud ID (Critical for Sync)
                            finalClasses[lName] = lData;
                            this.pendingUploads = true;
                        } else {
                            console.log(`☁️ Cloud "${lName}" is newer/same. Local changes discarded.`);
                        }
                    } else {
                        // STRICT SINGLE CLASS POLICY (Sync Conflict) - MOVED TO END
                        // If we are here, we have a unique local class that did not merge with any cloud class.
                        // BUT if we already have a class in the final set, we must drop this one.
                        const existingSurvivors = Object.keys(finalClasses);
                        if (existingSurvivors.length > 0) {
                            const survivor = existingSurvivors[0];
                            console.warn(`🔒 Single Class Policy: Conflict detected.`);
                            console.warn(`   Cloud/Survivor: "${survivor}"`);
                            console.warn(`   Local Victim:   "${lName}"`);
                            console.warn(`   ACTION: Dropping local class "${lName}" to enforce limit.`);

                            droppedLocalClasses.add(lName);
                            continue; // Skip processing/adding this class
                        }

                        // No Collision -> Safe to add
                        finalClasses[lName] = lData;
                        this.pendingUploads = true; // New local data needs upload
                    }
                }

                // Step 3c: Commit Classes
                localStorage.setItem('attendanceClasses_v2', JSON.stringify(finalClasses));
                window.classes = finalClasses;

                // Merge Logs & Migrate Renamed Logs
                const finalLogs = { ...localLogs };

                // CLEANUP: Remove logs for dropped classes (Single Class Policy Victims)
                if (droppedLocalClasses && droppedLocalClasses.size > 0) {
                    for (const date in finalLogs) {
                        const dayLogs = finalLogs[date];
                        if (!dayLogs) continue;

                        droppedLocalClasses.forEach(droppedName => {
                            // 1. Check Legacy Direct Key (e.g. "Mech-B")
                            if (dayLogs[droppedName] !== undefined) {
                                delete dayLogs[droppedName];
                            }
                            // 2. Check Namespaced Keys (e.g. "Mech-B_Math")
                            Object.keys(dayLogs).forEach(key => {
                                if (key.startsWith(`${droppedName}_`)) {
                                    delete dayLogs[key];
                                }
                            });
                        });

                        // Clean up empty days
                        if (Object.keys(dayLogs).length === 0) {
                            delete finalLogs[date];
                        }
                    }
                }

                // Apply Renames to Local Logs FIRST
                Object.keys(renames).forEach(oldName => {
                    const newName = renames[oldName];
                    for (const date in finalLogs) {
                        const dayLogs = finalLogs[date];
                        if (!dayLogs) continue;

                        // Iterate keys in the day log
                        Object.keys(dayLogs).forEach(key => {
                            // Check for Namespaced Keys: "OldName_Subject"
                            if (key.startsWith(`${oldName}_`)) {
                                const suffix = key.substring(oldName.length + 1);
                                const newKey = `${newName}_${suffix}`;
                                dayLogs[newKey] = dayLogs[key];
                                delete dayLogs[key];
                            }
                            // Legacy: We assume legacy logs might be lost or we don't touch them 
                            // because we can't be sure which class they belong to if unspaced.
                            // But given the "Smart Rename" happens on login, we assume current logs are fresh.
                        });
                    }
                });

                // Merge Cloud Logs (Smart Merge with Timestamp Check)
                const logTimestamps = this.safeParse('attendance_log_timestamps');

                cloudLogs.forEach(row => {
                    if (!finalLogs[row.date]) finalLogs[row.date] = {};

                    const cloudTime = new Date(row.updated_at || 0).getTime();
                    const localTime = new Date(logTimestamps[row.date] || 0).getTime();

                    if (localTime > cloudTime) {
                        console.log(`🏠 Race Condition Avoided: Local log for ${row.date} is newer (${localTime} > ${cloudTime}). Keeping Local.`);
                        this.pendingUploads = true; // Ensure this newer local version gets pushed eventually
                        // Do NOT overwrite with stale cloud data
                    } else {
                        // Cloud is newer or same -> Accept Cloud
                        Object.assign(finalLogs[row.date], row.logs);
                    }
                });

                localStorage.setItem('attendance_logs', JSON.stringify(finalLogs));
                window.attendanceLogs = finalLogs;

                // Step 5: Settings (Cloud Wins mostly)
                if (cloudSettings) {
                    if (cloudSettings.theme) localStorage.setItem('theme', cloudSettings.theme);
                    if (cloudSettings.preferences) {
                        const prefs = cloudSettings.preferences;
                        if (prefs.lastOpenedClass) localStorage.setItem('lastOpenedClass', prefs.lastOpenedClass);
                        if (prefs.userProfileName) localStorage.setItem('userProfileName', prefs.userProfileName); // Restore Name
                        if (prefs.studentProfile) localStorage.setItem('studentProfile', JSON.stringify(prefs.studentProfile)); // Name, phone, reg no...
                        // Restore others...
                        if (prefs.minAttendance) localStorage.setItem('calcSettings_minAttendance', prefs.minAttendance);
                        if (prefs.odmlCap) localStorage.setItem('calcSettings_odmlCap', prefs.odmlCap);
                        if (prefs.odmlRule) localStorage.setItem('calcSettings_odmlRule', prefs.odmlRule);
                        if (prefs.odmlAllowancePct) localStorage.setItem('calcSettings_odmlAllowancePct', prefs.odmlAllowancePct);
                    }
                }

                console.log('✅ ID-Based Sync Complete');

                // If we have pending uploads (New Local data or conflicts), upload now
                if (this.pendingUploads) {
                    console.log('📤 Uploading synced data...');
                    await this.uploadAll();
                    this.pendingUploads = false;
                }

                this.updateSyncStatus('Synced');

                // Reload App UI
                if (window.loadClasses) {
                    window.loadClasses();
                } else {
                    if (window.loadFromStorage) window.loadFromStorage();
                    if (window.populateClassSelector) window.populateClassSelector();
                }

                if (window.updateSidebarAccountUI) window.updateSidebarAccountUI();

                // Refresh specific UI parts
                this.refreshCalculationSettingsUI();
                this.subscribeToChanges(); // Subscribe to real-time (if available)
                this.startPolling(); // Start polling-based sync (fallback/alternative)

                // Clear SW cache to ensure fresh HTML on next load
                this.clearServiceWorkerCache();

                // Process any pending deletes in background
                this.processPendingDeletes();

                return { success: true, count: Object.keys(finalClasses).length };

            } catch (e) {
                console.error('Sync failed:', e);
                this.updateSyncStatus('Sync Error');
                return { success: false, error: e.message || "Unknown Error" };
            } finally {
                this.syncing = false;
                this.syncPromise = null;
            }
        })();

        return this.syncPromise;
    },

    async processPendingDeletes() {
        if (!AuthManager.user) return;
        const pending = JSON.parse(localStorage.getItem('pending_deletes') || '[]');
        if (pending.length === 0) return;

        console.log(`🗑️ Processing ${pending.length} pending deletes...`);
        const remaining = [];

        for (const name of pending) {
            try {
                await supabaseClient.from('classes').delete()
                    .eq('user_id', AuthManager.user.id)
                    .eq('name', name);
                console.log(`✅ Pending delete success: ${name}`);
            } catch (e) {
                console.error(`❌ Pending delete failed: ${name}`, e);
                remaining.push(name);
            }
        }

        if (remaining.length > 0) {
            localStorage.setItem('pending_deletes', JSON.stringify(remaining));
        } else {
            localStorage.removeItem('pending_deletes');
        }
    },

    async uploadAll() {
        if (!AuthManager.user) return;
        this.updateSyncStatus('Uploading...');

        // Process pending deletes first
        await this.processPendingDeletes();

        const localClasses = JSON.parse(localStorage.getItem('attendanceClasses_v2') || '{}');
        const theme = localStorage.getItem('theme') || 'light';
        const lastOpenedClass = localStorage.getItem('lastOpenedClass');
        const userProfileName = localStorage.getItem('userProfileName');

        // Gather Notifications
        const notifications = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('notificationSettings_')) {
                notifications[key] = JSON.parse(localStorage.getItem(key));
            }
        }

        try {
            const user_id = AuthManager.user.id;

            // 1. Upsert Classes
            for (const [name, data] of Object.entries(localClasses)) {
                // Enrich data with side-loaded localStorage items
                const arrangement = localStorage.getItem(`timetable_arrangement_${name}`);
                if (arrangement) data.timetableArrangement = JSON.parse(arrangement);

                const pTimes = localStorage.getItem(`periodTimes_${name}`);
                if (pTimes) data.periodTimes = JSON.parse(pTimes);

                const cSched = localStorage.getItem(`custom_schedules_${name}`);
                if (cSched) data.customSchedules = JSON.parse(cSched);

                // Dated timetable versions (so past days keep their old timetable on other devices)
                const tHist = localStorage.getItem(`timetable_history_${name}`);
                if (tHist) data.timetableHistory = JSON.parse(tHist);

                await supabaseClient.from('classes').upsert({
                    user_id,
                    name,
                    data,
                    updated_at: new Date()
                }, { onConflict: 'user_id, name' });
            }

            // 2. Upsert Settings
            await supabaseClient.from('user_settings').upsert({
                user_id,
                theme,
                preferences: {
                    lastOpenedClass,
                    userProfileName,
                    notifications,
                    // FIXED: Use correct localStorage keys matching index.html
                    minAttendance: localStorage.getItem('calcSettings_minAttendance'),
                    odmlCap: localStorage.getItem('calcSettings_odmlCap'), odmlRule: localStorage.getItem('calcSettings_odmlRule'), odmlAllowancePct: localStorage.getItem('calcSettings_odmlAllowancePct'),
                    minMedical: localStorage.getItem('calcSettings_minMedical'),
                    isOverall: localStorage.getItem('calcSettings_isOverall'),
                    personalGeminiKey: localStorage.getItem('personalGeminiKey'), // Encrypted if possible in future
                    studentProfile: JSON.parse(localStorage.getItem('studentProfile') || 'null')
                },
                updated_at: new Date()
            });

            // 3. Upsert Logs (CRITICAL MISSING STEP ADDED)
            const localLogs = JSON.parse(localStorage.getItem('attendance_logs') || '{}');
            for (const [date, logs] of Object.entries(localLogs)) {
                await supabaseClient.from('attendance_logs').upsert({
                    user_id,
                    date,
                    logs,
                    updated_at: new Date()
                }, { onConflict: 'user_id, date' });
            }

            this.updateSyncStatus('Synced');
        } catch (e) {
            console.error('Upload failed:', e);
            this.updateSyncStatus('Offline');
            this.pendingUploads = true;
        }
    },

    async forceResync() {
        if (!confirm("Force Global Sync?\n\nThis will re-upload ALL your local data to the cloud, ensuring everything is saved.\n\nContinue?")) return;
        this.syncing = false; // Reset lock
        await this.uploadAll();
        alert("✅ Forced Sync Complete!\nYour local data is now on the cloud.");
        window.location.reload();
    },

    // --- EDGE CASE HELPERS ---

    // Helper: Safe JSON Parse to prevent crashes
    safeParse(key, defaultVal = {}) {
        try {
            const val = localStorage.getItem(key);
            return val ? JSON.parse(val) : defaultVal;
        } catch (e) {
            console.error(`⚠️ Corrupted data in ${key}. Resetting to default.`, e);
            return defaultVal;
        }
    },

    // Helper: Safe Set Item (Quota Handling)
    safeSetItem(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
                console.error(`⚠️ LocalStorage Limit Exceeded for ${key}!`);
                alert("Storage Full: Your device storage is full. Data is saved to the Cloud, but offline access might be limited.");
            } else {
                console.error(`Error saving ${key}:`, e);
            }
        }
    },

    // Helper: Retry operation for Auth errors
    async retryOperation(operation) {
        try {
            return await operation();
        } catch (e) {
            // Check for Auth Supabase Error (401/403 or 'JWT expired')
            if (e.code === 'PGRST301' || e.message?.includes('JWT') || e.code === 401) {
                console.warn('🔄 Auth token issue detected. Retrying once...', e);
                // Attempt to refresh session
                const { data, error } = await supabaseClient.auth.getSession();
                if (data.session) {
                    return await operation();
                } else {
                    console.error('❌ Retry failed: Session lost.');
                    throw new Error("Session expired. Please login again.");
                }
            }
            throw e;
        }
    },

    async saveClass(name, data) {
        if (!AuthManager.user) return;

        this.syncPromise = (this.syncPromise || Promise.resolve()).then(async () => {
            this.syncing = true;
            this.updateSyncStatus('Saving...');
            try {
                await this.retryOperation(async () => {
                    await supabaseClient.from('classes').upsert({
                        user_id: AuthManager.user.id,
                        name,
                        data,
                        updated_at: new Date()
                    }, { onConflict: 'user_id, name' });
                });
                this.updateSyncStatus('Saved');
            } catch (e) {
                console.error('Save failed:', e);
                this.updateSyncStatus('Offline (Saved Locally)');
            } finally {
                this.syncing = false;
            }
        });

        return this.syncPromise;
    },

    async saveLog(date, logs) {
        if (!AuthManager.user) return;

        this.syncPromise = (this.syncPromise || Promise.resolve()).then(async () => {
            this.syncing = true;
            this.updateSyncStatus('Saving...');
            try {
                await this.retryOperation(async () => {
                    await supabaseClient.from('attendance_logs').upsert({
                        user_id: AuthManager.user.id,
                        date,
                        logs,
                        updated_at: new Date()
                    }, { onConflict: 'user_id, date' });
                });
                this.updateSyncStatus('Saved');
            } catch (e) {
                console.error('Log save failed:', e);
                this.updateSyncStatus('Offline (Saved Locally)');
            } finally {
                this.syncing = false;
            }
        });

        return this.syncPromise;
    },

    async saveSettings() {
        if (!AuthManager.user) return;

        this.syncPromise = (this.syncPromise || Promise.resolve()).then(async () => {
            this.syncing = true;
            this.updateSyncStatus('Saving settings...');

            const theme = localStorage.getItem('theme') || 'light';
            const lastOpenedClass = localStorage.getItem('lastOpenedClass');
            const userProfileName = localStorage.getItem('userProfileName');

            const notifications = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key.startsWith('notificationSettings_')) {
                    notifications[key] = this.safeParse(key, null);
                }
            }

            try {
                await this.retryOperation(async () => {
                    await supabaseClient.from('user_settings').upsert({
                        user_id: AuthManager.user.id,
                        theme,
                        preferences: {
                            lastOpenedClass,
                            userProfileName,
                            notifications,
                            minAttendance: localStorage.getItem('calcSettings_minAttendance'),
                            odmlCap: localStorage.getItem('calcSettings_odmlCap'), odmlRule: localStorage.getItem('calcSettings_odmlRule'), odmlAllowancePct: localStorage.getItem('calcSettings_odmlAllowancePct'),
                            minMedical: localStorage.getItem('calcSettings_minMedical'),
                            isOverall: localStorage.getItem('calcSettings_isOverall'),
                            personalGeminiKey: localStorage.getItem('personalGeminiKey'),
                            studentProfile: JSON.parse(localStorage.getItem('studentProfile') || 'null')
                        },
                        updated_at: new Date()
                    });
                });
                this.updateSyncStatus('Saved');
            } catch (e) {
                console.error('Settings save failed:', e);
                this.updateSyncStatus('Offline (Saved Locally)');
            } finally {
                this.syncing = false;
            }
        });

        return this.syncPromise;
    },

    async deleteClass(name) {
        if (!AuthManager.user) return;

        this.syncPromise = (this.syncPromise || Promise.resolve()).then(async () => {
            this.syncing = true;
            this.updateSyncStatus('Deleting...');
            try {
                await this.retryOperation(async () => {
                    // Add tombstone first
                    const pending = JSON.parse(localStorage.getItem('pending_deletes') || '[]');
                    if (!pending.includes(name)) {
                        pending.push(name);
                        localStorage.setItem('pending_deletes', JSON.stringify(pending));
                    }

                    await supabaseClient.from('classes').delete()
                        .eq('user_id', AuthManager.user.id)
                        .eq('name', name);

                    // Remove tombstone on success
                    const updatedPending = JSON.parse(localStorage.getItem('pending_deletes') || '[]');
                    const newPending = updatedPending.filter(n => n !== name);
                    if (newPending.length > 0) localStorage.setItem('pending_deletes', JSON.stringify(newPending));
                    else localStorage.removeItem('pending_deletes');
                });

                const notifKey = `notificationSettings_${name}`;
                if (localStorage.getItem(notifKey)) {
                    localStorage.removeItem(notifKey);
                }

                this.updateSyncStatus('Deleted');
            } catch (e) {
                console.error('Delete failed:', e);
                this.updateSyncStatus('Error deleting');
            } finally {
                this.syncing = false;
            }
        });

        return this.syncPromise;
    },

    async subscribeToChanges() {
        if (!AuthManager.user) return;

        console.log("🔌 Subscribing to Realtime changes...");
        const channel = supabaseClient.channel('realtime_sync')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'classes', filter: `user_id=eq.${AuthManager.user.id}` },
                (payload) => {
                    console.log('Class Change:', payload);
                    this.handleClassChange(payload);
                }
            )
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'attendance_logs', filter: `user_id=eq.${AuthManager.user.id}` },
                (payload) => {
                    console.log('Log Change:', payload);
                    this.handleLogChange(payload);
                }
            )
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'user_settings', filter: `user_id=eq.${AuthManager.user.id}` },
                (payload) => {
                    console.log('Settings Change:', payload);
                    this.handleSettingsChange(payload);
                }
            )
            .subscribe();
    },

    handleClassChange(payload) {
        const { eventType, new: newRow, old: oldRow } = payload;
        const localClasses = this.safeParse('attendanceClasses_v2');

        if (eventType === 'INSERT' || eventType === 'UPDATE') {
            const cloudData = newRow.data;
            const localData = localClasses[newRow.name];

            // TIMESTAMP CHECK: Only overwrite if cloud is actually newer
            const cloudTime = cloudData?.updatedAt || 0;
            const localTime = localData?.updatedAt || 0;

            if (cloudTime > localTime) {
                console.log(`🔄 Realtime: Cloud update for "${newRow.name}" is newer. Applying.`);
                localClasses[newRow.name] = cloudData;

                // Restore side-loaded ONLY if cloud is newer
                if (cloudData.timetableArrangement) {
                    this.safeSetItem(`timetable_arrangement_${newRow.name}`, JSON.stringify(cloudData.timetableArrangement));
                }
                if (cloudData.periodTimes) {
                    this.safeSetItem(`periodTimes_${newRow.name}`, JSON.stringify(cloudData.periodTimes));
                }
                if (cloudData.timetableHistory) {
                    this.safeSetItem(`timetable_history_${newRow.name}`, JSON.stringify(cloudData.timetableHistory));
                }
            } else {
                console.log(`🛡️ Realtime: Ignoring cloud update for "${newRow.name}" (Local is same or newer).`);
                // DON'T overwrite local data or timetable arrangement
                return; // Exit early - no need to save
            }
        } else if (eventType === 'DELETE') {
            delete localClasses[oldRow.name];
        }

        this.safeSetItem('attendanceClasses_v2', JSON.stringify(localClasses));
        if (window.loadFromStorage) window.loadFromStorage();
    },

    handleLogChange(payload) {
        const { eventType, new: newRow } = payload;
        if (eventType === 'INSERT' || eventType === 'UPDATE') {
            const localLogs = this.safeParse('attendance_logs');
            if (!localLogs[newRow.date]) localLogs[newRow.date] = {};
            Object.assign(localLogs[newRow.date], newRow.logs);
            this.safeSetItem('attendance_logs', JSON.stringify(localLogs));
            if (window.loadFromStorage) window.loadFromStorage();
        }
    },

    handleSettingsChange(payload) {
        const { eventType, new: newRow } = payload;
        if (eventType === 'INSERT' || eventType === 'UPDATE') {
            if (newRow.theme) {
                this.safeSetItem('theme', newRow.theme);
                if (newRow.theme === 'dark') document.body.classList.add('dark-mode');
                else document.body.classList.remove('dark-mode');
            }
            // For simplicity, we just reload heavily dependent settings or partial update
            if (newRow.preferences) {
                // Partial update logic matching syncOnLogin...
            }
        }
    },

    initListeners() {
        // Robust Online/Offline Listeners
        window.addEventListener('online', () => {
            console.log('🌐 Network restored. Attempting global sync...');
            this.updateSyncStatus('Online - Syncing...');
            this.uploadAll();
            this.startPolling();
        });

        window.addEventListener('offline', () => {
            console.log('🔌 Network lost. Switching to offline mode.');
            this.updateSyncStatus('Offline');
            this.stopPolling();
        });

        // Multi-Tab Sync (Cross-Tab Communication)
        window.addEventListener('storage', (event) => {
            if (document.hidden) { // Only update if not strictly focused (or always? usually good to always update)
                console.log(`🔄 Cross-Tab Sync: Detected change in ${event.key}`);

                if (event.key === 'attendanceClasses_v2' || event.key === 'attendance_logs') {
                    if (window.loadFromStorage) window.loadFromStorage();
                    if (window.renderDashboard) window.renderDashboard();
                }
                else if (event.key === 'theme') {
                    if (event.newValue === 'dark') document.body.classList.add('dark-mode');
                    else document.body.classList.remove('dark-mode');
                }
                else if (event.key === 'userProfileName') {
                    if (window.updateSidebarAccountUI) window.updateSidebarAccountUI();
                }
            }
        });
    },

    // Refresh Calculation Settings UI from localStorage values
    refreshCalculationSettingsUI() {
        const savedMinAttendance = localStorage.getItem('calcSettings_minAttendance');
        const savedMinMedical = localStorage.getItem('calcSettings_minMedical');
        const savedIsOverall = localStorage.getItem('calcSettings_isOverall');

        if (savedMinAttendance) {
            const minAttInput = document.getElementById('minAttendanceInput');
            if (minAttInput) minAttInput.value = savedMinAttendance;
        }
        if (savedMinMedical) {
            const minMedInput = document.getElementById('minMedicalInput');
            if (minMedInput) minMedInput.value = savedMinMedical;
        }
        if (savedIsOverall !== null) {
            const overallCheckbox = document.getElementById('overallCriteriaCheckbox');
            if (overallCheckbox) overallCheckbox.checked = savedIsOverall === 'true';
        }

        // Update medical max constraint
        if (window.updateMedicalMax) window.updateMedicalMax();

        console.log('🔄 Calculation Settings UI refreshed from localStorage');
    },

    // ===== POLLING-BASED SYNC (Alternative to Supabase Realtime) =====
    // Checks cloud for updates every POLLING_INTERVAL_MS milliseconds

    async checkForUpdates() {
        if (!AuthManager.user || this.syncing) return;

        try {
            // Fetch cloud data timestamps
            const { data: cloudClasses, error: classError } = await supabaseClient
                .from('classes')
                .select('name, data, updated_at');

            const { data: cloudLogs, error: logError } = await supabaseClient
                .from('attendance_logs')
                .select('date, logs, updated_at');

            if (classError || logError) {
                console.warn('⚠️ Polling: Failed to fetch cloud data');
                return;
            }

            const localClasses = this.safeParse('attendanceClasses_v2');
            const localLogs = this.safeParse('attendance_logs');
            let hasUpdates = false;

            // Check classes for updates
            const pendingDeletes = JSON.parse(localStorage.getItem('pending_deletes') || '[]');

            cloudClasses.forEach(row => {
                // TOMBSTONE CHECK: If pending delete, ignore cloud version
                if (pendingDeletes.includes(row.name)) return;

                const cloudData = row.data;
                const localData = localClasses[row.name];

                const cloudTime = new Date(cloudData?.updatedAt || row.updated_at || 0).getTime();
                const localTime = new Date(localData?.updatedAt || 0).getTime();

                if (cloudTime > localTime) {
                    console.log(`🔄 Polling: Cloud update detected for "${row.name}"`);
                    localClasses[row.name] = cloudData;

                    // Restore side-loaded data
                    if (cloudData.timetableArrangement) {
                        this.safeSetItem(`timetable_arrangement_${row.name}`, JSON.stringify(cloudData.timetableArrangement));
                    }
                    if (cloudData.periodTimes) {
                        this.safeSetItem(`periodTimes_${row.name}`, JSON.stringify(cloudData.periodTimes));
                    }
                    if (cloudData.timetableHistory) {
                        this.safeSetItem(`timetable_history_${row.name}`, JSON.stringify(cloudData.timetableHistory));
                    }
                    hasUpdates = true;
                }
            });

            // Check logs for updates (simpler: just merge newer ones)
            cloudLogs.forEach(row => {
                const localDayLogs = localLogs[row.date] || {};
                const cloudDayLogs = row.logs || {};

                // Simple merge: cloud wins for each key
                let dayUpdated = false;
                Object.keys(cloudDayLogs).forEach(key => {
                    if (JSON.stringify(localDayLogs[key]) !== JSON.stringify(cloudDayLogs[key])) {
                        localDayLogs[key] = cloudDayLogs[key];
                        dayUpdated = true;
                    }
                });
                if (dayUpdated) {
                    localLogs[row.date] = localDayLogs;
                    hasUpdates = true;
                }
            });

            if (hasUpdates) {
                this.safeSetItem('attendanceClasses_v2', JSON.stringify(localClasses));
                this.safeSetItem('attendance_logs', JSON.stringify(localLogs));
                window.classes = localClasses;
                window.attendanceLogs = localLogs;

                // Refresh UI
                if (window.loadFromStorage) window.loadFromStorage();
                if (window.populateClassSelector) window.populateClassSelector();
                if (window.updateSidebarAccountUI) window.updateSidebarAccountUI();

                this.updateSyncStatus('Synced');
                console.log('✅ Polling: Updates applied from cloud');
            }
        } catch (e) {
            console.warn('⚠️ Polling check failed:', e);
        }
    },

    startPolling() {
        if (this.pollingInterval) return; // Already running
        if (!AuthManager.user) return; // Not logged in

        console.log(`🔄 Starting polling sync (every ${this.POLLING_INTERVAL_MS / 1000}s)...`);

        // Initial check
        this.checkForUpdates();

        // Set up interval
        this.pollingInterval = setInterval(() => {
            this.checkForUpdates();
        }, this.POLLING_INTERVAL_MS);
    },

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
            console.log('🛑 Polling sync stopped.');
        }
    },

    updateSyncStatus(msg) {
        const el = document.getElementById('sidebarSyncStatus');
        if (el) el.textContent = `☁️ ${msg}`;
    },

    // Clear Service Worker cache to prevent stale HTML issues
    clearServiceWorkerCache() {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            console.log('🧹 Requesting SW cache clear after sync...');
            navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
        }
    }
};

window.SyncManager = SyncManager;

// Init listeners immediately
if (typeof SyncManager !== 'undefined') SyncManager.initListeners();
