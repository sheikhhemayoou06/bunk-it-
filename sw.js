// ==================== FIREBASE CLOUD MESSAGING FOR SERVICE WORKER ====================
// Import Firebase compat libraries (required for service workers)
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

// Firebase config (same as in index.html)
const firebaseConfig = {
    apiKey: "AIzaSyA_AbhNHG3WkRjtKfoLkHvrZaWxhJf3Zyk",
    authDomain: "bunk-it-notifications.firebaseapp.com",
    projectId: "bunk-it-notifications",
    storageBucket: "bunk-it-notifications.firebasestorage.app",
    messagingSenderId: "360203480812",
    appId: "1:360203480812:web:9350364110a5db986c7fc9",
    measurementId: "G-DFTJC9Q81Z"
};

// Initialize Firebase in Service Worker
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Handle background push messages from FCM
messaging.onBackgroundMessage((payload) => {
    console.log('SW: Background message received:', payload);

    const notificationTitle = payload.notification?.title || '📚 Bunk it Notification';
    const notificationOptions = {
        body: payload.notification?.body || 'You have a new notification!',
        icon: '/icon-192x192.png',
        badge: '/notification-icon.png',
        tag: payload.data?.tag || 'fcm-notification',
        data: payload.data || { url: '/' }
    };

    return self.registration.showNotification(notificationTitle, notificationOptions);
});

// ==================== END FIREBASE CLOUD MESSAGING ====================

const CACHE_NAME = 'bunkit-v2.34';
const ASSETS_TO_CACHE = [
    // NOTE: index.html intentionally NOT cached to prevent stale data issues
    // The service worker will still serve it via network-first strategy
    './offline.html',
    './privacy.html',
    './terms.html',
    './about.html',
    './contact.html',
    './faq.html',
    './support.html',
    './manifest.json',
    './robots.txt',
    './sitemap.xml',
    './icon-192x192.png',
    './icon-512x512.png',
    './badge-icon.png',
    './notification-icon.png',
    './js/auth-manager.js',
    './js/sync-manager.js',
    './js/social-manager.js'
];

// External assets to cache at runtime
const EXTERNAL_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/chart.js/3.9.1/chart.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'
];

// Install Event: Cache core assets and external libraries
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching all: app shell and content');
            // Cache local assets
            cache.addAll(ASSETS_TO_CACHE);

            // Pre-cache external libraries (don't block on failure)
            EXTERNAL_ASSETS.forEach(url => {
                cache.add(url).catch(() => console.log('Optional cache failed:', url));
            });
        })
    );
    self.skipWaiting();
});

// Activate Event: Clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[Service Worker] Removing old cache', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch Event: Stale-While-Revalidate Strategy
self.addEventListener('fetch', (event) => {
    // Network First for API calls (if any local API), Cache First for static
    if (event.request.url.includes('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // Handle external scripts with Stale-While-Revalidate
    if (EXTERNAL_ASSETS.some(url => event.request.url.includes(url))) {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(event.request).then((cachedResponse) => {
                    const fetchPromise = fetch(event.request).then((networkResponse) => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    });
                    return cachedResponse || fetchPromise;
                });
            })
        );
        return;
    }

    // === IMPROVED: Network-first with timeout for HTML pages ===
    // Handle navigation requests (HTML pages)
    if (event.request.mode === 'navigate') {
        event.respondWith(
            (async () => {
                try {
                    // Try network first with 3 second timeout
                    const networkPromise = fetch(event.request);
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Network timeout')), 3000)
                    );

                    const response = await Promise.race([networkPromise, timeoutPromise]);

                    if (response && response.ok) {
                        // Cache the fresh response
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseClone);
                        });
                        return response;
                    }
                    throw new Error('Network response not ok');
                } catch (error) {
                    console.log('SW: Network failed, using cache:', error.message);
                    // Network failed or timed out - use cache
                    const cachedResponse = await caches.match(event.request);
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // No cache - try offline page
                    const offlinePage = await caches.match('./offline.html');
                    if (offlinePage) {
                        return offlinePage;
                    }
                    // Last resort - return error response
                    return new Response('App is offline and not cached', {
                        status: 503,
                        statusText: 'Offline'
                    });
                }
            })()
        );
        return;
    }

    // Handle other requests with cache-first strategy
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Return cached version immediately
                return cachedResponse;
            }

            // Not in cache, fetch from network
            return fetch(event.request)
                .then((networkResponse) => {
                    // Cache successful responses
                    if (networkResponse && networkResponse.status === 200) {
                        const responseClone = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseClone);
                        });
                    }
                    return networkResponse;
                })
                .catch(() => {
                    // Network failed, return offline fallback for images
                    if (event.request.destination === 'image') {
                        return caches.match('/icon-192x192.png');
                    }
                    return new Response('Offline', { status: 503, statusText: 'Offline' });
                });
        })
    );
});

// === BACKGROUND SYNC API (Required for PWABuilder detection) ===
// Handles sync events when the app comes back online
self.addEventListener('sync', (event) => {
    console.log('SW: Background sync event:', event.tag);

    if (event.tag === 'sync-attendance') {
        // Sync attendance data when coming back online
        event.waitUntil(syncAttendanceData());
    } else if (event.tag === 'sync-settings') {
        // Sync settings when coming back online
        event.waitUntil(syncSettings());
    } else {
        // Generic sync handler
        console.log('SW: Unknown sync tag:', event.tag);
    }
});

// Background sync helper functions
async function syncAttendanceData() {
    console.log('SW: Syncing attendance data...');
    // Data is stored locally in IndexedDB/localStorage
    // This would sync to a server if one existed
    // For now, just log that sync completed
    const logs = await getFromIndexedDB('attendance_logs');
    console.log('SW: Attendance data ready:', logs ? 'Found' : 'None');
    return Promise.resolve();
}

async function syncSettings() {
    console.log('SW: Syncing settings...');
    const settings = await getFromIndexedDB('notificationSettings');
    console.log('SW: Settings synced:', settings ? 'Found' : 'None');
    return Promise.resolve();
}

// === NOTIFICATION HANDLING ===

// Helper: Format date as YYYY-MM-DD in local timezone (matches log format)
function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Listen for messages from the main app
self.addEventListener('message', async (event) => {
    // Handle force refresh request
    if (event.data && event.data.type === 'FORCE_REFRESH') {
        console.log('SW: Force refresh requested');
        try {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map(name => caches.delete(name)));
            // Re-cache essentials
            const cache = await caches.open(CACHE_NAME);
            await cache.addAll(ASSETS_TO_CACHE);
            console.log('SW: Cache refreshed');
            // Notify all clients
            const clients = await self.clients.matchAll();
            clients.forEach(client => client.postMessage({ type: 'CACHE_REFRESHED' }));
        } catch (e) {
            console.error('SW: Force refresh failed:', e);
        }
    }

    // Handle skip waiting request (for auto-refresh on update)
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('SW: Skip waiting requested, activating immediately...');
        self.skipWaiting();
    }

    // Handle cache clear request
    if (event.data && event.data.type === 'CLEAR_CACHE') {
        console.log('SW: Clear cache requested');
        try {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map(name => caches.delete(name)));
            console.log('SW: All caches cleared');
        } catch (e) {
            console.error('SW: Cache clear failed:', e);
        }
    }

    if (event.data && event.data.type === 'CHECK_NOTIFICATION') {
        checkAndShowNotification();
    }

    if (event.data && event.data.type === 'SETTINGS_UPDATED') {
        // Verify we can read the settings
        const settings = await getFromIndexedDB('notificationSettings');
        if (settings) {
            console.log('SW: Settings updated and verified:', settings);
            // Optional: Schedule future notification using TimestampTrigger if available
            scheduleNextNotification(settings.time);
        }
    }

    if (event.data && event.data.type === 'SCHEDULE_NOTIFICATION') {
        const settings = await getFromIndexedDB('notificationSettings');
        if (settings && settings.enabled) {
            console.log('SW: Received schedule request from main app.');
            scheduleNextNotification(settings.time);
        }
    }

    if (event.data && event.data.type === 'KEEP_ALIVE') {
        // This message keeps the SW alive and triggers a check
        // console.log('SW: Keep-alive ping received');
        checkAndShowNotification();
        checkSmartReminders();
    }
});

// Experimental: Schedule Notification using TimestampTrigger
async function scheduleNextNotification(timeStr) {
    if (!('showTrigger' in Notification.prototype)) {
        return; // API not supported
    }

    const [targetHour, targetMinute] = timeStr.split(':').map(Number);
    const now = new Date();
    let target = new Date();
    target.setHours(targetHour, targetMinute, 0, 0);

    if (target <= now) {
        // Target is in the past, schedule for tomorrow
        target.setDate(target.getDate() + 1);
    }

    const timestamp = target.getTime();

    await self.registration.showNotification('📚 Attendance Log Reminder', {
        body: "Time to log today's attendance!",
        icon: '/icon-192x192.png',
        badge: '/badge-icon.png',
        tag: 'daily-log-scheduled', // Unique tag for scheduled one
        requireInteraction: true,
        showTrigger: new TimestampTrigger(timestamp), // The magic part
        data: {
            url: '/?openLog=true'
        }
    });

    console.log(`SW: Scheduled system notification for ${target.toLocaleString()}`);
}

// === PUSH EVENT HANDLER (Required for PWABuilder detection) ===
// This handles incoming push messages from a push server
self.addEventListener('push', (event) => {
    console.log('SW: Push event received', event);

    let data = {
        title: '📚 Bunk it Notification',
        body: 'You have a new notification!',
        icon: '/icon-192x192.png',
        badge: '/notification-icon.png'
    };

    // Try to parse push data if available
    if (event.data) {
        try {
            const pushData = event.data.json();
            data = { ...data, ...pushData };
        } catch (e) {
            // If not JSON, use text
            data.body = event.data.text() || data.body;
        }
    }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: data.icon || '/icon-192x192.png',
            badge: data.badge || '/notification-icon.png',
            tag: data.tag || 'push-notification',
            data: data.data || { url: '/' }
        })
    );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification.data || {};

    // "How was today?" notification
    if (data.kind === 'day-check' && data.date) {
        event.waitUntil(handleDayCheckClick(event.action, data));
        return;
    }

    event.waitUntil(
        (async () => {
            // Try to find an existing open window/tab
            const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

            // Filter for clients that are our app (not other sites)
            const appClients = allClients.filter(client =>
                client.url.includes(self.registration.scope) || client.url.includes(self.location.origin)
            );

            if (appClients.length > 0) {
                // Focus the first existing window and send message to open daily log
                const client = appClients[0];
                await client.focus();
                client.postMessage({ type: 'OPEN_DAILY_LOG' });
                console.log('SW: Focused existing window and sent OPEN_DAILY_LOG message');
            } else {
                // No existing window, open a new one
                await clients.openWindow('/?openLog=true');
                console.log('SW: Opened new window with openLog=true');
            }
        })()
    );
});

async function handleDayCheckClick(action, data) {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appClients = allClients.filter(c => c.url.startsWith(self.location.origin));
    const status = action === 'all-present' ? 'Attended' : action === 'all-absent' ? 'Skipped' : null;

    if (status) {
        if (appClients.length) {
            // App is open (even in the background): it saves and recalculates right away
            appClients[0].postMessage({ type: 'QUICK_MARK', date: data.date, status });
        } else {
            // App closed: queue it, the app applies it the next time it opens
            const queue = (await getFromIndexedDB('pendingQuickMarks')) || [];
            queue.push({ date: data.date, status, className: data.className, at: new Date().toISOString() });
            await saveToIndexedDB('pendingQuickMarks', queue);
        }
        await logForApp({
            icon: status === 'Attended' ? '✅' : '❌',
            title: `Marked all ${status === 'Attended' ? 'present' : 'absent'} from notification`,
            body: shortDate(data.date)
        });
        // Remember the day as marked so no second reminder comes
        const plan = await getFromIndexedDB('dayPlan');
        if (plan && Array.isArray(plan.logged) && !plan.logged.includes(data.date)) {
            plan.logged.push(data.date);
            await saveToIndexedDB('dayPlan', plan);
        }
        await self.registration.showNotification(status === 'Attended' ? '✅ Marked all present' : '❌ Marked all absent', {
            body: `${shortDate(data.date)} saved.${appClients.length ? ' Attendance updated.' : ' Your attendance updates when you open Bunk it.'}`,
            icon: '/icon-192x192.png',
            badge: '/badge-icon.png',
            tag: `day-check-done-${data.date}`,
            silent: true,
            data: { url: '/' }
        });
        return;
    }

    // Tapped the notification itself: open the in-app "How was today?" panel
    if (appClients.length) {
        await appClients[0].focus();
        appClients[0].postMessage({ type: 'OPEN_DAY_CHECK', date: data.date });
    } else {
        await clients.openWindow(`/?dayCheck=${data.date}`);
    }
}

// Check if it's time to show notification (per-class support)
async function checkAndShowNotification() {
    try {
        // Get notification settings from a client (if any is open)
        const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const isAppVisible = allClients.some(client => client.visibilityState === 'visible');

        if (isAppVisible) {
            // If app is OPEN and VISIBLE, let the main app handle it
            console.log('SW: App is visible, letting main thread handle notification.');
            return;
        }

        console.log('SW: App is closed or in background. Service Worker taking over.');

        // Get all classes data
        const classesData = await getFromIndexedDB('classesData');
        if (!classesData) {
            console.log('SW: No classes data found in IndexedDB');
            return;
        }

        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        const currentTotalMinutes = currentHour * 60 + currentMinute;
        const today = formatLocalDate(now);
        const todayString = now.toDateString();

        // Loop through each class
        for (const className in classesData) {
            if (!classesData.hasOwnProperty(className)) continue;

            const classData = classesData[className];

            // Skip if class has ended
            if (classData.lastDate && today > classData.lastDate) {
                console.log(`SW: ${className} - Class ended (${classData.lastDate})`);
                continue;
            }

            // Get per-class notification settings
            const settings = await getFromIndexedDB(`notificationSettings_${className}`);
            if (!settings || !settings.enabled) {
                console.log(`SW: ${className} - Notifications disabled or not configured`);
                continue;
            }

            const [targetHour, targetMinute] = settings.time.split(':').map(Number);
            const targetTotalMinutes = targetHour * 60 + targetMinute;

            // Check if we are at or past the target time
            if (currentTotalMinutes >= targetTotalMinutes) {
                const lastShownKey = `lastNotificationDate_${className}`;
                const lastShown = await getFromIndexedDB(lastShownKey);

                if (lastShown !== todayString) {
                    console.log(`SW: ${className} - Time to notify! (${settings.time})`);
                    await showNotificationForClass(className);
                    await saveToIndexedDB(lastShownKey, todayString);
                    // Only show one notification at a time
                    break;
                } else {
                    console.log(`SW: ${className} - Already shown today`);
                }
            } else {
                console.log(`SW: ${className} - Not time yet (${currentTotalMinutes} < ${targetTotalMinutes})`);
            }
        }
    } catch (error) {
        console.error('SW: Notification check error:', error);
    }
}

// Day plan mirrored by the app (js/day-check.js): { className, days: { date: classes }, logged: [dates] }
async function dayCheckFor(className, dateStr) {
    const plan = await getFromIndexedDB('dayPlan');
    if (!plan || plan.className !== className || !plan.days) return null; // unknown: fall back to plain reminder
    return { classes: plan.days[dateStr] || 0, logged: (plan.logged || []).includes(dateStr) };
}

function shortDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

// History shown in the app's notification center (merged when the app opens)
async function logForApp(entry) {
    try {
        const list = (await getFromIndexedDB('notificationLog')) || [];
        list.unshift({ at: new Date().toISOString(), ...entry });
        await saveToIndexedDB('notificationLog', list.slice(0, 40));
    } catch (e) { /* ignore */ }
}

async function showNotificationForClass(className) {
    const today = formatLocalDate(new Date());
    const check = await dayCheckFor(className, today);
    if (check) {
        // No classes today (holiday / weekend / outside semester) or already marked: stay quiet
        if (!check.classes || check.logged) return;
        await self.registration.showNotification('📚 How was today?', {
            body: `${shortDate(today)} · ${check.classes} class${check.classes !== 1 ? 'es' : ''} in ${className}. Mark all at once, or tap to mark each class.`,
            icon: '/icon-192x192.png',
            badge: '/badge-icon.png',
            tag: `day-check-${today}`,
            requireInteraction: true,
            actions: [
                { action: 'all-present', title: '✅ All Present' },
                { action: 'all-absent', title: '❌ All Absent' }
            ],
            data: { kind: 'day-check', date: today, className, url: `/?dayCheck=${today}` }
        });
        await logForApp({ icon: '📚', title: 'How was today?', body: `${shortDate(today)} · ${check.classes} class${check.classes !== 1 ? 'es' : ''} to mark` });
        return;
    }

    const title = '📚 Attendance Log Reminder';
    const options = {
        body: `Time to log today's attendance for ${className}!`,
        icon: '/icon-192x192.png',
        badge: '/badge-icon.png',
        tag: `daily-log-${className}`,
        requireInteraction: true,
        data: {
            url: '/?openLog=true',
            className: className
        }
    };

    await self.registration.showNotification(title, options);
    console.log(`SW: Notification shown for ${className}`);
}

// Cleanup orphaned notification settings for deleted classes
async function cleanupOrphanedNotificationSettings() {
    try {
        const classesData = await getFromIndexedDB('classesData');
        if (!classesData) return;

        const validClassNames = new Set(Object.keys(classesData));
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('BunkitDB', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = (event) => resolve(event.target.result);
        });

        const tx = db.transaction(['settings'], 'readwrite');
        const store = tx.objectStore('settings');
        const allKeys = await new Promise((resolve, reject) => {
            const request = store.getAllKeys();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        // Find and delete orphaned notification settings
        for (const key of allKeys) {
            if (typeof key === 'string' && key.startsWith('notificationSettings_')) {
                const className = key.replace('notificationSettings_', '');
                if (!validClassNames.has(className)) {
                    console.log(`SW: Cleaning up orphaned notification settings for deleted class: ${className}`);
                    store.delete(key);
                    // Also clean up lastNotificationDate for this class
                    store.delete(`lastNotificationDate_${className}`);
                }
            }
        }
    } catch (error) {
        console.error('SW: Error cleaning up orphaned notification settings:', error);
    }
}

// Keep old function for backward compatibility
async function showNotification() {
    await showNotificationForClass('your class');
}

// Simple IndexedDB helpers
async function getFromIndexedDB(key) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('BunkitDB', 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('settings')) {
                resolve(null);
                return;
            }

            const transaction = db.transaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const getRequest = store.get(key);

            getRequest.onsuccess = () => resolve(getRequest.result);
            getRequest.onerror = () => resolve(null);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings');
            }
        };
    });
}

async function saveToIndexedDB(key, value) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('BunkitDB', 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = (event) => {
            const db = event.target.result;
            const transaction = db.transaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');
            store.put(value, key);

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings');
            }
        };
    });
}

// ====== CONTEXT-AWARE SMART REMINDERS ======

// Analyze current attendance context
async function analyzeAttendanceContext() {
    try {
        const classData = await getFromIndexedDB('selectedClass');
        const logs = await getFromIndexedDB('attendance_logs') || {};
        const today = formatLocalDate(new Date());

        // Check if logged today
        const hasLoggedToday = logs[today] && Object.keys(logs[today]).length > 0;

        // Find low attendance subjects
        const lowAttendanceSubjects = [];
        if (classData && classData.subjects) {
            classData.subjects.forEach(subject => {
                const subjectLogs = Object.values(logs).flatMap(dayLog =>
                    dayLog[subject.code] ? [{ ...dayLog[subject.code], code: subject.code }] : []
                );

                const total = subjectLogs.length;
                const present = subjectLogs.filter(log => log.status === 'present').length;
                const percentage = total > 0 ? (present / total) * 100 : 100;

                if (percentage < 75) {
                    lowAttendanceSubjects.push({
                        code: subject.code,
                        name: subject.name,
                        percentage: percentage.toFixed(1),
                        buffer: Math.max(0, Math.ceil((0.75 * total - present) / 0.25))
                    });
                }
            });
        }

        // Calculate logging streak
        let streak = 0;
        const dates = Object.keys(logs).sort().reverse();
        for (const date of dates) {
            if (Object.keys(logs[date]).length > 0) {
                streak++;
            } else {
                break;
            }
        }

        // Days since last log
        // iOS-compatible date parsing (use slash format)
        const lastLogDate = dates[0] ? new Date(dates[0].replace(/-/g, '/')) : null;
        const daysSinceLastLog = lastLogDate && !isNaN(lastLogDate.getTime()) ?
            Math.floor((new Date() - lastLogDate) / (1000 * 60 * 60 * 24)) : 999;

        return {
            hasLoggedToday,
            lowAttendanceSubjects,
            currentStreak: streak,
            daysSinceLastLog
        };
    } catch (error) {
        console.error('Context analysis error:', error);
        return {
            hasLoggedToday: true,
            lowAttendanceSubjects: [],
            currentStreak: 0,
            daysSinceLastLog: 0
        };
    }
}

// Check if reminder was shown recently
async function wasReminderShownRecently(type, hours = 24) {
    try {
        const lastShown = await getFromIndexedDB(`reminder_${type}`);
        if (!lastShown) return false;

        // Validate timestamp before parsing to prevent errors from corrupted data
        const parsedDate = new Date(lastShown);
        const hoursSinceShown = !isNaN(parsedDate.getTime())
            ? (Date.now() - parsedDate.getTime()) / (1000 * 60 * 60)
            : Infinity;
        return hoursSinceShown < hours;
    } catch {
        return false;
    }
}

// Save reminder timestamp
async function saveReminderTimestamp(type) {
    try {
        await saveToIndexedDB(`reminder_${type}`, new Date().toISOString());
    } catch (error) {
        console.error('Error saving reminder timestamp:', error);
    }
}

// Show smart notification
async function showSmartNotification(type, context) {
    const configs = {
        UNLOGGED: {
            title: '📝 Attendance Reminder',
            body: "Don't forget to log today's attendance!",
            tag: 'unlogged-reminder'
        },
        LOW_ATTENDANCE: {
            title: `⚠️ ${context.subject.code} Attendance Alert`,
            body: `At ${context.subject.percentage}%! Only ${context.subject.buffer} class buffer left.`,
            tag: `low-${context.subject.code}`
        },
        STREAK: {
            title: '🔥 Streak Alert',
            body: `Don't break your ${context.streak}-day logging streak!`,
            tag: 'streak-reminder'
        },
        RETURN: {
            title: '👋 Welcome Back!',
            body: `Haven't seen you in ${context.days} days. Let's update your attendance!`,
            tag: 'return-reminder'
        },
        MILESTONE: {
            title: '🎉 Milestone Achieved!',
            body: `${context.subject.code} reached ${context.percentage}% attendance!`,
            tag: 'milestone'
        }
    };

    const config = configs[type];
    if (!config) return;

    await self.registration.showNotification(config.title, {
        body: config.body,
        icon: '/icon-192x192.png',
        badge: '/notification-icon.png',
        tag: config.tag,
        requireInteraction: type === 'LOW_ATTENDANCE',
        data: {
            type: 'SMART_REMINDER',
            context: type,
            url: '/'
        }
    });

    await saveReminderTimestamp(type);
}

// Check and trigger smart reminders
async function checkSmartReminders() {
    try {
        const settings = await getFromIndexedDB('smartReminderSettings');
        if (!settings || settings.enabled === false) return;

        const context = await analyzeAttendanceContext();
        const now = new Date();
        const hour = now.getHours();
        const day = now.getDay();

        // 1. Unlogged reminder (6-9 PM)
        if (!context.hasLoggedToday && hour >= 18 && hour < 21) {
            if (!await wasReminderShownRecently('UNLOGGED', 12)) {
                await showSmartNotification('UNLOGGED', context);
            }
        }

        // 2. Low attendance warnings
        for (const subject of context.lowAttendanceSubjects) {
            const key = `LOW_${subject.code}`;
            if (!await wasReminderShownRecently(key, 24)) {
                await showSmartNotification('LOW_ATTENDANCE', { subject });
            }
        }

        // 3. Streak reminder (8-9 PM)
        if (!context.hasLoggedToday && context.currentStreak >= 3 && hour >= 20 && hour < 21) {
            if (!await wasReminderShownRecently('STREAK', 12)) {
                await showSmartNotification('STREAK', { streak: context.currentStreak });
            }
        }

        // 4. Return from break (3+ days inactive)
        if (context.daysSinceLastLog >= 3 && hour >= 10 && hour < 12) {
            if (!await wasReminderShownRecently('RETURN', 48)) {
                await showSmartNotification('RETURN', { days: context.daysSinceLastLog });
            }
        }

    } catch (error) {
        console.error('Smart reminders error:', error);
    }
}

// Keep Service Worker alive and check for notifications
setInterval(() => {
    checkAndShowNotification();
    checkSmartReminders(); // NEW: Context-aware reminders
}, 60000);

// Also check immediately when SW starts
checkAndShowNotification();
checkSmartReminders(); // NEW: Also check smart reminders on start

// Set up periodic check (Chrome supports this)
if ('periodicSync' in self.registration) {
    self.addEventListener('periodicsync', (event) => {
        if (event.tag === 'check-notification') {
            event.waitUntil(Promise.all([
                checkAndShowNotification(),
                checkSmartReminders() // NEW: Include smart reminders
            ]));
        }
    });
}

// Fallback: Check every hour using a timer (when service worker wakes up)
setInterval(() => {
    checkAndShowNotification();
    checkSmartReminders(); // NEW: Hourly smart reminder check
    cleanupOrphanedNotificationSettings(); // Clean up orphaned settings for deleted classes
}, 3600000); // Every hour
