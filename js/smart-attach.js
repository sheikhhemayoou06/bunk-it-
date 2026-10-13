// ============================================================
// SMART SEARCH: ChatGPT-style image attachments + AI answers
// ============================================================
// "+" in the composer attaches images (attendance screenshot, timetable,
// academic / holiday calendar). Gemini reads and classifies each one; the
// answer shows the extracted data with one-tap actions (update attendance,
// use timetable, save timings, add holidays / exam days, set semester dates).
// Questions the built-in engine doesn't know are answered by the AI with
// the student's real attendance as context.
// Uses globals: SmartSearch._chat, classes, selectedClass, getPersonalGeminiKey,
// getSubjectAnalysis, attendanceSplit, getMinAttendanceCriteria, formatLocalDate,
// parseLocalDate, applyTimetableVersion, savePeriodTimes, processJsonAndCalculate,
// saveToStorage, triggerRecalculation, openAddClassModal, fillWizardFromAI.
// ============================================================
(function () {
    'use strict';

    const MAX_FILES = 4;
    let pending = [];          // [{ file, url }]
    const results = {};        // id -> extracted data (for action buttons)
    let seq = 0;

    const C = () => window.SmartSearch?._chat;
    const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    function clsName() {
        const n = document.getElementById('classSelector')?.value;
        return n && typeof classes !== 'undefined' && classes[n] ? n : null;
    }
    function today() { return formatLocalDate(new Date()); }
    function fmt(d) {
        try { return parseLocalDate(d).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }); } catch (e) { return d; }
    }
    const isoOk = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const timeOk = (t) => typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t);
    const pad = (t) => t.length === 4 ? '0' + t : t;

    // ---------- composer UI ----------
    function mountUI() {
        const bar = document.querySelector('#smartSearchPage .si-search-bar');
        const composer = document.querySelector('#smartSearchPage .si-composer');
        if (!bar || !composer || document.getElementById('siAttachBtn')) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'siAttachBtn';
        btn.className = 'si-attach-btn';
        btn.title = 'Add image (attendance, timetable, calendar)';
        btn.setAttribute('aria-label', 'Add image');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.onclick = () => openPicker();
        bar.insertBefore(btn, bar.firstChild);

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.hidden = true;
        input.id = 'siAttachInput';
        input.onchange = () => { addFiles([...input.files]); input.value = ''; };
        composer.appendChild(input);

        const strip = document.createElement('div');
        strip.id = 'siAttachStrip';
        strip.className = 'si-attach-strip';
        strip.hidden = true;
        composer.parentNode.insertBefore(strip, composer);

        // Paste an image straight into the box
        document.getElementById('siSearchInput')?.addEventListener('paste', e => {
            const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
            if (files.length) { e.preventDefault(); addFiles(files); }
        });

        // Send with attachments
        const orig = SmartSearch.handleSearchSubmit;
        SmartSearch.handleSearchSubmit = function (e) {
            if (pending.length) {
                if (e) e.preventDefault();
                const input2 = document.getElementById('siSearchInput');
                const q = (input2?.value || '').trim();
                if (input2) input2.value = '';
                analyse(q);
                return;
            }
            return orig.apply(this, arguments);
        };
    }

    function openPicker() {
        let el = document.getElementById('siAttachMenu');
        if (!el) {
            el = document.createElement('div');
            el.id = 'siAttachMenu';
            el.className = 'si-attach-menu-wrap';
            el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
            document.body.appendChild(el);
        }
        const opt = (icon, title, sub) => `<button type="button" class="si-am-opt" onclick="SmartAttach.pick()"><span class="si-am-ic"><i class="fa-solid ${icon}"></i></span><span><strong>${title}</strong><small>${sub}</small></span></button>`;
        el.innerHTML = `
            <div class="si-attach-menu" role="menu">
                <div class="si-am-grip"></div>
                <h3>Add an image</h3>
                <p>Bunkit reads it and tells you what it means for your attendance.</p>
                ${opt('fa-chart-column', 'Attendance screenshot', 'Checked against your class: skips, classes left, OD/ML')}
                ${opt('fa-table-cells', 'Timetable', 'Use it as your timetable and class timings')}
                ${opt('fa-calendar-days', 'Academic calendar', 'Semester dates, exams and holidays')}
                ${opt('fa-umbrella-beach', 'Holiday list', 'Adds holidays so skips are counted right')}
                <button type="button" class="si-am-cancel" onclick="document.getElementById('siAttachMenu').classList.remove('open')">Cancel</button>
            </div>`;
        requestAnimationFrame(() => el.classList.add('open'));
    }

    function pick() {
        document.getElementById('siAttachMenu')?.classList.remove('open');
        document.getElementById('siAttachInput')?.click();
    }

    function addFiles(files) {
        files.filter(f => f.type.startsWith('image/')).forEach(f => {
            if (pending.length >= MAX_FILES) return;
            pending.push({ file: f, url: URL.createObjectURL(f) });
        });
        if (files.length && pending.length >= MAX_FILES && typeof showToast === 'function') showToast(`Up to ${MAX_FILES} images at a time`, '', { duration: 2500 });
        renderStrip();
        document.getElementById('siSearchInput')?.focus();
    }

    function removeFile(i) {
        const it = pending.splice(i, 1)[0];
        if (it) URL.revokeObjectURL(it.url);
        renderStrip();
    }

    function renderStrip() {
        const strip = document.getElementById('siAttachStrip');
        if (!strip) return;
        strip.hidden = !pending.length;
        strip.innerHTML = pending.map((p, i) => `
            <div class="si-attach-thumb">
                <img src="${p.url}" alt="Attached image ${i + 1}">
                <button type="button" onclick="SmartAttach.remove(${i})" aria-label="Remove image"><i class="fa-solid fa-xmark"></i></button>
            </div>`).join('') + (pending.length ? `<span class="si-attach-hint">Add a question, or just press send</span>` : '');
        const input = document.getElementById('siSearchInput');
        if (input) input.placeholder = pending.length ? 'Ask about this image… (optional)' : 'Ask anything…';
    }

    // ---------- image → AI ----------
    // Shrink to ≤1600 px JPEG so uploads stay small and fast
    function compress(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(img.width * scale));
                c.height = Math.max(1, Math.round(img.height * scale));
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                URL.revokeObjectURL(url);
                resolve({ data: c.toDataURL('image/jpeg', 0.85).split(',')[1], mimeType: 'image/jpeg' });
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be opened.")); };
            img.src = url;
        });
    }

    // This site's proxy first; if it is missing (local server) or has no keys
    // (a preview deployment), the live app's proxy. Busy answers are retried.
    const PROXIES = ['/api/gemini', 'https://www.bunkitapp.in/api/gemini'];
    async function proxyFetch(body) {
        let last;
        for (const url of PROXIES) {
            if (url.startsWith('http') && location.origin === new URL(url).origin) continue;
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    last = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
                } catch (e) { last = null; break; } // network error: try the next proxy
                if (last.ok) return last;
                // Busy / rate-limited: wait 1.5 s, 3 s, 6 s before asking again
                if (last.status === 503 || last.status === 429) {
                    // A used-up daily quota won't come back in seconds: stop retrying
                    try { if (/quota/i.test((await last.clone().json()).error || '')) break; } catch (e) { /* not JSON */ }
                    if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * 2 ** attempt));
                    continue;
                }
                break;
            }
            if (last && last.status !== 404 && last.status !== 405 && last.status !== 500 && last.status !== 503) return last;
        }
        if (!last) throw new Error("Couldn't reach the AI. Check your internet connection and try again.");
        return last;
    }

    async function callGemini(prompt, images) {
        const key = typeof getPersonalGeminiKey === 'function' ? getPersonalGeminiKey() : localStorage.getItem('personalGeminiKey');
        let res;
        if (key) {
            res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }, ...images.map(im => ({ inline_data: { mime_type: im.mimeType, data: im.data } }))] }],
                    generationConfig: { temperature: images.length ? 0.1 : 0.4, maxOutputTokens: 8192 }
                })
            });
        } else {
            res = await proxyFetch(JSON.stringify(images.length ? { action: 'vision-multi', prompt, images } : { action: 'chat', prompt }));
        }
        if (!res.ok) {
            let msg = `AI error ${res.status}`;
            try { const j = await res.json(); msg = j.error || msg; } catch (e) { /* ignore */ }
            if (res.status === 429) msg = 'The AI is busy right now. Try again in a minute, or add your own Gemini key in Profile → Preferences.';
            if (res.status === 503) msg = 'The AI is very busy right now. Please try again in a minute.';
            if (res.status === 404 || /not configured/i.test(msg)) msg = "The AI isn't available here right now. Add your own Gemini key in Profile → Preferences, or try again later.";
            throw new Error(msg);
        }
        const json = await res.json();
        return json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    }

    function parseJSON(text) {
        let t = String(text || '').trim();
        const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) t = fence[1];
        const a = t.indexOf('{'), b = t.lastIndexOf('}');
        if (a >= 0 && b > a) t = t.slice(a, b + 1);
        return JSON.parse(t);
    }

    function contextLines() {
        const name = clsName();
        if (!name) return 'The student has not set up a class yet.';
        const c = classes[name];
        const subs = (c.subjects || []).map(s => `${s.code}: ${s.name}`).join('; ');
        return `Class "${name}". Subjects (code: name): ${subs}. Semester: ${c.portalSetup?.semesterStartDate || 'start unknown'} to ${c.lastDate || 'end unknown'}. Minimum attendance ${Math.round(getMinAttendanceCriteria() * 100)}%.`;
    }

    function imagePrompt(question) {
        return `You read images for Bunkit, a college attendance app. Today is ${today()}.
${contextLines()}

Look at the image(s) and decide what each shows, then extract the data. Return ONLY one JSON object, no markdown:
{
 "type": "attendance" | "timetable" | "academic_calendar" | "holiday_list" | "other",
 "summary": "one short sentence describing what the image shows",
 "attendance": [{"code": "", "name": "", "present": 0, "total": 0, "odml": 0}],
 "timetable": {"days": {"Mon": [{"period": 1, "code": "", "name": "", "start": "HH:MM", "end": "HH:MM"}], "Tue": [], "Wed": [], "Thu": [], "Fri": [], "Sat": []}},
 "holidays": [{"date": "YYYY-MM-DD", "name": ""}],
 "exams": [{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "title": ""}],
 "semesterStart": "YYYY-MM-DD or null",
 "lastWorkingDay": "YYYY-MM-DD or null",
 "answer": "${question ? 'a short, direct answer to the student question below, using the image and the class data' : ''}"
}
Rules:
- Use the class subject codes above whenever a subject matches by code or name. Otherwise keep the code shown in the image.
- "present" = classes attended as the portal counts them, including OD/ML (duty / medical leave) hours. "total" = classes held (conducted). "odml" = OD/ML hours inside "present" (0 if none shown). If the portal lists OD/ML separately and does not include them in attended, add them to "present". Use 24-hour HH:MM times.
- For calendars, list every holiday / no-class day with its date; ranges become one entry per day. Exams, CATs, mid-terms and practical exams go in "exams".
- Infer missing years from the semester or today's date. Leave sections that don't apply as empty arrays / null.
${question ? `When answering, compare the image with the student's numbers tracked in Bunkit:\n${attendanceContext()}\nStudent question: "${question}"` : ''}`;
    }

    // ---------- send ----------
    async function analyse(question) {
        const chat = C();
        if (!chat || !pending.length) return;
        const files = pending.slice();
        pending = [];
        renderStrip();

        document.querySelector('#siAnswerSection .si-chat-empty')?.remove();
        const imgs = `<div class="si-msg-images">${files.map(f => `<img src="${f.url}" alt="Attached image">`).join('')}</div>`;
        const userEl = chat.appendUserMessage(question, imgs);
        chat.updateNewChatBtn && chat.updateNewChatBtn();
        const thinking = chat.appendThinking();
        const t = thinking.querySelector('.si-thinking');
        if (t) t.innerHTML = `<span class="si-thinking-dots"><span></span><span></span><span></span></span> <span class="si-think-step">Reading ${files.length > 1 ? `${files.length} images` : 'your image'}…</span>`;
        chat.scrollThread && chat.scrollThread(userEl);
        const steps = ['Finding subjects, dates and periods…', 'Checking it against your class…', 'Working out what it means for you…'];
        let si = 0;
        const stepTimer = setInterval(() => { const el = thinking.querySelector('.si-think-step'); if (el && si < steps.length) el.textContent = steps[si++]; }, 2600);

        let result;
        try {
            const images = await Promise.all(files.map(f => compress(f.file)));
            // A cut-off or malformed reply is asked again once
            let data;
            for (let attempt = 0; !data; attempt++) {
                try { data = parseJSON(await callGemini(imagePrompt(question), images)); }
                catch (e) { if (attempt >= 1 || !(e instanceof SyntaxError)) throw e; }
            }
            result = buildAnswer(data, question);
        } catch (e) {
            result = {
                iconClass: 'danger', title: "Couldn't read that image",
                body: `<p>${esc(e instanceof SyntaxError ? "The AI's reply was incomplete. Please send the image again." : (e.message || 'Something went wrong.'))}</p><p style="margin-top:8px;">Use a clear, uncropped photo or screenshot. Make sure the attendance table is fully visible.</p>`
            };
        }
        clearInterval(stepTimer);
        chat.renderAnswer(result, thinking, question || 'image');
    }

    // ---------- answers ----------
    // Match an image subject to a class subject: code, name words, or acronym (FLA, PQT)
    const STOP = new Set(['and', 'of', 'the', 'in', 'for', 'to', 'a', 'an', 'lab', 'theory', 'practical']);
    const words = (x) => String(x || '').toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w));
    // Acronyms keep words like "Theory" (Probability and Queueing Theory → PQT)
    const acronym = (x) => String(x || '').toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/)
        .filter(w => w && !['and', 'of', 'the', 'in', 'for', 'to', 'a', 'an'].includes(w)).map(w => w[0]).join('');
    function mapCode(code, name) {
        const c = classes[clsName()];
        if (!c) return code || name;
        const subs = c.subjects || [];
        const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const byCode = subs.find(s => norm(s.code) && (norm(s.code) === norm(code) || norm(s.code) === norm(name)));
        if (byCode) return byCode.code;
        const w1 = words(name);
        let best = null, bestScore = 0;
        subs.forEach(s => {
            const w2 = words(s.name);
            if (!w2.length) return;
            const common = w1.filter(w => w2.includes(w)).length;
            let score = w1.length ? common / Math.max(w1.length, w2.length) : 0;
            const acr = acronym(s.name);
            if (acr && (acr === norm(name) || acr === norm(code) || (w1.length > 1 && acronym(name) === acr))) score = Math.max(score, 0.9);
            if (score > bestScore) { bestScore = score; best = s; }
        });
        return best && bestScore >= 0.6 ? best.code : (code || name);
    }

    function buildAnswer(d, question) {
        const id = `r${++seq}`;
        results[id] = d;
        const name = clsName();
        const parts = [];
        const actions = [];
        const min = Math.round(getMinAttendanceCriteria() * 100);
        const types = new Set([d.type]);
        if ((d.attendance || []).length) types.add('attendance');
        if (Object.values(d.timetable?.days || {}).some(a => (a || []).length)) types.add('timetable');
        if ((d.holidays || []).length || (d.exams || []).length || d.lastWorkingDay || d.semesterStart) types.add('calendar');

        if (d.answer && question) parts.push(`<div class="si-ai-answer"><i class="fa-solid fa-wand-magic-sparkles"></i><p>${esc(d.answer)}</p></div>`);

        // Attendance: portal numbers from the image, worked out with the class data
        // (classes left until the last working day, OD/ML rule, numbers tracked in Bunkit)
        const att = (d.attendance || []).filter(a => a && Number(a.total) > 0);
        if (att.length) {
            const data = C().getAttendanceData() || [];
            const m = min / 100;
            let rows = '', tHeld = 0, tEff = 0, tRem = 0, tSkip = 0, atRisk = 0, differ = 0, lowest = null;
            const notInClass = [];
            att.forEach(a => {
                const code = mapCode(a.code, a.name);
                const total = Number(a.total);
                const attended = Math.min(Number(a.present) || 0, total);
                const odml = Math.min(Number(a.odml) || 0, attended);
                const known = data.find(x => x.code === code);
                if (name && !known) notInClass.push(a.name || a.code);
                const remaining = known ? Number(known.remaining) || 0 : 0;
                const sp = typeof attendanceSplit === 'function' ? attendanceSplit(attended, total, odml, remaining) : { withPct: attended / total * 100, withoutPct: (attended - odml) / total * 100 };
                const pct = sp.withPct;
                tHeld += total; tEff += pct / 100 * total; tRem += remaining;
                let verdict, tone, sub = '';
                if (known) {
                    const st = getSubjectAnalysis(attended, total, remaining, null, odml).stats;
                    const skip = Math.max(0, st.maxSkippable);
                    tSkip += skip;
                    if (!lowest || skip < lowest.skip) lowest = { name: a.name || code, skip };
                    if (st.stillNeed > remaining) { verdict = `Can't reach ${min}%`; tone = 'danger'; atRisk++; }
                    else if (pct < min) { verdict = `Attend ${st.stillNeed} more`; tone = 'warning'; atRisk++; }
                    else { verdict = `Can skip ${skip}`; tone = skip <= 2 ? 'warning' : 'safe'; }
                    sub = `${remaining} left · end ${st.projectedMinPercent.toFixed(0)}–${st.projectedMaxPercent.toFixed(0)}%`;
                    // Compare with what Bunkit has tracked for this subject
                    if (Number(known.attended) !== attended || Number(known.totalHeld) !== total) {
                        differ++;
                        const dh = total - (Number(known.totalHeld) || 0);
                        sub += `<br><span style="color:var(--si-warning)">Bunkit: ${known.attended}/${known.totalHeld}${dh ? ` (${dh > 0 ? '+' : ''}${dh} held on portal)` : ''}</span>`;
                    }
                } else {
                    const k = Math.floor((attended - m * total) / m + 1e-9);
                    verdict = pct >= min ? `Skip ${Math.max(0, k)} now` : `Attend ${Math.ceil((m * total - attended) / (1 - m))} in a row`;
                    tone = pct >= min ? (pct >= min + 5 ? 'safe' : 'warning') : 'danger';
                    if (pct < min) atRisk++;
                    if (name) sub = 'Not in your class';
                }
                const color = pct >= min ? (pct >= min + 5 ? 'success' : 'warning') : 'danger';
                rows += `<tr><td><strong>${esc(a.name || code)}</strong><br><small style="opacity:.7">${esc(code)}</small></td><td>${attended}/${total}${odml ? `<br><small style="opacity:.7">${odml} OD/ML</small>` : ''}</td><td><strong style="color:var(--si-${color})">${pct.toFixed(1)}%</strong>${odml && Math.abs(sp.withoutPct - pct) > 0.05 ? `<br><small style="opacity:.7">${sp.withoutPct.toFixed(1)}% own</small>` : ''}</td><td><span class="si-badge ${tone}">${esc(verdict)}</span>${sub ? `<br><small style="opacity:.75">${sub}</small>` : ''}</td></tr>`;
            });
            const overall = tHeld ? tEff / tHeld * 100 : 0;
            const oTone = overall >= min ? (overall >= min + 5 ? 'safe' : 'warning') : 'danger';
            const headline = !name ? `Minimum ${min}% · add your class for skips till the semester ends`
                : atRisk ? `<strong>${atRisk}</strong> subject${atRisk !== 1 ? 's need' : ' needs'} attention`
                : `You can skip <strong>${tSkip}</strong> class${tSkip !== 1 ? 'es' : ''} this semester`;
            parts.push(`
                <h4 class="si-ai-h"><i class="fa-solid fa-chart-column"></i> Attendance from your screenshot</h4>
                <div class="si-stats-grid">
                    <div class="si-stat-tile"><div class="si-stat-value ${oTone}">${overall.toFixed(1)}%</div><div class="si-stat-label">Overall (min ${min}%)</div></div>
                    ${name ? `<div class="si-stat-tile"><div class="si-stat-value ${atRisk ? 'danger' : 'safe'}">${atRisk ? atRisk : tSkip}</div><div class="si-stat-label">${atRisk ? 'Subjects at risk' : 'Classes you can skip'}</div></div>
                    <div class="si-stat-tile"><div class="si-stat-value info">${tRem}</div><div class="si-stat-label">Classes left</div></div>` : ''}
                </div>
                <p style="margin:8px 0;">${headline}${lowest && !atRisk && name ? ` · lowest margin: ${esc(lowest.name)} (${lowest.skip})` : ''}</p>
                <table class="si-subject-table"><thead><tr><th>Subject</th><th>Attended</th><th>%</th><th>For you</th></tr></thead><tbody>${rows}</tbody></table>
                ${differ ? `<p class="si-ai-note"><i class="fa-solid fa-triangle-exclamation"></i> ${differ} subject${differ !== 1 ? 's' : ''} differ from what Bunkit has tracked. Tap <strong>Match my class</strong> to use the portal numbers.</p>` : name ? '<p class="si-ai-note"><i class="fa-solid fa-check"></i> Matches what Bunkit has tracked.</p>' : ''}
                ${notInClass.length ? `<p class="si-ai-note">Not in your class: ${esc(notInClass.join(', '))}</p>` : ''}
                ${name ? '<p class="si-ai-note">"Can skip" and the end-of-semester range count your timetable up to the last working day, with your OD/ML rule.</p>' : ''}`);
            if (name) {
                actions.push(`<button class="si-ai-act primary" onclick="SmartAttach.act('${id}','match')"><i class="fa-solid fa-link"></i> Match my class</button>`);
                actions.push(`<button class="si-ai-act" onclick="SmartAttach.act('${id}','attendance')"><i class="fa-solid fa-chart-pie"></i> Full analysis</button>`);
            }
        }

        // Timetable
        const days = d.timetable?.days || {};
        const dayLists = DAY_NAMES.map(n => (days[n] || days[n.toLowerCase()] || []).filter(x => x && (x.code || x.name)).sort((x, y) => (x.period || 0) - (y.period || 0)));
        if (dayLists.some(l => l.length)) {
            const maxP = Math.max(...dayLists.map(l => Math.max(0, ...l.map(x => x.period || 0), l.length)));
            const used = DAY_NAMES.map((n, i) => i).filter(i => dayLists[i].length);
            let body = '';
            for (let p = 1; p <= maxP; p++) {
                const any = dayLists.flat().find(x => (x.period || 0) === p && x.start);
                body += `<tr><td><strong>P${p}</strong>${any ? `<br><small style="opacity:.7">${esc(any.start)}${any.end ? '–' + esc(any.end) : ''}</small>` : ''}</td>${used.map(i => {
                    const x = dayLists[i].find(y => (y.period || 0) === p);
                    return `<td>${x ? esc(mapCode(x.code, x.name)) : '<span style="opacity:.4">—</span>'}</td>`;
                }).join('')}</tr>`;
            }
            parts.push(`
                <h4 class="si-ai-h"><i class="fa-solid fa-table-cells"></i> Timetable</h4>
                <table class="si-subject-table si-tt-table"><thead><tr><th>Period</th>${used.map(i => `<th>${DAY_NAMES[i]}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`);
            const hasTimes = dayLists.flat().some(x => timeOk(x.start) && timeOk(x.end));
            if (name) {
                actions.push(`<button class="si-ai-act primary" onclick="SmartAttach.act('${id}','timetable')"><i class="fa-solid fa-calendar-check"></i> Use as my timetable</button>`);
                if (hasTimes) actions.push(`<button class="si-ai-act" onclick="SmartAttach.act('${id}','timings')"><i class="fa-regular fa-clock"></i> Save class timings</button>`);
            } else {
                actions.push(`<button class="si-ai-act primary" onclick="SmartAttach.act('${id}','createClass')"><i class="fa-solid fa-plus"></i> Create my class from this</button>`);
            }
        }

        // Calendar: holidays, exams, semester dates
        const c = name ? classes[name] : null;
        const hol = (d.holidays || []).filter(h => h && isoOk(h.date));
        const ex = (d.exams || []).filter(e => e && isoOk(e.from));
        if (hol.length || ex.length || isoOk(d.lastWorkingDay) || isoOk(d.semesterStart)) {
            const newHol = c ? hol.filter(h => !(c.holidays || []).includes(h.date)) : hol;
            const upcoming = hol.filter(h => h.date >= today());
            let html = `<h4 class="si-ai-h"><i class="fa-solid fa-calendar-days"></i> Calendar</h4>`;
            if (isoOk(d.semesterStart) || isoOk(d.lastWorkingDay)) {
                html += `<div class="si-stats-grid">
                    ${isoOk(d.semesterStart) ? `<div class="si-stat-tile"><div class="si-stat-value info" style="font-size:1rem">${fmt(d.semesterStart)}</div><div class="si-stat-label">Semester start</div></div>` : ''}
                    ${isoOk(d.lastWorkingDay) ? `<div class="si-stat-tile"><div class="si-stat-value info" style="font-size:1rem">${fmt(d.lastWorkingDay)}</div><div class="si-stat-label">Last working day</div></div>` : ''}
                    ${hol.length ? `<div class="si-stat-tile"><div class="si-stat-value safe">${hol.length}</div><div class="si-stat-label">Holidays (${upcoming.length} ahead)</div></div>` : ''}
                </div>`;
            }
            if (hol.length) html += `<table class="si-subject-table"><thead><tr><th>Holiday</th><th>Date</th><th>Status</th></tr></thead><tbody>${hol.slice(0, 40).map(h => `<tr><td>${esc(h.name || 'Holiday')}</td><td>${fmt(h.date)}</td><td>${c && (c.holidays || []).includes(h.date) ? '<span class="si-badge info">Already added</span>' : h.date < today() ? '<span class="si-badge" style="opacity:.6">Past</span>' : '<span class="si-badge safe">New</span>'}</td></tr>`).join('')}</tbody></table>`;
            if (ex.length) html += `<table class="si-subject-table"><thead><tr><th>Exam</th><th>Dates</th></tr></thead><tbody>${ex.map(e => `<tr><td>${esc(e.title || 'Exam')}</td><td>${fmt(e.from)}${e.to && e.to !== e.from ? ' → ' + fmt(e.to) : ''}</td></tr>`).join('')}</tbody></table>`;
            parts.push(html);
            if (c) {
                if (newHol.length) actions.push(`<button class="si-ai-act primary" onclick="SmartAttach.act('${id}','holidays')"><i class="fa-solid fa-umbrella-beach"></i> Add ${newHol.length} holiday${newHol.length !== 1 ? 's' : ''}</button>`);
                if (ex.length) actions.push(`<button class="si-ai-act" onclick="SmartAttach.act('${id}','exams')"><i class="fa-solid fa-file-pen"></i> Add ${ex.length} exam${ex.length !== 1 ? 's' : ''}</button>`);
                if (isoOk(d.lastWorkingDay) && d.lastWorkingDay !== c.lastDate) actions.push(`<button class="si-ai-act" onclick="SmartAttach.act('${id}','lastDate')"><i class="fa-solid fa-flag-checkered"></i> Set last day ${fmt(d.lastWorkingDay)}</button>`);
                if (isoOk(d.semesterStart) && d.semesterStart !== c.portalSetup?.semesterStartDate) actions.push(`<button class="si-ai-act" onclick="SmartAttach.act('${id}','semStart')"><i class="fa-solid fa-play"></i> Set start ${fmt(d.semesterStart)}</button>`);
            }
        }

        if (!parts.length) {
            parts.push(`<p>${esc(d.summary || "I couldn't find attendance, a timetable or calendar dates in this image.")}</p><p style="margin-top:8px;">Try a clearer screenshot of your attendance page, timetable or academic calendar.</p>`);
        }
        const kind = types.has('attendance') ? 'Attendance' : types.has('timetable') ? 'Timetable' : types.has('calendar') ? (d.type === 'holiday_list' ? 'Holiday list' : 'Academic calendar') : 'Image';
        return {
            iconClass: parts.length && actions.length ? 'info' : 'safe',
            title: `${kind} read${d.summary ? ` · ${String(d.summary).slice(0, 70)}` : ''}`,
            body: `${parts.join('')}${actions.length ? `<div class="si-ai-actions" id="act_${id}">${actions.join('')}</div>` : ''}${!name && (types.has('attendance') || types.has('calendar')) ? '<p class="si-ai-note">Add your class to save these results.</p>' : ''}`
        };
    }

    // ---------- actions ----------
    function done(id, kind, text) {
        const box = document.getElementById(`act_${id}`);
        const btn = box && [...box.querySelectorAll('button')].find(b => b.getAttribute('onclick')?.includes(`'${kind}'`));
        if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-check"></i> ${text}`; btn.classList.add('done'); }
        try { if (typeof triggerRecalculation === 'function') triggerRecalculation(); } catch (e) { /* ignore */ }
        try { if (typeof renderDashboard === 'function') renderDashboard(); } catch (e) { /* ignore */ }
        if (typeof showToast === 'function') showToast('Saved', text, { duration: 2500 });
    }

    // New timings from an image keep the lunch break the student set
    function keepLunch(name, times) {
        const lunch = typeof getPeriodTimes === 'function' ? (getPeriodTimes(name) || {}).lunch : null;
        return lunch ? { ...times, lunch } : times;
    }

    function act(id, kind) {
        const d = results[id];
        const name = clsName();
        if (!d) return;
        const c = name ? classes[name] : null;
        const save = () => { if (c) c.updatedAt = Date.now(); if (typeof saveToStorage === 'function') saveToStorage(); };

        if (kind === 'attendance' && c) {
            const json = {};
            (d.attendance || []).filter(a => a && Number(a.total) > 0).forEach(a => {
                const present = Math.min(Number(a.present) || 0, Number(a.total));
                json[mapCode(a.code, a.name)] = { name: a.name, present, total: Number(a.total), odml: Math.min(Number(a.odml) || 0, present) };
            });
            try { window.resultsTableOnly = true; } catch (e) { /* ignore */ }
            if (typeof processJsonAndCalculate === 'function') processJsonAndCalculate(json);
            done(id, kind, 'Analysis opened');
        }

        // Portal numbers become the class baseline up to today (same as Scan → Match my class)
        if (kind === 'match' && c) {
            const baseline = {};
            const known = new Set((c.subjects || []).map(s => s.code));
            (d.attendance || []).filter(a => a && Number(a.total) > 0).forEach(a => {
                const code = mapCode(a.code, a.name);
                if (!known.has(code)) return;
                const attended = Math.min(Number(a.present) || 0, Number(a.total));
                baseline[code] = { attended, total: Number(a.total), odml: Math.min(Number(a.odml) || 0, attended), exact: true };
            });
            const n = Object.keys(baseline).length;
            if (!n) { alert("None of the subjects in the screenshot match your class's subjects."); return; }
            if (!confirm(`Use these portal numbers for ${n} subject${n !== 1 ? 's' : ''}?\n\nEverything up to today (${today()}) will match the portal exactly. Classes you mark from tomorrow are added on top.`)) return;
            c.portalSetup = { ...(c.portalSetup || {}), active: true, baselineDate: today(), baselineData: baseline };
            if (selectedClass && selectedClass !== c && selectedClass.name === name) selectedClass.portalSetup = c.portalSetup;
            save();
            if (window.SyncManager) { try { SyncManager.uploadAll(); } catch (e) { /* offline */ } }
            try { if (typeof recalculateEverything === 'function') recalculateEverything({ quiet: true }); } catch (e) { /* ignore */ }
            done(id, kind, `Matched ${n} subject${n !== 1 ? 's' : ''} to portal`);
        }

        if ((kind === 'timetable' || kind === 'timings') && c) {
            const days = d.timetable?.days || {};
            const known = new Set((c.subjects || []).map(s => s.code));
            const arr = {}, times = {}, unknown = new Set();
            DAY_NAMES.forEach((n, i) => {
                const list = (days[n] || days[n.toLowerCase()] || []).filter(x => x && (x.code || x.name));
                const out = [];
                list.forEach((x, k) => {
                    const p = (x.period || k + 1) - 1;
                    const code = mapCode(x.code, x.name);
                    if (known.has(code)) out[p] = code; else { out[p] = out[p] || null; unknown.add(x.name || x.code); }
                    if (timeOk(x.start) && timeOk(x.end) && !times[p]) times[p] = { start: pad(x.start), end: pad(x.end) };
                });
                for (let p = 0; p < out.length; p++) if (out[p] === undefined) out[p] = null;
                arr[i] = out;
            });
            if (kind === 'timetable') {
                if (typeof applyTimetableVersion === 'function') applyTimetableVersion(name, arr, today(), null);
                else localStorage.setItem(`timetable_arrangement_${name}`, JSON.stringify(arr));
                if (Object.keys(times).length && typeof savePeriodTimes === 'function') savePeriodTimes(name, keepLunch(name, times));
                save();
                done(id, kind, `Timetable applied from today${unknown.size ? ` · ${unknown.size} unknown subject${unknown.size !== 1 ? 's' : ''} skipped` : ''}`);
            } else {
                if (typeof savePeriodTimes === 'function') savePeriodTimes(name, keepLunch(name, times));
                done(id, kind, `${Object.keys(times).length} class timings saved`);
            }
            if (window.ClassReminders) ClassReminders.tick();
        }

        if (kind === 'createClass') {
            const days = d.timetable?.days || {};
            const subs = {};
            const arr = {};
            DAY_NAMES.forEach((n, i) => {
                const list = (days[n] || days[n.toLowerCase()] || []).filter(x => x && (x.code || x.name));
                arr[i] = [];
                list.forEach((x, k) => {
                    const code = String(x.code || x.name).trim().toUpperCase().replace(/\s+/g, '').slice(0, 12);
                    subs[code] = subs[code] || { code, name: x.name || code, schedule: [0, 0, 0, 0, 0, 0, 0] };
                    subs[code].schedule[i]++;
                    arr[i][(x.period || k + 1) - 1] = code;
                });
            });
            if (typeof openAddClassModal === 'function') openAddClassModal();
            setTimeout(() => {
                if (typeof fillWizardFromAI === 'function') fillWizardFromAI({
                    subjects: Object.values(subs), holidays: (d.holidays || []).map(h => h.date).filter(isoOk),
                    lastDate: isoOk(d.lastWorkingDay) ? d.lastWorkingDay : undefined, startDate: isoOk(d.semesterStart) ? d.semesterStart : undefined
                }, arr);
            }, 300);
        }

        if (kind === 'holidays' && c) {
            const add = (d.holidays || []).map(h => h && h.date).filter(x => isoOk(x) && !(c.holidays || []).includes(x));
            c.holidays = [...new Set([...(c.holidays || []), ...add])].sort();
            if (selectedClass && selectedClass !== c && selectedClass.name === name) selectedClass.holidays = c.holidays;
            save();
            done(id, kind, `${add.length} holiday${add.length !== 1 ? 's' : ''} added`);
        }

        if (kind === 'exams' && c) {
            const list = c.examDays = c.examDays || [];
            let n = 0;
            (d.exams || []).filter(e => e && isoOk(e.from)).forEach(e => {
                if (list.some(x => x.from === e.from && (x.title || '') === (e.title || ''))) return;
                list.push({ from: e.from, to: isoOk(e.to) ? e.to : e.from, title: e.title || 'Exam' });
                n++;
            });
            save();
            done(id, kind, `${n} exam${n !== 1 ? 's' : ''} added`);
        }

        if (kind === 'lastDate' && c && isoOk(d.lastWorkingDay)) {
            c.lastDate = d.lastWorkingDay;
            const el = document.getElementById('lastDate'); if (el) el.value = c.lastDate;
            save();
            done(id, kind, `Last working day: ${fmt(c.lastDate)}`);
        }

        if (kind === 'semStart' && c && isoOk(d.semesterStart)) {
            c.portalSetup = { ...(c.portalSetup || {}), semesterStartDate: d.semesterStart };
            const el = document.getElementById('startDate'); if (el) el.value = d.semesterStart;
            save();
            done(id, kind, `Semester start: ${fmt(d.semesterStart)}`);
        }
    }

    // ---------- AI answers for open questions ----------
    // Every number the AI may quote comes from this snapshot, computed by the app's own engine.
    function classSnapshot() {
        const chat = C();
        const name = clsName();
        if (!name) return { class: null, note: 'No class set up yet.' };
        const c = classes[name];
        const t = today();
        const min = getMinAttendanceCriteria();
        const data = chat.getAttendanceData() || [];
        const times = (typeof getPeriodTimes === 'function' && getPeriodTimes(name)) || {};
        const r1 = (x) => Math.round(x * 10) / 10;
        const subjects = data.map(s => {
            const st = getSubjectAnalysis(s.attended, s.totalHeld, s.remaining, null, s.odml).stats;
            const own = s.totalHeld ? (s.attended - (s.odml || 0)) / s.totalHeld * 100 : 0;
            return {
                code: s.code, name: s.name, short: s.shortName || undefined,
                attended: s.attended, held: s.totalHeld, odml: s.odml || 0,
                percent: r1(st.currentPercent), ownPercentWithoutOdml: r1(own),
                remainingClasses: s.remaining, canSkip: Math.max(0, st.maxSkippable), mustAttend: st.stillNeed,
                status: st.stillNeed > s.remaining ? `cannot reach ${Math.round(min * 100)}%` : st.currentPercent < min * 100 ? 'below minimum' : 'safe',
                finalIfAttendAll: r1(st.projectedMaxPercent), finalIfSkipAll: r1(st.projectedMinPercent)
            };
        });
        const held = data.reduce((n, s) => n + (Number(s.totalHeld) || 0), 0);
        const att = data.reduce((n, s) => n + (Number(s.attended) || 0), 0);
        // Next 14 days, period by period, with times (days without classes listed apart)
        const schedule = [];
        const noClassDays = [];
        for (let i = 0; i < 14; i++) {
            const d = formatLocalDate(new Date(Date.now() + i * 864e5));
            const hol = (c.holidays || []).includes(d);
            const periods = hol ? [] : (chat.periodsOn(d) || []);
            const exam = chat.examOn ? chat.examOn(d) : null;
            const n = periods.filter(Boolean).length;
            if (!n) { noClassDays.push(`${d} ${parseLocalDate(d).toLocaleDateString('en-IN', { weekday: 'long' })}${hol ? ' (holiday)' : ''}`); continue; }
            schedule.push({
                date: d, day: parseLocalDate(d).toLocaleDateString('en-IN', { weekday: 'long' }),
                holiday: hol || undefined, exam: exam ? (exam.title || 'Exam') : undefined,
                classes: n,
                periods: periods.map((p, k) => p ? `P${k + 1} ${p.name} (${p.code})${times[k] && times[k].start ? ` ${times[k].start}-${times[k].end || ''}` : ''}` : `P${k + 1} free`)
            });
        }
        return {
            today: t, todayDay: parseLocalDate(t).toLocaleDateString('en-IN', { weekday: 'long' }),
            class: name, minimumAttendancePercent: Math.round(min * 100),
            semesterStart: c.portalSetup?.semesterStartDate || null, lastWorkingDay: c.lastDate || null,
            overall: { attended: att, held, percent: held ? r1(att / held * 100) : 0 },
            subjects,
            upcomingHolidays: (c.holidays || []).filter(h => h >= t).slice(0, 15),
            exams: (c.examDays || []).filter(e => (e.to || e.from) >= t).slice(0, 10),
            lunchBreak: times.lunch || null,
            next14ClassDays: schedule,
            next14DaysWithoutClasses: noClassDays
        };
    }

    function attendanceContext() {
        return JSON.stringify(classSnapshot());
    }

    // Tiny, safe markdown: **bold**, bullet lines, paragraphs
    function md(text) {
        const lines = esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split(/\n+/);
        let html = '', inList = false;
        lines.forEach(l => {
            const b = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
            if (b) { if (!inList) { html += '<ul class="si-ai-list">'; inList = true; } html += `<li>${b[1]}</li>`; }
            else { if (inList) { html += '</ul>'; inList = false; } if (l.trim()) html += `<p>${l}</p>`; }
        });
        if (inList) html += '</ul>';
        return html;
    }

    // Built-in questions the engine answers exactly. The AI rewrites any question into one of these.
    const ENGINE_FORMS = [
        'can I skip today', 'can I skip tomorrow', 'can I take leave on <D MON>', 'can I take leave from <D MON> to <D MON>',
        'how many days of leave can I take', 'if I miss <N> classes', 'if I miss <N> classes of <SUBJECT NAME>', 'how many classes can I skip',
        'how many classes of <SUBJECT NAME> can I skip', 'overall attendance', 'worst subjects', 'best subjects',
        '<SUBJECT NAME> attendance', 'recovery plan', 'what do I need for <N>%', 'prediction', 'find long weekends',
        'best day to take leave', 'my profile', 'when does the semester end', 'exam dates', 'OD/ML status',
        'unmarked days', 'holidays', 'timetable today', 'classes tomorrow', 'classes on <D MON>', 'help'
    ];

    function routerPrompt(query) {
        return `You are Bunkit's assistant for a college student. The student can write in ANY language or script (English, Hindi, Hinglish, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Urdu, Odia, etc.).

Class data (exact, computed by the app — the ONLY source of numbers):
${attendanceContext()}

Built-in calculator questions (answered exactly by the app):
${ENGINE_FORMS.map(f => `- ${f}`).join('\n')}

Return ONLY one JSON object, no markdown:
{"language": "language of the student's message, e.g. English, Hindi, Tamil", "route": "engine" | "answer", "english": "...", "answer": "..."}

Rules:
- route "engine" when the question needs a calculation or prediction (skipping, leave on dates, missing N classes, percentages needed, how many can I skip, recovery, semester-end %, long weekends, best leave day) OR exactly matches a built-in question. Put the matching built-in question in "english": fill <SUBJECT NAME> with the FULL subject name from the data, dates as "14 oct", resolve today/tomorrow/weekdays/relative dates using today = ${today()}. Leave "answer" empty.
- Questions comparing days or subjects from the schedule (which day has the most/fewest classes, which subject is most frequent, first/last class of a day) are route "answer", not the engine.
- When comparing days, only count days that have classes (skip holidays and weekends with no periods) unless asked otherwise.
- route "answer" only for questions the data answers directly without new arithmetic (which classes on a day, time of a period, which subject has most classes, when is the next holiday, lunch time, what a status means, study tips). Write "answer" in the SAME language and script as the student, short and clear (max 120 words), using only the numbers in the data. Never invent or estimate numbers. If the data doesn't contain the answer, say so politely.
- If the message is unrelated to college/attendance, route "answer" with a brief helpful reply in their language.

Student message: ${JSON.stringify(query)}`;
    }

    // The result card as labelled facts ("Can skip: 7"), so no number loses its meaning
    function cardFacts(card) {
        const body = card.querySelector('.si-answer-body').cloneNode(true);
        body.querySelectorAll('.si-ai-summary, .si-td-label, .odv-orig').forEach(x => x.remove());
        const lines = [`Title: ${card.querySelector('.si-answer-title')?.innerText.trim() || ''}`];
        body.querySelectorAll('.si-stat-tile').forEach(tile => {
            const v = tile.querySelector('.si-stat-value')?.innerText.trim(), l = tile.querySelector('.si-stat-label')?.innerText.trim();
            if (v && l) lines.push(`${l}: ${v}`);
            tile.remove();
        });
        body.querySelectorAll('table').forEach(table => {
            const heads = [...table.querySelectorAll('thead th')].map(th => th.innerText.trim());
            table.querySelectorAll('tbody tr').forEach(tr => {
                const cells = [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim());
                lines.push(`- ${cells[0]}: ${cells.slice(1).map((c, i) => `${heads[i + 1] || ''} ${c}`.trim()).join(', ')}`);
            });
            table.remove();
        });
        lines.push(body.innerText.replace(/\n{2,}/g, '\n').trim());
        return lines.join('\n').slice(0, 4000);
    }

    async function explainInLanguage(result, query, language, el) {
        const card = el && el.querySelector('.si-answer-card');
        if (!card) return;
        const slot = document.createElement('div');
        slot.className = 'si-ai-summary loading';
        slot.innerHTML = '<span class="si-thinking-dots"><span></span><span></span><span></span></span>';
        card.querySelector('.si-answer-body')?.prepend(slot);
        try {
            const facts = cardFacts(card);
            const text = await callGemini(`Explain this result to a college student in ${language}, in 2-4 short sentences, in ${language} script. Answer their question directly first.
Strict rules: use ONLY numbers and dates from the result, copied exactly, each with the exact meaning of its label (e.g. "Total safe skips, all subjects: 91" is skips, never classes to attend). Do not add, combine or calculate numbers. If you are unsure what a number means, leave it out. "Can skip N" means at most N classes can be missed.
Write naturally like a friend: put the meaning of each label into ${language} words; never quote the English labels or use "Label: value" format. Subject names, dates and numbers can stay as written.

Student question: ${JSON.stringify(query)}

Result from the attendance calculator:
${facts}`, []);
            if (!text.trim()) throw new Error('empty');
            slot.classList.remove('loading');
            slot.innerHTML = md(text);
        } catch (e) { console.warn("Language summary failed:", e && e.message); slot.remove(); }
    }

    // Any question, any language: the AI understands it, the app's engine calculates it
    async function smartAsk(query, thinkingEl, fallback) {
        const chat = C();
        const t = thinkingEl.querySelector('.si-thinking');
        if (t) t.innerHTML = '<span class="si-thinking-dots"><span></span><span></span><span></span></span> Understanding your question…';
        let plan;
        try {
            for (let attempt = 0; !plan; attempt++) {
                try { plan = parseJSON(await callGemini(routerPrompt(query), [])); }
                catch (e) { if (attempt >= 1 || !(e instanceof SyntaxError)) throw e; }
            }
        } catch (e) {
            console.warn('Smart Search AI failed:', e && e.message);
            // A real answer from the built-in engine is still shown; otherwise say what happened
            if (fallback && !fallback._fallback && !/what can you ask/i.test(fallback.title || '')) { chat.renderAnswer(fallback, thinkingEl, query); return; }
            chat.renderAnswer(aiDown(e, query), thinkingEl, query);
            return;
        }
        const language = String(plan.language || 'English');
        const isEnglish = /^english$/i.test(language);
        if (plan.route === 'engine' && plan.english) {
            let r = null;
            try { r = SmartSearch.processQuery(String(plan.english)); } catch (e) { r = null; }
            if (r && !r._fallback) {
                chat.renderAnswer(r, thinkingEl, query);
                if (!isEnglish) explainInLanguage(r, query, language, thinkingEl);
                return;
            }
        }
        if (plan.answer && String(plan.answer).trim()) {
            chat.renderAnswer({ iconClass: 'info', title: 'Bunkit AI', body: `<div class="si-ai-text">${md(String(plan.answer))}</div><p class="si-ai-note"><i class="fa-solid fa-wand-magic-sparkles"></i> Answered from your class data</p>` }, thinkingEl, query);
            return;
        }
        aiAnswer(query, thinkingEl, fallback);
    }

    // AI not available: say why, and offer the fix (a free personal Gemini key) right in the answer
    function aiDown(e, query) {
        const msg = String((e && e.message) || '');
        const quota = /quota|busy|429|rate|exhaust/i.test(msg);
        return {
            iconClass: 'warning',
            title: quota ? 'The free AI limit is used up for now' : "I couldn't understand that just now",
            body: `<p>${quota
                ? 'Questions in other languages and unusual wording need the AI, and the shared AI has reached its daily limit.'
                : `The AI that understands every language didn't respond (${esc(msg || 'network error')}).`}</p>
                <p><strong>Fix it in 1 minute:</strong> get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a>, then tap the button below and paste it. It stays only on this device.</p>
                <div class="si-ai-actions"><button class="si-ai-act primary" onclick='SmartAttach.addKey(${esc(JSON.stringify(query || ""))})'><i class="fa-solid fa-key"></i> Add my free Gemini key</button></div>
                <p class="si-ai-note">Without the AI you can still ask in English or Hindi, e.g. <em>"how many days of leave can I take"</em>, <em>"can I skip tomorrow"</em>, <em>"DBMS attendance"</em>.</p>`
        };
    }

    // Save a personal Gemini key (used first by every AI call) and ask the question again
    function addKey(query) {
        const key = (prompt('Paste your Gemini API key (from aistudio.google.com/apikey):') || '').trim();
        if (!key) return;
        if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) { alert("That doesn't look like a Gemini key. It starts with \"AIza\"."); return; }
        try { localStorage.setItem('personalGeminiKey', key); } catch (e) { /* storage blocked */ }
        if (typeof showToast === 'function') showToast('Gemini key saved', 'Smart Search will use your own key', { duration: 2500 });
        if (query && window.SmartSearch) SmartSearch.runQuery(query);
    }

    async function aiAnswer(query, thinkingEl, fallback) {
        const chat = C();
        const t = thinkingEl.querySelector('.si-thinking');
        if (t) t.innerHTML = '<span class="si-thinking-dots"><span></span><span></span><span></span></span> Thinking…';
        try {
            const prompt = `You are Bunkit's assistant for a college student. Reply in the SAME language and script as the question. Be brief (under 120 words), friendly and precise. Use ONLY the numbers in the class data below, copied exactly; never invent, estimate or recalculate numbers. If the data doesn't answer it, say so. If the question is unrelated to college, answer helpfully in one or two sentences.

Class data: ${attendanceContext()}

Question: ${query}`;
            const text = await callGemini(prompt, []);
            if (!text.trim()) throw new Error('empty');
            chat.renderAnswer({ iconClass: 'info', title: 'Bunkit AI', body: `<div class="si-ai-text">${md(text)}</div><p class="si-ai-note"><i class="fa-solid fa-wand-magic-sparkles"></i> Answered from your class data</p>` }, thinkingEl, query);
        } catch (e) {
            console.warn('Smart Search AI failed:', e && e.message);
            chat.renderAnswer(fallback && !fallback._fallback && !/what can you ask/i.test(fallback.title || '') ? fallback : aiDown(e, query), thinkingEl, query);
        }
    }

    function init() {
        let tries = 0;
        const t = setInterval(() => {
            tries++;
            if (window.SmartSearch?._chat && document.querySelector('#smartSearchPage .si-search-bar')) { clearInterval(t); mountUI(); }
            if (tries > 60) clearInterval(t);
        }, 250);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.SmartAttach = { pick, remove: removeFile, act, aiAnswer, smartAsk, addKey, explainInLanguage, _snapshot: classSnapshot, _build: buildAnswer, _add: addFiles };
})();
