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
  const dialogFit = await page.$$eval('#modalBody .hint', (nodes) => nodes[0].textContent);
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
