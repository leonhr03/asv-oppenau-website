/*
 * Admin-Panel für die ASV-Oppenau-Website.
 *
 * Änderungen an news.json, dates.json und youth.json leben zunächst als Entwurf
 * im localStorage dieses Browsers. Läuft die Seite auf einem Server mit PHP,
 * schreibt „Veröffentlichen“ den Entwurf nach Anmeldung über api.php in die
 * Dateien der Website. Ohne PHP (lokale Vorschau) bleibt es beim Prototyp:
 * nur lesen und als JSON-Datei exportieren.
 */
(() => {
    'use strict';

    const STORAGE_KEY = 'asv-admin-prototyp-v1';
    const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

    const KINDS = {
        news: { file: 'news.json', label: 'News', singular: 'Beitrag', ordered: true },
        dates: { file: 'dates.json', label: 'Termine', singular: 'Termin', ordered: false },
        youth: { file: 'youth.json', label: 'Jugend-Material', singular: 'Eintrag', ordered: true }
    };
    const KIND_KEYS = Object.keys(KINDS);

    // base: Stand der Website, auf dem der Entwurf aufbaut. draft: bearbeiteter Stand.
    // Beide: { news: [{ id, data }], dates: [...], youth: [...] }
    let base = null;
    let draft = null;
    let live = null; // Stand der Website beim Laden bzw. nach dem letzten Veröffentlichen
    let stale = false;
    let server = null; // null = Prototyp ohne PHP; sonst { csrf, versions: { news, dates, youth } }
    let publishing = false;
    let newsFilter = '';
    let editing = null; // { kind, id | null, original }
    let undoState = null;
    let toastTimer = null;
    let idCounter = 0;

    const $ = (selector) => document.querySelector(selector);
    const view = $('#view');
    const editor = $('#editor');
    const editorFields = $('#editorFields');
    const editorPreview = $('#editorPreview');
    const toast = $('#toast');

    /* ---------- Helfer ---------- */

    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        })[char]);
    }

    function stripHtml(html) {
        const div = document.createElement('div');
        div.innerHTML = String(html ?? '').replace(/<br\s*\/?>/gi, ' ');
        return (div.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function parseDate(text) {
        const match = String(text ?? '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (!match) return null;
        const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatDate(date) {
        return date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    const pad = (n) => String(n).padStart(2, '0');
    const toIso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

    function isoToGerman(iso) {
        const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
    }

    function today() {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        return date;
    }

    // Pfade in den JSON-Dateien sind relativ zur Website-Wurzel, der Admin liegt eine Ebene tiefer.
    function sitePath(path) {
        return /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(path) ? path : `../${path}`;
    }

    function imagesOf(data) {
        if (!data.image) return [];
        return Array.isArray(data.image) ? data.image : [data.image];
    }

    function parseLink(html) {
        if (!html) return { url: '', text: '' };
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        const anchor = tpl.content.querySelector('a[href]');
        const onlyAnchor = anchor && tpl.content.textContent.trim() === anchor.textContent.trim();
        return onlyAnchor ? { url: anchor.getAttribute('href'), text: anchor.textContent.trim() } : null;
    }

    const clone = (value) => JSON.parse(JSON.stringify(value));
    const newId = () => `new-${Date.now()}-${idCounter++}`;

    /* ---------- Server (api.php) ---------- */

    async function api(action, body) {
        const response = await fetch(`api.php?action=${action}`, {
            method: body ? 'POST' : 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': server?.csrf ?? '' } : {},
            body: body ? JSON.stringify(body) : undefined
        });
        const payload = await response.json(); // wirft, wenn kein PHP antwortet
        if (!response.ok) {
            const error = new Error(payload.error || `Fehler ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    function renderLogin(message = '') {
        base = draft = server = null;
        ['#resetBtn', '#publishBtn', '#logoutBtn', '#staleNote'].forEach((selector) => { $(selector).hidden = true; });
        $('#draftStatus').textContent = '';
        view.innerHTML = `
            <form class="panel login" id="loginForm">
                <h2>Anmelden</h2>
                ${message ? `<p>${escapeHtml(message)}</p>` : ''}
                <div class="field">
                    <label for="loginPassword">Passwort</label>
                    <input id="loginPassword" type="password" autocomplete="current-password" required>
                    <span class="field-error" id="loginError" role="alert" hidden></span>
                </div>
                <button class="btn btn--sm" type="submit">Anmelden</button>
            </form>
        `;
        $('#loginPassword').focus();
    }

    async function login() {
        const errorSlot = $('#loginError');
        try {
            await api('login', { password: $('#loginPassword').value });
            location.reload();
        } catch (error) {
            errorSlot.textContent = error.status ? error.message : 'Der Server ist nicht erreichbar.';
            errorSlot.hidden = false;
            $('#loginPassword').select();
        }
    }

    async function logout() {
        try {
            await api('logout', {});
        } catch (error) { /* Sitzung ist dann ohnehin weg oder der Server nicht erreichbar */ }
        location.reload();
    }

    function computeStale() {
        return KIND_KEYS.some((kind) =>
            JSON.stringify(base[kind].map((item) => item.data)) !== JSON.stringify(live[kind].map((item) => item.data)));
    }

    async function publish() {
        const kinds = KIND_KEYS.filter((kind) => changesOf(kind).total > 0);
        if (!server || publishing || !kinds.length) return;
        if (stale && !confirm('Die Website-Daten haben sich geändert, seit dieser Entwurf begonnen wurde. Trotzdem veröffentlichen und die neueren Daten überschreiben?')) return;

        publishing = true;
        renderChrome();
        try {
            const files = Object.fromEntries(kinds.map((kind) => [
                kind,
                { data: draft[kind].map((item) => item.data), version: server.versions[kind] }
            ]));
            const result = await api('save', { files });
            kinds.forEach((kind) => {
                base[kind] = clone(draft[kind]);
                live[kind] = clone(draft[kind]);
                server.versions[kind] = result.versions[kind];
            });
            stale = computeStale();
            persist();
            showToast('Veröffentlicht – die Website ist aktualisiert.');
        } catch (error) {
            if (error.status === 401) {
                publishing = false;
                renderLogin('Die Sitzung ist abgelaufen. Der Entwurf bleibt in diesem Browser erhalten.');
                return;
            }
            showToast(error.status ? error.message : 'Veröffentlichen fehlgeschlagen – der Server ist nicht erreichbar.');
        }
        publishing = false;
        render();
    }

    /* ---------- Entwurf & Änderungen ---------- */

    function changesOf(kind) {
        const baseMap = new Map(base[kind].map((item) => [item.id, JSON.stringify(item.data)]));
        const draftIds = new Set(draft[kind].map((item) => item.id));
        const added = draft[kind].filter((item) => !baseMap.has(item.id)).length;
        const changed = draft[kind].filter((item) => baseMap.has(item.id) && baseMap.get(item.id) !== JSON.stringify(item.data)).length;
        const removed = base[kind].filter((item) => !draftIds.has(item.id)).length;
        const keptBase = base[kind].filter((item) => draftIds.has(item.id)).map((item) => item.id).join('|');
        const keptDraft = draft[kind].filter((item) => baseMap.has(item.id)).map((item) => item.id).join('|');
        const reordered = KINDS[kind].ordered && keptBase !== keptDraft;
        return { added, changed, removed, reordered, total: added + changed + removed + (reordered ? 1 : 0) };
    }

    function statusOf(kind, item) {
        const original = base[kind].find((entry) => entry.id === item.id);
        if (!original) return 'new';
        return JSON.stringify(original.data) === JSON.stringify(item.data) ? '' : 'changed';
    }

    function describeChanges(change) {
        if (!change.total) return 'Keine Änderungen';
        const parts = [];
        if (change.added) parts.push(`${change.added} neu`);
        if (change.changed) parts.push(`${change.changed} geändert`);
        if (change.removed) parts.push(`${change.removed} gelöscht`);
        if (change.reordered) parts.push('Reihenfolge geändert');
        return parts.join(' · ');
    }

    const totalChanges = () => KIND_KEYS.reduce((sum, kind) => sum + changesOf(kind).total, 0);

    function persist() {
        try {
            if (totalChanges() === 0 && !stale) {
                localStorage.removeItem(STORAGE_KEY);
            } else {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ base, draft }));
            }
        } catch (error) {
            showToast('Entwurf konnte nicht im Browser gespeichert werden.');
        }
    }

    function readStored() {
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
            const valid = stored && KIND_KEYS.every((kind) => Array.isArray(stored.base?.[kind]) && Array.isArray(stored.draft?.[kind]));
            return valid ? stored : null;
        } catch (error) {
            return null;
        }
    }

    function exportJson(kind) {
        return `${JSON.stringify(draft[kind].map((item) => item.data), null, 2)}\n`;
    }

    /* ---------- Rahmen ---------- */

    function currentView() {
        const hash = location.hash.slice(1);
        return KINDS[hash] ? hash : 'overview';
    }

    function renderChrome() {
        const active = currentView();
        document.querySelectorAll('.admin-nav a').forEach((link) => {
            if (link.dataset.view === active) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        $('#viewTitle').textContent = KINDS[active]?.label ?? 'Übersicht';

        KIND_KEYS.forEach((kind) => {
            const badge = document.querySelector(`[data-count="${kind}"]`);
            const dirty = changesOf(kind).total > 0;
            badge.textContent = draft[kind].length;
            badge.classList.toggle('is-dirty', dirty);
            badge.title = dirty ? 'Enthält Änderungen im Entwurf' : '';
        });

        const total = totalChanges();
        const status = $('#draftStatus');
        status.textContent = total
            ? `Entwurf: ${total} ${total === 1 ? 'Änderung' : 'Änderungen'} – ${server ? 'noch nicht veröffentlicht' : 'nur in diesem Browser'}`
            : 'Keine Änderungen';
        status.classList.toggle('is-dirty', total > 0);
        $('#resetBtn').hidden = total === 0 && !stale;
        $('#staleNote').hidden = !stale;

        const publishBtn = $('#publishBtn');
        publishBtn.hidden = !server;
        publishBtn.disabled = publishing || total === 0;
        publishBtn.textContent = publishing ? 'Wird veröffentlicht …' : 'Veröffentlichen';
        $('#logoutBtn').hidden = !server;
    }

    function render() {
        if (!draft) return; // Login-Ansicht
        renderChrome();
        const active = currentView();
        if (active === 'news') renderNews();
        else if (active === 'dates') renderDates();
        else if (active === 'youth') renderYouth();
        else renderOverview();
    }

    function statusPill(status) {
        if (status === 'new') return '<span class="pill pill--new">Neu</span>';
        if (status === 'changed') return '<span class="pill pill--changed">Geändert</span>';
        return '';
    }

    function rowActions(kind, item, index, canMove) {
        const title = escapeHtml(item.data.title);
        const move = KINDS[kind].ordered ? `
            <button class="icon-btn" type="button" data-action="move" data-kind="${kind}" data-id="${item.id}" data-dir="-1" aria-label="${title} nach oben" ${!canMove || index === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-btn" type="button" data-action="move" data-kind="${kind}" data-id="${item.id}" data-dir="1" aria-label="${title} nach unten" ${!canMove || index === draft[kind].length - 1 ? 'disabled' : ''}>↓</button>
        ` : '';
        return `
            <div class="row__actions">
                ${move}
                <button class="btn btn--outline btn--sm" type="button" data-action="edit" data-kind="${kind}" data-id="${item.id}" aria-label="${title} bearbeiten">Bearbeiten</button>
                <button class="icon-btn icon-btn--danger" type="button" data-action="delete" data-kind="${kind}" data-id="${item.id}" aria-label="${title} löschen">✕</button>
            </div>
        `;
    }

    /* ---------- Ansichten ---------- */

    function renderOverview() {
        const now = today();
        const upcoming = draft.dates.filter((item) => {
            const date = parseDate(item.data.date);
            return date && date >= now;
        }).length;
        const withImages = draft.news.filter((item) => imagesOf(item.data).length).length;

        view.innerHTML = `
            <div class="stat-grid">
                <a class="stat-card" href="#news">
                    <span>News-Beiträge</span>
                    <strong>${draft.news.length}</strong>
                    <small>${withImages} mit Bildern</small>
                </a>
                <a class="stat-card" href="#dates">
                    <span>Termine</span>
                    <strong>${draft.dates.length}</strong>
                    <small>${upcoming} ${upcoming === 1 ? 'steht' : 'stehen'} noch an</small>
                </a>
                <a class="stat-card" href="#youth">
                    <span>Jugend-Material</span>
                    <strong>${draft.youth.length}</strong>
                    <small>Downloads und Links</small>
                </a>
            </div>

            <section class="panel" aria-labelledby="exportTitle">
                <h2 id="exportTitle">Entwurf exportieren</h2>
                <p>${server
                    ? '„Veröffentlichen“ oben schreibt alle Änderungen auf die Website. Zusätzlich lässt sich jeder Bereich als JSON-Datei herunterladen, z. B. als Sicherung oder fürs Git-Projekt.'
                    : 'Der Prototyp schreibt nicht auf die Website. Zum Ausprobieren lässt sich jeder Bereich als JSON-Datei herunterladen und bei Bedarf von Hand ins Projekt übernehmen.'}</p>
                <div class="export-list">
                    ${KIND_KEYS.map((kind) => {
                        const change = changesOf(kind);
                        return `
                            <div class="export-row">
                                <div>
                                    <code>${KINDS[kind].file}</code>
                                    <p class="${change.total ? 'is-dirty' : ''}">${describeChanges(change)}</p>
                                </div>
                                <div class="export-row__actions">
                                    <button class="btn btn--outline btn--sm" type="button" data-action="copy" data-kind="${kind}">JSON kopieren</button>
                                    <button class="btn btn--sm" type="button" data-action="download" data-kind="${kind}">Herunterladen</button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </section>
        `;
    }

    function renderNews() {
        const query = newsFilter.trim().toLowerCase();
        const items = draft.news
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => !query || `${item.data.title} ${stripHtml(item.data.content)}`.toLowerCase().includes(query));

        const rows = items.map(({ item, index }) => {
            const images = imagesOf(item.data);
            const thumb = images.length
                ? `<img src="${escapeHtml(sitePath(images[0]))}" alt="" loading="lazy">`
                : 'Text';
            const imageInfo = images.length > 1 ? `${images.length} Bilder · ` : '';
            return `
                <li class="row">
                    <div class="row__thumb">${thumb}</div>
                    <div>
                        <div class="row__title"><h3>${escapeHtml(item.data.title)}</h3>${statusPill(statusOf('news', item))}</div>
                        <p class="row__sub">${imageInfo}${escapeHtml(stripHtml(item.data.content))}</p>
                    </div>
                    ${rowActions('news', item, index, !query)}
                </li>
            `;
        }).join('');

        view.innerHTML = `
            <div class="toolbar">
                <input type="search" id="newsSearch" placeholder="News durchsuchen …" aria-label="News durchsuchen" value="${escapeHtml(newsFilter)}">
                <button class="btn btn--sm" type="button" data-action="add" data-kind="news">+ Neuer Beitrag</button>
            </div>
            ${rows
                ? `<ul class="rows">${rows}</ul>`
                : `<div class="empty-state">${query ? 'Kein Beitrag passt zur Suche.' : 'Noch keine Beiträge.'}</div>`}
        `;
    }

    function renderDates() {
        const now = today();
        const items = draft.dates
            .map((item) => ({ item, parsed: parseDate(item.data.date) }))
            .sort((a, b) => (b.parsed?.getTime() ?? Infinity) - (a.parsed?.getTime() ?? Infinity));
        const next = items
            .filter(({ parsed }) => parsed && parsed >= now)
            .sort((a, b) => a.parsed - b.parsed)[0];

        const rows = items.map((entry) => {
            const { item, parsed } = entry;
            const past = parsed && parsed < now;
            const chip = parsed
                ? `<div class="mini-date"><strong>${pad(parsed.getDate())}</strong><span>${MONATE[parsed.getMonth()]} ${String(parsed.getFullYear()).slice(2)}</span></div>`
                : '<div class="mini-date"><strong>?</strong><span>Datum</span></div>';
            const info = [item.data.description, item.data.link].filter(Boolean).map(stripHtml).join(' · ');
            return `
                <li class="row${past ? ' is-past' : ''}">
                    ${chip}
                    <div>
                        <div class="row__title">
                            <h3>${escapeHtml(item.data.title)}</h3>
                            ${entry === next ? '<span class="pill">Nächster Termin</span>' : ''}
                            ${past ? '<span class="pill pill--muted">Vergangen</span>' : ''}
                            ${!parsed ? '<span class="pill pill--changed">Datum fehlt</span>' : ''}
                            ${statusPill(statusOf('dates', item))}
                        </div>
                        <p class="row__sub">${escapeHtml(info || (parsed ? formatDate(parsed) : ''))}</p>
                    </div>
                    ${rowActions('dates', item, 0, false)}
                </li>
            `;
        }).join('');

        view.innerHTML = `
            <div class="toolbar">
                <p>Die Website sortiert Termine automatisch nach Datum.</p>
                <button class="btn btn--sm" type="button" data-action="add" data-kind="dates">+ Neuer Termin</button>
            </div>
            ${rows ? `<ul class="rows">${rows}</ul>` : '<div class="empty-state">Noch keine Termine.</div>'}
        `;
    }

    function renderYouth() {
        const rows = draft.youth.map((item, index) => {
            const isPdf = /\.pdf($|\?)/i.test(item.data.link);
            return `
                <li class="row">
                    <div class="row__thumb">${isPdf ? 'PDF' : 'Link'}</div>
                    <div>
                        <div class="row__title"><h3>${escapeHtml(item.data.title)}</h3>${statusPill(statusOf('youth', item))}</div>
                        <p class="row__sub">${escapeHtml(item.data.link)}</p>
                    </div>
                    ${rowActions('youth', item, index, true)}
                </li>
            `;
        }).join('');

        view.innerHTML = `
            <div class="toolbar">
                <p>Lernmaterial und Links auf der Jugend-Seite, in dieser Reihenfolge.</p>
                <button class="btn btn--sm" type="button" data-action="add" data-kind="youth">+ Neuer Eintrag</button>
            </div>
            ${rows ? `<ul class="rows">${rows}</ul>` : '<div class="empty-state">Noch kein Material.</div>'}
        `;
    }

    /* ---------- Editor ---------- */

    function field(name, label, control, hint = '') {
        return `
            <div class="field">
                <label for="f-${name}">${label}</label>
                ${control}
                ${hint ? `<small>${hint}</small>` : ''}
                <span class="field-error" data-error="${name}" hidden></span>
            </div>
        `;
    }

    const input = (name, value, attrs = '') =>
        `<input id="f-${name}" name="${name}" value="${escapeHtml(value)}" autocomplete="off" ${attrs}>`;
    const textarea = (name, value, attrs = '') =>
        `<textarea id="f-${name}" name="${name}" ${attrs}>${escapeHtml(value)}</textarea>`;

    function editorFieldsMarkup(kind, data) {
        if (kind === 'news') {
            return `
                ${field('title', 'Titel', input('title', data.title ?? '', 'required'), 'Ein Datum im Titel (z. B. 18.10.2026) zeigt die Website als Datum über dem Beitrag an.')}
                ${field('content', 'Text', textarea('content', data.content ?? ''), 'HTML ist erlaubt, z. B. &lt;br&gt; für einen Zeilenumbruch oder &lt;a href="…"&gt; für Links.')}
                ${field('images', 'Bilder', textarea('images', imagesOf(data).map(embedToken).join('\n'), 'class="is-short" spellcheck="false"'), 'Ein Pfad pro Zeile, z. B. img/Rhein.jpeg. Hochgeladene Bilder stehen als [Bild …] da und werden direkt in news.json gespeichert. Mehrere Bilder werden zum Slider.')}
                <div class="upload">
                    <label class="btn btn--outline btn--sm">
                        <input type="file" id="imageUpload" accept="image/jpeg,image/png,image/webp,image/gif" multiple>
                        Bilder hinzufügen
                    </label>
                    <span class="upload__status" id="uploadStatus" role="status"></span>
                </div>
                <div class="thumbs" id="thumbs"></div>
            `;
        }

        if (kind === 'dates') {
            const parsed = parseDate(data.date);
            const link = parseLink(data.link);
            const linkFields = link ? `
                <div class="field-row">
                    ${field('linkUrl', 'Link-Adresse', input('linkUrl', link.url, 'type="url" inputmode="url" placeholder="https://…"'))}
                    ${field('linkText', 'Link-Text', input('linkText', link.text))}
                </div>
            ` : field('linkRaw', 'Link (HTML)', input('linkRaw', data.link, 'spellcheck="false"'), 'Dieser Link hat ein Sonderformat und wird unverändert als HTML bearbeitet.');
            return `
                ${field('title', 'Titel', input('title', data.title ?? '', 'required'))}
                ${field('date', 'Datum', input('date', parsed ? toIso(parsed) : '', 'type="date" required'))}
                ${field('description', 'Beschreibung', textarea('description', data.description ?? '', 'class="is-short"'), 'Optional, z. B. Uhrzeit und Treffpunkt. HTML ist erlaubt.')}
                ${linkFields}
            `;
        }

        return `
            ${field('title', 'Titel', input('title', data.title ?? '', 'required'))}
            ${field('link', 'Link oder Datei', input('link', data.link ?? '', 'required spellcheck="false" placeholder="img/Datei.pdf oder https://…"'), 'PDFs aus dem Projekt als Pfad (img/…), externe Seiten als vollständige Adresse.')}
        `;
    }

    function readForm() {
        const { kind, original } = editing;
        const value = (name) => (editorFields.querySelector(`[name="${name}"]`)?.value ?? '').trim();
        const data = { title: value('title') };

        if (kind === 'news') {
            data.content = value('content');
            const images = value('images').split('\n').map((line) => line.trim()).filter(Boolean).map(resolveToken);
            // Form der Originaldatei beibehalten: Liste bleibt Liste, Einzelbild bleibt Text.
            if (images.length > 1 || (images.length === 1 && Array.isArray(original.image))) data.image = images;
            else if (images.length === 1) data.image = images[0];
        } else if (kind === 'dates') {
            data.date = isoToGerman(value('date'));
            if (value('description')) data.description = value('description');
            if (editorFields.querySelector('[name="linkRaw"]')) {
                if (value('linkRaw')) data.link = value('linkRaw');
            } else if (value('linkUrl')) {
                data.link = `<a href="${escapeHtml(value('linkUrl'))}">${escapeHtml(value('linkText') || value('linkUrl'))}</a>`;
            }
        } else {
            data.link = value('link');
        }
        return data;
    }

    function previewMarkup(kind, data) {
        const title = escapeHtml(data.title || 'Ohne Titel');

        if (kind === 'news') {
            const images = imagesOf(data);
            const date = parseDate(data.title);
            const meta = date ? `<time>${formatDate(date)}</time>` : '<span>Vereinsleben</span>';
            let media = '';
            if (images.length === 1) {
                media = `<div class="news-card__media"><img src="${escapeHtml(images[0])}" alt=""></div>`;
            } else if (images.length > 1) {
                media = `
                    <div class="news-card__media"><div class="slider">
                        <div class="slider__track"><div class="slider__slide is-active"><img src="${escapeHtml(images[0])}" alt=""></div></div>
                        <div class="slider__dots">${images.map((_, i) => `<span class="slider__dot${i === 0 ? ' is-active' : ''}"></span>`).join('')}</div>
                    </div></div>
                `;
            }
            return `
                <article class="news-card">
                    ${media}
                    <div class="news-card__body">
                        <div class="news-meta">${meta}</div>
                        <h2>${title}</h2>
                        <div class="news-card__text">${data.content ?? ''}</div>
                    </div>
                </article>
            `;
        }

        if (kind === 'dates') {
            const parsed = parseDate(data.date);
            return `
                <ol class="events">
                    <li class="event">
                        <div class="event-date">
                            <strong>${parsed ? pad(parsed.getDate()) : '–'}</strong>
                            <span>${parsed ? `${MONATE[parsed.getMonth()]} ${parsed.getFullYear()}` : 'Datum'}</span>
                        </div>
                        <div class="event-body">
                            <h3>${title}</h3>
                            ${data.description ? `<p>${data.description}</p>` : ''}
                            ${data.link ? `<p>${data.link}</p>` : ''}
                        </div>
                    </li>
                </ol>
            `;
        }

        const isPdf = /\.pdf($|\?)/i.test(data.link ?? '');
        return `
            <article class="resource-card">
                <h3>${title}</h3>
                <span class="resource-type">${isPdf ? 'PDF-Dokument' : 'Externer Link'}</span>
                <a class="btn btn--outline" href="${escapeHtml(data.link ?? '')}" target="_blank" rel="noopener">${isPdf ? 'PDF öffnen' : 'Seite öffnen'}</a>
            </article>
        `;
    }

    function updatePreview() {
        const data = readForm();
        editorPreview.innerHTML = previewMarkup(editing.kind, data);

        // Relative Pfade gelten ab Website-Wurzel; Links in der Vorschau öffnen in neuem Tab.
        editorPreview.querySelectorAll('img[src]').forEach((img) => img.setAttribute('src', sitePath(img.getAttribute('src'))));
        editorPreview.querySelectorAll('a[href]').forEach((anchor) => {
            anchor.setAttribute('href', sitePath(anchor.getAttribute('href')));
            anchor.target = '_blank';
            anchor.rel = 'noopener';
        });

        const thumbs = editorFields.querySelector('#thumbs');
        if (thumbs) {
            thumbs.innerHTML = imagesOf(data).map((src, index) => `
                <span class="thumb">
                    <img src="${escapeHtml(sitePath(src))}" alt="" title="${escapeHtml(embedToken(src))}">
                    <button class="thumb__remove" type="button" data-action="remove-image" data-index="${index}" aria-label="Bild ${index + 1} entfernen">✕</button>
                </span>
            `).join('');
        }
    }

    function openEditor(kind, id) {
        const existing = id ? draft[kind].find((item) => item.id === id) : null;
        const original = existing ? existing.data : {};
        editing = { kind, id: existing ? id : null, original, embedded: new Map() };
        $('#editorTitle').textContent = `${KINDS[kind].singular} ${existing ? 'bearbeiten' : 'anlegen'}`;
        editorFields.innerHTML = editorFieldsMarkup(kind, original);
        updatePreview();
        editor.showModal();
        editorFields.querySelector('input, textarea')?.focus();
    }

    function validate(data) {
        const errors = {};
        if (!data.title) errors.title = 'Bitte einen Titel eingeben.';
        if (editing.kind === 'dates' && !data.date) errors.date = 'Bitte ein Datum wählen.';
        if (editing.kind === 'youth' && !data.link) errors.link = 'Bitte einen Link oder Dateipfad eingeben.';

        editorFields.querySelectorAll('[data-error]').forEach((slot) => {
            const message = errors[slot.dataset.error];
            slot.hidden = !message;
            slot.textContent = message ?? '';
            editorFields.querySelector(`[name="${slot.dataset.error}"]`)?.classList.toggle('is-invalid', Boolean(message));
        });

        const first = Object.keys(errors)[0];
        if (first) editorFields.querySelector(`[name="${first}"]`)?.focus();
        return !first;
    }

    function saveEditor() {
        const data = readForm();
        if (!validate(data)) return;

        const { kind, id } = editing;
        if (id) {
            draft[kind].find((item) => item.id === id).data = data;
        } else {
            draft[kind].unshift({ id: newId(), data });
        }
        persist();
        editor.close();
        render();
        showToast(`${KINDS[kind].singular} im Entwurf ${id ? 'aktualisiert' : 'angelegt'}.`);
    }

    /* ---------- Bilder hochladen ---------- */

    const MAX_IMAGE_EDGE = 1280; // längste Seite in Pixeln – reicht für die Website, hält news.json klein
    const MAX_EMBED_BYTES = 2000000; // nach dem Verkleinern; Base64 macht daraus ~2,7 MB

    // Handyfotos sind oft 5–10 MB groß: vorher im Browser verkleinern und als JPEG speichern.
    // GIFs (evtl. animiert) und kleine Bilder bleiben unverändert.
    async function shrinkImage(file) {
        if (file.type === 'image/gif') return file;
        let bitmap;
        try {
            bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (error) {
            return file; // Browser kann das Format nicht lesen – dann unverändert übernehmen
        }
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
        if (scale === 1 && file.size < 250000) {
            bitmap.close();
            return file;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; // transparente PNGs bekommen weißen statt schwarzen Hintergrund
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
        if (!blob) return file;
        return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    }

    // Eingebettete Bilder (Data-URLs) sind hunderte KB lang – im Textfeld steht nur ein kurzer Platzhalter.
    function embedToken(src) {
        if (!src.startsWith('data:') || !editing) return src;
        for (const [token, url] of editing.embedded) if (url === src) return token;
        const token = `[Bild ${editing.embedded.size + 1}]`;
        editing.embedded.set(token, src);
        return token;
    }

    const resolveToken = (line) => editing?.embedded.get(line) ?? line;

    function readAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    // Bild verkleinern und als Data-URL (Base64) zurückgeben – landet so direkt in news.json.
    async function embedImage(file) {
        if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error('Nur JPG-, PNG-, WebP- oder GIF-Bilder sind erlaubt.');
        const small = await shrinkImage(file);
        if (small.size > MAX_EMBED_BYTES) throw new Error(`Das Bild ist größer als ${MAX_EMBED_BYTES / 1000000} MB.`);
        return readAsDataUrl(small);
    }

    function setImagePaths(paths) {
        const textareaEl = editorFields.querySelector('[name="images"]');
        textareaEl.value = paths.map(embedToken).join('\n');
        updatePreview();
    }

    const currentImagePaths = () => (editorFields.querySelector('[name="images"]')?.value ?? '')
        .split('\n').map((line) => line.trim()).filter(Boolean).map(resolveToken);

    async function uploadImages(fileInput) {
        const files = [...fileInput.files];
        fileInput.value = ''; // dieselbe Datei soll erneut wählbar sein
        if (!files.length) return;

        const status = $('#uploadStatus');
        const failed = [];
        fileInput.disabled = true;
        for (const [index, file] of files.entries()) {
            status.textContent = `Verarbeite ${files.length > 1 ? `${index + 1} von ${files.length}` : file.name} …`;
            try {
                const dataUrl = await embedImage(file);
                if (!editing) return; // Editor wurde inzwischen geschlossen
                setImagePaths([...currentImagePaths(), dataUrl]);
            } catch (error) {
                failed.push(`${file.name}: ${error.message}`);
            }
        }
        fileInput.disabled = false;
        status.textContent = failed.length
            ? failed.join(' ')
            : `${files.length === 1 ? 'Bild' : `${files.length} Bilder`} hinzugefügt.`;
        status.classList.toggle('is-error', failed.length > 0);
    }

    /* ---------- Aktionen ---------- */

    function showToast(message, undo = null) {
        clearTimeout(toastTimer);
        undoState = undo;
        toast.innerHTML = `<span>${escapeHtml(message)}</span>${undo ? '<button class="link-btn" type="button" data-action="undo">Rückgängig</button>' : ''}`;
        toast.hidden = false;
        toastTimer = setTimeout(() => {
            toast.hidden = true;
            undoState = null;
        }, undo ? 8000 : 3000);
    }

    function removeItem(kind, id) {
        const snapshot = clone(draft[kind]);
        const item = draft[kind].find((entry) => entry.id === id);
        draft[kind] = draft[kind].filter((entry) => entry.id !== id);
        persist();
        render();
        showToast(`„${item.data.title}“ aus dem Entwurf entfernt.`, { kind, snapshot });
    }

    function moveItem(kind, id, direction) {
        const list = draft[kind];
        const from = list.findIndex((entry) => entry.id === id);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= list.length) return;
        [list[from], list[to]] = [list[to], list[from]];
        persist();
        render();
        document.querySelector(`[data-action="move"][data-id="${id}"][data-dir="${direction}"]:not([disabled])`)?.focus();
    }

    function download(kind) {
        const url = URL.createObjectURL(new Blob([exportJson(kind)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = KINDS[kind].file;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        showToast(`${KINDS[kind].file} heruntergeladen – die Website bleibt unverändert.`);
    }

    async function copy(kind) {
        try {
            await navigator.clipboard.writeText(exportJson(kind));
            showToast(`Inhalt für ${KINDS[kind].file} kopiert.`);
        } catch (error) {
            showToast('Kopieren nicht möglich – bitte „Herunterladen“ nutzen.');
        }
    }

    function reset() {
        if (!confirm('Alle Änderungen im Entwurf verwerfen und den aktuellen Stand der Website laden?')) return;
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (error) { /* Speicher nicht verfügbar – nichts zu löschen */ }
        location.reload();
    }

    document.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action]');
        if (!target) return;
        const { action, kind, id } = target.dataset;

        if (action === 'add') openEditor(kind, null);
        else if (action === 'edit') openEditor(kind, id);
        else if (action === 'delete') removeItem(kind, id);
        else if (action === 'move') moveItem(kind, id, Number(target.dataset.dir));
        else if (action === 'download') download(kind);
        else if (action === 'copy') copy(kind);
        else if (action === 'reset') reset();
        else if (action === 'publish') publish();
        else if (action === 'logout') logout();
        else if (action === 'close-editor') editor.close();
        else if (action === 'remove-image') {
            const paths = currentImagePaths();
            paths.splice(Number(target.dataset.index), 1);
            setImagePaths(paths);
        }
        else if (action === 'undo' && undoState) {
            draft[undoState.kind] = undoState.snapshot;
            persist();
            render();
            showToast('Wiederhergestellt.');
        }
    });

    view.addEventListener('input', (event) => {
        if (event.target.id !== 'newsSearch') return;
        newsFilter = event.target.value;
        renderNews();
        const search = $('#newsSearch');
        search.focus();
        search.setSelectionRange(newsFilter.length, newsFilter.length);
    });

    view.addEventListener('submit', (event) => {
        if (event.target.id !== 'loginForm') return;
        event.preventDefault();
        login();
    });

    editorFields.addEventListener('input', (event) => {
        if (event.target.type !== 'file') updatePreview();
    });
    editorFields.addEventListener('change', (event) => {
        if (event.target.id === 'imageUpload') uploadImages(event.target);
    });
    $('#editorForm').addEventListener('submit', (event) => {
        event.preventDefault();
        saveEditor();
    });
    editor.addEventListener('close', () => { editing = null; });
    window.addEventListener('hashchange', () => {
        render();
        window.scrollTo(0, 0);
    });

    /* ---------- Start ---------- */

    async function init() {
        // Antwortet api.php mit JSON, läuft PHP: dann mit Anmeldung und Schreibzugriff.
        let status = null;
        try {
            status = await api('status');
        } catch (error) { /* kein PHP (lokale Vorschau) → Prototyp-Modus */ }

        if (status && typeof status.loggedIn === 'boolean') {
            document.body.classList.add('is-live');
            if (!status.configured) {
                view.innerHTML = `
                    <div class="empty-state">
                        <strong>Es ist noch kein Passwort eingerichtet.</strong><br>
                        Bitte <code>admin/config.php</code> nach der Vorlage <code>config.example.php</code> anlegen und hochladen.
                    </div>
                `;
                return;
            }
            if (!status.loggedIn) {
                renderLogin();
                return;
            }
            server = { csrf: status.csrf, versions: {} };
        }

        try {
            let lists;
            if (server) {
                const { files } = await api('load');
                lists = KIND_KEYS.map((kind) => files[kind].data);
                KIND_KEYS.forEach((kind) => { server.versions[kind] = files[kind].version; });
            } else {
                lists = await Promise.all(KIND_KEYS.map((kind) =>
                    fetch(`../${KINDS[kind].file}`, { cache: 'no-store' }).then((response) => {
                        if (!response.ok) throw new Error(`${KINDS[kind].file}: ${response.status}`);
                        return response.json();
                    })
                ));
            }
            live = Object.fromEntries(KIND_KEYS.map((kind, i) => [
                kind,
                lists[i].map((data, index) => ({ id: `${kind}-${index}`, data }))
            ]));
        } catch (error) {
            view.innerHTML = `
                <div class="empty-state">
                    <strong>Die Website-Daten konnten nicht geladen werden.</strong><br>
                    ${server ? `${escapeHtml(error.message)}<br>` : ''}Die Seite muss über einen Webserver laufen (z. B. den in WebStorm eingebauten oder
                    <code>python3 -m http.server</code> im Projektordner), nicht direkt als Datei.
                </div>
            `;
            return;
        }

        const stored = readStored();
        if (stored) {
            base = stored.base;
            draft = stored.draft;
            stale = computeStale();
        } else {
            base = clone(live);
            draft = clone(live);
        }
        render();
    }

    init();
})();
