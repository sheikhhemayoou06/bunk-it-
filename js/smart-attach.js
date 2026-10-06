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
                ${opt('fa-chart-column', 'Attendance screenshot', 'Your % per subject + how many you can skip')}
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
        } else if (images.length) {
            res = await fetch('/api/gemini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'vision-multi', prompt, images }) });
        } else {
            res = await fetch('/api/gemini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'chat', prompt }) });
        }
        if (!res.ok) {
            let msg = `AI error ${res.status}`;
            try { const j = await res.json(); msg = j.error || msg; } catch (e) { /* ignore */ }
            if (res.status === 429) msg = 'The AI is busy right now. Try again in a minute, or add your own Gemini key in Profile → Preferences.';
            if (res.status === 404) msg = 'AI reading works on the live app (bunk-it.vercel.app) or with your own Gemini key.';
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
- "present" = classes attended, "total" = classes held (conducted). Use 24-hour HH:MM times.
- For calendars, list every holiday / no-class day with its date; ranges become one entry per day. Exams, CATs, mid-terms and practical exams go in "exams".
- Infer missing years from the semester or today's date. Leave sections that don't apply as empty arrays / null.
${question ? `Student question: "${question}"` : ''}`;
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
            const text = await callGemini(imagePrompt(question), images);
            const data = parseJSON(text);
            result = buildAnswer(data, question);
        } catch (e) {
            result = {
                iconClass: 'danger', title: "Couldn't read that image",
                body: `<p>${esc(e.message || 'Something went wrong.')}</p><p style="margin-top:8px;">Use a clear, uncropped photo or screenshot. For attendance you can also use <strong>Attendance → Upload screenshot</strong>.</p>`
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

        // Attendance
        const att = (d.attendance || []).filter(a => a && Number(a.total) > 0);
        if (att.length) {
            const data = C().getAttendanceData() || [];
            let rows = '', tP = 0, tT = 0;
            att.forEach(a => {
                const code = mapCode(a.code, a.name);
                const present = Math.min(Number(a.present) || 0, Number(a.total)), total = Number(a.total);
                tP += present; tT += total;
                const pct = total ? present / total * 100 : 0;
                const known = data.find(x => x.code === code);
                let skip = '—';
                if (known) {
                    const st = getSubjectAnalysis(present, total, Number(known.remaining) || 0, null, Number(a.odml) || 0).stats;
                    skip = st.stillNeed > (known.remaining || 0) ? `Can't reach ${min}%` : st.maxSkippable > 0 ? `Can skip ${st.maxSkippable}` : `Attend ${st.stillNeed} more`;
                } else {
                    const m = min / 100;
                    const k = Math.floor(present / m - total + 1e-9);
                    skip = pct >= min ? `Skip ${Math.max(0, k)} now` : `Attend ${Math.ceil((m * total - present) / (1 - m))} in a row`;
                }
                const tone = pct >= min ? (pct >= min + 5 ? 'safe' : 'warning') : 'danger';
                rows += `<tr><td><strong>${esc(a.name || code)}</strong><br><small style="opacity:.7">${esc(code)}</small></td><td>${present}/${total}</td><td><strong style="color:var(--si-${tone === 'safe' ? 'success' : tone === 'warning' ? 'warning' : 'danger'})">${pct.toFixed(1)}%</strong></td><td><span class="si-badge ${tone}">${esc(skip)}</span></td></tr>`;
            });
            parts.push(`
                <h4 class="si-ai-h"><i class="fa-solid fa-chart-column"></i> Attendance · ${tT ? (tP / tT * 100).toFixed(1) : 0}% overall</h4>
                <table class="si-subject-table"><thead><tr><th>Subject</th><th>Attended</th><th>%</th><th>Skips</th></tr></thead><tbody>${rows}</tbody></table>`);
            if (name) actions.push(`<button class="si-ai-act primary" onclick="SmartAttach.act('${id}','attendance')"><i class="fa-solid fa-floppy-disk"></i> Update my attendance</button>`);
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

    function act(id, kind) {
        const d = results[id];
        const name = clsName();
        if (!d) return;
        const c = name ? classes[name] : null;
        const save = () => { if (c) c.updatedAt = Date.now(); if (typeof saveToStorage === 'function') saveToStorage(); };

        if (kind === 'attendance' && c) {
            const json = {};
            (d.attendance || []).filter(a => a && Number(a.total) > 0).forEach(a => {
                json[mapCode(a.code, a.name)] = { name: a.name, present: Math.min(Number(a.present) || 0, Number(a.total)), total: Number(a.total) };
            });
            try { window.resultsTableOnly = true; } catch (e) { /* ignore */ }
            if (typeof processJsonAndCalculate === 'function') processJsonAndCalculate(json);
            done(id, kind, 'Attendance updated');
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
                if (Object.keys(times).length && typeof savePeriodTimes === 'function') savePeriodTimes(name, times);
                save();
                done(id, kind, `Timetable applied from today${unknown.size ? ` · ${unknown.size} unknown subject${unknown.size !== 1 ? 's' : ''} skipped` : ''}`);
            } else {
                if (typeof savePeriodTimes === 'function') savePeriodTimes(name, times);
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
    function attendanceContext() {
        const data = C().getAttendanceData() || [];
        const min = getMinAttendanceCriteria();
        const name = clsName();
        if (!name || !data.length) return 'No attendance data yet.';
        const lines = data.map(s => {
            const st = getSubjectAnalysis(s.attended, s.totalHeld, s.remaining, null, s.odml).stats;
            return `${s.name} (${s.code}): ${s.attended}/${s.totalHeld} attended = ${st.currentPercent.toFixed(1)}%, ${s.remaining} classes left, can skip ${st.maxSkippable}, must attend ${st.stillNeed} more to stay at ${Math.round(min * 100)}%`;
        });
        const c = classes[name];
        const hol = (c.holidays || []).filter(h => h >= today()).slice(0, 8).join(', ');
        return `${contextLines()}\nToday: ${today()}.\n${lines.join('\n')}\nUpcoming holidays: ${hol || 'none listed'}.`;
    }

    // Tiny, safe markdown: **bold**, bullet lines, paragraphs
    function md(text) {
        const lines = esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split(/\n+/);
        let html = '', inList = false;
        lines.forEach(l => {
            const b = l.match(/^\s*[-*•]\s+(.*)/);
            if (b) { if (!inList) { html += '<ul class="si-ai-list">'; inList = true; } html += `<li>${b[1]}</li>`; }
            else { if (inList) { html += '</ul>'; inList = false; } if (l.trim()) html += `<p>${l}</p>`; }
        });
        if (inList) html += '</ul>';
        return html;
    }

    async function aiAnswer(query, thinkingEl, fallback) {
        const chat = C();
        const t = thinkingEl.querySelector('.si-thinking');
        if (t) t.innerHTML = '<span class="si-thinking-dots"><span></span><span></span><span></span></span> Thinking…';
        try {
            const prompt = `You are Bunkit's assistant for a college student. Answer briefly (under 120 words), friendly and precise. Use ONLY the numbers below; never invent attendance numbers. If the question is unrelated to attendance or college, answer helpfully in one or two sentences.

${attendanceContext()}

Question: ${query}`;
            const text = await callGemini(prompt, []);
            if (!text.trim()) throw new Error('empty');
            chat.renderAnswer({ iconClass: 'info', title: 'Bunkit AI', body: `<div class="si-ai-text">${md(text)}</div><p class="si-ai-note"><i class="fa-solid fa-wand-magic-sparkles"></i> AI answer based on your attendance data</p>` }, thinkingEl, query);
        } catch (e) {
            chat.renderAnswer(fallback, thinkingEl, query);
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

    window.SmartAttach = { pick, remove: removeFile, act, aiAnswer, _build: buildAnswer, _add: addFiles };
})();
