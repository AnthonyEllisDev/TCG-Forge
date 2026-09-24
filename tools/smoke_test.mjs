/*
 * End-to-end smoke test.
 *
 * Drives a running TCG Forge in headless Chromium and checks the paths that
 * break most easily: template loading, field binding, asset placement, layer
 * effects, undo/redo, save/open round trips and image export.
 *
 * Usage:
 *   python launch.py --no-browser &            # start the app first
 *   npm i playwright && npx playwright install chromium
 *   node tools/smoke_test.mjs [http://127.0.0.1:7870]
 *
 * Exits non-zero if anything fails, so CI can gate on it.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import http from 'node:http';
import net from 'node:net';

const BASE = process.argv[2] || 'http://127.0.0.1:7870';
const LAUNCH_OPTIONS = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : {};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/* Raw HTTP, so the request headers a browser refuses to forge can be tested. */
function rawRequest({ method = 'GET', path = '/api/status', headers = {}, body = null }) {
  const url = new URL(BASE);
  const sized = body
    ? { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }
    : headers;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, method, path, headers: sized },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* Announce a body far larger than the limit and never send it. */
function oversizedBodyProbe() {
  const url = new URL(BASE);
  return new Promise((resolve) => {
    let text = '';
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        `POST /api/write HTTP/1.1\r\nHost: ${url.host}\r\n` +
          'Content-Type: application/json\r\nContent-Length: 200000000\r\n\r\n{"junk":1}'
      );
    });
    socket.setTimeout(4000, () => socket.destroy());
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('close', () => resolve(text));
    socket.on('error', () => resolve(text));
  });
}

const browser = await chromium.launch(LAUNCH_OPTIONS);
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(`${e.message}`));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.TCGForge, null, { timeout: 15000 });
  await page.waitForTimeout(1200);

  check('app boots with no console errors', consoleErrors.length === 0, consoleErrors[0] || '');
  check('backend detected', (await page.textContent('#serverPill')).includes('local server'));

  /* ---- the local API is not open to the rest of the web ---------------- */
  const foreign = await rawRequest({
    method: 'POST',
    path: '/api/write',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ path: 'projects/smoke-foreign.json', content: '{}' }),
  });
  const rebound = await rawRequest({ headers: { Host: 'cards.evil.example' } });
  const sameOrigin = await rawRequest({
    method: 'POST',
    path: '/api/mkdir',
    headers: { 'Content-Type': 'application/json', Origin: BASE.replace(/\/$/, '') },
    body: JSON.stringify({ path: 'exports/smoke-guard' }),
  });
  const noOrigin = await rawRequest({ path: '/api/templates' });
  check('the workspace API refuses a foreign origin',
    foreign.status === 403 && /close/i.test(foreign.headers.connection || ''),
    `POST → ${foreign.status} (${foreign.headers.connection})`);
  check('the workspace API refuses a rebound host name', rebound.status === 403, `GET → ${rebound.status}`);
  check('the app itself and header-less callers still get through',
    sameOrigin.status === 200 && noOrigin.status === 200,
    `same-origin ${sameOrigin.status}, no Origin ${noOrigin.status}`);

  const files = await rawRequest({ path: '/files/assets/icons/star.svg' });
  check('workspace files are not readable cross-origin',
    files.status === 200 && !files.headers['access-control-allow-origin'],
    files.headers['access-control-allow-origin'] || 'no CORS header');

  const oversized = await oversizedBodyProbe();
  check('an over-large body closes its connection instead of desyncing it',
    oversized.startsWith('HTTP/1.1 400') && /\r\nConnection: close\r\n/i.test(oversized),
    oversized.split('\r\n')[0] || 'no response');

  /* ---- templates ------------------------------------------------------ */
  const templateCount = (await page.$$('#templateList .list-item')).length;
  check('templates listed', templateCount >= 4, `${templateCount} found`);

  for (const item of await page.$$('#templateList .list-item')) {
    if ((await item.textContent()).includes('Classic Spell')) {
      await item.click();
      break;
    }
  }
  await page.waitForTimeout(900);
  const layers = await page.evaluate(() => window.TCGForge.editor.objects().length);
  check('template loads onto the canvas', layers >= 9, `${layers} layers`);

  /* ---- field binding + auto-fit --------------------------------------- */
  await page.fill('#ff_title', 'Smoke Test Wyrm');
  await page.waitForTimeout(250);
  const title = await page.evaluate(() => window.TCGForge.editor.findBySlot('title')[0].text);
  check('card fields drive the canvas', title === 'Smoke Test Wyrm');

  await page.fill('#ff_rules', 'Trample. Whenever this creature attacks it deals damage equal to its power to each defending creature. '.repeat(4));
  await page.waitForTimeout(600);
  const fit = await page.evaluate(() => {
    const o = window.TCGForge.editor.findBySlot('rules')[0];
    return { size: o.fontSize, max: o.tcgFitSize, height: Math.round(o.height), target: o.tcgFitHeight };
  });
  check('auto-fit shrinks overflowing text', fit.size < fit.max && fit.height <= fit.target + 4, JSON.stringify(fit));

  /* ---- assets --------------------------------------------------------- */
  const placeFromLibrary = async (category, index) => {
    await page.click(`#assetTabs .tab[data-cat="${category}"]`);
    await page.waitForTimeout(250);
    const cells = await page.$$('#assetGrid .asset-cell');
    if (!cells[index]) throw new Error(`no asset at ${category}[${index}]`);
    await cells[index].click();
    await page.waitForTimeout(600);
  };
  await placeFromLibrary('backgrounds', 0);
  await placeFromLibrary('icons', 1);
  const afterAssets = await page.evaluate(() => window.TCGForge.editor.objects().length);
  check('assets place from the library', afterAssets === layers + 2, `${afterAssets} layers`);

  const art = await page.evaluate(async () => {
    const t = await import('/js/core/templates.js');
    const before = window.TCGForge.editor.objects().length;
    const img = await t.setFieldImage('art', '/files/assets/backgrounds/starfield.svg', {
      assetPath: 'assets/backgrounds/starfield.svg',
    });
    return { stable: before === window.TCGForge.editor.objects().length, clipped: !!img.clipPath, slot: img.tcgSlot };
  });
  check('art drops into its slot and clips', art.stable && art.clipped && art.slot === 'art', JSON.stringify(art));

  /* A blob: URL dies with the tab, so a file picked from disk has to become
     something the saved project can still find. */
  const picked = await page.evaluate(async () => {
    const { assets } = await import('/js/core/assets.js');
    const { api } = await import('/js/core/api.js');
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
      'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const blob = await (await fetch(png)).blob();
    const file = new File([blob], 'smoke-picked.png', { type: 'image/png' });
    const source = await assets.sourceForFile(file, 'art');
    await api.trash(source.path).catch(() => {});   // leave the library as found
    return source;
  });
  check('a file picked from disk lands in the workspace, not a blob URL',
    /^assets\/art\//.test(picked.path || '') && picked.url.startsWith('/files/'),
    JSON.stringify(picked));

  /* ---- effects -------------------------------------------------------- */
  await page.evaluate(() => {
    const panel = window.TCGForge.editor.objects().find((o) => o.tcgName === 'Text panel');
    window.TCGForge.editor.select(panel);
  });
  await page.waitForTimeout(300);
  await page.click('#fillMode .seg-btn[data-mode="linear"]');
  await page.check('#shadowOn');
  await page.selectOption('#pBlend', 'multiply');
  await page.waitForTimeout(400);
  const effects = await page.evaluate(() => {
    const o = window.TCGForge.editor.objects().find((x) => x.tcgName === 'Text panel');
    return { fill: typeof o.fill === 'object' ? o.fill.type : o.fill, shadow: !!o.shadow, blend: o.globalCompositeOperation };
  });
  check('gradient, shadow and blend mode apply',
    effects.fill === 'linear' && effects.shadow && effects.blend === 'multiply', JSON.stringify(effects));

  /* ---- history -------------------------------------------------------- */
  const history = await page.evaluate(async () => {
    const { editor, history } = window.TCGForge;
    const start = editor.objects().length;
    editor.insert('rect');
    await new Promise((r) => setTimeout(r, 400));
    editor.insert('ellipse');
    await new Promise((r) => setTimeout(r, 400));
    const grown = editor.objects().length;
    await history.undo();
    await history.undo();
    const undone = editor.objects().length;
    await history.redo();
    return { start, grown, undone, redone: editor.objects().length };
  });
  check('undo and redo restore state',
    history.grown === history.start + 2 && history.undone === history.start && history.redone === history.start + 1,
    JSON.stringify(history));

  /* ---- export --------------------------------------------------------- */
  await page.check('#showSafeZone');
  await page.check('#showBleed');
  await page.waitForTimeout(250);
  const dataURL = await page.evaluate(() => window.TCGForge.editor.toDataURL({ multiplier: 1 }));
  fs.writeFileSync('smoke-export.png', Buffer.from(dataURL.split(',')[1], 'base64'));
  check('export renders a PNG', dataURL.startsWith('data:image/png') && dataURL.length > 20000,
    `${Math.round(dataURL.length / 1024)} KB base64`);

  /* ---- project round trip --------------------------------------------- */
  const roundTrip = await page.evaluate(async () => {
    const p = await import('/js/core/project.js');
    const before = window.TCGForge.editor.objects().length;
    const beforeTitle = window.TCGForge.editor.findBySlot('title')[0].text;
    const saved = await p.saveProject({ name: 'Smoke Test Card' });
    await p.newProject({});
    const cleared = window.TCGForge.editor.objects().length;
    await p.openProjectPath(saved.path);
    return {
      cleared,
      restored: window.TCGForge.editor.objects().length === before,
      titleKept: window.TCGForge.editor.findBySlot('title')[0]?.text === beforeTitle,
    };
  });
  check('project saves and reopens intact',
    roundTrip.cleared === 0 && roundTrip.restored && roundTrip.titleKept, JSON.stringify(roundTrip));

  const imageRefs = await page.evaluate(() =>
    window.TCGForge.editor
      .objects()
      .filter((o) => o.type === 'image')
      .map((o) => ({ asset: o.tcgAsset, embedded: String(o.getSrc?.() || '').startsWith('data:') }))
  );
  check('images reference workspace paths, not base64',
    imageRefs.length > 0 && imageRefs.every((i) => i.asset && !i.embedded), `${imageRefs.length} images`);

  /* ---- batch renderer -------------------------------------------------- */
  const batch = await page.evaluate(async () => {
    const b = await import('/js/core/batch.js');
    const csv = 'title,type,rules,stats\nAlpha Drake,Creature — Drake,"Flying, haste.",2 / 2\nBeta Golem,Creature — Golem,"Defender, reach.",0 / 6\n';
    const table = b.parseTable(csv);
    const mapping = Object.fromEntries(table.columns.map((c) => [c, c]));
    const run = await b.runBatch({
      rows: table.rows,
      mapping,
      options: { multiplier: 1, format: 'png', pattern: 'smoke-{title}', subfolder: 'smoke', saveProjects: false, toWorkspace: true },
    });
    return { columns: table.columns.length, rows: table.rows.length, rendered: run.rendered.length, failed: run.failed.length };
  });
  check('batch renders a set from CSV',
    batch.columns === 4 && batch.rows === 2 && batch.rendered === 2 && batch.failed === 0, JSON.stringify(batch));

  /* A file with headers and no rows used to replace the loaded table and only
     then report the error, losing the spreadsheet that was already open. */
  await page.click('[data-action="batch"]');
  await page.waitForTimeout(300);
  const dataInput = await page.$('#modalBody input[type="file"]');
  const loadCsv = async (name, text) => {
    await dataInput.setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
    await page.waitForTimeout(400);
  };
  /* Rendering a preview is the only thing that proves the rows are still
     there: the summary line is not rewritten by a failed load either way. */
  const previewRenders = async () => {
    await page.evaluate(() => { document.querySelector('#modalBody .batch-preview').innerHTML = ''; });
    for (const button of await page.$$('#modalBody .btn')) {
      if ((await button.textContent()) === 'Preview first row') { await button.click(); break; }
    }
    await page.waitForTimeout(2000);
    return page.$$eval('#modalBody .batch-preview img', (nodes) => nodes.length > 0);
  };

  await loadCsv('smoke-good.csv', 'title,rules\nAlpha,x\nBeta,y\n');
  const loadedSummary = await page.$$eval('#modalBody .hint', (nodes) =>
    nodes.find((n) => /rows ×/.test(n.textContent))?.textContent || '');
  const beforeEmpty = await previewRenders();
  await loadCsv('smoke-empty.csv', 'title,rules\n');
  const afterEmpty = await previewRenders();
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  check('a headers-only data file keeps the table that was already loaded',
    /2 rows/.test(loadedSummary) && beforeEmpty && afterEmpty,
    JSON.stringify({ loadedSummary, beforeEmpty, afterEmpty }));

  await page.screenshot({ path: 'smoke-ui.png' });

  /* ---- regression guards ---------------------------------------------- */
  /* These exercise failure paths, so they run last: they deliberately wreck
     the canvas and leave the card setup pointing somewhere else. */

  const gradient = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const fx = await import('/js/core/effects.js');
    const rect = editor.insert('rect');
    rect.set('tcgName', 'gradient-probe');
    fx.setGradientFill(rect, { type: 'linear', from: '#ff0000', to: '#0000ff', angle: 30 });
    const before = fx.fillColors(rect).angle;
    await editor.loadJSON(JSON.parse(JSON.stringify(editor.toJSON())));
    const reloaded = editor.objects().find((o) => o.tcgName === 'gradient-probe');
    return { before, after: reloaded ? fx.fillColors(reloaded).angle : null };
  });
  check('gradient angle survives a save and reload',
    gradient.before === 30 && gradient.after === 30, JSON.stringify(gradient));

  const cardSetup = await page.evaluate(() => {
    window.TCGForge.editor.setCard({ width: 825, height: 1425, dpi: 600, preset: 'tarot' });
    return {
      dpi: document.getElementById('cardDpi').value,
      preset: document.getElementById('cardPreset').value,
      width: document.getElementById('cardWidth').value,
    };
  });
  check('card setup mirrors the card, not the last thing typed',
    cardSetup.dpi === '600' && cardSetup.preset === 'tarot' && cardSetup.width === '825',
    JSON.stringify(cardSetup));

  const afterBadLoad = await page.evaluate(async () => {
    const { editor, state } = window.TCGForge;
    let threw = false;
    try {
      await editor.loadJSON({ version: '6.9.1', objects: [{ type: 'NoSuchThing' }] });
    } catch { threw = true; }
    state.dirty = false;
    editor.touch();
    return { threw, suspended: editor.suspendEvents, stillTracking: state.dirty };
  });
  check('a failed canvas load still leaves edits tracked',
    afterBadLoad.threw && afterBadLoad.suspended === false && afterBadLoad.stillTracking === true,
    JSON.stringify(afterBadLoad));

  /* "Clip to card" installs a clipPath and marks it as ours. If that marker
     is not persisted the option cannot be switched off again after a reload. */
  const clipRoundTrip = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const rect = editor.insert('rect');
    rect.set('tcgName', 'clip-probe');
    const clip = document.getElementById('pClip');
    clip.checked = true;
    clip.dispatchEvent(new Event('change', { bubbles: true }));
    const applied = !!rect.clipPath;
    await editor.loadJSON(JSON.parse(JSON.stringify(editor.toJSON())));
    const back = editor.objects().find((o) => o.tcgName === 'clip-probe');
    const survived = !!back.clipPath?.tcgCardClip;
    editor.select(back);
    clip.checked = false;
    clip.dispatchEvent(new Event('change', { bubbles: true }));
    return { applied, survived, released: !back.clipPath };
  });
  check('clip to card can still be switched off after a reload',
    clipRoundTrip.applied && clipRoundTrip.survived && clipRoundTrip.released,
    JSON.stringify(clipRoundTrip));

  /* A multi-layer drag must snap to the rest of the card, not to its own
     members — they sit at zero distance and win every comparison. */
  const snap = await page.evaluate(() => {
    const { editor, state } = window.TCGForge;
    editor.clear();
    editor.setZoom(1);
    state.settings.snap = true;
    const box = (left, top) => {
      const o = editor.insert('rect');
      o.set({ left, top, width: 50, height: 50, scaleX: 1, scaleY: 1 });
      o.setCoords();
      return o;
    };
    box(100, 600);                       // the thing to snap against
    const a = box(400, 200);
    const b = box(500, 200);
    editor.select([a, b]);
    const sel = editor.active();
    sel.set({ left: sel.left + (103 - sel.getBoundingRect().left) });
    sel.setCoords();
    editor.handleMoving({ target: sel });
    return {
      members: sel.getObjects().length,
      guides: editor.guides.filter((g) => g.axis === 'x').map((g) => g.at),
      left: Math.round(sel.getBoundingRect().left),
    };
  });
  check('a multi-layer drag snaps to the card, not to itself',
    snap.members === 2 && snap.left === 100 && snap.guides.includes(100), JSON.stringify(snap));

  /* Re-rendering the layer list detaches the rename input, which fires blur —
     so cancelling must not go through the commit path. */
  const rename = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const target = editor.objects()[editor.objects().length - 1];
    target.set('tcgName', 'Original name');
    editor.touch();
    await new Promise((r) => setTimeout(r, 80));
    const row = document.querySelector('#layerList .layer-row .layer-name');
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = row.querySelector('input');
    input.value = 'Typed then cancelled';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return { name: target.tcgName };
  });
  check('Escape abandons a layer rename instead of committing it',
    rename.name === 'Original name', JSON.stringify(rename));

  /* Tab has to stay inside a dialog: aria-modal does nothing to the keyboard. */
  await page.evaluate(async () => {
    const d = await import('/js/ui/dialogs.js');
    d.openModal({
      title: 'Focus probe',
      body: 'nothing here',
      buttons: [{ label: 'One', onClick: () => {} }, { label: 'Two', primary: true, onClick: () => {} }],
    });
  });
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Tab');
  const trapped = await page.evaluate(async () => {
    const inside = document.getElementById('modalRoot').contains(document.activeElement);
    const labelled = document.querySelector('#modalRoot .modal').getAttribute('aria-labelledby');
    (await import('/js/ui/dialogs.js')).closeModal();
    return { inside, labelled };
  });
  check('keyboard focus stays inside an open dialog',
    trapped.inside && trapped.labelled === 'modalTitle', JSON.stringify(trapped));

  const afterBadStep = await page.evaluate(async () => {
    const { history } = window.TCGForge;
    let threw = false;
    try {
      await history.apply(JSON.stringify({ card: {}, canvas: { version: '6.9.1', objects: [{ type: 'NoSuchThing' }] } }));
    } catch { threw = true; }
    return { threw, locked: history.locked };
  });
  check('a failed history step releases the lock',
    afterBadStep.threw && afterBadStep.locked === false, JSON.stringify(afterBadStep));

  /* Every way out of a dialog has to answer its caller exactly once: the
     buttons, Enter, Escape and the ✕. */
  const answers = await page.evaluate(async () => {
    const d = await import('/js/ui/dialogs.js');
    const settle = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('NEVER SETTLED'), 500))]);
    const tick = () => new Promise((r) => setTimeout(r, 60));
    const footButton = (label) =>
      [...document.querySelectorAll('#modalFoot .btn')].find((b) => b.textContent === label);

    const out = {};
    let p = settle(d.confirmDialog({ title: 'T', message: 'M', confirmLabel: 'Go' }));
    await tick();
    footButton('Go').click();
    out.confirmed = await p;

    p = settle(d.confirmDialog({ title: 'T', message: 'M' }));
    await tick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.escaped = await p;

    p = settle(d.promptDialog({ title: 'T', value: 'typed name' }));
    await tick();
    footButton('OK').click();
    out.prompted = await p;

    p = settle(d.promptDialog({ title: 'T' }));
    await tick();
    document.querySelector('#modalRoot .modal-head [data-close]').click();
    out.dismissed = await p;
    return out;
  });
  check('every way out of a dialog answers its caller',
    answers.confirmed === true && answers.escaped === false &&
    answers.prompted === 'typed name' && answers.dismissed === null,
    JSON.stringify(answers));

  /* A render that throws must not latch the flag that hides the guides, nor
     leave a transparent background behind. */
  const exportFailure = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const real = editor.canvas.toDataURL.bind(editor.canvas);
    const background = editor.canvas.backgroundColor;
    editor.canvas.toDataURL = () => { throw new Error('render failed'); };
    let threw = false;
    try { editor.toDataURL({ transparent: true }); } catch { threw = true; }
    editor.canvas.toDataURL = real;
    return { threw, exporting: editor.exporting, backgroundKept: editor.canvas.backgroundColor === background };
  });
  check('a failed export leaves the guides and background alone',
    exportFailure.threw && exportFailure.exporting === false && exportFailure.backgroundKept,
    JSON.stringify(exportFailure));

  /* templateId is a slug; the row label is a display name. */
  const highlight = await page.evaluate(async () => {
    const t = await import('/js/core/templates.js');
    const { api, state } = window.TCGForge;
    const list = await api.listTemplates();
    const wanted = list.find((x) => /classic/i.test(x.name));
    await t.applyTemplate(await api.readJSON(wanted.path));
    await new Promise((r) => setTimeout(r, 200));
    const active = [...document.querySelectorAll('#templateList .list-item.active .li-title')];
    return { id: wanted.id, templateId: state.project.templateId, active: active.map((n) => n.textContent) };
  });
  check('the template browser marks the template that is loaded',
    highlight.id === highlight.templateId && highlight.active.length === 1 &&
      /Classic/i.test(highlight.active[0]),
    JSON.stringify(highlight));

  /* ---- print sheets ---------------------------------------------------- */
  const geometry = await page.evaluate(async () => {
    const ps = await import('/js/core/printSheet.js');
    const a4 = ps.planSheet({ cardWidth: 750, cardHeight: 1050, cardDpi: 300, page: 'a4', dpi: 300, marginMm: 6 });
    const land = ps.planSheet({ cardWidth: 750, cardHeight: 1050, cardDpi: 300, page: 'letter', landscape: true, dpi: 300 });
    const hidpi = ps.planSheet({ cardWidth: 1500, cardHeight: 2100, cardDpi: 600, page: 'a4', dpi: 300, marginMm: 6 });
    let refused = null;
    try { ps.planSheet({ cardWidth: 6000, cardHeight: 9000, cardDpi: 300, page: 'a4' }); }
    catch (err) { refused = err.message; }
    return {
      a4: { grid: `${a4.cols}x${a4.rows}`, page: [a4.pageWidth, a4.pageHeight], trim: a4.trimInches, slot: Math.round(a4.slots[0].width) },
      land: `${land.cols}x${land.rows}`,
      hidpiTrim: hidpi.trimInches,
      refused,
    };
  });
  check('a print sheet places cards at their true physical size',
    geometry.a4.grid === '3x3' && geometry.a4.page[0] === 2480 && geometry.a4.page[1] === 3508 &&
      geometry.a4.trim[0] === 2.5 && geometry.a4.slot === 750 &&
      geometry.land === '4x2' && geometry.hidpiTrim[0] === 2.5 && !!geometry.refused,
    JSON.stringify(geometry));

  /* The PDF is hand-rolled, so its byte offsets are the thing most likely to
     rot silently: walk the xref table and confirm every entry resolves. */
  const pdfShape = await page.evaluate(async () => {
    const ps = await import('/js/core/printSheet.js');
    const pdf = await import('/js/core/pdf.js');
    const plan = ps.planSheet({ cardWidth: 750, cardHeight: 1050, cardDpi: 300, page: 'a4', dpi: 150 });
    const card = document.createElement('canvas');
    card.width = 150; card.height = 210;
    card.getContext('2d').fillRect(0, 0, 150, 210);
    const image = await ps.loadImage(card.toDataURL('image/png'));
    const sheet = ps.composePage([image, image], plan, { guides: 'crop' });
    const bytes = pdf.buildPDF(
      [{
        jpeg: pdf.dataURLToBytes(sheet.toDataURL('image/jpeg', 0.9)),
        pixelWidth: sheet.width,
        pixelHeight: sheet.height,
        widthPt: plan.pagePoints[0],
        heightPt: plan.pagePoints[1],
      }],
      { title: 'smoke' }
    );
    const text = new TextDecoder('windows-1252').decode(bytes);
    const box = (text.match(/\/MediaBox \[ ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) \]/) || []).slice(3).map(Number);
    const startxref = Number((text.match(/startxref\s+(\d+)/) || [])[1]);
    const rows = [...text.slice(startxref).matchAll(/(\d{10}) (\d{5}) ([nf])/g)];
    return {
      header: text.slice(0, 8),
      box,
      objects: rows.length,
      resolved: rows.every((row, i) => row[3] === 'f' || text.startsWith(`${i} 0 obj`, Number(row[1]))),
      jpegStream: /\/Filter \/DCTDecode/.test(text),
      url: pdf.pdfDataURL(bytes).slice(0, 28),
      bytes: bytes.length,
    };
  });
  check('the print sheet PDF states its page size and its xref resolves',
    pdfShape.header === '%PDF-1.4' && Math.abs(pdfShape.box[0] - 595.28) < 1 &&
      Math.abs(pdfShape.box[1] - 841.89) < 1 && pdfShape.resolved && pdfShape.jpegStream &&
      pdfShape.url === 'data:application/pdf;base64,' && pdfShape.bytes > 5000,
    JSON.stringify({ ...pdfShape, url: undefined }));

  /* And the dialog actually writes them. */
  await page.click('[data-action="print-sheet"]');
  await page.waitForTimeout(400);
  const dialogFit = await page.$eval('#printFit', (node) => node.textContent);
  for (const button of await page.$$('#modalFoot .btn')) {
    if ((await button.textContent()) === 'Make sheets') { await button.click(); break; }
  }
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'smoke-print.png' });
  const sheetFiles = await page.evaluate(async () => {
    const { api } = window.TCGForge;
    const data = await api.request('/api/list?path=exports/print').catch(() => ({ entries: [] }));
    return (data.entries || []).map((e) => ({ name: e.name, size: e.size }));
  });
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  check('the print dialog writes a sheet into the workspace',
    /cards per/.test(dialogFit) && sheetFiles.some((f) => /\.pdf$/.test(f.name) && f.size > 10000),
    JSON.stringify({ dialogFit, sheetFiles }));

  /* ---- card backs: duplex and gutterfold ------------------------------- */
  /* The geometry is the feature. A back has to land on the far side of the
     page centre line from its front, because that is what the sheet of paper
     does when the printer turns it over. */
  const duplex = await page.evaluate(async () => {
    const ps = await import('/js/core/printSheet.js');
    const base = { cardWidth: 750, cardHeight: 1050, cardDpi: 300, page: 'a4', dpi: 150, marginMm: 6 };
    const plain = ps.planSheet(base);
    const long = ps.planSheet({ ...base, backMode: 'duplex', flipEdge: 'long' });
    const short = ps.planSheet({ ...base, backMode: 'duplex', flipEdge: 'short' });
    const shifted = ps.planSheet({ ...base, backMode: 'duplex', flipEdge: 'long', shiftXMm: 2, shiftYMm: -1 });
    const mirrorsX = long.slots.every((slot, i) =>
      Math.abs(long.backSlots[i].left + slot.width - (long.pageWidth - slot.left)) < 0.01 &&
      Math.abs(long.backSlots[i].top - slot.top) < 0.01);
    const mirrorsY = short.slots.every((slot, i) =>
      Math.abs(short.backSlots[i].top + slot.height - (short.pageHeight - slot.top)) < 0.01 &&
      Math.abs(short.backSlots[i].left - slot.left) < 0.01);
    const mmX = 2 / 25.4 * 150;
    const mmY = -1 / 25.4 * 150;
    const shiftApplied =
      Math.abs(shifted.backSlots[0].left - (long.backSlots[0].left + mmX)) < 0.01 &&
      Math.abs(shifted.backSlots[0].top - (long.backSlots[0].top + mmY)) < 0.01;
    return {
      plainHasNoBacks: plain.backSlots === null,
      perPageUnchanged: long.perPage === plain.perPage,
      mirrorsX,
      mirrorsY,
      shiftApplied,
      // Rounding the page to whole pixels leaves the mirrored grid a fraction
      // of a pixel off the printed one; a millimetre is 6 pixels here.
      firstBackOverLastFront:
        Math.abs(long.backSlots[0].left - long.slots[long.cols - 1].left) < 1,
    };
  });
  check('a duplex back lands on the far side of the page from its front',
    duplex.plainHasNoBacks && duplex.perPageUnchanged && duplex.mirrorsX && duplex.mirrorsY &&
      duplex.shiftApplied && duplex.firstBackOverLastFront,
    JSON.stringify(duplex));

  const gutter = await page.evaluate(async () => {
    const ps = await import('/js/core/printSheet.js');
    const base = { cardWidth: 750, cardHeight: 1050, cardDpi: 300, page: 'a4', dpi: 150, marginMm: 6 };
    const plain = ps.planSheet(base);
    const fold = ps.planSheet({ ...base, backMode: 'gutterfold' });
    let refused = null;
    try { ps.planSheet({ ...base, cardHeight: 1800, backMode: 'gutterfold' }); }
    catch (err) { refused = err.message; }
    return {
      halfThePage: fold.perPage < plain.perPage && fold.rows < plain.rows && fold.cols === plain.cols,
      foldAtCentre: fold.foldY === fold.pageHeight / 2,
      rotated: fold.backRotated === true,
      frontsBelowFold: fold.slots.every((s) => s.top > fold.foldY),
      backsAboveFold: fold.backSlots.every((s) => s.top + s.height < fold.foldY),
      mirrorsFold: fold.slots.every((s, i) =>
        Math.abs(fold.backSlots[i].top + s.height - (fold.pageHeight - s.top)) < 0.01 &&
        Math.abs(fold.backSlots[i].left - s.left) < 0.01),
      refused,
    };
  });
  check('a gutterfold sheet puts the backs across the fold from the fronts',
    gutter.halfThePage && gutter.foldAtCentre && gutter.rotated && gutter.frontsBelowFold &&
      gutter.backsAboveFold && gutter.mirrorsFold && /half of/.test(gutter.refused || ''),
    JSON.stringify(gutter));

  /* Geometry can be right on paper and wrong on the page. Paint real sheets
     and read the pixels back: the wrong mirror, or a back printed the right
     way up on a folded sheet, is invisible in the source and obvious here. */
  const painted = await page.evaluate(async () => {
    const ps = await import('/js/core/printSheet.js');
    const swatch = (top, bottom = top) => {
      const c = document.createElement('canvas');
      c.width = 60; c.height = 84;
      const x = c.getContext('2d');
      x.fillStyle = top; x.fillRect(0, 0, 60, 42);
      x.fillStyle = bottom; x.fillRect(0, 42, 60, 42);
      return c.toDataURL('image/png');
    };
    const at = (canvas, x, y) => {
      const d = canvas.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    };

    const base = { cardWidth: 750, cardHeight: 1050, cardDpi: 300, page: 'a4', dpi: 150, marginMm: 6 };
    const plan = ps.planSheet({ ...base, backMode: 'duplex', flipEdge: 'long' });
    const fronts = await Promise.all(['#ff0000', '#00ff00', '#0000ff'].map((c) => ps.loadImage(swatch(c))));
    const backs = await Promise.all(['#00ffff', '#ff00ff', '#ffff00'].map((c) => ps.loadImage(swatch(c))));
    const pages = await ps.buildSheets(
      fronts.map((_, i) => swatch(['#ff0000', '#00ff00', '#0000ff'][i])),
      plan,
      { backs: ['#00ffff', '#ff00ff', '#ffff00'].map((c) => swatch(c)), guides: 'none', pageLabel: 'smoke' }
    );

    const front = pages[0].canvas;
    const back = pages[1].canvas;
    const mid = (slot) => [slot.left + slot.width / 2, slot.top + slot.height / 2];
    // Back 0 must sit exactly where front 2 sits, so the sheet turned over
    // puts each back behind its own card.
    const backOfFirst = at(back, ...mid(plan.slots[2]));
    const frontOfFirst = at(front, ...mid(plan.slots[0]));

    /* gutterfold: the back is printed upside down, so the half that was on
       top comes out at the bottom. */
    const foldPlan = ps.planSheet({ ...base, backMode: 'gutterfold' });
    const foldPages = await ps.buildSheets([swatch('#ff0000')], foldPlan, {
      backs: [swatch('#000080', '#ffffff')],
      guides: 'none',
    });
    const bs = foldPlan.backSlots[0];
    const foldTop = at(foldPages[0].canvas, bs.left + bs.width / 2, bs.top + bs.height * 0.15);
    const foldBottom = at(foldPages[0].canvas, bs.left + bs.width / 2, bs.top + bs.height * 0.85);

    return {
      pageCount: pages.length,
      sides: pages.map((p) => p.side).join(','),
      frontOfFirst,
      backOfFirst,
      emptyWhereBackIsNot: at(back, ...mid(plan.slots[6])),
      foldPages: foldPages.length,
      foldTop,
      foldBottom,
    };
  });
  check('a printed back sits behind its own card, and a folded one upside down',
    painted.pageCount === 2 && painted.sides === 'front,back' &&
      painted.frontOfFirst === '255,0,0' && painted.backOfFirst === '0,255,255' &&
      painted.emptyWhereBackIsNot === '255,255,255' &&
      painted.foldPages === 1 && painted.foldTop === '255,255,255' && painted.foldBottom === '0,0,128',
    JSON.stringify(painted));

  const pairing = await page.evaluate(async () => {
    const ps = await import('/js/core/printSheet.js');
    const errors = [];
    const grab = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
    errors.push(grab(() => ps.pairBacks([], 4)));
    errors.push(grab(() => ps.pairBacks(['a', 'b'], 4)));
    return {
      oneForAll: ps.pairBacks(['back.png'], 4),
      onePerCard: ps.pairBacks(['a', 'b', 'c'], 3).join(''),
      errors,
    };
  });
  check('card backs pair one for the set, or one per card, or not at all',
    pairing.oneForAll.length === 4 && pairing.oneForAll.every((u) => u === 'back.png') &&
      pairing.onePerCard === 'abc' && /single-sided/.test(pairing.errors[0] || '') &&
      /2 backs for 4 cards/.test(pairing.errors[1] || ''),
    JSON.stringify(pairing));

  /* And the dialog drives all of it. */
  await page.evaluate(async () => {
    const { api } = window.TCGForge;
    const c = document.createElement('canvas');
    c.width = 750; c.height = 1050;
    const x = c.getContext('2d');
    x.fillStyle = '#204080'; x.fillRect(0, 0, 750, 1050);
    await api.exportImage({
      filename: 'smoke-back.png', dataURL: c.toDataURL('image/png'),
      folder: 'smoke-backs', overwrite: true,
    });
  });
  await page.click('[data-action="print-sheet"]');
  await page.waitForTimeout(500);
  await page.selectOption('#printBackMode', 'duplex');
  await page.selectOption('#printBackFolder', 'exports/smoke-backs');
  await page.selectOption('#printFormat', 'png');
  await page.fill('#printCopies', '2');
  const duplexFit = await page.$eval('#printFit', (node) => node.textContent);
  for (const button of await page.$$('#modalFoot .btn')) {
    if ((await button.textContent()) === 'Make sheets') { await button.click(); break; }
  }
  await page.waitForTimeout(7000);
  await page.screenshot({ path: 'smoke-duplex.png' });
  const duplexStatus = await page.$eval('#printStatus', (node) => node.textContent);
  const duplexFiles = await page.evaluate(async () => {
    const { api } = window.TCGForge;
    const data = await api.request('/api/list?path=exports/print').catch(() => ({ entries: [] }));
    return (data.entries || []).map((e) => e.name);
  });
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  check('the print dialog writes a front page and a back page',
    /double-sided/.test(duplexFit) && /fronts and backs interleaved/.test(duplexStatus) &&
      duplexFiles.some((n) => /-sheet-01(-\d+)?\.png$/.test(n)) &&
      duplexFiles.some((n) => /-sheet-01-back(-\d+)?\.png$/.test(n)),
    JSON.stringify({ duplexFit, duplexStatus, duplexFiles: duplexFiles.slice(0, 6) }));

  /* ---- per-card quantities --------------------------------------------- */
  /* A deck is four of one card and one of another. The counting is arithmetic,
     so it is checked as arithmetic first: what a spreadsheet cell may hold,
     what a manifest may claim, and the ceiling that stops a mistyped count
     from trying to lay out a million cards. */
  const deckMath = await page.evaluate(async () => {
    const ps = await import('/js/core/printSheet.js');
    const refusal = (fn) => { try { fn(); return null; } catch (err) { return err.message; } };
    return {
      expanded: ps.expandByQuantity(['a', 'b', 'c'], [3, 1, 2]).join(''),
      noCounts: ps.expandByQuantity(['a', 'b'], null).join(''),
      cells: [ps.readQuantity(''), ps.readQuantity('x'), ps.readQuantity('0'),
        ps.readQuantity('-4'), ps.readQuantity('2.7'), ps.readQuantity(4)].join(','),
      // A manifest may only name a file in the folder it was found in.
      strippedPath: ps.parseDeck({
        format: 'tcgforge.deck',
        cards: [{ file: '../../launch.py', qty: 2 }],
      })[0].file,
      refused: [
        refusal(() => ps.parseDeck({ format: 'not-a-deck', cards: [{ file: 'a.png' }] })),
        refusal(() => ps.parseDeck({ format: 'tcgforge.deck', cards: [] })),
        refusal(() => ps.expandByQuantity(['a', 'b', 'c'], [9999, 9999, 9999])),
      ],
    };
  });
  check('a deck list counts copies, and refuses what it cannot count',
    deckMath.expanded === 'aaabcc' && deckMath.noCounts === 'ab' &&
      deckMath.cells === '1,1,1,1,2,4' && deckMath.strippedPath === 'launch.py' &&
      deckMath.refused.every(Boolean) && /2000/.test(deckMath.refused[2]),
    JSON.stringify(deckMath));

  /* The count has to reach the paper. Three designs in three colours, laid out
     from a deck list, must appear on the sheet as many times as the list says
     — read back off the page, not off a number that agrees with itself. */
  const deckSheet = await page.evaluate(async () => {
    const ps = await import('/js/core/printSheet.js');
    const swatch = (colour) => {
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 140;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    };
    const designs = [swatch('#ff0000'), swatch('#00ff00'), swatch('#0000ff')];
    const urls = ps.expandByQuantity(designs, [3, 1, 2]);
    const plan = ps.planSheet({ cardWidth: 750, cardHeight: 1050, cardDpi: 300, dpi: 150 });
    const pages = await ps.buildSheets(urls, plan, { guides: 'none' });
    const ctx = pages[0].canvas.getContext('2d');
    const counts = {};
    for (const slot of plan.slots) {
      const px = ctx.getImageData(
        Math.round(slot.left + slot.width / 2),
        Math.round(slot.top + slot.height / 2), 1, 1).data;
      const key = `${px[0]},${px[1]},${px[2]}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return { cards: urls.length, pages: pages.length, perPage: plan.perPage, counts };
  });
  check('a deck prints as many of each card as the list asks for',
    deckSheet.cards === 6 && deckSheet.pages === 1 && deckSheet.perPage === 9 &&
      deckSheet.counts['255,0,0'] === 3 && deckSheet.counts['0,255,0'] === 1 &&
      deckSheet.counts['0,0,255'] === 2 && deckSheet.counts['255,255,255'] === 3,
    JSON.stringify(deckSheet));

  /* A run with a quantity column renders each design once and writes the
     counts beside the images — one file per design, not one per copy. */
  const deckWrite = await page.evaluate(async () => {
    const { api } = window.TCGForge;
    const batch = await import('/js/core/batch.js');
    const templates = await import('/js/core/templates.js');
    await templates.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    const result = await batch.runBatch({
      rows: [
        { title: 'Smoke Triple', qty: '3' },
        { title: 'Smoke Single', qty: '' },   // an empty cell is one, not none
        { title: 'Smoke Double', qty: '2' },
      ],
      mapping: { title: 'title' },
      options: { multiplier: 1, pattern: '{title}', subfolder: 'smoke-deck', qtyColumn: 'qty' },
    });
    const listing = await api.request('/api/list?path=exports/smoke-deck');
    // A missing list is this check's own failure, not a reason to abandon the run.
    const deck = await api.readJSON('exports/smoke-deck/deck.json').catch(() => null);
    return {
      guessed: batch.guessQtyColumn(['title', 'Qty', 'art']),
      noColumn: batch.guessQtyColumn(['title', 'art']),
      rendered: result.rendered.length,
      deckPath: result.deckPath,
      images: (listing.entries || []).filter((e) => /\.png$/.test(e.name)).length,
      counts: (deck?.cards || []).map((card) => card.qty).join(','),
      total: deck?.total ?? null,
    };
  });
  check('a batch run records how many of each card the deck wants',
    deckWrite.rendered === 3 && deckWrite.guessed === 'Qty' && deckWrite.noColumn === '' &&
      deckWrite.deckPath === 'exports/smoke-deck/deck.json' &&
      deckWrite.counts === '3,1,2' && deckWrite.total === 6 && deckWrite.images === 3,
    JSON.stringify(deckWrite));

  /* And the dialog finds that list on its own, without being told. */
  await page.click('[data-action="print-sheet"]');
  await page.waitForTimeout(500);
  await page.selectOption('#printSource', 'folder');
  await page.selectOption('#printFolder', 'exports/smoke-deck');
  await page.waitForTimeout(600);
  const deckHint = await page.$eval('#printDeckHint', (node) => node.textContent);
  const deckToggle = await page.$eval('#printUseQty', (node) => node.checked && !node.disabled);
  const pressPreview = async () => {
    for (const button of await page.$$('#modalFoot .btn')) {
      if ((await button.textContent()) === 'Preview') { await button.click(); break; }
    }
    await page.waitForTimeout(3500);
    return page.$eval('#printStatus', (node) => node.textContent);
  };
  const deckStatus = await pressPreview();
  await page.screenshot({ path: 'smoke-deck.png' });
  // Set rather than click: with no list found the box is disabled, and this
  // check has to report that as a failure instead of stalling on it.
  await page.$eval('#printUseQty', (node) => { node.checked = false; });
  const plainStatus = await pressPreview();
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  check('the print dialog finds the deck list and lays the copies out',
    /6 cards/.test(deckHint) && /3 designs/.test(deckHint) && deckToggle &&
      /6 cards from 3 designs/.test(deckStatus) &&
      /3 cards/.test(plainStatus) && !/designs/.test(plainStatus),
    JSON.stringify({ deckHint, deckToggle, deckStatus, plainStatus }));

  /* ---- bug guards ------------------------------------------------------ */
  /* A batch that cannot put the canvas back must still hand the history lock
     over, or undo and redo are dead for the rest of the session and nothing
     on screen says why. */
  const batchLock = await page.evaluate(async () => {
    const { history, editor } = window.TCGForge;
    const batch = await import('/js/core/batch.js');
    const real = editor.loadJSON.bind(editor);
    let calls = 0;
    editor.loadJSON = async (json) => {
      calls += 1;
      if (calls >= 2) throw new Error('simulated restore failure');
      return real(json);
    };
    try {
      await batch.runBatch({
        rows: [{ title: 'Lock probe' }], mapping: { title: 'title' },
        options: { toWorkspace: false },
      });
    } catch { /* the restore failure is the point */ }
    editor.loadJSON = real;
    const locked = history.locked;
    const depthBefore = history.status().depth;
    editor.insert('rect');
    await new Promise((r) => setTimeout(r, 700));
    const depthAfter = history.status().depth;
    editor.remove(editor.objects().slice(-1));
    history.locked = false;
    return { locked, depthBefore, depthAfter, stillRecording: depthAfter > depthBefore };
  });
  check('a batch that fails to restore still hands back the history lock',
    batchLock.locked === false && batchLock.stillRecording, JSON.stringify(batchLock));

  /* Opening a project replaces the canvas as completely as New does. */
  const openGuard = await page.evaluate(async () => {
    const { state, editor } = window.TCGForge;
    state.setDirty(true);
    const layersBefore = editor.objects().length;
    document.querySelector('[data-action="open-project"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const title = document.querySelector('#modalTitle').textContent;
    // Cancel, and nothing may have happened to the card.
    const cancel = [...document.querySelectorAll('#modalFoot .btn')]
      .find((b) => b.textContent === 'Cancel');
    cancel?.click();
    await new Promise((r) => setTimeout(r, 300));
    return {
      title,
      asked: /unsaved|Open another/i.test(title),
      closed: document.querySelector('#modalRoot').hidden,
      layersKept: editor.objects().length === layersBefore,
    };
  });
  check('opening a project asks before discarding unsaved work',
    openGuard.asked && openGuard.closed && openGuard.layersKept, JSON.stringify(openGuard));

  /* A panel field owns its own undo stack while the caret is in it. */
  const fieldUndo = await page.evaluate(async () => {
    const { editor, history, state } = window.TCGForge;
    state.setDirty(false);
    const input = document.querySelector('#fieldForm input[type="text"]');
    if (!input) return { skipped: true };
    const slot = input.id.replace(/^ff_/, '');
    input.focus();
    input.value = 'Undo probe';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const indexBefore = history.status().index;
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 600));
    return {
      hijacked: event.defaultPrevented,
      indexBefore,
      indexAfter: history.status().index,
      textKept: editor.findBySlot(slot)[0]?.text === 'Undo probe',
    };
  });
  check('undo inside a card field is left to the field',
    fieldUndo.hijacked === false && fieldUndo.indexAfter === fieldUndo.indexBefore && fieldUndo.textKept,
    JSON.stringify(fieldUndo));

  /* The library feeds the canvas, and the canvas feeds the project file. */
  const offlineImport = await page.evaluate(async () => {
    const { assets, api } = window.TCGForge;
    const was = api.online;
    api.online = false;
    const c = document.createElement('canvas');
    c.width = 4; c.height = 4;
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'offline-probe.png', { type: 'image/png' });
    const imported = await assets.importFiles([file], 'art');
    api.online = was;
    const entry = (assets.index.art || []).find((i) => i.file === 'offline-probe.png');
    assets.index.art = (assets.index.art || []).filter((i) => i.file !== 'offline-probe.png');
    return {
      returned: String(imported[0]?.url || '').slice(0, 11),
      indexed: String(entry?.url || '').slice(0, 11),
    };
  });
  check('an import without the backend keeps the picture, not a blob URL',
    offlineImport.returned === 'data:image/' && offlineImport.indexed === 'data:image/',
    JSON.stringify(offlineImport));

  /* Loading a template must not leave Save aimed at the project that was open.
     The top bar has already swapped to the template's name, so an overwrite
     there is silent, total, and impossible to see coming. */
  const templateTarget = await page.evaluate(async () => {
    const { state, api } = window.TCGForge;
    const project = await import('/js/core/project.js');
    const templates = await import('/js/core/templates.js');
    state.project.path = null;
    const victim = await project.saveProject({ name: 'Smoke Victim' });
    const before = (await api.readJSON(victim.path)).name;

    const list = await api.listTemplates();
    await templates.applyTemplate(await api.readJSON(list[0].path));
    const pathAfter = state.project.path;

    const saved = await project.saveProject({});          // the user presses Ctrl+S
    const after = (await api.readJSON(victim.path)).name;
    await api.trash(victim.path).catch(() => {});
    if (saved.path !== victim.path) await api.trash(saved.path).catch(() => {});
    return { victim: victim.path, pathAfter, savedTo: saved.path, before, after };
  });
  check('loading a template does not aim Save at the project that was open',
    templateTarget.pathAfter === null && templateTarget.savedTo !== templateTarget.victim &&
      templateTarget.after === templateTarget.before,
    JSON.stringify(templateTarget));

  /* The batch dialog keeps its spreadsheet between openings. A reopened dialog
     that does not show it looks empty while Render set still holds every row,
     mapped onto slots this card may no longer have. */
  const batchReopen = await page.evaluate(async () => {
    const dialogs = await import('/js/ui/dialogs.js');
    const panel = await import('/js/ui/batchPanel.js');
    const { api } = window.TCGForge;
    const csv = (await api.request('/api/read?path=batch/sample-set.csv')).content;
    const readBack = () => ({
      summary: document.querySelector('#batchSummary').textContent,
      rows: document.querySelectorAll('#modalBody .map-row').length,
      qty: document.querySelector('#batchQtyColumn')?.value,
    });

    panel.openBatchDialog();
    await new Promise((r) => setTimeout(r, 250));
    const input = document.querySelector('#modalBody input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([csv], 'sample-set.csv', { type: 'text/csv' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 700));
    const loaded = readBack();

    dialogs.closeModal();
    panel.openBatchDialog();
    await new Promise((r) => setTimeout(r, 500));
    const reopened = readBack();
    dialogs.closeModal();
    return { loaded, reopened };
  });
  check('a reopened batch dialog shows the spreadsheet it still holds',
    /6 rows/.test(batchReopen.loaded.summary) && batchReopen.loaded.rows > 0 &&
      batchReopen.loaded.qty === 'qty' &&
      batchReopen.reopened.summary === batchReopen.loaded.summary &&
      batchReopen.reopened.rows === batchReopen.loaded.rows &&
      batchReopen.reopened.qty === 'qty',
    JSON.stringify(batchReopen));

  /* ---- graceful degradation ------------------------------------------- */
  const offlinePage = await browser.newPage();
  await offlinePage.goto(BASE, { waitUntil: 'networkidle' });
  await offlinePage.waitForTimeout(1000);
  await offlinePage.route('**/api/**', (route) => route.abort());
  const offline = await offlinePage.evaluate(async () => {
    const { api } = await import('/js/core/api.js');
    const online = await api.connect();
    const p = await import('/js/core/project.js');
    const res = await p.saveProject({ name: 'Offline Card' }).catch((e) => ({ error: e.message }));
    return { online, saved: res?.saved };
  });
  check('degrades to downloads when the backend is gone',
    offline.online === false && offline.saved === 'download', JSON.stringify(offline));
} catch (err) {
  check(`unexpected failure: ${err.message}`, false);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
