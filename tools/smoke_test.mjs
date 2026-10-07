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
import os from 'node:os';
import path from 'node:path';

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

  /* ---- layers that follow a field -------------------------------------- */
  /* The Classic Spell cost gem carries tcgShowIf: 'cost'. Emptying the field
     has to take the gem off the rendered card — read the pixel, not the flag —
     and the rule has to survive a save and reload. */
  const showIf = await page.evaluate(async () => {
    const { api, editor } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const p = await import('/js/core/project.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    const gem = () => editor.objects().find((o) => o.tcgName === 'Cost gem');
    // Sample the gem's rim, clear of the digit painted over its middle.
    const pixelAtGem = async () => {
      const g = gem();
      const url = editor.toDataURL({ multiplier: 1 });
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = url; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const x = Math.round(g.left + g.radius);
      const y = Math.round(g.top + g.radius * 0.35);
      return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)).join(',');
    };

    const filledPixel = await pixelAtGem();
    t.setFieldText('cost', '');
    const emptyVisible = gem().visible;
    const emptyPixel = await pixelAtGem();
    t.setFieldText('cost', '   ');
    const blankVisible = gem().visible;
    t.setFieldText('cost', '7');
    const refilledVisible = gem().visible;

    // "!cost" is the other way round.
    const probe = editor.insert('rect');
    probe.set('tcgShowIf', '!cost');
    editor.touch();
    const negatedWhileFilled = probe.visible;
    t.setFieldText('cost', '');
    const negatedWhileEmpty = probe.visible;
    editor.remove(probe);

    const saved = await p.serializeProject({ embed: false });
    await p.applyProject(saved);
    const reloaded = gem();
    return {
      filledPixel, emptyPixel, emptyVisible, blankVisible, refilledVisible,
      negatedWhileFilled, negatedWhileEmpty,
      reloadedRule: reloaded?.tcgShowIf, reloadedVisible: reloaded?.visible,
    };
  });
  check('a layer tied to a field leaves the card when the field is empty',
    showIf.emptyVisible === false && showIf.blankVisible === false &&
      showIf.refilledVisible === true && showIf.filledPixel !== showIf.emptyPixel &&
      showIf.negatedWhileFilled === false && showIf.negatedWhileEmpty === true &&
      showIf.reloadedRule === 'cost' && showIf.reloadedVisible === false,
    JSON.stringify(showIf));

  /* A batch run decides per card: the sorcery with no stats loses its plate,
     the creature beside it keeps one, and the canvas comes back as it was. */
  const showIfBatch = await page.evaluate(async () => {
    const { api, editor } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const b = await import('/js/core/batch.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    const plate = editor.objects().find((o) => o.tcgName === 'Stats plate');
    // The plate's gold rim, clear of the text painted inside it.
    const at = { x: Math.round(plate.left + 20), y: Math.round(plate.top + 1) };
    const res = await b.runBatch({
      rows: [{ title: 'Beast', stats: '3 / 3' }, { title: 'Spell', stats: '' }],
      mapping: { title: 'title', stats: 'stats' },
      options: { multiplier: 1, pattern: '{n:3}', subfolder: 'smoke-showif' },
    });
    const sample = async (path) => {
      if (!path) return null;
      const img = new Image();
      await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = `/files/${path}?t=${Date.now()}`; })
        .catch(() => null);
      if (!img.width) return null;
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(at.x, at.y, 1, 1).data.slice(0, 3));
    };
    const withStats = await sample(res.rendered[0]?.path);
    const without = await sample(res.rendered[1]?.path);
    return {
      rendered: res.rendered.length,
      withStats, without,
      plateAfterRun: editor.objects().find((o) => o.tcgName === 'Stats plate')?.visible,
    };
  });
  const brightness = (rgb) => (rgb ? rgb[0] + rgb[1] + rgb[2] : -1);
  check('a batch run drops the ornament only from the card whose cell is blank',
    showIfBatch.rendered === 2 && showIfBatch.withStats && showIfBatch.without &&
      brightness(showIfBatch.withStats) - brightness(showIfBatch.without) > 150 &&
      showIfBatch.plateAfterRun === true,
    JSON.stringify(showIfBatch));

  /* The control lives in Properties → Layer, offers every field both ways
     round, and takes the Visible box away while it is in charge. */
  await page.evaluate(() => {
    const { editor } = window.TCGForge;
    editor.select(editor.objects().find((o) => o.tcgName === 'Cost gem'));
  });
  await page.waitForTimeout(150);
  const showIfUI = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const select = document.querySelector('#pShowIf');
    const options = Array.from(select.options).map((o) => o.value);
    const value = select.value;
    const visibleLocked = document.querySelector('#pVisible').disabled;
    const badge = Array.from(document.querySelectorAll('#layerList .layer-cond')).map((n) => n.textContent);
    const t = await import('/js/core/templates.js');
    t.setFieldText('cost', '');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    const gem = editor.objects().find((o) => o.tcgName === 'Cost gem');
    return {
      options: options.filter((o) => /cost/.test(o)),
      value, visibleLocked, badge,
      clearedRule: gem.tcgShowIf ?? null,
      shownAgain: gem.visible,
    };
  });
  check('the properties panel sets the condition and the layer list shows it',
    showIfUI.options.includes('cost') && showIfUI.options.includes('!cost') &&
      showIfUI.value === 'cost' && showIfUI.visibleLocked === true &&
      showIfUI.badge.includes('if cost') &&
      showIfUI.clearedRule === null && showIfUI.shownAgain === true,
    JSON.stringify(showIfUI));

  /* ---- 0.6.0 bug guards ------------------------------------------------ */
  /* A dialog's buttons are not typing targets, so the editor's own keys used
     to reach straight past it: Delete removed the selected layer. */
  await page.evaluate(() => {
    const { editor } = window.TCGForge;
    editor.select(editor.objects().find((o) => o.selectable !== false));
  });
  const behindBefore = await page.evaluate(() => {
    const o = window.TCGForge.editor.active();
    return { count: window.TCGForge.editor.objects().length, left: Math.round(o.left) };
  });
  await page.evaluate(async () => (await import('/js/ui/toolbar.js')).openShortcuts());
  await page.waitForTimeout(150);
  await page.keyboard.press('Delete');
  await page.keyboard.press('ArrowRight');
  const behindAfter = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    return {
      count: editor.objects().length,
      left: Math.round(editor.active()?.left ?? -1),
      dialogOpen: !document.querySelector('#modalRoot').hidden,
    };
  });
  await page.keyboard.press('Escape');
  check('keys pressed in a dialog do not reach the layers behind it',
    behindAfter.dialogOpen && behindAfter.count === behindBefore.count &&
      behindAfter.left === behindBefore.left,
    JSON.stringify({ behindBefore, behindAfter }));

  /* Members of a multi-layer selection hold coordinates relative to the
     selection, and clones taken from them landed far off the card. */
  const multiClone = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const a = editor.insert('rect');
    a.set({ left: 100, top: 100 }); a.setCoords();
    const b = editor.insert('ellipse');
    b.set({ left: 400, top: 600 }); b.setCoords();
    const where = (list) => {
      editor.canvas.discardActiveObject();
      return list.map((o) => [Math.round(o.getBoundingRect().left), Math.round(o.getBoundingRect().top)]);
    };
    editor.select([a, b]);
    const n = editor.objects().length;
    await editor.duplicate();
    const dup = where(editor.objects().slice(n));
    editor.select([a, b]);
    await editor.copy();
    await editor.paste();
    const pasted = where(editor.objects().slice(-2));
    const originals = where([a, b]);
    editor.remove(editor.objects().slice(n - 2));
    return { originals, dup, pasted };
  });
  const near = (p, q, d) => Math.abs(p[0] - q[0] - d) <= 2 && Math.abs(p[1] - q[1] - d) <= 2;
  check('a duplicated or pasted multi-layer selection lands beside the originals',
    near(multiClone.dup[0], multiClone.originals[0], 24) && near(multiClone.dup[1], multiClone.originals[1], 24) &&
      near(multiClone.pasted[0], multiClone.originals[0], 28) && near(multiClone.pasted[1], multiClone.originals[1], 28),
    JSON.stringify(multiClone));

  /* Grouped artwork used to keep the absolute URL the browser resolved — the
     port baked in — and was left out when a project embedded its images. */
  const grouped = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const p = await import('/js/core/project.js');
    const img = await editor.addImage('/files/assets/icons/star.svg', { assetPath: 'assets/icons/star.svg' });
    const r = editor.insert('rect');
    editor.select([img, r]);
    editor.toggleGroup();
    const group = editor.active();
    const inner = async (embed) => {
      const data = await p.serializeProject({ embed });
      const g = data.canvas.objects.find((o) => String(o.type).toLowerCase() === 'group');
      return g?.objects.find((o) => String(o.type).toLowerCase() === 'image')?.src || '';
    };
    const plain = await inner(false);
    const embedded = await inner(true);
    editor.remove(group);
    return { plain, embedded: embedded.slice(0, 26) };
  });
  check('grouped artwork is saved by workspace path, and embedded when asked',
    grouped.plain === '/files/assets/icons/star.svg' && grouped.embedded.startsWith('data:image/'),
    JSON.stringify(grouped));

  /* Batch exports overwrite on purpose, so two rows filling the pattern the
     same way used to write one file twice and lose the first card. */
  const collide = await page.evaluate(async () => {
    const { api } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const b = await import('/js/core/batch.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    const res = await b.runBatch({
      rows: [{ title: 'Goblin', qty: '2' }, { title: 'Goblin', qty: '3' }, { title: 'Elf', qty: '1' }],
      mapping: { title: 'title' },
      options: { multiplier: 1, pattern: '{title}', subfolder: 'smoke-collide', qtyColumn: 'qty' },
    });
    const listing = await api.request('/api/list?path=exports/smoke-collide').catch(() => ({ entries: [] }));
    const deck = await api.readJSON('exports/smoke-collide/deck.json').catch(() => null);
    return {
      files: listing.entries.map((e) => e.name).filter((n) => n.endsWith('.png')).sort(),
      deck: (deck?.cards || []).map((c) => `${c.file}×${c.qty}`),
    };
  });
  check('two rows that fill the pattern alike both survive a batch run',
    collide.files.join() === 'elf.png,goblin-2.png,goblin.png' &&
      collide.deck.join() === 'goblin.png×2,goblin-2.png×3,elf.png×1',
    JSON.stringify(collide));

  /* The preview told you the default pattern's name whatever you had typed. */
  const previewName = await page.evaluate(async () => {
    const dialogs = await import('/js/ui/dialogs.js');
    const panel = await import('/js/ui/batchPanel.js');
    panel.openBatchDialog();
    await new Promise((r) => setTimeout(r, 300));
    const pattern = document.querySelector('#batchPattern');
    pattern.value = '{title}-proof';
    document.querySelector('#batchPreview').click();
    await new Promise((r) => setTimeout(r, 1500));
    const status = document.querySelector('#batchStatus')?.textContent || '';
    dialogs.closeModal();
    return status;
  });
  check('the batch preview names the file the pattern will actually write',
    /→ ember-wyrm-proof$/.test(previewName), previewName);

  /* The workspace root is not a file. A write to "." put its temporary file
     beside the workspace folder, outside the sandbox. */
  const rootWrite = await rawRequest({
    method: 'POST',
    path: '/api/write',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '.', content: 'x' }),
  });
  const rootTrash = await rawRequest({
    method: 'POST',
    path: '/api/trash',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: './' }),
  });
  const rootList = await rawRequest({ path: '/api/list?path=.' });
  check('the workspace root cannot be written over or thrown away',
    rootWrite.status === 400 && rootTrash.status === 400 && rootList.status === 200,
    `write ${rootWrite.status}, trash ${rootTrash.status}, list ${rootList.status}`);

  /* Collapsed panels are remembered between sessions, so a header the
     keyboard cannot reach is a panel a keyboard user can never open. */
  const head = page.locator('.panel[data-panel] .panel-head').first();
  await head.focus().catch(() => {});
  const headBefore = await page.evaluate(() => {
    const h = document.querySelector('.panel[data-panel] .panel-head');
    return { focused: document.activeElement === h, expanded: h.getAttribute('aria-expanded'),
      collapsed: h.closest('.panel').classList.contains('collapsed') };
  });
  await page.keyboard.press('Enter');
  const headAfter = await page.evaluate(() => {
    const h = document.querySelector('.panel[data-panel] .panel-head');
    return { expanded: h.getAttribute('aria-expanded'),
      collapsed: h.closest('.panel').classList.contains('collapsed') };
  });
  if (headAfter.collapsed !== headBefore.collapsed) await page.keyboard.press('Enter');
  check('panel headers open and close from the keyboard',
    headBefore.focused && headAfter.collapsed !== headBefore.collapsed &&
      headAfter.expanded === String(!headAfter.collapsed),
    JSON.stringify({ headBefore, headAfter }));

  /* ---- 0.7.0 bug guards ------------------------------------------------- */

  /* An edit made less than a debounce before Ctrl+Z was not on the stack yet,
     so undo stepped back past it and it could never be redone. Real keys. */
  const fastUndo = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const r = editor.insert('rect');
    r.set({ left: 100, top: 100 }); r.setCoords(); editor.touch();
    editor.select(r);
    await new Promise((res) => setTimeout(res, 500));
    window.__fastUndo = r;
    return r.left;
  });
  await page.mouse.move(5, 5);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const fastUndoAfter = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const tcgId = window.__fastUndo.tcgId;
    return editor.objects().find((o) => o.tcgId === tcgId)?.left;
  });
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(150);
  const fastRedo = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const obj = editor.objects().find((o) => o.tcgId === window.__fastUndo.tcgId);
    const left = obj?.left;
    if (obj) editor.remove(obj);
    return left;
  });
  check('undo straight after an edit steps back one edit, and redo brings it back',
    fastUndoAfter === fastUndo + 1 && fastRedo === fastUndo + 2,
    JSON.stringify({ start: fastUndo, afterUndo: fastUndoAfter, afterRedo: fastRedo }));

  /* A preview or a run writes into the slots, then puts the canvas back; the
     project it started from was saved and still is. */
  const batchDirty = await page.evaluate(async () => {
    try {
      const { state } = window.TCGForge;
      const batch = await import('/js/core/batch.js');
      const p = await import('/js/core/project.js');
      await p.saveProject({ name: 'Smoke Clean', path: null });
      const saved = state.dirty;
      await batch.renderRow({ title: 'Preview Only' }, { title: 'title' });
      const afterPreview = state.dirty;
      await batch.runBatch({ rows: [{ title: 'A' }], mapping: { title: 'title' }, options: { subfolder: 'smoke-clean' } });
      return { saved, afterPreview, afterRun: state.dirty };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a batch preview or run leaves a saved project saved',
    batchDirty.saved === false && batchDirty.afterPreview === false && batchDirty.afterRun === false,
    JSON.stringify(batchDirty));

  /* A project that cannot open (an image it names has gone) used to resize and
     rename the card behind the error and leave it marked saved, so the next
     Save wrote that over the project that was open. */
  const brokenOpen = await page.evaluate(async () => {
    try {
      const { state, editor, api } = window.TCGForge;
      const p = await import('/js/core/project.js');
      await p.saveProject({ name: 'Smoke Keeper', path: null });
      const keeper = state.project.path;
      const layers = editor.objects().length;
      await api.writeJSON('projects/smoke-broken.json', {
        format: 'tcgforge.project', version: 1, name: 'Broken One', templateId: 'other',
        card: { width: 500, height: 500, dpi: 150, radius: 0, background: '#ff0000', preset: 'square' },
        fields: [],
        canvas: { objects: [{ type: 'Image', src: '/files/assets/art/smoke-gone.png', tcgAsset: 'assets/art/smoke-gone.png', width: 10, height: 10 }] },
      });
      let error = null;
      await p.openProjectPath('projects/smoke-broken.json').catch((e) => { error = e.message; });
      const after = { name: state.project.name, width: state.card.width, path: state.project.path,
        dirty: state.dirty, layers: editor.objects().length, canvasWidth: editor.canvas.getWidth() / editor.zoom };
      await p.saveProject({});
      const written = await api.readJSON(keeper).catch(() => null);
      await api.trash('projects/smoke-broken.json').catch(() => {});
      return { error: !!error, keeper, layers, after, writtenName: written?.name, writtenWidth: written?.card?.width };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a project that fails to open leaves the open card exactly as it was',
    brokenOpen.error === true && brokenOpen.after?.name === 'Smoke Keeper' && brokenOpen.after.width === 750 &&
      brokenOpen.after.path === brokenOpen.keeper && brokenOpen.after.dirty === false &&
      brokenOpen.after.layers === brokenOpen.layers && Math.abs(brokenOpen.after.canvasWidth - 750) < 2 &&
      brokenOpen.writtenName === 'Smoke Keeper' && brokenOpen.writtenWidth === 750,
    JSON.stringify(brokenOpen));

  /* The size box raised the font; the next keystroke in the text put it back. */
  const fitSize = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const t = editor.insert('text');
    // A box with room to spare, so the fit has no reason to shrink anything
    // and whatever size the text ends at is the cap's doing.
    t.set({ text: 'Hi', tcgFitHeight: 600 });
    editor.select(t);
    const auto = document.getElementById('pAutoFit');
    auto.checked = true;
    auto.dispatchEvent(new Event('change', { bubbles: true }));
    const size = document.getElementById('pFontSize');
    size.value = String(Math.round(t.fontSize) + 6);
    size.dispatchEvent(new Event('input', { bubbles: true }));
    const asked = Number(size.value);
    const text = document.getElementById('pText');
    text.value = 'Hi!';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    const result = { asked, afterEdit: t.fontSize, cap: t.tcgFitSize };
    editor.remove(t);
    return result;
  });
  check('a font size set on an auto-fit layer survives the next edit of its text',
    fitSize.afterEdit === fitSize.asked && fitSize.cap === fitSize.asked, JSON.stringify(fitSize));

  /* Replacing a big picture with a small one kept the old scale, so the new
     one landed at a fraction of the room the old one took. */
  const replaceBefore = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const c = document.createElement('canvas');
    c.width = 3000; c.height = 2000;
    c.getContext('2d').fillRect(0, 0, 3000, 2000);
    const img = await editor.addImage(c.toDataURL('image/png'), { tcgName: 'Smoke big' });
    editor.select(img);
    window.__replaceTarget = img;
    return { w: Math.round(img.getScaledWidth()), h: Math.round(img.getScaledHeight()) };
  });
  const smallPng = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 400;
    c.getContext('2d').fillRect(0, 0, 400, 400);
    return c.toDataURL('image/png').split(',')[1];
  });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
    page.click('[data-action="img-replace"]').catch(() => null),
  ]);
  if (chooser) {
    await chooser.setFiles({ name: 'smoke-small.png', mimeType: 'image/png', buffer: Buffer.from(smallPng, 'base64') });
  }
  await page.waitForTimeout(800);
  const replaceAfter = await page.evaluate(async () => {
    const { editor, api } = window.TCGForge;
    const img = window.__replaceTarget;
    const out = { w: Math.round(img.getScaledWidth()), h: Math.round(img.getScaledHeight()), natural: img.width, asset: img.tcgAsset };
    editor.remove(img);
    if (img.tcgAsset) await api.trash(img.tcgAsset).catch(() => {});
    return out;
  });
  check('a replaced picture takes the room the old one had',
    !!chooser && replaceAfter.natural === 400 && replaceAfter.h === replaceBefore.h && replaceAfter.w === replaceBefore.h,
    JSON.stringify({ before: replaceBefore, after: replaceAfter }));

  /* Changing from one back mode to another re-ticked sheet numbering that the
     user had just unticked. */
  await page.keyboard.press('Control+p');
  await page.waitForSelector('#printBackMode');
  await page.selectOption('#printBackMode', 'duplex');
  const labelsOn = await page.isChecked('#printPageLabels');
  await page.evaluate(() => {
    const box = document.getElementById('printPageLabels');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.selectOption('#printBackMode', 'gutterfold');
  const labelsKept = await page.isChecked('#printPageLabels');
  await page.keyboard.press('Escape');
  check('sheet numbering stays off when switching between back modes',
    labelsOn === true && labelsKept === false, JSON.stringify({ labelsOn, labelsKept }));

  /* ---- multi-card projects --------------------------------------------- */

  /* A project from before 0.7.0 is one card, opens as one, and is not
     rewritten on disk until it is saved. */
  const v1 = await page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const p = await import('/js/core/project.js');
      const cards = await import('/js/core/cards.js');
      const tpl = await api.readJSON('templates/classic-spell.json');
      const legacy = { format: 'tcgforge.project', version: 1, name: 'Smoke Legacy', templateId: 'classic-spell',
        card: tpl.card, fields: tpl.fields, canvas: tpl.canvas, meta: { app: 'TCG Forge' } };
      const text = JSON.stringify(legacy, null, 2);
      await api.request('/api/write', { method: 'POST', body: JSON.stringify({ path: 'projects/smoke-legacy.json', content: text }) });
      await p.openProjectPath('projects/smoke-legacy.json');
      const onDisk = (await api.request('/api/read?path=projects/smoke-legacy.json')).content;
      const opened = { cards: cards.cardList().length, title: editor.findBySlot('title')[0]?.text, untouched: onDisk === text };
      await p.saveProject({});
      const saved = await api.readJSON('projects/smoke-legacy.json');
      await api.trash('projects/smoke-legacy.json').catch(() => {});
      await api.trash('projects/smoke-legacy.json.bak').catch(() => {});
      return { ...opened, savedVersion: saved.version, savedCards: saved.cards?.length,
        savedTitle: saved.cards?.[0]?.values?.title, activeCard: saved.activeCard };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a version-1 project opens as one card and is only rewritten when saved',
    v1.cards === 1 && v1.untouched === true && v1.savedVersion === 2 && v1.savedCards === 1 &&
      v1.savedTitle === v1.title && v1.activeCard === 0,
    JSON.stringify(v1));

  /* The point of the feature: slots are per card, everything else is shared.
     Art comes and goes with its card, the placeholder comes back for a card
     with none, a frame moved on one card has moved on all of them, and the
     whole list survives a save and reopen — pixels, not labels. */
  const multi = await page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const p = await import('/js/core/project.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const art = () => editor.findBySlot('art')[0];
      const pixel = () => {
        const { left, top, width, height } = art().getBoundingRect();
        const url = editor.toDataURL({ multiplier: 1 });
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve(Array.from(ctx.getImageData(Math.round(left + width / 2), Math.round(top + height / 2), 1, 1).data.slice(0, 3)).join(','));
          };
          img.src = url;
        });
      };
      const emptyArt = await pixel();
      t.setFieldText('title', 'Card One');
      await t.setFieldImage('art', '/files/assets/backgrounds/ember.svg', { assetPath: 'assets/backgrounds/ember.svg' });
      const oneArt = await pixel();
      await cards.addCard();
      t.setFieldText('title', 'Card Two');
      const two = { title: editor.findBySlot('title')[0].text, artType: art().type, pixel: await pixel() };
      const frame = editor.objects().find((o) => !o.tcgSlot && !o.tcgShowIf && o.selectable !== false);
      frame.set('left', frame.left + 7); frame.setCoords(); editor.touch();
      const frameLeft = frame.left;
      const frameId = frame.tcgId;
      await cards.switchCard(0);
      const one = { title: editor.findBySlot('title')[0].text, asset: art().tcgAsset, pixel: await pixel(),
        frameLeft: editor.objects().find((o) => o.tcgId === frameId)?.left };
      await p.saveProject({ name: 'Smoke Multi', path: null });
      const saved = await api.readJSON(state.project.path);
      await cards.switchCard(1);
      await p.saveProject({});
      await p.openProjectPath(state.project.path);
      const reopened = { cards: cards.cardList().length, active: cards.activeIndex(),
        title: editor.findBySlot('title')[0].text, artType: art().type };
      await cards.switchCard(0);
      reopened.firstTitle = editor.findBySlot('title')[0].text;
      reopened.firstAsset = art().tcgAsset;
      reopened.firstPixel = await pixel();
      await api.trash(state.project.path).catch(() => {});
      await api.trash(`${state.project.path}.bak`).catch(() => {});
      return { emptyArt, oneArt, two, one, frameLeft, reopened,
        savedValues: saved.cards.map((c) => [c.values.title, c.values.art]), savedVersion: saved.version };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('each card keeps its own fields and art while the layout is shared',
    multi.two?.title === 'Card Two' && multi.two.artType !== 'image' && multi.two.pixel === multi.emptyArt &&
      multi.oneArt !== multi.emptyArt && multi.one.title === 'Card One' &&
      multi.one.asset === 'assets/backgrounds/ember.svg' && multi.one.pixel === multi.oneArt &&
      multi.one.frameLeft === multi.frameLeft &&
      JSON.stringify(multi.savedValues) === JSON.stringify([['Card One', 'assets/backgrounds/ember.svg'], ['Card Two', null]]),
    JSON.stringify(multi));
  check('a multi-card project reopens on the card it was saved on, with every card intact',
    multi.reopened?.cards === 2 && multi.reopened.active === 1 && multi.reopened.title === 'Card Two' &&
      multi.reopened.artType !== 'image' && multi.reopened.firstTitle === 'Card One' &&
      multi.reopened.firstAsset === 'assets/backgrounds/ember.svg' && multi.reopened.firstPixel === multi.oneArt,
    JSON.stringify(multi.reopened));

  /* Rows become cards without rendering anything, and the project renders
     back out as one image per card — each with its own art, not the one on
     screen. */
  const rowsAndExport = await page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      state.project.name = 'Smoke Rows';
      const text = (await api.request('/api/read?path=batch/sample-set.csv')).content;
      const table = batch.parseAny(text, 'sample-set.csv');
      const mapping = Object.fromEntries(table.columns.map((c) => [c, cards.slotKinds().has(c) ? c : '-']));
      const before = cards.cardList().length;
      const added = await cards.addRows(table.rows, mapping, batch.resolveAsset);
      await cards.removeCard(0);
      const titles = cards.cardList().map((c) => c.values.title);
      await cards.switchCard(2);
      const shown = { title: editor.findBySlot('title')[0].text, art: editor.findBySlot('art')[0].tcgAsset || null };
      const urls = await cards.renderCards({ multiplier: 0.25 });
      const result = await cards.exportCards({ multiplier: 0.25 });
      const folder = result.rendered[0]?.path?.split('/').slice(0, -1).join('/');
      const listed = folder ? (await api.request(`/api/list?path=${folder}`)).entries.map((e) => e.name) : [];
      return { before, added: added.added, missing: added.missing, titles, expected: table.rows.map((r) => r.title),
        expectedArt: table.rows[2].art, shown, distinct: new Set(urls).size, rendered: urls.length,
        folder, listed, activeAfter: cards.activeIndex(), titleAfter: editor.findBySlot('title')[0].text };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('spreadsheet rows become cards in the project, each opening with its own values',
    rowsAndExport.added === rowsAndExport.expected?.length && rowsAndExport.missing?.length === 0 &&
      JSON.stringify(rowsAndExport.titles) === JSON.stringify(rowsAndExport.expected) &&
      rowsAndExport.shown.title === rowsAndExport.expected[2] && !!rowsAndExport.shown.art &&
      rowsAndExport.shown.art.includes(rowsAndExport.expectedArt),
    JSON.stringify(rowsAndExport));
  check('every card in a project renders and exports as its own image',
    rowsAndExport.rendered === rowsAndExport.expected?.length && rowsAndExport.distinct === rowsAndExport.rendered &&
      rowsAndExport.folder === 'exports/smoke-rows' &&
      rowsAndExport.listed.filter((name) => name.endsWith('.png')).length === rowsAndExport.rendered &&
      rowsAndExport.activeAfter === 2 && rowsAndExport.titleAfter === rowsAndExport.expected[2],
    JSON.stringify({ rendered: rowsAndExport.rendered, distinct: rowsAndExport.distinct, folder: rowsAndExport.folder, listed: rowsAndExport.listed }));

  /* The strip itself, driven the way a person drives it. */
  await page.click('[data-card-action="add"]');
  await page.waitForTimeout(400);
  const stripAdded = await page.evaluate(() => ({
    tiles: document.querySelectorAll('#cardTiles .card-tile').length,
    active: [...document.querySelectorAll('#cardTiles .card-tile')].findIndex((t) => t.classList.contains('active')),
    count: document.getElementById('cardCount').textContent,
  }));
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(400);
  const afterPageUp = await page.evaluate(() => window.TCGForge.editor.findBySlot('title')[0].text);
  await page.click('[data-card-action="delete"]');
  await page.click('#modalFoot .btn.danger');
  await page.waitForTimeout(400);
  const stripDeleted = await page.evaluate(() => ({
    tiles: document.querySelectorAll('#cardTiles .card-tile').length,
    thumbs: document.querySelectorAll('#cardTiles .card-tile img').length,
  }));
  check('the card strip adds, steps through and deletes cards',
    stripAdded.tiles === 7 && stripAdded.active === 3 && stripAdded.count === '4 / 7' &&
      afterPageUp === rowsAndExport.expected?.[2] && stripDeleted.tiles === 6 && stripDeleted.thumbs >= 1,
    JSON.stringify({ stripAdded, afterPageUp, stripDeleted }));

  /* A card only glimpsed on the way past still gets its picture. The capture
     used to be skipped while a switch was starting, and it cancelled the one
     waiting to be taken, so stepping quickly left blank tiles behind. */
  const passing = await page.evaluate(() => window.TCGForge.state.project.activeCard + 1);
  const total = await page.evaluate(() => window.TCGForge.state.project.cards.length);
  await page.keyboard.press('PageDown');
  // Straight on as soon as the strip says the first step has landed — well
  // inside the pause the after-edit capture waits for.
  await page.waitForFunction((want) => document.getElementById('cardCount').textContent === want,
    `${passing + 1} / ${total}`, { timeout: 5000 }).catch(() => {});
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(600);
  const glimpsed = await page.evaluate((index) => {
    const tile = document.querySelectorAll('#cardTiles .card-tile')[index];
    return { index, thumb: !!tile?.querySelector('img'), active: window.TCGForge.state.project.activeCard };
  }, passing);
  check('a card stepped past quickly keeps its thumbnail',
    glimpsed.thumb && glimpsed.active === passing + 1, JSON.stringify(glimpsed));

  /* Print straight from the project, one of each card. */
  await page.keyboard.press('Control+p');
  await page.waitForSelector('#printSource');
  const hasProject = await page.$eval('#printSource', (s) => [...s.options].some((o) => o.value === 'project'));
  if (hasProject) await page.selectOption('#printSource', 'project');
  for (const button of await page.$$('#modalFoot .btn')) {
    if ((await button.textContent()) === 'Preview') { await button.click(); break; }
  }
  await page.waitForFunction(() => /cards/.test(document.getElementById('printStatus')?.textContent || '') &&
    !/Drawing|Loading/.test(document.getElementById('printStatus').textContent), null, { timeout: 30000 }).catch(() => {});
  const projectPrint = await page.$eval('#printStatus', (n) => n.textContent).catch(() => '');
  await page.keyboard.press('Escape');
  check('the print dialog lays out every card in the project',
    hasProject && /\b6 cards\b/.test(projectPrint), projectPrint);


  /* ---- per-card copies (0.8.0) ---------------------------------------- */

  /* A count lives on the card record: saved only where it is not one, read
     back on open, carried by Duplicate, and one for any card that has none. */
  const counts = await page.evaluate(async () => {
    try {
      const { state, api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const p = await import('/js/core/project.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      t.setFieldText('title', 'Counted');
      await cards.addCard();
      t.setFieldText('title', 'Single');
      const settled = cards.setCardQty(0, '3');
      const clamped = cards.setCardQty(1, '0');
      await p.saveProject({ name: 'Smoke Counts', path: null });
      const saved = await api.readJSON(state.project.path);
      await p.openProjectPath(state.project.path);
      const reopened = cards.cardQuantities();
      await cards.switchCard(0);
      await cards.addCard({ copy: true });
      const afterCopy = cards.cardQuantities();
      await api.trash(state.project.path).catch(() => {});
      await api.trash(`${state.project.path}.bak`).catch(() => {});
      // A file from before counts existed.
      await p.openProjectData({ ...saved, cards: saved.cards.map(({ id, values }) => ({ id, values })) });
      const legacy = cards.cardQuantities();
      return { settled, clamped, savedQty: saved.cards.map((c) => c.qty ?? null), reopened, afterCopy, legacy };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('each card keeps its own number of copies through save, reopen and Duplicate',
    counts.settled === 3 && counts.clamped === 1 &&
      JSON.stringify(counts.savedQty) === JSON.stringify([3, null]) &&
      JSON.stringify(counts.reopened) === JSON.stringify([3, 1]) &&
      JSON.stringify(counts.afterCopy) === JSON.stringify([3, 3, 1]) &&
      JSON.stringify(counts.legacy) === JSON.stringify([1, 1]),
    JSON.stringify(counts));

  /* Rows added as cards take their counts from the quantity column; the
     project then exports a deck list saying so, and a later export with the
     counts changed rewrites the list rather than leaving the old one. */
  const deckOut = await page.evaluate(async () => {
    try {
      const { state, api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      const cards = await import('/js/core/cards.js');
      const sheet = await import('/js/core/printSheet.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      state.project.name = 'Smoke Deck Cards';
      const text = (await api.request('/api/read?path=batch/sample-set.csv')).content;
      const table = batch.parseAny(text, 'sample-set.csv');
      const mapping = Object.fromEntries(table.columns.map((c) => [c, cards.slotKinds().has(c) ? c : '-']));
      const qtyColumn = batch.guessQtyColumn(table.columns);
      await cards.addRows(table.rows, mapping, batch.resolveAsset, { qtyColumn });
      await cards.removeCard(0);
      const wanted = table.rows.map((row) => sheet.readQuantity(row[qtyColumn]));
      const got = cards.cardQuantities();
      const first = await cards.exportCards({ multiplier: 0.2 });
      const listOne = await api.readJSON(first.deckPath).catch(() => null);
      cards.cardList().forEach((_, i) => cards.setCardQty(i, 1));
      const second = await cards.exportCards({ multiplier: 0.2 });
      const listTwo = await api.readJSON(second.deckPath).catch(() => null);
      const folder = first.rendered[0]?.path?.split('/').slice(0, -1).join('/');
      if (folder) await api.trash(folder).catch(() => {});
      return { qtyColumn, wanted, got, deckPath: first.deckPath,
        firstQty: listOne?.cards?.map((c) => c.qty), firstFiles: listOne?.cards?.map((c) => c.file),
        rendered: first.rendered.map((r) => r.path.split('/').pop()),
        secondQty: listTwo?.cards?.map((c) => c.qty) };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('rows added as cards take their copies from the quantity column',
    deckOut.qtyColumn === 'qty' && deckOut.wanted?.some((n) => n > 1) &&
      JSON.stringify(deckOut.got) === JSON.stringify(deckOut.wanted),
    JSON.stringify({ wanted: deckOut.wanted, got: deckOut.got, error: deckOut.error }));
  check('exporting every card writes a deck list of each card\'s copies, and rewrites it when they change',
    /smoke-deck-cards\/deck\.json$/.test(deckOut.deckPath || '') &&
      JSON.stringify(deckOut.firstQty) === JSON.stringify(deckOut.wanted) &&
      JSON.stringify(deckOut.firstFiles) === JSON.stringify(deckOut.rendered) &&
      deckOut.secondQty?.length === deckOut.wanted.length && deckOut.secondQty.every((n) => n === 1),
    JSON.stringify(deckOut));

  /* The strip's Copies box, typed into like a person would, and the print
     dialog laying the project out by those counts. */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const cards = await import('/js/core/cards.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    t.setFieldText('title', 'Strip One');
    await cards.addCard();
    t.setFieldText('title', 'Strip Two');
    await cards.addCard();
    t.setFieldText('title', 'Strip Three');
    await cards.switchCard(1);
    state.setDirty(false);
  });
  await page.fill('#cardQty', '4');
  await page.waitForTimeout(200);
  const strip = await page.evaluate(async () => {
    const cards = await import('/js/core/cards.js');
    const tile = document.querySelectorAll('#cardTiles .card-tile')[1];
    return { qty: cards.cardQuantities(), badge: tile?.querySelector('.tile-qty')?.textContent || '',
      total: document.getElementById('cardDeckTotal')?.textContent || '',
      dirty: window.TCGForge.state.dirty };
  });
  check('the Copies box in the card strip sets the card on screen, and the strip says so',
    JSON.stringify(strip.qty) === JSON.stringify([1, 4, 1]) && strip.badge === '×4' &&
      strip.total === '6 in the deck' && strip.dirty === true,
    JSON.stringify(strip));

  const printCounts = async () => {
    for (const button of await page.$$('#modalFoot .btn')) {
      if ((await button.textContent()) === 'Preview') { await button.click(); break; }
    }
    await page.waitForFunction(() => /cards/.test(document.getElementById('printStatus')?.textContent || '') &&
      !/Drawing|Loading/.test(document.getElementById('printStatus').textContent), null, { timeout: 30000 }).catch(() => {});
    return page.$eval('#printStatus', (n) => n.textContent).catch(() => '');
  };
  // Ctrl+P is left to the browser while a box has the caret.
  await page.$eval('#cardQty', (n) => n.blur());
  await page.keyboard.press('Control+p');
  await page.waitForSelector('#printSource', { timeout: 5000 }).catch(() => {});
  await page.selectOption('#printSource', 'project', { timeout: 5000 }).catch(() => {});
  const byCount = await printCounts();
  const hint = await page.$eval('#printDeckHint', (n) => (n.hidden ? '' : n.textContent)).catch(() => '');
  await page.$eval('#printUseQty', (n) => { n.checked = false; n.dispatchEvent(new Event('change')); }).catch(() => {});
  const oneEach = await printCounts();
  await page.keyboard.press('Escape');
  check('printing every card lays each one out as many times as its Copies say',
    /\b6 cards from 3 designs\b/.test(byCount) && /\b3 cards\b/.test(oneEach) && !/designs/.test(oneEach) &&
      /6 copies of 3 designs/.test(hint),
    JSON.stringify({ byCount, oneEach, hint }));

  /* ---- 0.8.0 bug guards ------------------------------------------------- */

  /* A blank art cell in a batch row gets the layout's own art window, not the
     picture on the card that happens to be on screen. Read from the pixels. */
  const blankArt = await page.evaluate(async () => {
    try {
      const { api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const box = editor.findBySlot('art')[0].getBoundingRect();
      const at = (url) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          resolve(Array.from(ctx.getImageData(Math.round(box.left + box.width / 2),
            Math.round(box.top + box.height / 2), 1, 1).data.slice(0, 3)).join(','));
        };
        img.src = url;
      });
      const empty = await at(editor.toDataURL({ multiplier: 1 }));
      await t.setFieldImage('art', api.fileURL('assets/backgrounds/ember.svg'), { assetPath: 'assets/backgrounds/ember.svg' });
      const placed = await at(editor.toDataURL({ multiplier: 1 }));
      const urls = [];
      await batch.runBatch({
        rows: [{ title: 'Blank art', art: '' }, { title: 'Spaces', art: '  ' }],
        mapping: { title: 'title', art: 'art' },
        options: { multiplier: 1, sink: (url) => urls.push(url) },
      });
      const rows = [];
      for (const url of urls) rows.push(await at(url));
      return { empty, placed, rows, after: editor.findBySlot('art')[0].tcgAsset || null };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a blank art cell in a batch row renders the layout\'s art window, not the art on screen',
    blankArt.placed !== blankArt.empty && blankArt.rows?.length === 2 &&
      blankArt.rows.every((px) => px === blankArt.empty) && blankArt.after === 'assets/backgrounds/ember.svg',
    JSON.stringify(blankArt));

  const forgot = await page.evaluate(async () => {
    try {
      const { api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const p = await import('/js/core/project.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      await cards.addCard();
      cards.cardList()[0].values = { title: 'Ghost', art: 'assets/art/smoke-missing-wyrm.png' };
      const failed = await cards.switchCard(0);
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const saved = await p.serializeProject({ embed: false });
      return { failed, art: saved.cards[0].values.art, cards: saved.cards.length };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('loading a template forgets artwork the previous project could not load',
    forgot.failed?.length === 1 && forgot.art === null && forgot.cards === 1, JSON.stringify(forgot));

  /* One run at a time: a preview started inside a run is refused, and the
     run keeps history locked the whole way through. */
  const oneRun = await page.evaluate(async () => {
    try {
      const { api, history, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      t.setFieldText('title', 'Mine');
      const locks = [];
      const rows = Array.from({ length: 5 }, (_, i) => ({ title: `Row ${i}` }));
      const run = batch.runBatch({ rows, mapping: { title: 'title' },
        options: { multiplier: 0.2, sink: () => locks.push(history.locked) } });
      await new Promise((r) => setTimeout(r, 20));
      const during = batch.isRendering();
      const preview = await batch.renderRow({ title: 'Preview' }, { title: 'title' }).then(() => 'rendered', (e) => e.message);
      await run;
      return { during, preview, locks, after: batch.isRendering(), title: editor.findBySlot('title')[0].text,
        unlocked: history.locked === false };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a preview cannot start inside a run, and the run keeps history locked throughout',
    oneRun.during === true && /still rendering/.test(oneRun.preview || '') && oneRun.locks?.length === 5 &&
      oneRun.locks.every(Boolean) && oneRun.after === false && oneRun.unlocked && oneRun.title === 'Mine',
    JSON.stringify(oneRun));

  /* Escape on the export dialog while every card is rendering must not hand
     the editor back: the run would put its snapshot over whatever came next. */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const cards = await import('/js/core/cards.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    await cards.addCard();
    await cards.addCard();
    await cards.switchCard(0);
    state.setDirty(false);
    window.__realExport = api.exportImage;
    window.__realWrite = api.writeJSON;
    api.exportImage = ({ filename }) => new Promise((resolve) =>
      setTimeout(() => resolve({ path: `exports/smoke-stub/${filename}` }), 450));
    api.writeJSON = async (path) => ({ path });
  });
  await page.keyboard.press('Control+e');
  await page.waitForSelector('#exportEveryCard');
  await page.$eval('#exportEveryCard', (n) => { n.checked = true; n.dispatchEvent(new Event('change')); });
  for (const button of await page.$$('#modalFoot .btn')) {
    if ((await button.textContent()) === 'Export') { await button.click(); break; }
  }
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.click('.modal-head [data-close]').catch(() => {});
  const exportHold = await page.evaluate(async () => {
    const batch = await import('/js/core/batch.js');
    const held = { rendering: batch.isRendering(), open: !document.getElementById('modalRoot').hidden };
    while (batch.isRendering()) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    held.closedAfter = document.getElementById('modalRoot').hidden;
    const { api } = window.TCGForge;
    api.exportImage = window.__realExport;
    api.writeJSON = window.__realWrite;
    return held;
  });
  await page.fill('#ff_title', 'Kept After Export').catch(() => {});
  await page.waitForTimeout(400);
  exportHold.title = await page.evaluate(() => window.TCGForge.editor.findBySlot('title')[0].text);
  check('the export dialog stays up while every card renders, so nothing typed is lost',
    exportHold.rendering === true && exportHold.open === true && exportHold.closedAfter === true &&
      exportHold.title === 'Kept After Export',
    JSON.stringify(exportHold));

  /* Ctrl+S with the caret still in the name box saves under the new name. */
  await page.evaluate(() => {
    const { state } = window.TCGForge;
    state.project.path = null;
    state.project.name = 'Smoke Old Name';
    document.getElementById('projectName').value = 'Smoke Old Name';
  });
  await page.fill('#projectName', 'Smoke Named Deck');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(600);
  const named = await page.evaluate(() => ({ path: window.TCGForge.state.project.path,
    name: window.TCGForge.state.project.name }));
  named.file = await page.evaluate(async (path) =>
    (await window.TCGForge.api.readJSON(path).catch(() => null))?.name ?? null, 'projects/smoke-named-deck.json');
  check('Ctrl+S from the project name box saves under the name just typed',
    named.path === 'projects/smoke-named-deck.json' && named.file === 'Smoke Named Deck', JSON.stringify(named));

  /* The rows that open, load or pick things answer the keyboard. */
  await page.evaluate(() => {
    const { state } = window.TCGForge;
    state.project.path = null;
    state.project.name = 'Somewhere Else';
    state.setDirty(false);
  });
  await page.keyboard.press('Control+o');
  await page.waitForSelector('#modalBody .list-item', { timeout: 5000 }).catch(() => {});
  let reached = '';
  for (let i = 0; i < 40 && !reached.includes('smoke-named-deck'); i += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => (document.activeElement?.classList.contains('list-item')
      ? document.activeElement.textContent : ''));
  }
  if (reached.includes('smoke-named-deck')) await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const keyed = await page.evaluate(() => ({ opened: window.TCGForge.state.project.path,
    closed: document.getElementById('modalRoot').hidden }));
  if (!keyed.closed) await page.keyboard.press('Escape');

  await page.evaluate(() => window.TCGForge.state.setDirty(false));
  await page.focus('#templateList .list-item[data-path="templates/minimal-modern.json"]').catch(() => {});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  keyed.template = await page.evaluate(() => ({ id: window.TCGForge.state.project.templateId,
    focus: document.activeElement?.dataset?.path || document.activeElement?.tagName }));
  await page.focus('#layerList .layer-row[data-index="0"]').catch(() => {});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  keyed.layer = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    return { picked: editor.selection()[0] === editor.objects()[0],
      focus: document.activeElement?.classList.contains('layer-row') ? document.activeElement.dataset.index : null };
  });
  await page.evaluate(async () => {
    const { api } = window.TCGForge;
    await api.trash('projects/smoke-named-deck.json').catch(() => {});
    await api.trash('projects/smoke-named-deck.json.bak').catch(() => {});
  });
  check('saved projects, templates and layers can be chosen from the keyboard',
    keyed.opened === 'projects/smoke-named-deck.json' && keyed.closed &&
      keyed.template.id === 'minimal-modern' && keyed.template.focus === 'templates/minimal-modern.json' &&
      keyed.layer.picked && keyed.layer.focus === '0',
    JSON.stringify(keyed));

  /* ---- distribute (0.9.0) ---------------------------------------------- */
  /* Three rects of different widths, out of order on the canvas: the toolbar
     button has to leave equal gaps between their edges, keep the outer edges
     where they were, and redraw the selection box around the result. */
  const spread = await page.evaluate(async () => {
    try {
      const { api, editor, state } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const o = await import('/js/core/objects.js');
      await t.applyTemplate(await api.readJSON('templates/blank-starter.json'));
      const make = (left, top, width, height, name) => {
        const r = o.makeRect({ left, top, width, height, tcgName: name, strokeWidth: 0 });
        editor.canvas.add(r);
        return r;
      };
      const a = make(40, 100, 40, 40, 'Pip A');
      const c = make(600, 180, 60, 40, 'Pip C');
      const b = make(90, 300, 100, 40, 'Pip B');
      editor.select([a, b]);
      await new Promise((r) => setTimeout(r, 50));
      const twoDisabled = document.getElementById('distributeH').disabled;
      editor.select([c, a, b]);
      await new Promise((r) => setTimeout(r, 50));
      state.setDirty(false);
      return { twoDisabled, threeEnabled: !document.getElementById('distributeH').disabled };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.click('#distributeH').catch(() => {});
  await page.waitForTimeout(400);
  Object.assign(spread, await page.evaluate(() => {
    const { editor, state } = window.TCGForge;
    const rects = editor.objects().filter((obj) => /^Pip /.test(obj.tcgName || ''));
    const boxes = rects.map((obj) => ({ name: obj.tcgName, ...obj.getBoundingRect() }))
      .sort((p, q) => p.left - q.left);
    const gaps = boxes.slice(1).map((box, i) => Math.round((box.left - (boxes[i].left + boxes[i].width)) * 100) / 100);
    const sel = editor.canvas.getActiveObject()?.getBoundingRect();
    return {
      order: boxes.map((box) => box.name).join(),
      lefts: boxes.map((box) => Math.round(box.left)),
      gaps,
      tops: rects.map((obj) => Math.round(obj.getBoundingRect().top)).sort((p, q) => p - q),
      selected: editor.selection().length,
      selBox: sel ? [Math.round(sel.left), Math.round(sel.left + sel.width)] : null,
      dirty: state.dirty,
    };
  }));
  check('distributing three layers leaves equal gaps and keeps the outer edges',
    spread.twoDisabled === true && spread.threeEnabled === true &&
      spread.order === 'Pip A,Pip B,Pip C' && spread.lefts[0] === 40 && spread.lefts[2] === 600 &&
      spread.gaps.length === 2 && Math.abs(spread.gaps[0] - spread.gaps[1]) < 0.01 &&
      Math.abs(spread.gaps[0] - 210) < 0.51 &&
      spread.tops.join() === '100,180,300' && spread.selected === 3 &&
      spread.selBox?.[0] === 40 && spread.selBox?.[1] === 660 && spread.dirty === true,
    JSON.stringify(spread));

  /* Alt+Shift+V from the keyboard, undo in one step, and a refusal below three. */
  const column = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const rects = editor.objects().filter((obj) => /^Pip /.test(obj.tcgName || ''));
    editor.select(rects);
    document.activeElement?.blur?.();
    await new Promise((r) => setTimeout(r, 300));
    return { before: rects.map((obj) => Math.round(obj.getBoundingRect().top)) };
  });
  await page.keyboard.press('Alt+Shift+V');
  await page.waitForTimeout(400);
  Object.assign(column, await page.evaluate(async () => {
    const { editor, history } = window.TCGForge;
    const rects = editor.objects().filter((obj) => /^Pip /.test(obj.tcgName || ''));
    const boxes = rects.map((obj) => obj.getBoundingRect()).sort((p, q) => p.top - q.top);
    const gaps = boxes.slice(1).map((box, i) => Math.round((box.top - (boxes[i].top + boxes[i].height)) * 100) / 100);
    await new Promise((r) => setTimeout(r, 350));
    await history.undo();
    await new Promise((r) => setTimeout(r, 200));
    const after = editor.objects().filter((obj) => /^Pip /.test(obj.tcgName || ''))
      .map((obj) => Math.round(obj.getBoundingRect().top));
    const two = editor.objects().filter((obj) => /^Pip /.test(obj.tcgName || '')).slice(0, 2);
    editor.select(two);
    const twoBefore = two.map((obj) => Math.round(obj.getBoundingRect().top)).join();
    return { gaps, undone: after, twoBefore };
  }));
  await page.keyboard.press('Alt+Shift+V');
  await page.waitForTimeout(300);
  Object.assign(column, await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const two = editor.objects().filter((obj) => /^Pip /.test(obj.tcgName || '')).slice(0, 2);
    return {
      twoAfter: two.map((obj) => Math.round(obj.getBoundingRect().top)).join(),
      toast: Array.from(document.querySelectorAll('#toasts .toast')).map((n) => n.textContent).pop() || '',
    };
  }));
  check('Alt+Shift+V spaces layers down the card, undoes in one step, and refuses two',
    column.gaps.length === 2 && Math.abs(column.gaps[0] - column.gaps[1]) < 0.01 &&
      Math.abs(column.gaps[0] - 60) < 0.51 &&
      column.undone.join() === column.before.join() &&
      column.twoAfter === column.twoBefore && /three or more/.test(column.toast),
    JSON.stringify(column));

  /* ---- 0.9.0 bug guards ------------------------------------------------ */
  /* An edit made while a save was writing was marked saved with it. */
  const midSave = await page.evaluate(async () => {
    try {
      const { api, editor, state } = window.TCGForge;
      const toolbar = await import('/js/ui/toolbar.js');
      const t = await import('/js/core/templates.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const real = api.writeJSON;
      let written = null;
      api.writeJSON = async (path, data) => {
        written = data;
        await new Promise((r) => setTimeout(r, 600));
        return { path };
      };
      state.project.path = 'projects/smoke-midsave.json';
      try {
        const saving = toolbar.handleSave();
        await new Promise((r) => setTimeout(r, 150));
        editor.findBySlot('title')[0].set('text', 'Typed during the save');
        editor.touch();
        await saving;
      } finally {
        api.writeJSON = real;
      }
      const dirtyAfterEdit = state.dirty;
      await toolbar.handleSave();
      return { dirtyAfterEdit, inFile: JSON.stringify(written).includes('Typed during the save'), dirtyAfterResave: state.dirty };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    await api.trash('projects/smoke-midsave.json').catch(() => {});
    await api.trash('projects/smoke-midsave.json.bak').catch(() => {});
    state.project.path = null;
  });
  check('an edit made while a save is writing is still unsaved afterwards',
    midSave.dirtyAfterEdit === true && midSave.inFile === false && midSave.dirtyAfterResave === false,
    JSON.stringify(midSave));

  /* The Export dialog's Cancel and the Print dialog's Close handed the editor
     back while every card was still rendering; the run then put its snapshot
     over whatever came next. */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const cards = await import('/js/core/cards.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    await cards.addCard();
    await cards.addCard();
    await cards.switchCard(0);
    state.setDirty(false);
    window.__realExport = api.exportImage;
    window.__realWrite = api.writeJSON;
    api.exportImage = ({ filename }) => new Promise((resolve) =>
      setTimeout(() => resolve({ path: `exports/smoke-stub/${filename}` }), 450));
    api.writeJSON = async (path) => ({ path });
  });
  const footButton = async (label) => {
    for (const button of await page.$$('#modalFoot .btn')) {
      if ((await button.textContent()) === label) return button;
    }
    return null;
  };
  await page.keyboard.press('Control+e');
  await page.waitForSelector('#exportEveryCard', { timeout: 5000 }).catch(() => {});
  await page.$eval('#exportEveryCard', (n) => { n.checked = true; n.dispatchEvent(new Event('change')); }).catch(() => {});
  await (await footButton('Export'))?.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  await (await footButton('Cancel'))?.click({ timeout: 3000 }).catch(() => {});
  const cancelHold = await page.evaluate(async () => {
    const batch = await import('/js/core/batch.js');
    const held = { rendering: batch.isRendering(), open: !document.getElementById('modalRoot').hidden };
    while (batch.isRendering()) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    held.closedAfter = document.getElementById('modalRoot').hidden;
    held.title = window.TCGForge.editor.findBySlot('title')[0].text;
    return held;
  });
  await page.evaluate(async () => {
    if (!document.getElementById('modalRoot').hidden) (await import('/js/ui/dialogs.js')).closeModal();
  });
  await page.keyboard.press('Control+p');
  await page.waitForSelector('#printSource', { timeout: 5000 }).catch(() => {});
  await page.selectOption('#printSource', 'project').catch(() => {});
  // Drawing a card is quick; slow its images so Close lands mid-run.
  await page.route('**/files/**', async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue().catch(() => {});
  });
  await (await footButton('Preview'))?.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(150);
  await (await footButton('Close'))?.click({ timeout: 3000 }).catch(() => {});
  const closeHold = await page.evaluate(async () => {
    const batch = await import('/js/core/batch.js');
    const held = { rendering: batch.isRendering(), open: !document.getElementById('modalRoot').hidden };
    while (batch.isRendering()) await new Promise((r) => setTimeout(r, 50));
    return held;
  });
  await page.unroute('**/files/**');
  await (await footButton('Close'))?.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  closeHold.closedLater = await page.evaluate(() => document.getElementById('modalRoot').hidden);
  await page.evaluate(() => {
    const { api } = window.TCGForge;
    api.exportImage = window.__realExport;
    api.writeJSON = window.__realWrite;
  });
  check('Cancel and Close cannot hand the editor back while every card is rendering',
    cancelHold.rendering === true && cancelHold.open === true && cancelHold.closedAfter === true &&
      closeHold.rendering === true && closeHold.open === true && closeHold.closedLater === true,
    JSON.stringify({ cancelHold, closeHold }));

  /* Escape during the batch preview closed the dialog while the preview still
     held the canvas; its restore then wiped what was typed next. */
  await page.evaluate(() => {
    const { editor, state } = window.TCGForge;
    editor.findBySlot('title')[0].set('text', 'Before the preview');
    editor.touch();
    state.setDirty(false);
  });
  fs.writeFileSync('smoke-preview.csv', 'title,art\nPreview Row,starfield\n');
  await page.keyboard.press('Control+b');
  await page.waitForSelector('#batchPreview', { timeout: 5000 }).catch(() => {});
  await page.setInputFiles('#modalBody input[type=file]', 'smoke-preview.csv').catch(() => {});
  await page.waitForTimeout(500);
  await page.route('**/files/assets/**', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue().catch(() => {});
  });
  await page.click('#batchPreview').catch(() => {});
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  const previewHold = await page.evaluate(async () => {
    const batch = await import('/js/core/batch.js');
    return { rendering: batch.isRendering(), open: !document.getElementById('modalRoot').hidden };
  });
  previewHold.settled = await page.evaluate(async () => {
    const batch = await import('/js/core/batch.js');
    for (let i = 0; i < 400 && batch.isRendering(); i += 1) await new Promise((r) => setTimeout(r, 50));
    return !batch.isRendering();
  });
  await page.unroute('**/files/assets/**');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  previewHold.closedLater = await page.evaluate(() => document.getElementById('modalRoot').hidden);
  await page.fill('#ff_title', 'Typed after the preview').catch(() => {});
  await page.waitForTimeout(300);
  previewHold.title = await page.evaluate(() => window.TCGForge.editor.findBySlot('title')[0].text);
  fs.rmSync('smoke-preview.csv', { force: true });
  check('Escape waits for the batch preview to give the canvas back',
    previewHold.rendering === true && previewHold.open === true && previewHold.closedLater === true &&
      previewHold.title === 'Typed after the preview',
    JSON.stringify(previewHold));

  /* A real double-click on a layer name never reached the name — picking the
     layer redrew every row between the two clicks — and clicking into the
     rename box ended the rename. */
  await page.evaluate(async () => {
    if (!document.getElementById('modalRoot').hidden) (await import('/js/ui/dialogs.js')).closeModal();
  });
  const layerName = await page.$('#layerList .layer-row[data-index="0"] .layer-name');
  await layerName?.dblclick();
  await page.waitForTimeout(200);
  const renameBox = await page.$('#layerList input');
  const renaming = { opened: !!renameBox };
  if (renameBox) {
    await renameBox.fill('Renamed by mouse');
    await renameBox.click();
    await page.waitForTimeout(150);
    renaming.stillOpen = (await page.$$('#layerList input')).length === 1;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
  }
  renaming.name = await page.evaluate(() => window.TCGForge.editor.objects()[0].tcgName || null);
  renaming.row = await page.evaluate(() =>
    document.querySelector('#layerList .layer-row[data-index="0"] .layer-name')?.textContent || '');
  check('a layer can be renamed with a real double-click, and clicking the box keeps it open',
    renaming.opened && renaming.stillOpen && renaming.name === 'Renamed by mouse' && renaming.row === 'Renamed by mouse',
    JSON.stringify(renaming));

  /* A picture imported from the Fonts tab went into assets/fonts, which only
     lists font files — written to disk and never seen again. */
  await page.click('#assetTabs [data-cat="fonts"]').catch(() => {});
  const uploads = [];
  const watchUpload = (req) => {
    if (req.url().endsWith('/api/upload')) uploads.push(JSON.parse(req.postData() || '{}').category);
  };
  page.on('request', watchUpload);
  fs.writeFileSync('smoke-fonts-tab.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
  await page.setInputFiles('#assetFileInput', 'smoke-fonts-tab.svg').catch(() => {});
  await page.waitForTimeout(1200);
  page.off('request', watchUpload);
  fs.rmSync('smoke-fonts-tab.svg', { force: true });
  const fontsTab = await page.evaluate(async (sent) => {
    const { api, assets } = window.TCGForge;
    const found = (assets.index.art || []).find((a) => /^smoke-fonts-tab/.test(a.file || ''));
    const toast = Array.from(document.querySelectorAll('#toasts .toast')).map((n) => n.textContent).pop() || '';
    if (found?.path) await api.trash(found.path).catch(() => {});
    await assets.refresh();
    return { sent, listed: found?.path || null, toast };
  }, uploads);
  await page.click('#assetTabs [data-cat="frames"]').catch(() => {});
  check('an image imported from the Fonts tab lands in art, where it is listed',
    fontsTab.sent.join() === 'art' && /^assets\/art\/smoke-fonts-tab/.test(fontsTab.listed || '') &&
      /into art/.test(fontsTab.toast),
    JSON.stringify(fontsTab));

  /* The zoom readout resets to 100% on a click, and now on Enter too. */
  await page.evaluate(() => window.TCGForge.editor.setZoom(0.5));
  await page.focus('#zoomLabel').catch(() => {});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const zoomKey = await page.evaluate(() => ({ zoom: window.TCGForge.editor.zoom,
    focusable: document.getElementById('zoomLabel').tabIndex }));
  await page.evaluate(() => window.TCGForge.editor.fitToWindow());
  check('the zoom readout resets the zoom from the keyboard',
    zoomKey.zoom === 1 && zoomKey.focusable === 0, JSON.stringify(zoomKey));

  /* ---- card numbering (0.10.0) ---------------------------------------- */
  const numberingUnit = await page.evaluate(async () => {
    const { formatNumbering } = await import('/js/core/editor.js');
    return [
      formatNumbering('{n:3}/{total}', { n: 7, total: 60 }),
      formatNumbering('No. {n} of {total:2}', { n: 12, total: 9 }),
      formatNumbering('{title} {n}', { n: 2, total: 3 }),
    ];
  });
  check('a numbering pattern fills {n}, {total} and their padded forms',
    JSON.stringify(numberingUnit) === JSON.stringify(['007/60', 'No. 12 of 09', '{title} 2']),
    JSON.stringify(numberingUnit));

  /* The shipped Classic Spell numbers itself from the card's place in the
     project: adding, switching, reordering and deleting cards all move it, the
     pattern survives a save and reopen, and the layer cannot be typed into. */
  const numbered = await page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const p = await import('/js/core/project.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const layer = () => editor.objects().find((o) => o.tcgNumbering);
      const seen = { fresh: layer()?.text, editable: layer()?.editable };
      await cards.addCard();
      await cards.addCard();
      seen.third = layer().text;
      await cards.switchCard(0);
      seen.first = layer().text;
      cards.moveCard(0, 1);
      seen.moved = layer().text;
      await cards.removeCard(2);
      seen.removed = layer().text;
      seen.dirtyBeforeSave = state.dirty;
      await p.saveProject({ name: 'Smoke Numbered', path: null });
      const saved = await api.readJSON(state.project.path);
      const savedLayer = saved.canvas.objects.find((o) => o.tcgNumbering);
      await p.openProjectPath(state.project.path);
      seen.reopened = { text: layer()?.text, pattern: layer()?.tcgNumbering, cards: cards.cardList().length,
        active: cards.activeIndex(), dirty: state.dirty };
      seen.savedPattern = savedLayer?.tcgNumbering;
      await api.trash(state.project.path).catch(() => {});
      await api.trash(`${state.project.path}.bak`).catch(() => {});
      return seen;
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a numbered layer follows its card through adding, switching, reordering and deleting',
    numbered.fresh === '001/001' && numbered.editable === false && numbered.third === '003/003' &&
      numbered.first === '001/003' && numbered.moved === '002/003' && numbered.removed === '002/002',
    JSON.stringify(numbered));
  check('a numbering pattern is saved with the layout and renumbers on reopen',
    numbered.savedPattern === '{n:3}/{total:3}' && numbered.reopened?.pattern === '{n:3}/{total:3}' &&
      numbered.reopened.text === '002/002' && numbered.reopened.cards === 2 && numbered.reopened.active === 1 &&
      numbered.reopened.dirty === false,
    JSON.stringify(numbered.reopened));

  /* In a run, each row is numbered as a card of the run: three rows with the
     same words render three different images (only the number differs), each
     with its own number, and the canvas is numbered as the project again
     afterwards. */
  const numberedRun = await page.evaluate(async () => {
    try {
      const { api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const layer = () => editor.objects().find((o) => o.tcgNumbering);
      const texts = [];
      const images = [];
      const rows = [{ title: 'Same' }, { title: 'Same' }, { title: 'Same' }];
      await batch.runBatch({
        rows, mapping: { title: 'title' },
        options: { multiplier: 0.5, pattern: '{n}', sink: (url) => { texts.push(layer().text); images.push(url); } },
      });
      const preview = { before: layer().text };
      editor.setNumberContext({ n: 4, total: 9 });
      preview.set = layer().text;
      editor.setNumberContext(null);
      preview.after = layer().text;
      return { texts, distinct: new Set(images).size, after: layer().text, preview };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('every row of a run is numbered as its own card, and the canvas is renumbered after',
    JSON.stringify(numberedRun.texts) === JSON.stringify(['001/003', '002/003', '003/003']) &&
      numberedRun.distinct === 3 && numberedRun.after === '001/001' &&
      numberedRun.preview?.set === '004/009' && numberedRun.preview.after === '001/001',
    JSON.stringify(numberedRun));

  /* The Properties panel: the numbered layer shows its pattern, its Text and
     Field slot boxes are shut, a pattern typed for real rewrites the text,
     the Layers row carries a # badge, and clearing it opens the Text box. */
  const numberRowIndex = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const objs = editor.objects();
    return objs.indexOf(objs.find((o) => o.tcgNumbering));
  });
  await page.click(`#layerList .layer-row[data-index="${numberRowIndex}"] .layer-name`).catch(() => {});
  await page.waitForTimeout(200);
  const numberUi = { pattern: await page.inputValue('#pNumbering').catch(() => null),
    textShut: await page.$eval('#pText', (n) => n.disabled).catch(() => null),
    slotShut: await page.$eval('#pSlot', (n) => n.disabled).catch(() => null) };
  await page.click('#pNumbering', { clickCount: 3 }).catch(() => {});
  await page.keyboard.type('No. {n} of {total}');
  await page.waitForTimeout(250);
  numberUi.typed = await page.evaluate(() =>
    window.TCGForge.editor.objects().find((o) => o.tcgNumbering)?.text);
  numberUi.pText = await page.inputValue('#pText').catch(() => null);
  numberUi.badge = await page.$eval(`#layerList .layer-row[data-index="${numberRowIndex}"] .layer-number`,
    (n) => n.textContent).catch(() => null);
  await page.click('#pNumbering', { clickCount: 3 }).catch(() => {});
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
  numberUi.cleared = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const o = editor.selection()[0];
    return { pattern: o?.tcgNumbering ?? null, editable: o?.editable, textOpen: !document.getElementById('pText').disabled };
  });
  check('the properties panel sets a numbering pattern and shuts the text it owns',
    numberUi.pattern === '{n:3}/{total:3}' && numberUi.textShut === true && numberUi.slotShut === true &&
      numberUi.typed === 'No. 1 of 1' && numberUi.pText === 'No. 1 of 1' && numberUi.badge === '#' &&
      numberUi.cleared.pattern === null && numberUi.cleared.editable === true && numberUi.cleared.textOpen,
    JSON.stringify(numberUi));

  /* ---- 0.10.0 bug guards ----------------------------------------------- */
  const canvasPoint = (slot) => page.evaluate((s) => {
    const { editor } = window.TCGForge;
    const o = editor.findBySlot(s)[0];
    const r = o.getBoundingRect();
    const c = editor.canvas.upperCanvasEl.getBoundingClientRect();
    const z = editor.canvas.getZoom();
    return { x: c.left + (r.left + r.width / 2) * z, y: c.top + (r.top + r.height / 2) * z };
  }, slot);

  /* Typing straight onto the canvas marks the project unsaved while the caret
     is still in the text, so Open asks before throwing it away. */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    await t.applyTemplate(await api.readJSON('templates/blank-starter.json'));
    state.setDirty(false);
  });
  await page.waitForTimeout(300);
  const titleAt = await canvasPoint('title');
  await page.mouse.click(titleAt.x, titleAt.y);
  await page.mouse.dblclick(titleAt.x, titleAt.y);
  await page.keyboard.press('End');
  await page.keyboard.type(' TYPED');
  await page.waitForTimeout(150);
  const canvasTyping = await page.evaluate(() => ({
    text: window.TCGForge.editor.findBySlot('title')[0].text, dirty: window.TCGForge.state.dirty }));
  await page.click('[data-action="open-project"]', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  canvasTyping.asked = /unsaved changes/i.test(await page.textContent('#modalBody').catch(() => '') || '');
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  await page.evaluate(() => window.TCGForge.editor.canvas.getActiveObject()?.exitEditing?.());
  check('typing on the canvas marks the card unsaved before editing ends',
    /TYPED$/.test(canvasTyping.text) && canvasTyping.dirty === true && canvasTyping.asked === true,
    JSON.stringify(canvasTyping));

  /* The Properties Text box follows an edit made in Card Fields, so typing in
     it afterwards extends that edit instead of writing the old text back. */
  await page.evaluate(() => {
    const { editor } = window.TCGForge;
    editor.select(editor.findBySlot('title')[0]);
  });
  await page.fill('#ff_title', 'Ember Wyrm');
  await page.waitForTimeout(250);
  const staleText = { shown: await page.inputValue('#pText') };
  await page.click('#pText');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.waitForTimeout(250);
  staleText.after = await page.evaluate(() => window.TCGForge.editor.findBySlot('title')[0].text);
  check('the properties text box follows Card Fields, so typing there keeps the edit',
    staleText.shown === 'Ember Wyrm' && staleText.after === 'Ember Wyrm!', JSON.stringify(staleText));

  /* Placing a background sends it to the back; the Layers list has to say so,
     or a drag there moves the wrong layer. Properties shows the fitted size. */
  await page.click('#assetTabs [data-cat="backgrounds"]');
  await page.waitForTimeout(400);
  await page.click('#assetGrid > *:first-child').catch(() => {});
  await page.waitForTimeout(600);
  const placedBg = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const objs = editor.objects();
    const canvas = objs.map((o) => o.tcgId);
    const rows = Array.from(document.querySelectorAll('#layerList .layer-row'))
      .map((r) => objs[Number(r.dataset.index)]?.tcgId);
    const labels = Array.from(document.querySelectorAll('#layerList .layer-row .layer-name')).map((n) => n.textContent);
    const sel = editor.selection()[0];
    return { bottomIsBg: /^Background/.test(objs[0]?.tcgName || ''),
      listTop: labels[0], listBottom: labels[labels.length - 1],
      rowsMatch: JSON.stringify(rows.slice().reverse()) === JSON.stringify(canvas) || JSON.stringify(rows) === JSON.stringify(canvas),
      pW: Number(document.getElementById('pW').value), width: Math.round(sel?.getScaledWidth() || 0) };
  });
  await page.click('#assetTabs [data-cat="frames"]').catch(() => {});
  check('a placed background is listed at the bottom of the layers, at its fitted size',
    placedBg.bottomIsBg && /^Background/.test(placedBg.listBottom || '') && placedBg.rowsMatch &&
      placedBg.pW === placedBg.width, JSON.stringify(placedBg));

  /* A locked layer, picked from the Layers panel, is not moved by the arrow
     keys or removed by Delete; the toast says why. */
  const lockIndex = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    editor.canvas.discardActiveObject();
    const objs = editor.objects();
    return objs.indexOf(objs.find((o) => o.tcgSlot === 'title'));
  });
  await page.click(`#layerList .layer-row[data-index="${lockIndex}"] .layer-btn[title^="Lock"]`).catch(() => {});
  await page.waitForTimeout(150);
  await page.click(`#layerList .layer-row[data-index="${lockIndex}"] .layer-name`).catch(() => {});
  await page.waitForTimeout(150);
  const lockBefore = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const o = editor.findBySlot('title')[0];
    return { left: o.left, count: editor.objects().length, selected: editor.selection().includes(o), locked: o.selectable === false };
  });
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  const lockAfter = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const o = editor.findBySlot('title')[0];
    return { left: o?.left, count: editor.objects().length,
      toast: Array.from(document.querySelectorAll('#toasts .toast')).map((n) => n.textContent).pop() || '' };
  });
  await page.click(`#layerList .layer-row[data-index="${lockIndex}"] .layer-btn[title^="Lock"]`).catch(() => {});
  check('a locked layer picked from the Layers panel is not nudged or deleted from the keyboard',
    lockBefore.locked && lockBefore.selected && lockAfter.left === lockBefore.left &&
      lockAfter.count === lockBefore.count && /locked/i.test(lockAfter.toast),
    JSON.stringify({ lockBefore, lockAfter }));

  /* A column set to "ignore" in the batch dialog stays ignored when the dialog
     is opened again. */
  const ignoreCsv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-smoke-')), 'ignore.csv');
  fs.writeFileSync(ignoreCsv, 'title,rules\nFire,Burn it\nIce,Freeze\n');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+b');
  await page.waitForSelector('#modalBody', { timeout: 5000 }).catch(() => {});
  const ignoreChooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await page.click('#modalBody button:text-is("Load file…")', { timeout: 3000 }).catch(() => {});
  const ignoreFile = await ignoreChooser;
  if (ignoreFile) await ignoreFile.setFiles(ignoreCsv);
  await page.waitForTimeout(400);
  await page.selectOption('#modalBody select[aria-label="Slot for column title"]', '-', { timeout: 3000 }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(400);
  const ignoredMap = await page.$$eval('#modalBody .map-row select', (ns) => ns.map((n) => [n.getAttribute('aria-label'), n.value]));
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  check('a column set to ignore in the batch dialog stays ignored when it is reopened',
    JSON.stringify(ignoredMap) === JSON.stringify([['Slot for column title', '-'], ['Slot for column rules', 'rules']]),
    JSON.stringify(ignoredMap));

  /* ---- per-card changes (0.11.0) --------------------------------------- */
  /* A layer made the card's own keeps that card's position, turn and colour;
     every other card, the saved layout, a template built from it and a copy of
     the layer all see the layout. */
  const ownLayer = await page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const p = await import('/js/core/project.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      t.setFieldText('title', 'First');
      await cards.addCard();
      t.setFieldText('title', 'Second');
      await cards.addCard();
      t.setFieldText('title', 'Third');
      await cards.switchCard(1);
      const title = () => editor.findBySlot('title')[0];
      const look = () => {
        const o = title();
        return { left: Math.round(o.left), top: Math.round(o.top), angle: o.angle, fill: o.fill, own: !!o.tcgBase };
      };
      const base = look();
      const allowed = { title: cards.canOverride(title()), art: cards.canOverride(editor.findBySlot('art')[0]) };
      cards.setOverride(title(), true);
      title().set({ left: title().left + 60, top: title().top + 40, angle: 5, fill: '#ff0000' });
      editor.touch();
      const second = look();
      await cards.switchCard(0);
      const first = look();
      await cards.switchCard(2);
      const third = look();
      await cards.switchCard(1);
      const back = look();
      const template = JSON.stringify(t.buildTemplate({ name: 'Smoke Own' }).canvas);
      await p.saveProject({ name: 'Smoke Own Layer', path: null });
      const saved = await api.readJSON(state.project.path);
      const savedTitle = saved.canvas.objects.find((o) => o.tcgSlot === 'title');
      const id = title().tcgId;
      await p.openProjectPath(state.project.path);
      const reopened = { ...look(), active: cards.activeIndex(), dirty: state.dirty };
      await cards.switchCard(0);
      reopened.first = look();
      await cards.switchCard(1);
      editor.select(title());
      await editor.duplicate();
      const copy = editor.canvas.getActiveObject();
      const copyOwn = !!copy?.tcgBase;
      editor.remove([copy]);
      await api.trash(state.project.path).catch(() => {});
      await api.trash(`${state.project.path}.bak`).catch(() => {});
      return {
        allowed, base, second, first, third, back, reopened, copyOwn,
        savedTitle: { left: Math.round(savedTitle.left), fill: savedTitle.fill, own: 'tcgBase' in savedTitle },
        savedCanvasClean: !JSON.stringify(saved.canvas).includes('tcgBase'),
        templateClean: !template.includes('tcgBase') && !template.includes('#ff0000'),
        savedOverrides: saved.cards.map((c) => c.overrides?.[id] || null),
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  const sameLook = (a, b) => a && b && a.left === b.left && a.top === b.top && a.angle === b.angle && a.fill === b.fill;
  check('a layer changed on one card keeps the change there and nowhere else',
    ownLayer.allowed?.title === true && ownLayer.allowed.art === false &&
      ownLayer.second.own && ownLayer.second.left === ownLayer.base.left + 60 &&
      ownLayer.second.top === ownLayer.base.top + 40 && ownLayer.second.fill === '#ff0000' &&
      sameLook(ownLayer.first, ownLayer.base) && !ownLayer.first.own &&
      sameLook(ownLayer.third, ownLayer.base) && sameLook(ownLayer.back, ownLayer.second) &&
      ownLayer.copyOwn === false,
    JSON.stringify(ownLayer));
  check('a card\'s own changes are saved apart from the layout and come back on reopen',
    ownLayer.savedCanvasClean && ownLayer.templateClean && ownLayer.savedTitle?.left === ownLayer.base?.left &&
      ownLayer.savedTitle.own === false && ownLayer.savedOverrides?.[0] === null && ownLayer.savedOverrides[2] === null &&
      ownLayer.savedOverrides[1]?.left === ownLayer.second.left && ownLayer.savedOverrides[1]?.angle === 5 &&
      ownLayer.savedOverrides[1]?.fill === '#ff0000' && !('scaleX' in ownLayer.savedOverrides[1]) &&
      sameLook(ownLayer.reopened, ownLayer.second) && ownLayer.reopened.active === 1 &&
      ownLayer.reopened.dirty === false && sameLook(ownLayer.reopened.first, ownLayer.base),
    JSON.stringify({ saved: ownLayer.savedOverrides, reopened: ownLayer.reopened, savedTitle: ownLayer.savedTitle }));

  /* Rendering: every card is drawn with its own changes, and a spreadsheet
     run — started while a card with a change is on screen — is drawn from the
     layout. Pixels are read back from the rendered images. */
  const ownRender = await page.evaluate(async () => {
    try {
      const { api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      const batch = await import('/js/core/batch.js');
      await t.applyTemplate(await api.readJSON('templates/blank-starter.json'));
      const block = editor.insert('rect');
      block.set({ left: 100, top: 100, width: 160, height: 160, scaleX: 1, scaleY: 1, angle: 0, fill: '#00ff00',
        stroke: null, strokeWidth: 0, originX: 'left', originY: 'top', tcgName: 'Block' });
      block.setCoords();
      editor.touch();
      await cards.addCard();
      await cards.addCard();
      await cards.switchCard(1);
      cards.setOverride(block, true);
      block.set({ left: 400, top: 600, fill: '#ff00ff', scaleX: 1.5 });
      // Resizing a box folds its scale into its width, as a drag does.
      editor.bakeScale(block);
      editor.touch();
      const pixel = async (url, x, y) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)).join(',');
      };
      const urls = await cards.renderCards({ multiplier: 1 });
      const set = [];
      for (const url of urls) {
        set.push({ base: await pixel(url, 180, 180), moved: await pixel(url, 480, 680), wide: await pixel(url, 630, 680),
          edge: await pixel(url, 300, 180) });
      }
      const sheet = [];
      await batch.runBatch({
        rows: [{ title: 'Row' }], mapping: { title: 'title' },
        options: { multiplier: 1, pattern: '{n}', sink: (url) => sheet.push(url) },
      });
      const row = { base: await pixel(sheet[0], 180, 180), moved: await pixel(sheet[0], 480, 680) };
      const preview = await batch.renderRow({ title: 'Preview' }, { title: 'title' }, { multiplier: 1 });
      const previewed = { base: await pixel(preview, 180, 180), moved: await pixel(preview, 480, 680) };
      return {
        set, row, previewed,
        saved: cards.cardList()[1].overrides,
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  const green = '0,255,0';
  const magenta = '255,0,255';
  check('every card renders with its own changes, and a spreadsheet run renders the layout',
    ownRender.set?.length === 3 &&
      ownRender.set[0].base === green && ownRender.set[0].moved !== magenta &&
      ownRender.set[1].base !== green && ownRender.set[1].moved === magenta && ownRender.set[1].wide === magenta &&
      ownRender.set[0].edge !== green && ownRender.set[2].edge !== green &&
      Object.values(ownRender.saved || {})[0]?.width === 240 &&
      ownRender.set[2].base === green && ownRender.set[2].moved !== magenta &&
      ownRender.row.base === green && ownRender.row.moved !== magenta &&
      ownRender.previewed.base === green && ownRender.previewed.moved !== magenta,
    JSON.stringify(ownRender));

  /* The Properties box, with real clicks and keys: tick it, nudge the layer,
     step to the next card and back, untick it. */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const cards = await import('/js/core/cards.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    await cards.addCard();
    await cards.switchCard(0);
    state.setDirty(false);
  });
  await page.waitForTimeout(300);
  const ownUiAt = await canvasPoint('title');
  await page.mouse.click(ownUiAt.x, ownUiAt.y);
  await page.waitForTimeout(150);
  const ownUi = { artDisabled: null };
  ownUi.before = await page.evaluate(() => ({
    left: window.TCGForge.editor.findBySlot('title')[0].left,
    disabled: document.querySelector('#pCardOnly').disabled,
    checked: document.querySelector('#pCardOnly').checked,
  }));
  await page.click('#pCardOnly', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(150);
  ownUi.ticked = await page.evaluate(() => ({
    own: !!window.TCGForge.editor.findBySlot('title')[0].tcgBase,
    badge: Array.from(document.querySelectorAll('#layerList .layer-own')).map((n) => n.textContent),
    hint: document.querySelector('#pCardOnlyHint').textContent,
    dirty: window.TCGForge.state.dirty,
  }));
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(100);
  const ownLeft = () => page.evaluate(() => ({
    left: window.TCGForge.editor.findBySlot('title')[0].left,
    badge: document.querySelectorAll('#layerList .layer-own').length,
  }));
  ownUi.nudged = await ownLeft();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(700);
  ownUi.nextCard = await ownLeft();
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(700);
  ownUi.backAgain = await ownLeft();
  await page.mouse.click(ownUiAt.x + 10, ownUiAt.y);
  await page.waitForTimeout(150);
  ownUi.boxBack = await page.evaluate(() => document.querySelector('#pCardOnly').checked);
  await page.click('#pCardOnly', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(150);
  ownUi.unticked = await ownLeft();
  await page.evaluate(() => window.TCGForge.editor.select(window.TCGForge.editor.findBySlot('art')[0]));
  await page.waitForTimeout(150);
  ownUi.artDisabled = await page.evaluate(() => document.querySelector('#pCardOnly').disabled);
  await page.evaluate(() => window.TCGForge.editor.canvas.discardActiveObject());
  check('the Only on this card box makes a layer the card\'s own and gives it back',
    ownUi.before.disabled === false && ownUi.before.checked === false && ownUi.ticked.own === true &&
      JSON.stringify(ownUi.ticked.badge) === '["this card"]' && ownUi.ticked.dirty === true &&
      ownUi.nudged.left === ownUi.before.left + 10 &&
      ownUi.nextCard.left === ownUi.before.left && ownUi.nextCard.badge === 0 &&
      ownUi.backAgain.left === ownUi.before.left + 10 && ownUi.backAgain.badge === 1 && ownUi.boxBack === true &&
      ownUi.unticked.left === ownUi.before.left && ownUi.unticked.badge === 0 && ownUi.artDisabled === true,
    JSON.stringify(ownUi));

  /* ---- 0.11.0 bug guards ----------------------------------------------- */
  /* A two-card project, the second card's art slowed down so a switch to it
     takes a moment: the window in which a save or an undo used to act on the
     wrong card. */
  const slowStar = async (ms) => {
    await page.unroute('**/assets/icons/star.svg').catch(() => {});
    if (ms) {
      await page.route('**/assets/icons/star.svg', async (route) => {
        await new Promise((r) => setTimeout(r, ms));
        await route.continue();
      });
    }
  };
  const switchPair = async (name) => page.evaluate(async (projectName) => {
    const { state, api, editor, history } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const p = await import('/js/core/project.js');
    const cards = await import('/js/core/cards.js');
    const batch = await import('/js/core/batch.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    await batch.applyRow({ title: 'Card One', art: 'assets/icons/gem.svg' }, { title: 'title', art: 'art' });
    await cards.addCard();
    await batch.applyRow({ title: 'Card Two', art: 'assets/icons/star.svg' }, { title: 'title', art: 'art' });
    await cards.switchCard(0);
    history.reset();
    await p.saveProject({ name: projectName, path: null });
    document.activeElement?.blur?.();
    editor.canvas.discardActiveObject();
    return state.project.path;
  }, name);

  const switchSavePath = await switchPair('Smoke Switch Save');
  await slowStar(1500);
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(2600);
  const switchSave = await page.evaluate(async (file) => {
    const { state, api, editor } = window.TCGForge;
    const cards = await import('/js/core/cards.js');
    const saved = await api.readJSON(file).catch(() => null);
    const out = {
      saved: saved?.cards?.map((c) => [c.values.title, c.values.art]),
      memory: cards.cardList().map((c) => c.values.title),
      canvas: editor.findBySlot('title')[0]?.text,
      active: cards.activeIndex(),
      dirty: state.dirty,
    };
    return out;
  }, switchSavePath);
  check('a save pressed while a card is still switching writes each card as itself',
    JSON.stringify(switchSave.saved) ===
      JSON.stringify([['Card One', 'assets/icons/gem.svg'], ['Card Two', 'assets/icons/star.svg']]) &&
      JSON.stringify(switchSave.memory) === JSON.stringify(['Card One', 'Card Two']) &&
      switchSave.canvas === 'Card Two' && switchSave.active === 1,
    JSON.stringify(switchSave));

  /* Undo pressed mid-switch must not load the other card's step over the
     switch — that left two art layers in one slot. */
  await slowStar(0);
  await switchPair('Smoke Switch Undo');
  await page.evaluate(async () => {
    const { editor, history } = window.TCGForge;
    const f = await import('/js/core/templates.js');
    f.setFieldText('title', 'Card One edited');
    editor.touch();
    history.flush();
    document.activeElement?.blur?.();
  });
  await slowStar(1500);
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(2600);
  const switchUndo = await page.evaluate(async () => {
    const { editor, api, state } = window.TCGForge;
    const cards = await import('/js/core/cards.js');
    const out = {
      artLayers: editor.findBySlot('art').length,
      title: editor.findBySlot('title')[0]?.text,
      active: cards.activeIndex(),
      first: cards.cardList()[0].values.title,
    };
    await api.trash(state.project.path).catch(() => {});
    await api.trash(`${state.project.path}.bak`).catch(() => {});
    return out;
  });
  await page.evaluate(async (file) => {
    const { api } = window.TCGForge;
    await api.trash(file).catch(() => {});
    await api.trash(`${file}.bak`).catch(() => {});
  }, switchSavePath);
  check('an undo pressed while a card is still switching leaves one art layer on the new card',
    switchUndo.artLayers === 1 && switchUndo.title === 'Card Two' && switchUndo.active === 1 &&
      switchUndo.first === 'Card One edited',
    JSON.stringify(switchUndo));

  /* Two undos pressed faster than a step can load land two steps back, with
     both steps still there to redo. */
  await slowStar(0);
  await page.evaluate(async () => {
    const { api, editor, history } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const batch = await import('/js/core/batch.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    history.reset();
    t.setFieldText('title', 'T1'); editor.touch(); history.flush();
    await batch.applyRow({ art: 'assets/icons/star.svg' }, { art: 'art' }); editor.touch(); history.flush();
    t.setFieldText('title', 'T2'); editor.touch(); history.flush();
    editor.canvas.discardActiveObject();
    document.activeElement?.blur?.();
  });
  await slowStar(400);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(1500);
  await slowStar(0);
  const quickUndos = await page.evaluate(async () => {
    const { editor, history } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    return { ...history.status(), title: editor.findBySlot('title')[0]?.text,
      art: t.isPlacedArt(editor.findBySlot('art')[0]), artLayers: editor.findBySlot('art').length,
      locked: history.locked };
  });
  check('two quick undos step back twice and keep both steps to redo',
    quickUndos.index === 1 && quickUndos.depth === 4 && quickUndos.title === 'T1' && quickUndos.art === false &&
      quickUndos.artLayers === 1 && quickUndos.locked === false,
    JSON.stringify(quickUndos));

  /* A first save under a name another project already has asks before it
     replaces that file. */
  const clash = await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const p = await import('/js/core/project.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    t.setFieldText('title', 'The first card');
    await p.saveProject({ name: 'Smoke Clash', path: null });
    const first = state.project.path;
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    t.setFieldText('title', 'A different card');
    state.setDirty(true);
    return { first, pathAfterTemplate: state.project.path };
  });
  await page.fill('#projectName', 'Smoke Clash');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  clash.asked = await page.isVisible('#modalFoot .btn.danger').catch(() => false);
  await page.click('#modalFoot button:text-is("Cancel")', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  clash.afterCancel = await page.evaluate(async (file) => {
    const { api, state } = window.TCGForge;
    const data = await api.readJSON(file).catch(() => null);
    const title = data?.cards?.[0]?.values?.title;
    return { title, path: state.project.path, dirty: state.dirty };
  }, clash.first);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  await page.click('#modalFoot .btn.danger', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
  clash.afterReplace = await page.evaluate(async (file) => {
    const { api, state } = window.TCGForge;
    const data = await api.readJSON(file).catch(() => null);
    const out = { title: data?.cards?.[0]?.values?.title, path: state.project.path, dirty: state.dirty };
    await api.trash(file).catch(() => {});
    await api.trash(`${file}.bak`).catch(() => {});
    return out;
  }, clash.first);
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  check('saving a new project under a name already taken asks before replacing that file',
    clash.pathAfterTemplate === null && clash.asked === true &&
      clash.afterCancel.title === 'The first card' && clash.afterCancel.path === null &&
      clash.afterCancel.dirty === true &&
      clash.afterReplace.title === 'A different card' && clash.afterReplace.path === clash.first,
    JSON.stringify(clash));

  /* A name typed into Properties is kept when the next thing the user does is
     click another layer on the canvas. */
  await page.evaluate(async () => {
    const { api } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
  });
  await page.waitForTimeout(300);
  const renameFrom = await canvasPoint('title');
  await page.mouse.click(renameFrom.x, renameFrom.y);
  await page.waitForTimeout(150);
  await page.click('#pName', { clickCount: 3 });
  await page.keyboard.type('Hero Banner');
  const renameTo = await canvasPoint('rules');
  await page.mouse.click(renameTo.x, renameTo.y);
  await page.waitForTimeout(250);
  const renamed = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    return { title: editor.findBySlot('title')[0].tcgName, rules: editor.findBySlot('rules')[0].tcgName,
      selected: editor.canvas.getActiveObject()?.tcgSlot, box: document.querySelector('#pName').value };
  });
  check('a layer name typed in Properties is kept when another layer is clicked on the canvas',
    renamed.title === 'Hero Banner' && renamed.rules !== 'Hero Banner' && renamed.selected === 'rules' &&
      renamed.box === renamed.rules,
    JSON.stringify(renamed));

  /* Raising or lowering several layers moves them as one block, in their own
     stacking order, whichever order they were picked in. */
  const blockOrder = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const p = await import('/js/core/project.js');
    await p.newProject({});
    const make = (name) => {
      const o = editor.insert('rect');
      o.set('tcgName', name);
      return o;
    };
    const [A, B, C, D] = ['A', 'B', 'C', 'D'].map(make);
    const names = () => editor.objects().filter((o) => /^[ABCD]$/.test(o.tcgName)).map((o) => o.tcgName).join('');
    const reset = () => [A, B, C, D].forEach((o, i) => editor.canvas.moveObjectTo(o, editor.objects().length - 4 + i));
    const run = (picked, action) => {
      reset();
      editor.select(picked);
      editor.order(action);
      const out = names();
      editor.canvas.discardActiveObject();
      return out;
    };
    return {
      start: names(),
      upAB: run([A, B], 'up'),
      upBA: run([B, A], 'up'),
      bottomAB: run([A, B], 'bottom'),
      topBA: run([B, A], 'top'),
      downDC: run([D, C], 'down'),
      downCD: run([C, D], 'down'),
      upAtTop: run([C, D], 'up'),
    };
  });
  check('raising or lowering several layers moves them as one block',
    blockOrder.start === 'ABCD' && blockOrder.upAB === 'CABD' && blockOrder.upBA === 'CABD' &&
      blockOrder.bottomAB === 'ABCD' && blockOrder.topBA === 'CDAB' && blockOrder.downDC === 'ACDB' &&
      blockOrder.downCD === 'ACDB' && blockOrder.upAtTop === 'ABCD',
    JSON.stringify(blockOrder));

  /* A library font with a hyphen or underscore in its file name is applied
     under the family name it was registered as. */
  const fontName = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const { placeAsset } = await import('/js/ui/assetPanel.js');
    const { assets } = await import('/js/core/assets.js');
    const o = editor.insert('text');
    await placeAsset({ category: 'fonts', name: 'Smoke-Font_Bold', file: 'Smoke-Font_Bold.ttf',
      path: 'assets/fonts/Smoke-Font_Bold.ttf' });
    return { type: o?.type, family: o?.fontFamily, registered: assets.familyOf?.({ name: 'Smoke-Font_Bold' }) };
  });
  check('a library font is applied under the family name it was registered as',
    fontName.family === 'Smoke Font Bold' && fontName.registered === 'Smoke Font Bold',
    JSON.stringify(fontName));

  /* ---- 0.12.0 bug guards ------------------------------------------------ */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    state.setDirty(false);
  });
  await page.waitForTimeout(300);

  /* "Embed images" fetched each picture without asking whether the fetch
     worked, so a picture that had gone from the workspace was embedded as the
     server's JSON error — and the project could then never be opened again,
     even after the file came back. */
  const embedGone = await page.evaluate(async () => {
    try {
      const { api } = await import('/js/core/api.js');
      const t = await import('/js/core/templates.js');
      const p = await import('/js/core/project.js');
      const png =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
        'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const up = await api.uploadAsset({ category: 'art', filename: 'smoke-embed-gone.png', dataURL: png });
      await t.setFieldImage('art', api.fileURL(up.path), { assetPath: up.path });
      await api.trash(up.path);
      const data = await p.serializeProject({ embed: true });
      let src = null;
      const walk = (list) => (list || []).forEach((o) => {
        if (o.tcgAsset === up.path) src = o.src;
        walk(o.objects);
      });
      walk(data.canvas.objects);
      t.clearFieldImage?.('art');
      return { path: up.path, src: String(src).slice(0, 60) };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('embedding a picture that has gone keeps its path instead of an error page',
    !embedGone.error && embedGone.src === `/files/${embedGone.path}`, JSON.stringify(embedGone));

  /* A file dropped straight into an asset folder keeps its own name, and a
     "#" or "?" in it cut the address short: the library listed it and every
     attempt to load it was a 404. */
  const hashName = await page.evaluate(async () => {
    try {
      const { api } = await import('/js/core/api.js');
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#0f0"/></svg>';
      const path = 'assets/art/smoke hash #1?.svg';
      await api.post('/api/write', { path, content: svg });
      const listing = await api.request('/api/assets');
      const item = (listing.assets?.art || listing.art || []).find((a) => a.path === path);
      const listed = item ? (await fetch(item.url)).status : null;
      const direct = (await fetch(api.fileURL(path))).status;
      await api.trash(path).catch(() => {});
      return { found: !!item, listed, direct };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a library file with # or ? in its name can be loaded',
    hashName.found && hashName.listed === 200 && hashName.direct === 200, JSON.stringify(hashName));

  /* Artwork a card names that would not load was remembered while the card
     was on screen — but not across a save and reopen, so stepping off that
     card after reopening wrote null over the path. */
  const lostArt = await page.evaluate(async () => {
    try {
      const c = await import('/js/core/cards.js');
      const p = await import('/js/core/project.js');
      await c.addCard();
      c.cardList()[0].values.art = 'assets/art/smoke-missing-art.png';
      await c.switchCard(0);
      const saved = await p.serializeProject();
      await p.openProjectData(saved);
      await c.switchCard(1);
      const after = c.cardList()[0].values.art;
      const resaved = (await p.serializeProject()).cards[0].values.art;
      return { saved: saved.cards[0].values.art, after, resaved };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('art that would not load survives a reopen and a card switch',
    lostArt.after === 'assets/art/smoke-missing-art.png' && lostArt.resaved === lostArt.after,
    JSON.stringify(lostArt));

  /* "Save an editable project file per card" wrote straight over any project
     of the same name, with none of the backup an ordinary save keeps. */
  const batchBak = await page.evaluate(async () => {
    try {
      const { api } = await import('/js/core/api.js');
      const b = await import('/js/core/batch.js');
      await api.writeJSON('projects/smoke-batch-own.json', { format: 'tcgforge.project', name: 'Hand-made' });
      await b.runBatch({
        rows: [{ title: 'Own' }], mapping: { title: 'title' },
        options: { pattern: 'smoke-batch-own', subfolder: '', saveProjects: true, multiplier: 1 },
      });
      const now = await api.readJSON('projects/smoke-batch-own.json').catch(() => null);
      const bak = await api.readJSON('projects/smoke-batch-own.json.bak').catch(() => null);
      for (const f of ['projects/smoke-batch-own.json', 'projects/smoke-batch-own.json.bak',
        'exports/smoke-batch-own.png']) await api.trash(f).catch(() => {});
      return { now: now?.name, bak: bak?.name };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a batch run keeps a backup of a project file it replaces',
    batchBak.now && batchBak.bak === 'Hand-made', JSON.stringify(batchBak));

  /* Opening a dialog from the keyboard left focus on the toolbar button
     behind it whenever the dialog's first input was a hidden file picker. */
  await page.evaluate(() => window.TCGForge.state.setDirty(false));
  await page.focus('[data-action="open-project"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#modalRoot:not([hidden])', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  const dialogFocus = await page.evaluate(() => {
    const a = document.activeElement;
    const inModal = !!a?.closest('.modal');
    return { tag: a?.tagName, type: a?.type || '', inModal };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('a dialog opened from the keyboard takes the focus',
    dialogFocus.inModal && dialogFocus.type !== 'file', JSON.stringify(dialogFocus));

  /* The server took a JSON array as a request and answered with a 500 from
     deep inside the handler; anything but an object is a 400 now. */
  const arrayBody = await rawRequest({
    method: 'POST', path: '/api/write',
    headers: { 'Content-Type': 'application/json' }, body: '[1]',
  });
  check('a request body that is not a JSON object is refused as a bad request',
    arrayBody.status === 400, `POST [1] → ${arrayBody.status}`);

  /* Every write used the same temp file, so two writes to one path at the
     same moment could rename or remove each other's and one came back 404. */
  const racing = [];
  for (let round = 0; round < 4; round += 1) {
    const batch = await Promise.all(Array.from({ length: 8 }, (_, i) => rawRequest({
      method: 'POST', path: '/api/write',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'projects/smoke-racing.json', content: JSON.stringify({ i, pad: 'x'.repeat(150000) }) }),
    })));
    racing.push(...batch.map((r) => r.status));
  }
  await page.evaluate(async () => {
    const { api } = await import('/js/core/api.js');
    await api.trash('projects/smoke-racing.json').catch(() => {});
  });
  check('simultaneous writes to one file all succeed',
    racing.length === 32 && racing.every((s) => s === 200),
    `${racing.filter((s) => s === 200).length}/32 → 200`);

  /* Serving the network (--host 0.0.0.0) used to switch the Host check off
     altogether, so a page arriving under its own DNS name — a rebinding
     attack on the user's own browser — could write to the workspace. Any
     address that is not 127.0.0.1 counts as serving the network; 127.0.0.2
     says so without opening a port to the network (or a firewall prompt),
     except on macOS, which only answers on 127.0.0.1. */
  const network = await (async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'launch.py');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-network-'));
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const bind = process.platform === 'darwin' ? '0.0.0.0' : '127.0.0.2';
    const child = spawn(python, ['-u', launcher, '--no-browser', '--host', bind, '--port', '7960',
      '--workspace', scratch, '--allow-host', 'cards.example'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const port = await new Promise((resolve) => {
        let out = '';
        const timer = setTimeout(() => resolve(null), 8000);
        child.stdout.on('data', (chunk) => {
          out += chunk;
          const m = out.match(/running\s*:\s*http:\/\/[^:]+:(\d+)\//);
          if (m) { clearTimeout(timer); resolve(Number(m[1])); }
        });
        child.on('exit', () => { clearTimeout(timer); resolve(null); });
      });
      if (!port) return { error: 'launcher did not start' };
      const probe = (host) => new Promise((resolve) => {
        const req = http.request({ host: bind === '0.0.0.0' ? '127.0.0.1' : bind, port, path: '/api/status',
          headers: { Host: `${host}:${port}` } },
          (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', () => resolve(null));
        req.end();
      });
      return {
        rebound: await probe('cards.evil.example'),
        address: await probe('192.168.1.20'),
        named: await probe('cards.example'),
        loopback: await probe('localhost'),
      };
    } catch (err) {
      return { error: err.message };
    } finally {
      child.kill();
    }
  })();
  check('serving the network still refuses a name nobody gave the server',
    network.rebound === 403 && network.address === 200 && network.named === 200 && network.loopback === 200,
    JSON.stringify(network));

  /* Every error the app reports is a toast, and the toasts were silent to a
     screen reader. */
  const spoken = await page.evaluate(async () => {
    const { toast } = await import('/js/ui/dialogs.js');
    toast('Smoke error', 'err', 400);
    const host = document.querySelector('#toasts');
    const last = host.lastElementChild;
    return { live: host.getAttribute('aria-live'), role: host.getAttribute('role'), errRole: last?.getAttribute('role') };
  });
  check('toasts are announced, and errors interrupt',
    spoken.live === 'polite' && spoken.role === 'status' && spoken.errRole === 'alert', JSON.stringify(spoken));

  /* ---- icons in text ---------------------------------------------------- */

  /* The shipped icon font is what the builder makes from the shipped icons,
     byte for byte — so it is reproducible and cannot drift from the SVGs —
     and a rebuild keeps every icon's code point, because a card's text stores
     the code point itself. */
  const iconBuild = await (async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const builder = path.join(root, 'tools', 'build_icon_font.py');
    const shipped = ['element-air', 'element-dark', 'element-earth', 'element-fire', 'element-light',
      'element-water', 'gem', 'heart', 'shield', 'skull', 'star', 'sword'];
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-icons-'));
    const icons = path.join(scratch, 'icons');
    fs.mkdirSync(icons);
    for (const name of shipped) {
      fs.copyFileSync(path.join(root, 'workspace', 'assets', 'icons', `${name}.svg`), path.join(icons, `${name}.svg`));
    }
    const out = path.join(scratch, 'Forge-Icons.ttf');
    const run = (...args) => spawnSync(python, [builder, '--icons', icons, '--out', out, ...args], { encoding: 'utf8' });
    const first = run();
    if (first.status !== 0) return { error: first.stderr || first.error?.message || 'builder failed' };
    const same = Buffer.compare(fs.readFileSync(out),
      fs.readFileSync(path.join(root, 'workspace', 'assets', 'fonts', 'Forge-Icons.ttf'))) === 0;
    const table = () => Object.fromEntries(run('--list').stdout.trim().split('\n')
      .map((line) => line.match(/U\+([0-9A-F]+)\s+\{(.+)\}/)).filter(Boolean).map((m) => [m[2], m[1]]));
    const before = table();
    // A new icon that sorts first, and one taken away.
    fs.copyFileSync(path.join(icons, 'star.svg'), path.join(icons, 'aaa-new.svg'));
    fs.rmSync(path.join(icons, 'gem.svg'));
    run();
    const after = table();
    const kept = shipped.filter((n) => n !== 'gem').every((n) => before[n] && before[n] === after[n]);
    return { same, count: Object.keys(before).length, gem: before.gem, kept, added: after['aaa-new'], gone: !after.gem };
  })().catch((err) => ({ error: err.message }));
  check('the icon font is rebuilt from the icons byte for byte, keeping every code point',
    iconBuild.same && iconBuild.count === 12 && iconBuild.gem === 'E006' && iconBuild.kept &&
      iconBuild.added === 'E00C' && iconBuild.gone,
    JSON.stringify(iconBuild));

  /* The app reads the icon names out of the font, and the canvas draws and
     measures an icon from it: two icons paint different shapes (a missing
     glyph paints the same box for both) at the font's own advance width. */
  const iconPaint = await page.evaluate(async () => {
    try {
      const { editor } = window.TCGForge;
      const icons = await import('/js/core/icons.js');
      const list = icons.iconList();
      const gem = list.find((i) => i.name === 'gem');
      const o = editor.insert('text');
      o.set({ left: 20, top: 20, width: 500, fontSize: 300, fill: '#ff00ff', text: '\ue007', opacity: 1 });
      o.initDimensions();
      const advance = Math.round(o.getLineWidth(0));
      const mask = () => new Promise((resolve) => {
        const url = editor.toDataURL({ multiplier: 1 });
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(20, 20, 420, 420).data;
          let ink = 0;
          let hash = 0;
          for (let i = 0; i < d.length; i += 4) {
            const on = d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200;
            if (on) { ink += 1; hash = (hash * 31 + i) % 1000000007; }
          }
          resolve({ ink, hash });
        };
        img.src = url;
      });
      const heart = await mask();
      o.set('text', '\ue00a');
      o.initDimensions();
      editor.canvas.requestRenderAll();
      const star = await mask();
      editor.canvas.remove(o);
      editor.touch();
      return {
        count: list.length, gem: gem?.char.codePointAt(0).toString(16), families: icons.iconFamilies(),
        loaded: document.fonts.check('20px "Forge Icons"'), advance, heart, star,
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('icons are read from the font and drawn on the canvas at their own width',
    !iconPaint.error && iconPaint.count === 12 && iconPaint.gem === 'e006' && iconPaint.loaded &&
      Math.abs(iconPaint.advance - 291) <= 3 && iconPaint.heart.ink > 3000 && iconPaint.star.ink > 3000 &&
      iconPaint.heart.hash !== iconPaint.star.hash,
    JSON.stringify(iconPaint));

  /* Typed into Card Fields with real keys: a finished {name} becomes the icon
     in the box and on the card, the caret stays put, and braces that name no
     icon are left alone. */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    state.setDirty(false);
  });
  await page.waitForTimeout(300);
  await page.click('#ff_rules');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Pay {gem} and {nothing} now');
  await page.waitForTimeout(250);
  const typedIcon = await page.evaluate(() => ({
    field: document.querySelector('#ff_rules').value,
    canvas: window.TCGForge.editor.findBySlot('rules')[0].text,
    caret: document.querySelector('#ff_rules').selectionStart,
  }));
  check('{name} typed into a card field becomes the icon, on the card too',
    typedIcon.field === 'Pay \ue006 and {nothing} now' && typedIcon.canvas === typedIcon.field &&
      typedIcon.caret === typedIcon.field.length,
    JSON.stringify(typedIcon));

  /* The palette puts the icon at the caret of the box that had it last — not
     simply the first field — and gives that box the focus back (a real mouse
     click and a real keyboard press). */
  await page.click('#ff_rules');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Bolt');
  await page.keyboard.press('Home');
  await page.click('#iconPalette [data-icon="star"]');
  await page.keyboard.type(' ');
  await page.waitForTimeout(200);
  const paletteMouse = await page.evaluate(() => ({
    field: document.querySelector('#ff_rules').value,
    canvas: window.TCGForge.editor.findBySlot('rules')[0].text,
    focus: document.activeElement?.id,
  }));
  await page.focus('#iconPalette [data-icon="heart"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const paletteKeys = await page.evaluate(() => ({
    field: document.querySelector('#ff_rules').value,
    focus: document.activeElement?.id,
  }));
  check('the icon palette inserts at the caret of the last text box',
    paletteMouse.field === '\ue00a Bolt' && paletteMouse.canvas === paletteMouse.field &&
      paletteMouse.focus === 'ff_rules' && paletteKeys.field === '\ue00a \ue007Bolt' && paletteKeys.focus === 'ff_rules',
    JSON.stringify({ paletteMouse, paletteKeys }));

  /* On the canvas a token turns into the icon when typing ends, and in the
     Properties text box as it is typed. A short title keeps it on one line,
     so End is the end of the text. */
  await page.fill('#ff_title', 'Bolt');
  await page.waitForTimeout(150);
  const titleLayer = await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const o = editor.findBySlot('title')[0];
    const r = o.getBoundingRect();
    const z = editor.canvas.getZoom();
    const box = editor.canvas.upperCanvasEl.getBoundingClientRect();
    return { x: box.left + (r.left + 30) * z, y: box.top + (r.top + r.height / 2) * z };
  });
  await page.mouse.click(titleLayer.x, titleLayer.y);
  await page.mouse.dblclick(titleLayer.x, titleLayer.y);
  await page.keyboard.press('End');
  await page.keyboard.type(' {skull}');
  const whileTyping = await page.evaluate(() => window.TCGForge.editor.findBySlot('title')[0].text);
  await page.evaluate(() => window.TCGForge.editor.canvas.getActiveObject()?.exitEditing?.());
  await page.waitForTimeout(200);
  const canvasIcon = await page.evaluate(() => ({
    text: window.TCGForge.editor.findBySlot('title')[0].text,
    field: document.querySelector('#ff_title').value,
  }));
  await page.evaluate(() => window.TCGForge.editor.select(window.TCGForge.editor.findBySlot('rules')[0]));
  await page.waitForTimeout(200);
  await page.click('#pText');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Gain {heart}.');
  await page.waitForTimeout(200);
  const propsIcon = await page.evaluate(() => ({
    box: document.querySelector('#pText').value,
    canvas: window.TCGForge.editor.findBySlot('rules')[0].text,
  }));
  check('a token typed on the canvas or in Properties becomes the icon',
    whileTyping.endsWith(' {skull}') && canvasIcon.text.endsWith(' \ue009') && canvasIcon.field === canvasIcon.text &&
      propsIcon.box === 'Gain \ue007.' && propsIcon.canvas === propsIcon.box,
    JSON.stringify({ whileTyping, canvasIcon, propsIcon }));

  /* A spreadsheet cell's {name} is the icon on the rendered card, and the
     canvas comes back as it was. */
  const batchIcons = await page.evaluate(async () => {
    try {
      const { editor } = window.TCGForge;
      const b = await import('/js/core/batch.js');
      const before = editor.findBySlot('rules')[0].text;
      const seen = [];
      const images = [];
      await b.runBatch({
        rows: [{ rules: 'Pay {gem}.' }, { rules: 'Pay {GEM} and {star}.' }],
        mapping: { rules: 'rules' },
        options: {
          multiplier: 1,
          sink: (url) => images.push(url),
          prepare: () => seen.push(editor.findBySlot('rules')[0].text),
        },
      });
      return { seen, images: images.length, after: editor.findBySlot('rules')[0].text === before };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a {name} in a spreadsheet cell renders as the icon',
    batchIcons.seen?.[0] === 'Pay \ue006.' && batchIcons.seen?.[1] === 'Pay \ue006 and \ue00a.' &&
      batchIcons.images === 2 && batchIcons.after,
    JSON.stringify(batchIcons));

  /* ---- 0.13.0: bug guards ---------------------------------------------- */

  /* A path the API hands out can be handed straight back. A `%` in a file
     name dropped into the workspace by hand was decoded a second time, so the
     server listed `set 100%41.json` and then looked for `set 100A.json`. */
  const percentName = await page.evaluate(async () => {
    try {
      const { api } = window.TCGForge;
      const path = 'projects/smoke 100%41.json';
      await api.writeJSON(path, { format: 'tcgforge.project', name: 'Percent Probe' });
      const listed = (await api.listProjects()).some((p) => p.path === path);
      const wrongTwin = (await api.listProjects()).some((p) => p.path === 'projects/smoke 100A.json');
      const read = await api.readJSON(path).then((d) => d.name).catch((e) => `error: ${e.message}`);
      const served = (await fetch(api.fileURL(path))).status;
      const trashed = await api.trash(path).then(() => true).catch(() => false);
      return { listed, wrongTwin, read, served, trashed };
    } catch (err) {
      return { error: err.message };
    }
  });
  const percentTraversal = await rawRequest({ path: '/files/assets/%2e%2e/%2e%2e/launch.py' });
  check('a file with % in its name reads, serves and trashes by the path the API lists',
    percentName.listed && !percentName.wrongTwin && percentName.read === 'Percent Probe' &&
      percentName.served === 200 && percentName.trashed && percentTraversal.status !== 200,
    JSON.stringify({ ...percentName, traversal: percentTraversal.status }));

  /* A code point is handed out once. Taking the newest icon out and adding
     another must not give the new one the old one's point — saved cards that
     held the old icon would quietly show the new one — and putting the file
     back restores the old point. A second font in the same folder starts
     after the first, instead of mapping U+E000 again. */
  const retiredIcons = await (async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const builder = path.join(root, 'tools', 'build_icon_font.py');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-retired-'));
    const icons = path.join(scratch, 'icons');
    const fonts = path.join(scratch, 'fonts');
    fs.mkdirSync(icons);
    fs.mkdirSync(fonts);
    const shippedIcons = path.join(root, 'workspace', 'assets', 'icons');
    for (const file of fs.readdirSync(shippedIcons)) fs.copyFileSync(path.join(shippedIcons, file), path.join(icons, file));
    const out = path.join(fonts, 'Forge-Icons.ttf');
    fs.copyFileSync(path.join(root, 'workspace', 'assets', 'fonts', 'Forge-Icons.ttf'), out);
    const run = (dir, font, ...args) => spawnSync(python, [builder, '--icons', dir, '--out', font, ...args], { encoding: 'utf8' });
    const table = (font) => Object.fromEntries(run(icons, font, '--list').stdout.trim().split('\n')
      .map((line) => line.match(/U\+([0-9A-F]+)\s+\{(.+)\}/)).filter(Boolean).map((m) => [m[2], m[1]]));
    const before = table(out);
    fs.rmSync(path.join(icons, 'sword.svg'));
    const removed = run(icons, out);
    fs.copyFileSync(path.join(icons, 'gem.svg'), path.join(icons, 'axe.svg'));
    run(icons, out);
    const withAxe = table(out);
    fs.copyFileSync(path.join(shippedIcons, 'sword.svg'), path.join(icons, 'sword.svg'));
    run(icons, out);
    const restored = table(out);
    const runes = path.join(scratch, 'runes');
    fs.mkdirSync(runes);
    fs.copyFileSync(path.join(shippedIcons, 'star.svg'), path.join(runes, 'rune.svg'));
    const second = path.join(fonts, 'Rune-Icons.ttf');
    run(runes, second);
    const runeTable = table(second);
    return {
      sword: before.sword, warned: /sword/.test(removed.stderr || ''), axe: withAxe.axe,
      swordGone: !withAxe.sword, back: restored.sword, axeKept: restored.axe, rune: runeTable.rune,
      runeBytes: [...fs.readFileSync(second)],
    };
  })().catch((err) => ({ error: err.message }));
  check('the icon builder never hands one code point to two icons',
    retiredIcons.sword === 'E00B' && retiredIcons.warned && retiredIcons.swordGone && retiredIcons.axe === 'E00C' &&
      retiredIcons.back === 'E00B' && retiredIcons.axeKept === 'E00C' && retiredIcons.rune === 'E00D',
    JSON.stringify({ ...retiredIcons, runeBytes: retiredIcons.runeBytes?.length }));

  /* The app's side of the same promise: a second icon font that maps a point
     the first already maps (most icon fonts start at U+E000) is left out of
     the catalogue, because the canvas would draw the first font's glyph. */
  const sharedPoint = await page.evaluate(async () => {
    try {
      const icons = await import('/js/core/icons.js');
      // Forge Icons' own bytes under another family and with every name
      // changed: same code points, new names.
      const res = await fetch(window.TCGForge.api.fileURL('assets/fonts/Forge-Icons.ttf'));
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder('latin1').decode(bytes);
      for (const name of ['element-air', 'gem']) {
        const at = text.indexOf(name);
        bytes[at] = 'z'.charCodeAt(0);
      }
      const added = icons.addIconFont('Smoke Clash Icons', bytes.buffer);
      const list = icons.iconList();
      return {
        added,
        clash: list.filter((i) => i.name === 'zlement-air' || i.name === 'zem').length,
        air: list.find((i) => i.name === 'element-air')?.family,
        families: icons.iconFamilies().includes('Smoke Clash Icons'),
        collapsed: icons.collapseIcons('Pay \ue006 or \ue000.'),
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('an icon font that reuses another font\'s code points cannot claim them',
    sharedPoint.added === 0 && sharedPoint.clash === 0 && sharedPoint.air === 'Forge Icons' &&
      !sharedPoint.families && sharedPoint.collapsed === 'Pay {gem} or {element-air}.',
    JSON.stringify(sharedPoint));

  /* The palette never types into a box that is out of sight. Properties →
     Text stays in the page, hidden, once the selection is not a text layer;
     an icon put there changed nothing anyone could see. */
  const hiddenTarget = await (async () => {
    await page.evaluate(async () => {
      const { editor, api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      editor.select(editor.findBySlot('title')[0]);
      editor.emitSelection();
    });
    await page.click('#pText');
    await page.evaluate(() => {
      const { editor } = window.TCGForge;
      editor.select([]);
      editor.emitSelection();
    });
    const pTextShown = await page.evaluate(() => document.querySelector('#pText').checkVisibility());
    const firstField = await page.evaluate(() => document.querySelector('#fieldForm [data-icon-target]')?.id);
    const before = await page.evaluate((id) => document.getElementById(id).value, firstField);
    await page.click('#iconPalette [data-icon="star"]');
    await page.waitForTimeout(200);
    return page.evaluate(({ id, before }) => ({
      pTextShown: document.querySelector('#pText').checkVisibility(),
      pTextHasIcon: document.querySelector('#pText').value.includes('\ue00a'),
      field: id,
      fieldGotIcon: !before.includes('\ue00a') && document.getElementById(id).value.includes('\ue00a'),
      focus: document.activeElement?.id,
    }), { id: firstField, before }).then((r) => ({ ...r, hiddenBefore: !pTextShown }));
  })().catch((err) => ({ error: err.message }));
  check('the icon palette skips a text box that is hidden',
    hiddenTarget.hiddenBefore && !hiddenTarget.pTextHasIcon && hiddenTarget.fieldGotIcon &&
      hiddenTarget.focus === hiddenTarget.field,
    JSON.stringify(hiddenTarget));

  /* ---- 0.13.0: cards out to a spreadsheet and back --------------------- */

  /* Save as CSV in the strip writes one row per card, with its id, every
     slot, its copies, icons as {name}; the batch parser reads the same cells
     back. Then the sheet is edited as a person would — the card on screen
     retitled and given new art, another card's art cleared and its copies
     changed, one row copied as a new card — and brought back with *Add rows
     as cards*: the cards are updated in place, per-card layer changes kept,
     the copied row added, and the card on screen redrawn. A picture kept
     only inside the project file goes out as a blank cell and survives the
     blank cell coming back. */
  const sheetSetup = await page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      state.project.name = 'Smoke Sheet Set';
      const text = (await api.request('/api/read?path=batch/sample-set.csv')).content;
      const table = batch.parseAny(text, 'sample-set.csv');
      const mapping = Object.fromEntries(table.columns.map((c) => [c, cards.slotKinds().has(c) ? c : '-']));
      await cards.addRows(table.rows.slice(0, 3), mapping, batch.resolveAsset, { qtyColumn: 'qty' });
      await cards.removeCard(0);
      await cards.switchCard(1);
      // Card 2 nudges its title for itself alone.
      const title = editor.findBySlot('title')[0];
      cards.setOverride(title, true);
      title.set({ left: title.left + 40 });
      editor.touch();
      await cards.switchCard(0);
      await cards.switchCard(1);
      // Card 1's art lives only inside the project file: no path to write.
      cards.cardList()[0].values.art = 'data:image/svg+xml;base64,' +
        btoa('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
      return {
        ids: cards.cardList().map((c) => c.id),
        titles: cards.cardList().map((c) => c.values.title),
        arts: cards.cardList().map((c) => c.values.art),
        rules0: cards.cardList()[0].values.rules,
        overridden: Object.keys(cards.cardList()[1].overrides || {}).length,
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.evaluate(() => window.TCGForge.api.trash('batch/smoke-sheet-set.csv').catch(() => {}));
  await page.click('#cardsCsv');
  await page.waitForTimeout(600);
  const sheetFile = await page.evaluate(async () => {
    try {
      const { api } = window.TCGForge;
      const batch = await import('/js/core/batch.js');
      // The bytes on disk, not /api/read's text (which reads line ends loosely).
      const bytes = new Uint8Array(await (await fetch(api.fileURL('batch/smoke-sheet-set.csv'))).arrayBuffer());
      const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      const table = batch.parseAny(raw, 'smoke-sheet-set.csv');
      return { raw, columns: table.columns, rows: table.rows, bom: raw.charCodeAt(0) === 0xfeff, crlf: raw.includes('\r\n') };
    } catch (err) {
      return { error: err.message };
    }
  });
  const sheetRows = sheetFile.rows || [];
  check('Save as CSV writes every card with its id, slots, copies and icons by name',
    sheetFile.bom && sheetFile.crlf && sheetFile.columns?.[0] === '_id' && sheetFile.columns.includes('qty') &&
      ['title', 'rules', 'art'].every((c) => sheetFile.columns.includes(c)) &&
      JSON.stringify(sheetRows.map((r) => r._id)) === JSON.stringify(sheetSetup.ids) &&
      JSON.stringify(sheetRows.map((r) => r.title)) === JSON.stringify(sheetSetup.titles) &&
      JSON.stringify(sheetRows.map((r) => r.art)) === JSON.stringify(['', ...(sheetSetup.arts || []).slice(1)]) &&
      sheetRows[0]?.rules.includes('{element-fire}') && !/[\ue000-\uf8ff]/.test(sheetFile.raw) &&
      sheetRows[0]?.rules.includes('\n') && sheetRows.map((r) => r.qty).join() === '4,1,4' &&
      sheetSetup.overridden === 1,
    JSON.stringify({ setup: sheetSetup, columns: sheetFile.columns, qty: sheetRows.map((r) => r.qty), rules0: sheetRows[0]?.rules, pua: /[\ue000-\uf8ff]/.test(sheetFile.raw || ''), bom: sheetFile.bom, crlf: sheetFile.crlf, error: sheetFile.error }));

  // Edit the sheet as a person would, and save it back where it came from.
  const sheetEdited = await page.evaluate(async (rows) => {
    try {
      const { api } = window.TCGForge;
      const batch = await import('/js/core/batch.js');
      const columns = Object.keys(rows[0]);
      const edited = rows.map((r) => ({ ...r }));
      edited[1].title = 'Retitled In A Sheet';
      edited[1].art = 'assets/icons/heart.svg';
      edited[1].rules = 'Gain {heart}, then +1/+1.';
      edited[2].art = '';
      edited[2].qty = '7';
      edited.push({ ...rows[0], title: 'A Copied Row' });
      await api.writeText('batch/smoke-sheet-set.csv', batch.toCSV(columns, edited));
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }, sheetRows);

  // Bring it back through the batch dialog, the way a person would.
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+b');
  await page.waitForSelector('#batchSummary');
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !!document.querySelector('#batchWorkspaceFile option[value="batch/smoke-sheet-set.csv"]'),
    null, { timeout: 5000 }).catch(() => {});
  await page.selectOption('#batchWorkspaceFile', 'batch/smoke-sheet-set.csv', { timeout: 3000 }).catch(() => {});
  await page.click('#batchOpenFile', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  const idMapping = await page.evaluate(() => document.querySelector('select[aria-label="Slot for column _id"]')?.value);
  await page.click('#batchAddCards');
  await page.waitForFunction(() => /Updated/.test(document.querySelector('#batchStatus')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const sheetBack = await page.evaluate(async () => {
    try {
      const { editor, state } = window.TCGForge;
      const cards = await import('/js/core/cards.js');
      const status = document.querySelector('#batchStatus').textContent;
      (await import('/js/ui/dialogs.js')).closeModal();
      const list = cards.cardList();
      const onScreen = {
        title: editor.findBySlot('title')[0].text,
        art: editor.findBySlot('art')[0].tcgAsset || null,
        rules: editor.findBySlot('rules')[0].text,
        titleOwn: !!editor.findBySlot('title')[0].tcgBase,
      };
      return {
        status,
        count: list.length,
        active: state.project.activeCard,
        ids: list.map((c) => c.id),
        titles: list.map((c) => c.values.title),
        arts: list.map((c) => c.values.art ?? null),
        qty: list.map((c) => cards.qtyOf(c)),
        keptOverride: Object.keys(list[1].overrides || {}).length,
        onScreen,
        dirty: state.dirty,
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a saved sheet comes back as an update to the same cards',
    sheetEdited.ok && idMapping === '-' && sheetBack.count === 4 &&
      JSON.stringify(sheetBack.ids?.slice(0, 3)) === JSON.stringify(sheetSetup.ids) &&
      sheetBack.titles?.[1] === 'Retitled In A Sheet' && sheetBack.titles?.[3] === 'A Copied Row' &&
      sheetBack.titles?.[0] === sheetSetup.titles?.[0] &&
      sheetBack.arts?.[0]?.startsWith('data:') && sheetBack.arts?.[3] === null &&
      sheetBack.arts?.[1] === 'assets/icons/heart.svg' && sheetBack.arts?.[2] === null &&
      sheetBack.qty?.join() === '4,1,7,4' && sheetBack.keptOverride === 1 &&
      sheetBack.active === 1 && sheetBack.onScreen.title === 'Retitled In A Sheet' &&
      sheetBack.onScreen.art === 'assets/icons/heart.svg' && sheetBack.onScreen.rules === 'Gain \ue007, then +1/+1.' &&
      sheetBack.onScreen.titleOwn && sheetBack.dirty && /Updated 3 cards and added 1 card/.test(sheetBack.status),
    JSON.stringify({ idMapping, ...sheetBack }));
  await page.evaluate(async () => {
    const { api } = window.TCGForge;
    for (const path of ['batch/smoke-sheet-set.csv', 'batch/smoke-sheet-set.csv.bak']) await api.trash(path).catch(() => {});
  });

  /* ---- 0.14.0: bug guards ---------------------------------------------- */

  /* Embedding awaits every picture. A card switch that started in that wait
     moved the active card under the save: the file's canvas showed one card
     while its activeCard named the other, so reopening and stepping off wrote
     the first card's words over the second. */
  const raceSaved = await page.evaluate(async () => {
    const { api } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const b = await import('/js/core/batch.js');
    const c = await import('/js/core/cards.js');
    const p = await import('/js/core/project.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    t.setFieldText('title', 'Race Alpha');
    await b.applyRow({ art: 'assets/backgrounds/ember.svg' }, { art: 'art' });
    await c.addCard();
    t.setFieldText('title', 'Race Beta');
    await c.switchCard(0);
    window.TCGForge.state.settings.embedImages = true;
    await p.saveProject({ name: 'Smoke Embed Race', path: 'projects/smoke-embed-race.json' });
    document.activeElement?.blur?.();
    return (await api.readJSON('projects/smoke-embed-race.json')).meta.modified;
  });
  await page.route('**/files/assets/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    route.continue().catch(() => {});
  });
  await page.click('#canvasScroll', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(150);
  await page.keyboard.press('PageDown');
  // Every picture on the layout is slowed, so the save takes several seconds.
  for (let waited = 0; waited < 30000; waited += 500) {
    await page.waitForTimeout(500);
    const modified = await page.evaluate(async () =>
      (await window.TCGForge.api.readJSON('projects/smoke-embed-race.json').catch(() => null))?.meta.modified);
    if (modified && modified !== raceSaved) break;
  }
  await page.unroute('**/files/assets/**');
  const embedRace = await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    state.settings.embedImages = false;
    const data = await api.readJSON('projects/smoke-embed-race.json').catch(() => null);
    for (const path of ['projects/smoke-embed-race.json', 'projects/smoke-embed-race.json.bak']) await api.trash(path).catch(() => {});
    if (!data) return { error: 'no file' };
    const canvasTitle = data.canvas.objects.find((o) => o.tcgSlot === 'title')?.text;
    return { canvasTitle, active: data.activeCard, cards: data.cards.map((card) => card.values.title) };
  });
  check('a card switch during an embedding save cannot split the file between two cards',
    embedRace.cards?.join() === 'Race Alpha,Race Beta' && embedRace.canvasTitle === embedRace.cards[embedRace.active],
    JSON.stringify(embedRace));

  /* Art picked while a switch is still loading the incoming card's picture
     landed beside it: the slot held two images, and the stray one stayed on
     the layout for every card. */
  await page.evaluate(async () => {
    const c = await import('/js/core/cards.js');
    const t = await import('/js/core/templates.js');
    const b = await import('/js/core/batch.js');
    await c.switchCard(0);
    await b.applyRow({ art: null }, { art: 'art' });
    t.setFieldText('title', 'Art Race A');
    await c.switchCard(1);
    await b.applyRow({ art: 'assets/backgrounds/ember.svg' }, { art: 'art' });
    await c.switchCard(0);
    document.activeElement?.blur?.();
  });
  await page.route('**/files/assets/backgrounds/ember.svg', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    route.continue().catch(() => {});
  });
  await page.click('#canvasScroll', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const a = await import('/js/ui/assetPanel.js');
    await a.placeAsset({ category: 'art', name: 'abyss', path: 'assets/backgrounds/abyss.svg' });
  });
  await page.waitForTimeout(2500);
  await page.unroute('**/files/assets/backgrounds/ember.svg');
  const artRace = await page.evaluate(async () => {
    try {
      const c = await import('/js/core/cards.js');
      const { editor, state } = window.TCGForge;
      const onB = editor.findBySlot('art').map((o) => o.tcgAsset || o.type);
      await c.switchCard(0);
      const onA = editor.findBySlot('art').map((o) => o.tcgAsset || o.type);
      return { onB, onA, records: state.project.cards.map((card) => card.values.art) };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('art picked during a card switch replaces the slot instead of joining it',
    artRace.onB?.join() === 'assets/backgrounds/abyss.svg' && artRace.onA?.length === 1 &&
      artRace.onA[0] !== 'assets/backgrounds/abyss.svg' && artRace.records?.[1] === 'assets/backgrounds/abyss.svg',
    JSON.stringify(artRace));

  /* A layout with a slot called `qty` writes the card counts as `copies`; the
     way back picked `qty` (the slot's text) as the count and overwrote every
     card's Copies with it. */
  await page.evaluate(async () => {
    const { api, editor, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const c = await import('/js/core/cards.js');
    const o = await import('/js/core/objects.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    editor.place(o.makeText('2', { tcgSlot: 'qty', tcgName: 'Printed count' }));
    t.setFieldText('title', 'Qty Alpha');
    t.setFieldText('qty', '7');
    c.setCardQty(0, 4);
    await c.addCard();
    t.setFieldText('title', 'Qty Beta');
    t.setFieldText('qty', '9');
    c.setCardQty(1, 3);
    state.project.name = 'Smoke Qty Slot';
    document.activeElement?.blur?.();
  });
  await page.click('#cardsCsv');
  await page.waitForTimeout(900);
  await page.keyboard.press('Control+b');
  await page.waitForSelector('#batchWorkspaceFile', { timeout: 5000 }).catch(() => {});
  await page.selectOption('#batchWorkspaceFile', 'batch/smoke-qty-slot.csv').catch(() => {});
  await page.click('#batchOpenFile', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  const qtyChosen = await page.inputValue('#batchQtyColumn').catch(() => '');
  await page.click('#batchAddCards', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const qtySlotSheet = await page.evaluate(async () => {
    const { state, api } = window.TCGForge;
    const d = await import('/js/ui/dialogs.js');
    d.closeModal();
    const out = state.project.cards.map((card) => ({ qtySlot: card.values.qty, copies: card.qty ?? 1 }));
    for (const path of ['batch/smoke-qty-slot.csv', 'batch/smoke-qty-slot.csv.bak']) await api.trash(path).catch(() => {});
    return out;
  });
  check('a slot called qty does not take over the copy count on the way back from a sheet',
    qtyChosen === 'copies' && JSON.stringify(qtySlotSheet) === '[{"qtySlot":"7","copies":4},{"qtySlot":"9","copies":3}]',
    JSON.stringify({ qtyChosen, qtySlotSheet }));

  /* Save as template wrote templates/<name>.json without looking, so the
     default name (the project's) silently replaced an earlier template, or a
     shipped one. It asks now, and No goes back to the dialog as typed. */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    t.setFieldText('title', 'Clash Original');
    await t.saveTemplate({ name: 'Smoke Clash' });
    t.setFieldText('title', 'Clash Replacement');
    state.project.name = 'Smoke Clash';
    document.activeElement?.blur?.();
  });
  const clashFoot = async (label) => {
    for (const button of await page.$$('#modalFoot .btn')) {
      if ((await button.textContent()) === label) return button;
    }
    return null;
  };
  const clashTitle = () => page.$eval('#modalTitle', (n) => n.textContent).catch(() => '');
  const clashFile = () => page.evaluate(async () => {
    const data = await window.TCGForge.api.readJSON('templates/smoke-clash.json').catch(() => null);
    return data?.canvas.objects.find((o) => o.tcgSlot === 'title')?.text ?? null;
  });
  await page.click('[data-action="save-template"]');
  await page.waitForTimeout(300);
  await (await clashFoot('Save template'))?.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  const askedTitle = await clashTitle();
  const hasDanger = !!(await page.$('#modalFoot .btn.danger'));
  await (await clashFoot('Cancel'))?.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  const backTitle = await clashTitle();
  const keptName = await page.$eval('#modalBody input', (n) => n.value).catch(() => '');
  const afterNo = await clashFile();
  await (await clashFoot('Save template'))?.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.click('#modalFoot .btn.danger', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(700);
  const afterYes = await clashFile();
  const templateClash = { askedTitle, hasDanger, backTitle, keptName, afterNo, afterYes };
  await page.evaluate(async () => {
    const { api } = window.TCGForge;
    (await import('/js/ui/dialogs.js')).closeModal();
    for (const path of ['templates/smoke-clash.json', 'templates/smoke-clash.json.bak']) await api.trash(path).catch(() => {});
  });
  check('saving a template over one of the same name asks first, and No keeps the old file',
    /Replace an existing template/.test(askedTitle) && hasDanger && backTitle === 'Save as template' &&
      keptName === 'Smoke Clash' && afterNo === 'Clash Original' && afterYes === 'Clash Replacement',
    JSON.stringify(templateClash));

  /* A `/files/…` cell (a URL copied out of a saved file) was stored as the
     URL, so embedding fetched /files/files/… and quietly left the art out. */
  const filesCell = await page.evaluate(async () => {
    try {
      const { api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const c = await import('/js/core/cards.js');
      const b = await import('/js/core/batch.js');
      const p = await import('/js/core/project.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      await c.addRows([{ title: 'URL art', art: '/files/assets/backgrounds/ember.svg' }], { title: 'title', art: 'art' }, b.resolveAsset);
      const stored = c.cardList()[1]?.values.art;
      const data = await p.serializeProject({ embed: true });
      return { stored, embedded: String(data.cards[1]?.values.art).slice(0, 22) };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a /files/ cell is stored as a workspace path, so the art embeds',
    filesCell.stored === 'assets/backgrounds/ember.svg' && filesCell.embedded === 'data:image/svg+xml;bas',
    JSON.stringify(filesCell));

  /* A font file named with a quote registered its family with the quote, but
     every CSS font list writes the family without one — so the font was never
     drawn. Measured by painting a glyph only that font has. */
  const quotedFont = await page.evaluate(async () => {
    try {
      const { assets } = window.TCGForge;
      const bytes = await (await fetch('/files/assets/fonts/Forge-Icons.ttf')).arrayBuffer();
      const family = await assets.registerFontFromFile(new File([bytes], 'Smoke"Quote.ttf'));
      const css = `"${family.replace(/["\\]/g, '')}"`;
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `300px ${css}, monospace`;
      return { family, width: Math.round(ctx.measureText('\ue007').width) };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a font whose file name holds a quote is still drawn',
    quotedFont.family === 'SmokeQuote' && quotedFont.width === 291, JSON.stringify(quotedFont));

  /* New icons took the point after the highest one in use, so a neighbouring
     font with a glyph at U+F8FF left no room for any — and the build said only
     "No icons to build." without the warnings that explained it. */
  const iconRoom = await (async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const tools = path.join(root, 'tools');
    const builder = path.join(tools, 'build_icon_font.py');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-room-'));
    const fonts = path.join(scratch, 'fonts');
    const icons = path.join(scratch, 'icons');
    const broken = path.join(scratch, 'broken');
    for (const dir of [fonts, icons, broken]) fs.mkdirSync(dir);
    const neighbour = path.join(fonts, 'Vendor-Logo.ttf');
    const made = spawnSync(python, ['-c', [
      'import sys', `sys.path.insert(0, ${JSON.stringify(tools)})`, 'import build_icon_font as b',
      "g = [('.notdef', None, b.notdef_contours(), b.ADVANCE), ('space', 0x20, [], b.SPACE_ADVANCE),"
        + " ('logo', 0xF8FF, b.notdef_contours(), b.ADVANCE)]",
      `open(${JSON.stringify(neighbour)}, 'wb').write(b.build_font(g, {}))`,
    ].join('\n')], { encoding: 'utf8' });
    fs.copyFileSync(path.join(root, 'workspace', 'assets', 'icons', 'gem.svg'), path.join(icons, 'gem.svg'));
    const built = spawnSync(python, [builder, '--icons', icons, '--out', path.join(fonts, 'Mine.ttf')], { encoding: 'utf8' });
    fs.writeFileSync(path.join(broken, 'bad.svg'), '<svg');
    const empty = spawnSync(python, [builder, '--icons', broken, '--out', path.join(scratch, 'Empty.ttf')], { encoding: 'utf8' });
    return {
      neighbour: made.status, status: built.status, gem: (built.stdout.match(/U\+([0-9A-F]+)\s+\{gem\}/) || [])[1],
      emptyStatus: empty.status, said: /bad\.svg/.test(empty.stderr || ''),
    };
  })().catch((err) => ({ error: err.message }));
  check('the icon builder uses the lowest free code point, and says why when nothing builds',
    iconRoom.neighbour === 0 && iconRoom.status === 0 && iconRoom.gem === 'E000' &&
      iconRoom.emptyStatus === 1 && iconRoom.said, JSON.stringify(iconRoom));

  /* The canvas element is a whole number of screen pixels at the current
     zoom, and Fabric sized exports from it: a 750 px card at most zooms came
     out 749 px wide — a card that prints a hair narrow on every sheet. */
  const exactSize = await page.evaluate(async () => {
    try {
      const { editor, state } = window.TCGForge;
      const before = editor.zoom;
      const sizes = [];
      for (const zoom of [0.37, 0.61, 0.83]) {
        editor.setZoom(zoom);
        for (const multiplier of [1, 2]) {
          const img = new Image();
          img.src = editor.toDataURL({ multiplier, format: 'png' });
          await img.decode();
          sizes.push(`${img.naturalWidth}x${img.naturalHeight}`);
        }
      }
      editor.setZoom(before);
      return { card: `${state.card.width}x${state.card.height}`, sizes };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('an export is the card\'s own size at any zoom',
    exactSize.card === '750x1050' && exactSize.sizes?.join() === '750x1050,1500x2100,750x1050,1500x2100,750x1050,1500x2100',
    JSON.stringify(exactSize));

  /* ---- 0.14.0: bleed made from the card's edges ------------------------ */

  /* The mirror itself, pixel for pixel: every pixel of the margin is the
     pixel the same distance inside the edge, sides across one axis and
     corners across both. A source whose colour encodes its own coordinates
     makes any wrong strip, flip or offset show up. */
  const bleedMirror = await page.evaluate(async () => {
    try {
      const { mirrorBleed, bleedPixels } = await import('/js/core/bleed.js');
      const w = 40;
      const h = 20;
      const src = document.createElement('canvas');
      src.width = w;
      src.height = h;
      const sctx = src.getContext('2d');
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          sctx.fillStyle = `rgb(${x * 6},${y * 12},200)`;
          sctx.fillRect(x, y, 1, 1);
        }
      }
      const out = mirrorBleed(src, 5, 3);
      const data = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
      const fold = (i, n) => (i < 0 ? -1 - i : i >= n ? 2 * n - 1 - i : i);
      let wrong = 0;
      let first = null;
      for (let y = 0; y < out.height; y += 1) {
        for (let x = 0; x < out.width; x += 1) {
          const sx = fold(x - 5, w);
          const sy = fold(y - 3, h);
          const at = (y * out.width + x) * 4;
          if (data[at] !== sx * 6 || data[at + 1] !== sy * 12) {
            wrong += 1;
            first ??= { x, y, got: [data[at], data[at + 1]], want: [sx * 6, sy * 12] };
          }
        }
      }
      return { size: [out.width, out.height], wrong, first, px: [bleedPixels(3, 300), bleedPixels(3, 300, 2), bleedPixels(0), bleedPixels(-1)] };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('mirrored bleed copies each edge outward, sides and corners',
    bleedMirror.size?.join() === '50,26' && bleedMirror.wrong === 0 && bleedMirror.px?.join() === '35,71,0,0',
    JSON.stringify(bleedMirror));

  /* The export dialog, driven for real: 3 mm on a 750 × 1050 card at 300 dpi
     is 35 px a side, the corners come out square (no transparent pixels where
     the radius was), the margin mirrors the edge, and the trim inside is the
     card itself, not a stretched copy. */
  await page.evaluate(async () => {
    const { api, state } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    t.setFieldText('title', 'Bleed Probe');
    state.project.name = 'Smoke Bleed';
    document.activeElement?.blur?.();
  });
  await page.keyboard.press('Control+e');
  await page.waitForSelector('#exportBleed', { timeout: 5000 }).catch(() => {});
  await page.$eval('#modalBody select', (s) => { s.value = '1'; s.dispatchEvent(new Event('change')); }).catch(() => {});
  await page.fill('#exportBleed', '3').catch(() => {});
  const bleedHint = await page.$eval('#exportBleedHint', (n) => n.textContent).catch(() => '');
  for (const button of await page.$$('#modalFoot .btn')) {
    if ((await button.textContent()) === 'Export') { await button.click({ timeout: 3000 }).catch(() => {}); break; }
  }
  await page.waitForTimeout(1500);
  const bleedExport = await page.evaluate(async () => {
    try {
      const { api, editor } = window.TCGForge;
      const pixels = async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return { w: c.width, h: c.height, at: (x, y) => [...ctx.getImageData(x, y, 1, 1).data] };
      };
      const out = await pixels(`${api.fileURL('exports/smoke-bleed.png')}?t=${Date.now()}`);
      const trim = await pixels(editor.toDataURL({ multiplier: 1, format: 'png', squareCorners: true }));
      const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
      const mid = 500;
      let mirrored = true;
      for (let k = 0; k < 6; k += 1) {
        if (!same(out.at(34 - k, mid), out.at(35 + k, mid))) mirrored = false;
        if (!same(out.at(mid, 34 - k), out.at(mid, 35 + k))) mirrored = false;
      }
      let inside = true;
      for (const [x, y] of [[0, 0], [375, 525], [749, 1049], [10, 600], [700, 40]]) {
        if (!same(out.at(x + 35, y + 35), trim.at(x, y))) inside = false;
      }
      await api.trash('exports/smoke-bleed.png').catch(() => {});
      return { size: [out.w, out.h], corner: out.at(2, 2)[3], innerCorner: out.at(36, 36)[3], mirrored, inside };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('Export with bleed writes a larger, square-cornered card with its edges mirrored out',
    /35 px/.test(bleedHint) && /820 × 1120/.test(bleedHint) && bleedExport.size?.join() === '820,1120' &&
      bleedExport.corner === 255 && bleedExport.innerCorner === 255 && bleedExport.mirrored && bleedExport.inside,
    JSON.stringify({ bleedHint, ...bleedExport }));

  /* Every card, and a batch preview through the batch dialog's own box: the
     bleed reaches runBatch() for both. */
  const bleedCards = await page.evaluate(async () => {
    try {
      const { api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const c = await import('/js/core/cards.js');
      t.setFieldText('title', 'Bleed One');
      await c.addCard();
      t.setFieldText('title', 'Bleed Two');
      const result = await c.exportCards({ multiplier: 1, bleedMm: 3 });
      const sizes = [];
      for (const card of result.rendered) {
        const img = new Image();
        img.src = `${api.fileURL(card.path)}?t=${Date.now()}`;
        await img.decode();
        sizes.push(`${img.naturalWidth}x${img.naturalHeight}`);
      }
      for (const card of result.rendered) await api.trash(card.path).catch(() => {});
      if (result.deckPath) await api.trash(result.deckPath).catch(() => {});
      return { sizes, failed: result.failed.length };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.keyboard.press('Control+b');
  await page.waitForSelector('#batchBleed', { timeout: 5000 }).catch(() => {});
  await page.selectOption('#batchWorkspaceFile', 'batch/sample-set.csv').catch(() => {});
  await page.click('#batchOpenFile', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  const rememberedBleed = await page.inputValue('#batchBleed').catch(() => '');
  await page.fill('#batchBleed', '2').catch(() => {});
  await page.click('#batchPreview', { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('.batch-preview img')?.complete, null, { timeout: 15000 }).catch(() => {});
  const previewSize = await page.$eval('.batch-preview img', (img) => `${img.naturalWidth}x${img.naturalHeight}`).catch(() => '');
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  check('every-card export and the batch preview carry the bleed too',
    bleedCards.sizes?.join() === '820x1120,820x1120' && bleedCards.failed === 0 &&
      rememberedBleed === '3' && previewSize === '798x1098',
    JSON.stringify({ ...bleedCards, rememberedBleed, previewSize }));

  /* The print sheet makes the bleed from a trim-size image instead of
     stretching it over the bleed. A card with a 4 px green band down its left
     edge, laid out 1:1: two pixels inside the trim are still green when
     mirrored, red when stretched (the band was pushed out into the bleed). */
  const bleedSheet = await page.evaluate(async () => {
    try {
      const ps = await import('/js/core/printSheet.js');
      const card = document.createElement('canvas');
      card.width = 100;
      card.height = 140;
      const cctx = card.getContext('2d');
      cctx.fillStyle = '#ff0000';
      cctx.fillRect(0, 0, 100, 140);
      cctx.fillStyle = '#00ff00';
      cctx.fillRect(0, 0, 4, 140);
      const url = card.toDataURL('image/png');
      const plan = ps.planSheet({ cardWidth: 100, cardHeight: 140, cardDpi: 100, dpi: 100, page: 'a4', marginMm: 6, bleedMm: 0.762 });
      const sample = async (mirror) => {
        const [page] = await ps.buildSheets([url], plan, { guides: 'none', mirror });
        const ctx = page.canvas.getContext('2d');
        const s = plan.slots[0];
        const at = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3).join();
        return { inside: at(s.left + 2, s.top + 70), outside: at(s.left - 2, s.top + 70), corner: at(s.left - 2, s.top - 2) };
      };
      return { bleed: plan.bleed, mirror: await sample(true), stretch: await sample(false) };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('a print sheet mirrors bleed out of trim-size cards rather than stretching them',
    Math.abs(bleedSheet.bleed - 3) < 1e-6 && bleedSheet.mirror?.inside === '0,255,0' && bleedSheet.mirror.outside === '0,255,0' &&
      bleedSheet.mirror.corner === '0,255,0' && bleedSheet.stretch?.inside === '255,0,0',
    JSON.stringify(bleedSheet));

  /* And the print dialog uses it: its preview of the current card with 3 mm
     bleed is compared with the two ways the same page could be built. */
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+p');
  await page.waitForSelector('#printBleedFrom', { timeout: 5000 }).catch(() => {});
  const bleedDefault = await page.inputValue('#printBleedFrom').catch(() => '');
  await page.selectOption('#printSource', 'card').catch(() => {});
  await page.fill('#printBleed', '3').catch(() => {});
  await page.$eval('#printPageLabels', (n) => { n.checked = false; n.dispatchEvent(new Event('change')); }).catch(() => {});
  for (const button of await page.$$('#modalFoot .btn')) {
    if ((await button.textContent()) === 'Preview') { await button.click({ timeout: 3000 }).catch(() => {}); break; }
  }
  await page.waitForFunction(() => /showing page 1/.test(document.getElementById('printStatus')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const bleedDialog = await page.evaluate(async () => {
    try {
      const { editor, state } = window.TCGForge;
      const ps = await import('/js/core/printSheet.js');
      const shown = document.querySelector('#modalBody .batch-preview img');
      if (!shown) return { error: 'no preview' };
      await shown.decode();
      const plan = ps.planSheet({
        cardWidth: state.card.width, cardHeight: state.card.height, cardDpi: state.card.dpi || 300,
        page: document.getElementById('printPage')?.value || 'a4', dpi: 300, marginMm: 6, bleedMm: 3,
      });
      const count = plan.perPage;
      const build = async (mirror) => {
        const url = editor.toDataURL({ multiplier: 1, format: 'png', squareCorners: mirror });
        const [first] = await ps.buildSheets(Array.from({ length: Math.min(count, 9) }, () => url), plan, { guides: 'crop', mirror });
        return first.canvas;
      };
      const small = (source) => {
        const c = document.createElement('canvas');
        c.width = 200;
        c.height = 283;
        const ctx = c.getContext('2d');
        ctx.drawImage(source, 0, 0, c.width, c.height);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const seen = small(shown);
      const diff = (canvas) => {
        const d = small(canvas);
        let total = 0;
        for (let i = 0; i < d.length; i += 4) total += Math.abs(d[i] - seen[i]) + Math.abs(d[i + 1] - seen[i + 1]) + Math.abs(d[i + 2] - seen[i + 2]);
        return Math.round(total / (d.length / 4));
      };
      return { mirrorDiff: diff(await build(true)), stretchDiff: diff(await build(false)) };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.evaluate(async () => {
    (await import('/js/ui/dialogs.js')).closeModal();
    window.TCGForge.state.set('lastExportBleed', 0);
  });
  check('the print dialog mirrors bleed by default',
    bleedDefault === 'mirror' && bleedDialog.mirrorDiff * 2 < bleedDialog.stretchDiff,
    JSON.stringify({ bleedDefault, ...bleedDialog }));

  /* ---- 0.15.0: bug guards ---------------------------------------------- */

  /* Opening a template or a project while a card switch is still loading its
     art: the switch used to finish into the new canvas, so the template (or
     the project just opened) showed the outgoing card's words and picture,
     marked saved. The art is slowed so the switch is still in flight. */
  const switchSetup = async () => page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      editor.findBySlot('title')[0].set({ text: 'Alpha' });
      editor.touch();
      await cards.addCard();
      const { setFieldImage, setFieldText } = t;
      setFieldText('title', 'Bravo');
      await setFieldImage('art', api.fileURL('assets/backgrounds/ember.svg'), { assetPath: 'assets/backgrounds/ember.svg' });
      await cards.switchCard(0);
      state.setDirty(false);
      return { ok: cards.cardList().length === 2 };
    } catch (err) {
      return { error: err.message };
    }
  });
  const slowEmber = async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {});
  };
  const midSwitch = async (open) => {
    await page.route('**/files/assets/backgrounds/ember.svg*', slowEmber);
    const result = await page.evaluate(async (open) => {
      try {
        const { state, api, editor } = window.TCGForge;
        const strip = await import('/js/ui/cardStrip.js');
        const t = await import('/js/core/templates.js');
        const project = await import('/js/core/project.js');
        const stepping = strip.stepCard(1);
        await new Promise((r) => setTimeout(r, 150));
        if (open === 'template') await t.applyTemplate(await api.readJSON('templates/minimal-modern.json'));
        else await project.openProjectPath('projects/smoke-other-set.json');
        await stepping;
        await new Promise((r) => setTimeout(r, 300));
        return {
          title: editor.findBySlot('title')[0]?.text,
          art: editor.findBySlot('art').map((o) => o.tcgAsset || o.type),
          dirty: state.dirty,
          path: state.project.path,
        };
      } catch (err) {
        return { error: err.message };
      }
    }, open);
    await page.unroute('**/files/assets/backgrounds/ember.svg*', slowEmber);
    return result;
  };
  const otherSet = await page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const project = await import('/js/core/project.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      editor.findBySlot('title')[0].set({ text: 'Other card' });
      editor.touch();
      state.project.name = 'Smoke Other Set';
      await project.saveProject({ path: 'projects/smoke-other-set.json' });
      return { saved: true };
    } catch (err) {
      return { error: err.message };
    }
  });
  await switchSetup();
  const switchTpl = await midSwitch('template');
  check('loading a template during a card switch shows the template, not the card being left',
    switchTpl.title !== 'Bravo' && !String(switchTpl.title).includes('Alpha') &&
      !(switchTpl.art || []).includes('assets/backgrounds/ember.svg') && switchTpl.path === null,
    JSON.stringify(switchTpl));
  await switchSetup();
  const switchOpen = await midSwitch('project');
  check('opening a project during a card switch shows that project\'s card',
    otherSet.saved && switchOpen.title === 'Other card' &&
      !(switchOpen.art || []).includes('assets/backgrounds/ember.svg') &&
      switchOpen.path === 'projects/smoke-other-set.json',
    JSON.stringify({ otherSet, ...switchOpen }));
  await page.evaluate(() => window.TCGForge.api.trash('projects/smoke-other-set.json').catch(() => {}));

  /* Ctrl+C / Ctrl+V of a field layer kept its slot (Ctrl+D did not), so two
     layers held one slot and the copy carried the first card's words or art
     onto every card. */
  const pasteSlot = await page.evaluate(async () => {
    try {
      const { api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      editor.select([editor.findBySlot('title')[0]]);
      document.activeElement?.blur?.();
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(300);
  Object.assign(pasteSlot, await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const pasted = editor.active();
    return {
      titles: editor.findBySlot('title').length,
      pastedSlot: pasted?.tcgSlot ?? null,
      pastedText: pasted?.text ?? null,
      layers: editor.objects().length,
    };
  }));
  check('a pasted field layer is a plain layer, not a second home for the slot',
    pasteSlot.titles === 1 && pasteSlot.pastedSlot === null && !!pasteSlot.pastedText,
    JSON.stringify(pasteSlot));

  /* Grouping field layers took them out of the slot system (it looks at
     top-level layers), and the next card switch saved the card without its
     words and left them over the next card. Grouping them is refused with a
     reason; grouping other layers still works. */
  const groupSlots = await page.evaluate(async () => {
    try {
      const { api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      editor.select([editor.findBySlot('title')[0], editor.findBySlot('rules')[0]]);
      document.activeElement?.blur?.();
      return { before: editor.objects().length };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(200);
  Object.assign(groupSlots, await page.evaluate(() => {
    const { editor } = window.TCGForge;
    const plain = editor.objects().filter((o) => !o.tcgSlot && !o.tcgShowIf && !o.lockMovementX).slice(0, 2);
    const result = {
      after: editor.objects().length,
      groups: editor.objects().filter((o) => o.type === 'group').length,
      title: editor.findBySlot('title').length,
      rules: editor.findBySlot('rules').length,
      fields: document.querySelectorAll('#fieldForm [data-icon-target]').length,
      toast: Array.from(document.querySelectorAll('#toasts .toast')).map((n) => n.textContent).pop() || '',
      plain: plain.length,
    };
    editor.select(plain);
    document.activeElement?.blur?.();
    return result;
  }));
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(200);
  groupSlots.plainGrouped = await page.evaluate(() =>
    window.TCGForge.editor.objects().filter((o) => o.type === 'group').length);
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(200);
  check('field layers cannot be grouped out of the slot system, other layers still can',
    groupSlots.after === groupSlots.before && groupSlots.groups === 0 && groupSlots.title === 1 &&
      groupSlots.rules === 1 && groupSlots.fields >= 2 && /cannot go in a group/.test(groupSlots.toast) &&
      groupSlots.plain === 2 && groupSlots.plainGrouped === 1,
    JSON.stringify(groupSlots));

  /* Long batch names: the server cut the whole name at 120 characters, so
     the ".png" went, and with it the "-2" that kept two cards apart. */
  const longNames = await page.evaluate(async () => {
    try {
      const { api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const long = 'When this creature enters the battlefield draw two cards then discard a card unless you control another creature';
      const rows = [
        { title: 'Long One', rules: `${long} with flying` },
        { title: 'Long One', rules: `${long} with flying, it gains haste` },
        { title: 'Short', rules: 'x' },
      ];
      const res = await batch.runBatch({
        rows,
        mapping: { title: 'title', rules: 'rules' },
        options: { pattern: '{title}-{rules}', subfolder: 'smoke-long', multiplier: 0.2 },
      });
      const direct = await api.exportImage({
        filename: `${'a'.repeat(140)}.png`,
        dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
        folder: 'smoke-long',
        overwrite: true,
      });
      const listed = await api.request('/api/list?path=exports/smoke-long');
      return {
        rendered: (res.rendered || []).length,
        files: (listed.entries || []).map((f) => f.name).filter((n) => n !== 'deck.json'),
        direct: direct.path,
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  check('long batch file names keep their extension and stay apart',
    longNames.rendered === 3 && longNames.files?.length === 4 &&
      longNames.files.every((n) => /\.png$/.test(n)) && /\/a{100,116}\.png$/.test(longNames.direct || ''),
    JSON.stringify(longNames));
  await page.evaluate(() => window.TCGForge.api.trash('exports/smoke-long').catch(() => {}));

  /* A POST outside /api/ was answered without its body being read, so the
     body was then parsed as a second request on the same connection. */
  const smuggled = await new Promise((resolve) => {
    const url = new URL(BASE);
    const inner = `GET /api/status HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`;
    const badLength = `POST /api/write HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: 1x\r\n\r\n${inner}`;
    const results = [];
    for (const head of [
      `POST /index.html HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: ${inner.length}\r\n\r\n${inner}`,
      badLength,
    ]) {
      results.push(new Promise((done) => {
        let text = '';
        const socket = net.connect(Number(url.port), url.hostname, () => socket.write(head));
        socket.setTimeout(2500, () => socket.destroy());
        socket.on('data', (chunk) => { text += chunk; });
        // Not anchored to a line: a second response starts straight after the
        // first one's body.
        socket.on('close', () => done((text.match(/HTTP\/1\.[01] \d{3}/g) || []).join(', ')));
        socket.on('error', () => done(text));
      }));
    }
    Promise.all(results).then(resolve);
  });
  check('a POST body the server does not read is never answered as a second request',
    /^HTTP\/1\.[01] 404$/.test(smuggled[0]) && /^HTTP\/1\.[01] 400$/.test(smuggled[1]),
    JSON.stringify(smuggled));

  /* ---- 0.15.0: filtering the card strip --------------------------------- */

  /* The parser: words, "quoted words", field:words, #number, and a prefix
     that names no field kept as text. */
  const filterParse = await page.evaluate(async () => {
    const cards = await import('/js/core/cards.js');
    const terms = cards.parseFilter('title:"Ember Wyrm" FIRE 10:30 #12 nope:"a b"', new Set(['title', 'rules']));
    const values = { title: 'Ember Wyrm', rules: 'Deals 2 \ue005 damage', art: 'data:image/png;base64,QUFBemJ' };
    return {
      terms,
      fieldOnly: cards.cardMatches(values, cards.parseFilter('rules:wyrm', new Set(['rules'])), 1),
      anywhere: cards.cardMatches(values, cards.parseFilter('wyrm deals', new Set()), 1),
      number: [cards.cardMatches(values, cards.parseFilter('#3'), 3), cards.cardMatches(values, cards.parseFilter('#3'), 4)],
      dataUrl: cards.cardMatches(values, cards.parseFilter('azb'), 1),
    };
  });
  check('the card filter reads words, quotes, field:words and #number',
    JSON.stringify(filterParse.terms) === JSON.stringify([
      { slot: 'title', text: 'ember wyrm' }, { slot: null, text: 'fire' }, { slot: null, text: '10:30' },
      { number: 12 }, { slot: null, text: 'nope:a b' },
    ]) && filterParse.fieldOnly === false && filterParse.anywhere === true &&
      filterParse.number.join() === 'true,false' && filterParse.dataUrl === false,
    JSON.stringify(filterParse));

  /* The real box over the six sample cards: it narrows the tiles, the card on
     screen stays (faded) when it does not match, Page Down and the › button
     step through the matches only, Enter wraps like a find, field:words and
     {icon} work, the card on screen is matched by what it shows now, Escape
     clears, and none of it touches the project. */
  const filterSetup = await page.evaluate(async () => {
    try {
      const { state, api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const text = (await api.request('/api/read?path=batch/sample-set.csv')).content;
      const table = batch.parseAny(text, 'sample-set.csv');
      const mapping = Object.fromEntries(table.columns.map((c) => [c, cards.slotKinds().has(c) ? c : '-']));
      await cards.addRows(table.rows, mapping, batch.resolveAsset);
      await cards.removeCard(0);
      await cards.switchCard(0);
      state.setDirty(false);
      return { ids: cards.cardList().map((c) => c.id) };
    } catch (err) {
      return { error: err.message };
    }
  });
  const stripState = () => page.evaluate(() => ({
    tiles: Array.from(document.querySelectorAll('#cardTiles .card-tile')).map((n) =>
      `${n.querySelector('.tile-label').textContent.split('.')[0]}${n.classList.contains('no-match') ? '~' : ''}`).join(' '),
    count: document.querySelector('#cardFilterCount').textContent,
    active: window.TCGForge.state.project.activeCard,
    prev: document.querySelector('[data-card-action="prev"]').disabled,
    next: document.querySelector('[data-card-action="next"]').disabled,
  }));
  const filterUi = {};
  await page.fill('#cardFilter', 'flying');
  filterUi.flying = await stripState();
  await page.click('#canvasScroll', { position: { x: 5, y: 5 } });
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(700);
  filterUi.pageDown = await stripState();
  await page.click('#cardFilter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  filterUi.enterWraps = await stripState();
  await page.fill('#cardFilter', 'rules:{element-fire}');
  filterUi.fieldIcon = await stripState();
  await page.fill('#cardFilter', 'art:starfield');
  filterUi.art = await stripState();
  await page.click('[data-card-action="next"]', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(700);
  filterUi.nextButton = await stripState();
  await page.fill('#cardFilter', 'type:sorcery #5');
  filterUi.scoped = await stripState();
  // The card on screen is matched by what it shows, not by its stale record.
  await page.fill('#ff_title', 'Zebra Herald');
  await page.fill('#cardFilter', 'zebra');
  filterUi.live = await stripState();
  await page.fill('#cardFilter', 'nothing-matches-this');
  filterUi.none = await stripState();
  filterUi.emptyNote = await page.$eval('#cardTiles', (n) => n.querySelector('.strip-empty')?.textContent || '');
  await page.focus('#cardFilter');
  await page.keyboard.press('Escape');
  filterUi.cleared = await stripState();
  filterUi.clearedBox = await page.$eval('#cardFilter', (n) => n.value);
  await page.click('#canvasScroll', { position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  filterUi.slashFocus = await page.evaluate(() => document.activeElement?.id);
  filterUi.project = await page.evaluate(async () => {
    const cards = await import('/js/core/cards.js');
    return { cards: cards.cardList().length, order: cards.cardList().map((c) => c.id).join('|') };
  });
  check('the strip filter narrows the tiles and the card on screen stays, faded',
    filterUi.flying.tiles === '1 3' && filterUi.flying.count === '2 of 6 match' &&
      filterUi.fieldIcon.tiles === '1 5' && filterUi.fieldIcon.count === '2 of 6 match' &&
      filterUi.art.tiles === '1~ 3 6',
    JSON.stringify({ flying: filterUi.flying, fieldIcon: filterUi.fieldIcon }));
  check('Page Down, the next button and Enter step through the matching cards only',
    filterUi.pageDown.active === 2 && filterUi.pageDown.next === true && filterUi.pageDown.prev === false &&
      filterUi.enterWraps.active === 0 &&
      filterUi.nextButton.active === 2,
    JSON.stringify({ pageDown: filterUi.pageDown, enterWraps: filterUi.enterWraps, art: filterUi.art, next: filterUi.nextButton }));
  check('the strip filter searches one field, a card number and the card on screen as it is now',
    filterUi.scoped.tiles === '3~ 5' && filterUi.scoped.count === '1 of 6 match' &&
      filterUi.live.tiles === '3' && filterUi.live.count === '1 of 6 match' &&
      filterUi.none.count === '0 of 6 match' && /No card matches/.test(filterUi.emptyNote),
    JSON.stringify({ scoped: filterUi.scoped, live: filterUi.live, none: filterUi.none, note: filterUi.emptyNote }));
  check('Escape clears the filter, / comes back to it, and the project is untouched',
    filterUi.cleared.tiles === '1 2 3 4 5 6' && filterUi.cleared.count === '' && filterUi.clearedBox === '' &&
      filterUi.slashFocus === 'cardFilter' && filterUi.project.cards === 6 &&
      filterUi.project.order === (filterSetup.ids || []).join('|'),
    JSON.stringify({ cleared: filterUi.cleared, slash: filterUi.slashFocus, project: filterUi.project }));
  await page.evaluate(async () => (await import('/js/ui/cardStrip.js')).clearFilter());
  await page.evaluate(() => document.activeElement?.blur?.());

  /* ---- 0.16.0: nothing borrows or replaces the canvas mid-switch ------- */

  /* Two cards — Alpha with no art, Beta with ember — and ember slowed so a
     switch to Beta is still drawing for ~1.2 s. Each guard starts a switch
     without awaiting it, then does the thing that used to read the half-drawn
     canvas. */
  const switchTwo = async () => page.evaluate(async () => {
    try {
      const { state, api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      t.setFieldText('title', 'Alpha');
      await t.clearFieldImage('art');
      const list = cards.cardList();
      list.push({ id: 'card-beta', values: { title: 'Beta', art: 'assets/backgrounds/ember.svg' } });
      cards.syncActive();
      state.project.name = 'Smoke Switch';
      state.setDirty(false);
      return { cards: list.length };
    } catch (err) {
      return { error: err.message };
    }
  });
  const slowEmberRoute = '**/files/assets/backgrounds/ember.svg';
  await page.route(slowEmberRoute, async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    route.continue().catch(() => {});
  });
  /* Records the title and art each render saw; `stop()` puts toDataURL back. */
  const watchRenders = () => page.evaluate(() => {
    const { editor } = window.TCGForge;
    const original = editor.toDataURL;
    window.__smokeRenders = [];
    editor.toDataURL = function watched(options) {
      const art = editor.findBySlot('art')[0];
      window.__smokeRenders.push(`${editor.findBySlot('title')[0]?.text}/${art?.tcgAsset ? 'ember' : 'none'}`);
      return original.call(editor, options);
    };
    window.__smokeStopRenders = () => { editor.toDataURL = original; };
  });
  const onScreen = () => page.evaluate(() => {
    const { editor, state } = window.TCGForge;
    const art = editor.findBySlot('art')[0];
    return {
      active: state.project.activeCard,
      shown: `${editor.findBySlot('title')[0]?.text}/${art?.tcgAsset ? 'ember' : 'none'}`,
      records: (state.project.cards || []).map((c) => `${c.values.title}/${c.values.art ? 'ember' : 'none'}`).join(' '),
      dirty: state.dirty,
    };
  });

  await switchTwo();
  const newMidSwitch = await page.evaluate(async () => {
    try {
      const cards = await import('/js/core/cards.js');
      const p = await import('/js/core/project.js');
      const { editor, state } = window.TCGForge;
      const sw = cards.switchCard(1);
      await new Promise((r) => setTimeout(r, 120));
      await p.newProject({});
      await sw;
      await cards.settled();
      return {
        layers: editor.objects().map((o) => o.tcgSlot || o.type),
        cards: state.project.cards ? state.project.cards.length : null,
        dirty: state.dirty,
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  check(
    'New during a card switch gives a blank card, not the last project\'s art',
    newMidSwitch.layers?.length === 0 && newMidSwitch.dirty === false,
    JSON.stringify(newMidSwitch)
  );

  await switchTwo();
  await watchRenders();
  const exportMidSwitch = await page.evaluate(async () => {
    try {
      const cards = await import('/js/core/cards.js');
      const p = await import('/js/core/project.js');
      const sw = cards.switchCard(1);
      await new Promise((r) => setTimeout(r, 120));
      const res = await p.exportImage({ multiplier: 0.2, filename: 'smoke-midswitch.png' });
      await sw;
      await window.TCGForge.api.trash(res.path).catch(() => {});
      return { renders: window.__smokeRenders.slice() };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.evaluate(() => window.__smokeStopRenders?.());
  check(
    'exporting during a card switch draws the card being switched to',
    exportMidSwitch.renders?.join() === 'Beta/ember',
    JSON.stringify(exportMidSwitch)
  );

  await switchTwo();
  await watchRenders();
  const everyMidSwitch = await page.evaluate(async () => {
    try {
      const cards = await import('/js/core/cards.js');
      const sw = cards.switchCard(1);
      await new Promise((r) => setTimeout(r, 120));
      const res = await cards.exportCards({ multiplier: 0.2 });
      await sw;
      const folder = res.rendered[0]?.path?.split('/').slice(0, -1).join('/');
      if (folder) await window.TCGForge.api.trash(folder).catch(() => {});
      return { renders: window.__smokeRenders.slice(), folder };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.evaluate(() => window.__smokeStopRenders?.());
  const everyAfter = await onScreen();
  await page.evaluate(async () => {
    const cards = await import('/js/core/cards.js');
    await cards.switchCard(0);
  });
  const everyBack = await onScreen();
  check(
    'every card exported during a switch: each drawn as itself, and no card overwritten',
    everyMidSwitch.renders?.join() === 'Alpha/none,Beta/ember' &&
      everyAfter.active === 1 && everyAfter.shown === 'Beta/ember' &&
      everyBack.records === 'Alpha/none Beta/ember',
    JSON.stringify({ everyMidSwitch, everyAfter, everyBack })
  );

  await switchTwo();
  const previewMidSwitch = await page.evaluate(async () => {
    try {
      const cards = await import('/js/core/cards.js');
      const batch = await import('/js/core/batch.js');
      const sw = cards.switchCard(1);
      await new Promise((r) => setTimeout(r, 120));
      await batch.renderRow({ title: 'Row One' }, { title: 'title' }, { multiplier: 0.2 });
      await sw;
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });
  const previewAfter = await onScreen();
  await page.evaluate(async () => {
    const cards = await import('/js/core/cards.js');
    await cards.switchCard(0);
  });
  const previewBack = await onScreen();
  check(
    'a batch preview during a switch leaves the card on screen and both records as they were',
    !previewMidSwitch.error && previewAfter.active === 1 && previewAfter.shown === 'Beta/ember' &&
      previewBack.records === 'Alpha/none Beta/ember',
    JSON.stringify({ previewMidSwitch, previewAfter, previewBack })
  );

  /* Real keys into Card Fields while the switch draws: refused, rather than
     landing on the card being left and vanishing a moment later. The art is
     held until the keys are in, so the switch is still drawing however slowly
     the clicks and keys arrive — a fixed delay let a slow runner finish the
     switch first and type into the new card, which proved nothing. Beta's
     art is a picture this page has never loaded, so no browser cache can
     hand it over without the held request. */
  await switchTwo();
  const heldArt = `assets/art/smoke-held-${Date.now()}.svg`;
  await page.evaluate(async (path) => {
    const { api, state } = window.TCGForge;
    await api.writeText(path, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0f0"/></svg>');
    state.project.cards[1].values.art = path;
  }, heldArt);
  let releaseHeld = () => {};
  const heldGate = new Promise((resolve) => { releaseHeld = resolve; });
  const heldRoute = `**/files/${heldArt}`;
  await page.route(heldRoute, async (route) => {
    await heldGate;
    route.continue().catch(() => {});
  });
  await page.waitForTimeout(400);
  await page.click('[data-card-action="next"]', { timeout: 3000 }).catch(() => {});
  let typedMidSwitch = false;
  for (let i = 0; i < 30 && !typedMidSwitch; i += 1) {
    await page.waitForTimeout(100);
    typedMidSwitch = await page.evaluate(() => {
      const { state, editor } = window.TCGForge;
      return state.project.activeCard === 1 && editor.findBySlot('title')[0]?.text === 'Alpha';
    });
  }
  await page.click('#ff_title', { timeout: 3000 }).catch(() => {});
  await page.keyboard.press('End');
  await page.keyboard.type('Typed');
  const typedDuring = await page.evaluate(() => ({
    box: document.querySelector('#ff_title')?.value,
    canvas: window.TCGForge.editor.findBySlot('title')[0]?.text,
    // Beta's art is still held, so the switch cannot have finished.
    stillSwitching: window.TCGForge.state.project.activeCard === 1 &&
      !window.TCGForge.editor.findBySlot('art')[0]?.tcgAsset,
  }));
  releaseHeld();
  await page.evaluate(async () => (await import('/js/core/cards.js')).settled());
  await page.waitForTimeout(100);
  const typedAfter = await page.evaluate(() => ({
    box: document.querySelector('#ff_title')?.value,
    canvas: window.TCGForge.editor.findBySlot('title')[0]?.text,
    records: (window.TCGForge.state.project.cards || []).map((c) => c.values.title).join(' '),
  }));
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.unroute(heldRoute);
  await page.evaluate((path) => window.TCGForge.api.trash(path).catch(() => {}), heldArt);
  check(
    'typing into Card Fields during a switch is held, and the box then shows the new card',
    typedMidSwitch && typedDuring.stillSwitching &&
      !/Typed/.test(typedDuring.canvas || '') && !/Typed/.test(typedDuring.box || '') &&
      typedAfter.box === 'Beta' && typedAfter.canvas === 'Beta' && typedAfter.records === 'Alpha Beta',
    JSON.stringify({ typedMidSwitch, typedDuring, typedAfter })
  );
  await page.unroute(slowEmberRoute);

  /* A subfolder with a slash: images, deck list and per-card projects all in
     one folder, and the status names that folder. */
  const subfolderRun = await page.evaluate(async () => {
    try {
      const { api } = window.TCGForge;
      const batch = await import('/js/core/batch.js');
      const res = await batch.runBatch({
        rows: [{ title: 'Sub One', qty: '2' }, { title: 'Sub Two', qty: '1' }],
        mapping: { title: 'title' },
        options: { multiplier: 0.2, subfolder: 'Smoke Sub/2', saveProjects: true, qtyColumn: 'qty' },
      });
      const list = async (path) => ((await api.request(`/api/list?path=${encodeURIComponent(path)}`).catch(() => ({}))).entries || [])
        .map((e) => e.name).sort().join(',');
      const out = {
        folder: res.folder,
        deckPath: res.deckPath,
        images: await list('exports/smoke-sub-2'),
        projects: await list('projects/smoke-sub-2'),
        stray: await list('exports/2'),
      };
      for (const path of ['exports/smoke-sub-2', 'projects/smoke-sub-2', 'exports/2']) await api.trash(path).catch(() => {});
      return out;
    } catch (err) {
      return { error: err.message };
    }
  });
  check(
    'a batch subfolder is one folder for images, deck list and projects',
    subfolderRun.folder === 'smoke-sub-2' &&
      subfolderRun.images === '001-sub-one.png,002-sub-two.png,deck.json' &&
      subfolderRun.projects === '001-sub-one.json,002-sub-two.json' &&
      subfolderRun.deckPath === 'exports/smoke-sub-2/deck.json' && subfolderRun.stray === '',
    JSON.stringify(subfolderRun)
  );

  /* The card on screen names art that will not load; a batch row with a blank
     art cell must not be saved with that card's missing picture. */
  const lostArtRow = await page.evaluate(async () => {
    try {
      const { api, state } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      const batch = await import('/js/core/batch.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      cards.cardList().push({ id: 'card-gone', values: { title: 'Gone', art: 'assets/art/smoke-not-there.png' } });
      const missing = await cards.switchCard(1);
      await batch.runBatch({
        rows: [{ title: 'No Art Row', art: '' }],
        mapping: { title: 'title', art: 'art' },
        options: { multiplier: 0.2, subfolder: 'smoke-lost-art', saveProjects: true },
      });
      const saved = await api.readJSON('projects/smoke-lost-art/001-no-art-row.json').catch(() => null);
      const kept = cards.cardList()[1].values.art;
      for (const path of ['exports/smoke-lost-art', 'projects/smoke-lost-art']) await api.trash(path).catch(() => {});
      state.setDirty(false);
      return { missing, savedArt: saved ? saved.cards[0].values.art : 'unread', kept: cards.captureValues().art || kept };
    } catch (err) {
      return { error: err.message };
    }
  });
  check(
    'a batch row\'s project file does not inherit art the card on screen could not load',
    lostArtRow.missing?.length === 1 && lostArtRow.savedArt === null &&
      lostArtRow.kept === 'assets/art/smoke-not-there.png',
    JSON.stringify(lostArtRow)
  );

  /* ---- 0.16.0: tabletop deck sheets ------------------------------------ */

  const tabletopPlan = await page.evaluate(async () => {
    try {
      const tt = await import('/js/core/tabletop.js');
      const one = tt.planTabletop({ count: 69, cardWidth: 750, cardHeight: 1050 });
      const two = tt.planTabletop({ count: 70, cardWidth: 750, cardHeight: 1050 });
      const six = tt.planTabletop({ count: 6, cardWidth: 750, cardHeight: 1050 });
      const tiny = tt.planTabletop({ count: 1, cardWidth: 750, cardHeight: 1050 });
      let refused = '';
      try { tt.planTabletop({ count: 0, cardWidth: 750, cardHeight: 1050 }); } catch (err) { refused = err.message; }
      const grid = (p) => p.sheets.map((s) => `${s.columns}x${s.rows}:${s.number}@${s.hiddenSlot}`).join(' ');
      return {
        one: grid(one), oneCell: `${one.cell.width}x${one.cell.height}`, oneSheet: `${one.sheets[0].width}x${one.sheets[0].height}`,
        two: grid(two), twoCell: `${two.cell.width}x${two.cell.height}`,
        six: grid(six), sixCell: `${six.cell.width}x${six.cell.height}`,
        tiny: grid(tiny),
        refused,
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  check(
    'a tabletop deck is cut into sheets of at most 69 cards, within 4096 px, last slot kept',
    tabletopPlan.one === '10x7:69@69' && tabletopPlan.oneCell === '409x573' && tabletopPlan.oneSheet === '4090x4011' &&
      tabletopPlan.two === '10x7:69@69 2x2:1@3' && tabletopPlan.twoCell === '409x573' &&
      tabletopPlan.six === '4x2:6@7' && tabletopPlan.sixCell === '750x1050' &&
      tabletopPlan.tiny === '2x2:1@3' && /no cards/.test(tabletopPlan.refused),
    JSON.stringify(tabletopPlan)
  );

  /* Paint a sheet from flat colours and read every slot back: faces in order
     (copies repeated), empty slots left black, the back in the last slot. */
  const tabletopPaint = await page.evaluate(async () => {
    try {
      const tt = await import('/js/core/tabletop.js');
      const swatch = (colour) => {
        const c = document.createElement('canvas');
        c.width = 50; c.height = 70;
        const ctx = c.getContext('2d');
        ctx.fillStyle = colour; ctx.fillRect(0, 0, 50, 70);
        return c.toDataURL('image/png');
      };
      const red = swatch('#ff0000');
      const green = swatch('#00ff00');
      const blue = swatch('#0000ff');
      const built = await tt.buildTabletopSheets([red, green, green, blue], { back: swatch('#ff00ff') });
      const sheet = built.sheets[0];
      const ctx = sheet.canvas.getContext('2d');
      const slots = [];
      for (let i = 0; i < sheet.columns * sheet.rows; i += 1) {
        const r = tt.slotRect(sheet, built.cell, i);
        const [R, G, B] = ctx.getImageData(r.left + r.width / 2, r.top + r.height / 2, 1, 1).data;
        slots.push(`${R > 128 ? 1 : 0}${G > 128 ? 1 : 0}${B > 128 ? 1 : 0}`);
      }
      return { grid: `${sheet.columns}x${sheet.rows}`, size: `${sheet.canvas.width}x${sheet.canvas.height}`, slots: slots.join(' ') };
    } catch (err) {
      return { error: err.message };
    }
  });
  check(
    'a tabletop sheet holds each face in order, its copies, and the back in the last slot',
    tabletopPaint.grid === '3x2' && tabletopPaint.size === '150x140' &&
      tabletopPaint.slots === '100 010 010 001 000 101',
    JSON.stringify(tabletopPaint)
  );

  /* The real dialog over a project of six sample cards, one of them three
     copies, with a back: the sheet, the back and the manifest are written,
     the faces are the cards in strip order, and the project is untouched. */
  const tabletopSetup = await page.evaluate(async () => {
    try {
      const { state, api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const batch = await import('/js/core/batch.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      const text = (await api.request('/api/read?path=batch/sample-set.csv')).content;
      const table = batch.parseAny(text, 'sample-set.csv');
      const mapping = Object.fromEntries(table.columns.map((c) => [c, cards.slotKinds().has(c) ? c : '-']));
      await cards.addRows(table.rows, mapping, batch.resolveAsset);
      await cards.removeCard(0);
      await cards.switchCard(0);
      cards.setCardQty(1, 3);
      state.project.name = 'Smoke Table';
      const c = document.createElement('canvas');
      c.width = 75; c.height = 105;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 75, 105);
      await api.exportImage({ filename: 'back.png', dataURL: c.toDataURL('image/png'), folder: 'smoke-tt-back', overwrite: true });
      state.setDirty(false);
      return { ids: cards.cardList().map((card) => card.id).join('|') };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.click('[data-action="tabletop"]');
  await page.waitForSelector('#tabletopSource');
  await page.waitForFunction(() => document.querySelector('#tabletopBack')?.options.length > 1);
  await page.selectOption('#tabletopSource', 'project');
  await page.selectOption('#tabletopBack', 'exports/smoke-tt-back');
  await page.waitForTimeout(200);
  const tabletopFit = await page.textContent('#tabletopFit');
  for (const button of await page.$$('#modalFoot button')) {
    if ((await button.textContent()) === 'Make deck sheets') { await button.click(); break; }
  }
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(500);
    const text = await page.textContent('#tabletopStatus').catch(() => '');
    if (/→|failed/.test(text)) break;
  }
  const tabletopStatus = await page.textContent('#tabletopStatus').catch(() => '');
  const tabletopFiles = await page.evaluate(async (ids) => {
    try {
      const { api, state } = window.TCGForge;
      const cards = await import('/js/core/cards.js');
      const manifest = await api.readJSON('exports/smoke-table-tabletop/tabletop.json').catch(() => null);
      const listed = ((await api.request('/api/list?path=exports/smoke-table-tabletop').catch(() => ({}))).entries || [])
        .map((e) => e.name).sort().join(',');
      const out = { manifest, listed, project: { same: cards.cardList().map((c) => c.id).join('|') === ids, active: state.project.activeCard, dirty: state.dirty } };
      if (manifest) {
        const img = new Image();
        img.src = api.fileURL(`exports/smoke-table-tabletop/${manifest.sheets[0].file}`);
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const [w, h] = manifest.cardSize;
        const cols = manifest.sheets[0].width;
        const at = (i) => Array.from(ctx.getImageData((i % cols) * w + w / 2, Math.floor(i / cols) * h + h * 0.3, 1, 1).data.slice(0, 3));
        const close = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 24);
        out.size = `${img.width}x${img.height}`;
        out.copiesMatch = close(at(1), at(2)) && close(at(2), at(3));
        out.neighboursDiffer = !close(at(0), at(1)) && !close(at(3), at(4));
        out.hidden = at(manifest.sheets[0].width * manifest.sheets[0].height - 1);
      }
      return out;
    } catch (err) {
      return { error: err.message };
    }
  }, tabletopSetup.ids);
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  check(
    'the tabletop dialog writes a sheet, the back and a manifest for a project',
    /^8 cards → 1 sheet \(3 × 3\)/.test(tabletopFit) &&
      /Width 3, Height 3, Number 8/.test(tabletopStatus) &&
      tabletopFiles.listed === 'back.png,smoke-table.jpg,tabletop.json' &&
      tabletopFiles.manifest?.cards === 8 && tabletopFiles.manifest?.back === 'back.png' &&
      tabletopFiles.manifest?.sheets?.[0]?.number === 8 && tabletopFiles.size === '2250x3150' &&
      tabletopFiles.copiesMatch && tabletopFiles.neighboursDiffer &&
      tabletopFiles.hidden?.[0] > 200 && tabletopFiles.hidden?.[1] < 60 && tabletopFiles.hidden?.[2] > 200 &&
      tabletopFiles.project?.same && tabletopFiles.project?.active === 0 && tabletopFiles.project?.dirty === false,
    JSON.stringify({ tabletopFit, tabletopStatus, tabletopFiles })
  );

  /* A folder from Export → Every card brings its deck list: the counts come
     from deck.json without the project being drawn again. */
  const tabletopFolder = await page.evaluate(async () => {
    try {
      const cards = await import('/js/core/cards.js');
      const res = await cards.exportCards({ multiplier: 0.2 });
      return { folder: res.rendered[0]?.path?.split('/').slice(0, -1).join('/') };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.click('[data-action="tabletop"]');
  await page.waitForFunction(() => document.querySelector('#tabletopFolder')?.options.length > 1);
  await page.selectOption('#tabletopSource', 'folder');
  if (tabletopFolder.folder) await page.selectOption('#tabletopFolder', tabletopFolder.folder).catch(() => {});
  await page.waitForTimeout(500);
  const tabletopFolderFit = await page.textContent('#tabletopFit');
  await page.evaluate(async () => (await import('/js/ui/dialogs.js')).closeModal());
  await page.evaluate(async (folder) => {
    const { api, state } = window.TCGForge;
    for (const path of [folder, 'exports/smoke-table-tabletop', 'exports/smoke-tt-back']) {
      if (path) await api.trash(path).catch(() => {});
    }
    state.setDirty(false);
  }, tabletopFolder.folder);
  check(
    'a folder\'s deck list sets the tabletop copies',
    tabletopFolder.folder === 'exports/smoke-table' &&
      /^8 cards → 1 sheet \(3 × 3\) · copies from deck\.json/.test(tabletopFolderFit),
    JSON.stringify({ tabletopFolder, tabletopFolderFit })
  );

  /* ---- 0.17.0: art framing per card, and the bugs found with it ------- */

  /* Art placed from the library, then a switch before the picture loads: the
     picture belongs to the card it was placed on. The request is held until
     the switch has been asked for, so the race is open however slow the
     runner is; the picture is new to this page, so no cache can skip it. */
  const placeArtPath = `assets/art/smoke-place-${Date.now()}.svg`;
  let releasePlace = () => {};
  const placeGate = new Promise((resolve) => { releasePlace = resolve; });
  let placeHeld = false;
  const placeRoute = `**/files/${placeArtPath}`;
  await page.route(placeRoute, async (route) => {
    placeHeld = true;
    await placeGate;
    route.continue().catch(() => {});
  });
  const placeSetup = await page.evaluate(async (path) => {
    try {
      const { state, api } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      await api.writeText(path, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#f0f"/></svg>');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      t.setFieldText('title', 'Alpha');
      await t.clearFieldImage('art');
      cards.cardList().push({ id: 'card-place-b', values: { title: 'Beta', art: null } });
      cards.syncActive();
      state.setDirty(false);
      const panel = await import('/js/ui/assetPanel.js');
      window.__smokePlace = panel.placeAsset({ category: 'art', path, name: 'held' }).catch((err) => err.message);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }, placeArtPath);
  for (let i = 0; i < 40 && !placeHeld; i += 1) await page.waitForTimeout(100);
  await page.evaluate(async () => {
    const cards = await import('/js/core/cards.js');
    window.__smokePlaceSwitch = cards.switchCard(1).catch((err) => err.message);
  });
  await page.waitForTimeout(300);
  const placeWhileHeld = await page.evaluate(() => window.TCGForge.state.project.activeCard);
  releasePlace();
  const placedOn = await page.evaluate(async () => {
    try {
      await window.__smokePlace;
      await window.__smokePlaceSwitch;
      const { state, editor } = window.TCGForge;
      const art = editor.findBySlot('art')[0];
      const records = state.project.cards.map((c) => `${c.values.title}:${c.values.art ? 'art' : 'none'}`).join(' ');
      return { active: state.project.activeCard, shown: art?.tcgAsset ? 'art' : 'none', records };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.unroute(placeRoute);
  await page.evaluate((path) => window.TCGForge.api.trash(path).catch(() => {}), placeArtPath);
  check(
    'art placed just before a card switch lands on the card it was placed on',
    placeSetup.ok && placeHeld && placeWhileHeld === 0 &&
      placedOn.active === 1 && placedOn.shown === 'none' && placedOn.records === 'Alpha:art Beta:none',
    JSON.stringify({ placeSetup, placeHeld, placeWhileHeld, placedOn })
  );

  /* A deck list names files as the folder spells them; a space in a name
     must not make the card's copies disappear. */
  const spacedDeck = await page.evaluate(async () => {
    try {
      const { api } = window.TCGForge;
      const c = document.createElement('canvas');
      c.width = 30; c.height = 42;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#c33'; ctx.fillRect(0, 0, 30, 42);
      await api.exportImage({ filename: 'fire card.png', dataURL: c.toDataURL(), folder: 'smoke-deck-space', overwrite: true });
      ctx.fillStyle = '#33c'; ctx.fillRect(0, 0, 30, 42);
      await api.exportImage({ filename: 'water.png', dataURL: c.toDataURL(), folder: 'smoke-deck-space', overwrite: true });
      await api.writeJSON('exports/smoke-deck-space/deck.json', {
        format: 'tcgforge.deck',
        cards: [{ file: 'fire card.png', qty: 3 }, { file: 'water.png', qty: 2 }],
      });
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.click('[data-action="tabletop"]', { timeout: 3000 }).catch(() => {});
  await page.waitForSelector('#tabletopSource', { timeout: 5000 }).catch(() => {});
  await page.selectOption('#tabletopSource', 'folder', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.selectOption('#tabletopFolder', 'exports/smoke-deck-space', { timeout: 3000 }).catch(() => {});
  let spacedFit = '';
  for (let i = 0; i < 30 && !/copies/.test(spacedFit); i += 1) {
    await page.waitForTimeout(100);
    spacedFit = await page.evaluate(() => document.querySelector('#tabletopFit')?.textContent || '');
  }
  for (const b of await page.$$('#modalFoot button')) {
    if ((await b.textContent()) === 'Preview') { await b.click({ timeout: 3000 }).catch(() => {}); break; }
  }
  let spacedStatus = '';
  for (let i = 0; i < 50 && !/Number|failed/.test(spacedStatus); i += 1) {
    await page.waitForTimeout(100);
    spacedStatus = await page.evaluate(() => document.querySelector('#tabletopStatus')?.textContent || '');
  }
  await page.evaluate(async () => {
    const dialogs = await import('/js/ui/dialogs.js');
    dialogs.closeModal();
    await window.TCGForge.api.trash('exports/smoke-deck-space').catch(() => {});
  });
  check(
    'a deck list naming a file with a space keeps that card\'s copies',
    spacedDeck.ok && spacedFit.startsWith('5 cards') && /Number 5\b/.test(spacedStatus),
    JSON.stringify({ spacedDeck, spacedFit, spacedStatus })
  );

  /* HEAD answers to the same Host and Origin checks as GET, and a workspace
     file opened on its own cannot run a script as this origin. */
  const headForeign = await rawRequest({ method: 'HEAD', path: '/index.html', headers: { Origin: 'http://evil.example' } }).catch((err) => ({ error: err.message }));
  const headRebound = await rawRequest({ method: 'HEAD', path: '/index.html', headers: { Host: 'evil.example' } }).catch((err) => ({ error: err.message }));
  const headOwn = await rawRequest({ method: 'HEAD', path: '/index.html' }).catch((err) => ({ error: err.message }));
  check(
    'HEAD is refused for a foreign Origin or a rebound Host',
    headForeign.status === 403 && headRebound.status === 403 && headOwn.status === 200,
    JSON.stringify({ foreign: headForeign.status, rebound: headRebound.status, own: headOwn.status })
  );

  const scriptSvg = `assets/art/smoke-script-${Date.now()}.svg`;
  const scriptTarget = `projects/smoke-svg-wrote-${Date.now()}.json`;
  await page.evaluate(([svgPath, target]) => window.TCGForge.api.writeText(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>' +
      `fetch('/api/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'${target}',content:'{}'})})` +
      '</script></svg>'
  ), [scriptSvg, scriptTarget]);
  const svgPage = await browser.newPage();
  const svgResponse = await svgPage.goto(`${BASE}/files/${scriptSvg}`).catch(() => null);
  await svgPage.waitForTimeout(1200);
  await svgPage.close();
  const svgWrote = await page.evaluate(async (target) => {
    const res = await fetch(window.TCGForge.api.fileURL(target));
    if (res.ok) await window.TCGForge.api.trash(target).catch(() => {});
    return res.ok;
  }, scriptTarget);
  await page.evaluate((path) => window.TCGForge.api.trash(path).catch(() => {}), scriptSvg);
  check(
    'a script inside a workspace picture cannot call the API when the picture is opened',
    svgWrote === false && /sandbox/.test(svgResponse?.headers()['content-security-policy'] || ''),
    JSON.stringify({ svgWrote, csp: svgResponse?.headers()['content-security-policy'] })
  );

  /* The feature. A tall picture, left half red and right half blue, covers
     the art window edge to edge across its width. */
  const framePath = `assets/art/smoke-frame-${Date.now()}.svg`;
  const frameSetup = await page.evaluate(async (path) => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      await api.writeText(path, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="80">' +
        '<rect width="10" height="80" fill="#f00"/><rect x="10" width="10" height="80" fill="#00f"/></svg>');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      state.project.name = 'Smoke Framing';
      t.setFieldText('title', 'Framed');
      await t.setFieldImage('art', api.fileURL(path), { assetPath: path });
      const art = editor.findBySlot('art')[0];
      // Move the picture right by half its window, as a drag would.
      art.set({ left: art.left + art.tcgArtBox.width / 2 });
      art.setCoords();
      editor.touch();
      // Same picture on the second card, not framed.
      cards.cardList().push({ id: 'card-frame-b', values: { title: 'Plain', art: path } });
      await cards.switchCard(1);
      const plain = t.readFraming(editor.findBySlot('art')[0]);
      await cards.switchCard(0);
      const back = t.readFraming(editor.findBySlot('art')[0]);
      const file = await (await import('/js/core/project.js')).serializeProject({ embed: false });
      return {
        plain,
        back,
        records: cards.cardList().map((c) => c.framing || null),
        fileFraming: file?.cards?.map((c) => c.framing || null) ?? null,
      };
    } catch (err) {
      return { error: err.message };
    }
  }, framePath);
  check(
    'a card keeps how its art is framed across a switch, and the same picture on another card starts plain',
    frameSetup.plain === null && frameSetup.back?.x === 0.5 && frameSetup.back?.zoom === 1 &&
      frameSetup.records?.[0]?.art?.x === 0.5 && frameSetup.records?.[1] === null &&
      frameSetup.fileFraming?.[0]?.art?.x === 0.5 && frameSetup.fileFraming?.[1] === null,
    JSON.stringify(frameSetup)
  );

  /* Every card drawn: the framed one shows the picture's red half three
     quarters across the window, the plain one its blue half. */
  const framePaint = await page.evaluate(async () => {
    try {
      const { editor } = window.TCGForge;
      const cards = await import('/js/core/cards.js');
      const box = editor.findBySlot('art')[0].tcgArtBox;
      const urls = await cards.renderCards({ multiplier: 1, squareCorners: true });
      const sample = async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const [r, g, b] = ctx.getImageData(Math.round(box.left + box.width * 0.75), Math.round(box.top + box.height * 0.5), 1, 1).data;
        return r > 200 && b < 60 ? 'red' : b > 200 && r < 60 ? 'blue' : `${r},${g},${b}`;
      };
      return { colours: await Promise.all(urls.map(sample)) };
    } catch (err) {
      return { error: err.message };
    }
  });
  check(
    'every card is drawn with its own art framing',
    framePaint.colours?.join() === 'red,blue',
    JSON.stringify(framePaint)
  );

  /* Card Fields: the zoom slider (driven by keys) and Refit. */
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.focus('#ffz_art', { timeout: 3000 }).catch(() => {});
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  const zoomed = await page.evaluate(async () => {
    const t = await import('/js/core/templates.js');
    const art = window.TCGForge.editor.findBySlot('art')[0];
    return {
      framing: t.readFraming(art),
      readout: document.querySelector('#ffzo_art')?.textContent,
      refit: document.querySelector('[data-refit-slot="art"]')?.disabled,
    };
  });
  await page.click('[data-refit-slot="art"]', { timeout: 3000 }).catch(() => {});
  const refitted = await page.evaluate(async () => {
    const t = await import('/js/core/templates.js');
    return {
      framing: t.readFraming(window.TCGForge.editor.findBySlot('art')[0]),
      slider: document.querySelector('#ffz_art')?.value,
      refit: document.querySelector('[data-refit-slot="art"]')?.disabled,
    };
  });
  await page.evaluate(async (path) => {
    document.activeElement?.blur?.();
    window.TCGForge.state.setDirty(false);
    await window.TCGForge.api.trash(path).catch(() => {});
  }, framePath);
  check(
    'the Card Fields zoom keeps the picture where it was moved to, and Refit fills the window again',
    zoomed.framing?.zoom === 7.95 && zoomed.framing?.x === 0.5 && zoomed.readout === '795%' && zoomed.refit === false &&
      refitted.framing === null && refitted.slider === '100' && refitted.refit === true,
    JSON.stringify({ zoomed, refitted })
  );

  /* ---- 0.18.0: a card's own changes, and the bugs found with it ------- */

  /* A project whose card picture has gone from the workspace could not be
     opened at all — Fabric refused the whole file. It opens now, with the
     slot's placeholder, and the card keeps the picture's path and framing, so
     putting the file back brings the art back as it was. */
  const goneArtPath = `assets/art/smoke-gone-${Date.now()}.svg`;
  // The file names a picture this page has never fetched, so no image cache
  // can stand in for it.
  const goneLaterPath = `assets/art/smoke-gone-later-${Date.now()}.svg`;
  const goneArtSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0c0"/></svg>';
  const goneOpen = await page.evaluate(async ({ first, path, svg }) => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      const p = await import('/js/core/project.js');
      await api.writeText(first, svg);
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      t.setFieldText('title', 'Gone One');
      await t.setFieldImage('art', api.fileURL(first), { assetPath: first });
      t.applyFraming(editor.findBySlot('art')[0], { zoom: 2, x: 0, y: 0 });
      editor.touch();
      cards.cardList().push({ id: 'card-gone-b', values: { title: 'Other', art: null } });
      const saved = await p.saveProject({ name: 'Smoke Gone Art', path: 'projects/smoke-gone-art.json' });
      await api.trash(first);
      const text = JSON.stringify(await api.readJSON(saved.path)).split(first).join(path);
      await api.writeJSON(saved.path, JSON.parse(text));
      let error = null;
      let opened = null;
      try {
        opened = await p.openProjectPath(saved.path);
      } catch (err) {
        error = err.message;
      }
      const art = editor.findBySlot('art')[0];
      const shown = t.isPlacedArt(art) ? 'art' : 'placeholder';
      // Off the card and back while the picture is still missing.
      if (!error) {
        await cards.switchCard(1);
        await cards.switchCard(0);
      }
      const record = cards.cardList()[0];
      await p.saveProject({});
      const file = await api.readJSON(saved.path).catch(() => null);
      // The picture comes back: the card shows it framed as it was.
      await api.writeText(path, svg);
      if (!error) {
        await cards.switchCard(1);
        await cards.switchCard(0);
      }
      const back = t.readFraming(editor.findBySlot('art')[0]);
      await api.trash(path).catch(() => {});
      await api.trash(saved.path).catch(() => {});
      state.setDirty(false);
      return {
        error,
        missing: opened?.missingArt ?? null,
        shown,
        recordArt: record?.values?.art === path,
        recordZoom: record?.framing?.art?.zoom ?? null,
        fileArt: file?.cards?.[0]?.values?.art === path,
        fileZoom: file?.cards?.[0]?.framing?.art?.zoom ?? null,
        back,
      };
    } catch (err) {
      return { error: err.message };
    }
  }, { first: goneArtPath, path: goneLaterPath, svg: goneArtSvg });
  check(
    'a project whose card art has gone missing still opens, showing the placeholder and naming the file',
    goneOpen.error === null && goneOpen.missing?.[0] === goneLaterPath && goneOpen.shown === 'placeholder' &&
      goneOpen.recordArt === true && goneOpen.fileArt === true,
    JSON.stringify(goneOpen)
  );
  check(
    'a card keeps its art framing while the picture is missing, and shows it again when the file is back',
    goneOpen.error === null && goneOpen.recordZoom === 2 && goneOpen.fileZoom === 2 && goneOpen.back?.zoom === 2,
    JSON.stringify(goneOpen)
  );

  /* Flip, crop and stretch from Properties were undone by the next card
     switch, by Duplicate, and by every *Every card* render. */
  const flipPath = `assets/art/smoke-flip-${Date.now()}.svg`;
  const flipKept = await page.evaluate(async (path) => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      const fx = await import('/js/core/effects.js');
      await api.writeText(path, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="80">' +
        '<rect width="10" height="80" fill="#f00"/><rect x="10" width="10" height="80" fill="#00f"/></svg>');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      t.setFieldText('title', 'Flipped');
      await t.setFieldImage('art', api.fileURL(path), { assetPath: path });
      const art = editor.findBySlot('art')[0];
      art.set({ flipX: true });
      editor.touch();
      cards.cardList().push({ id: 'card-flip-b', values: { title: 'Plain', art: path } });
      const box = art.tcgArtBox;
      const urls = await cards.renderCards({ multiplier: 1, squareCorners: true });
      const sample = async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const [r, , b] = ctx.getImageData(Math.round(box.left + box.width * 0.25), Math.round(box.top + box.height * 0.5), 1, 1).data;
        return r > 200 && b < 60 ? 'red' : b > 200 && r < 60 ? 'blue' : `${r},${b}`;
      };
      const colours = (await Promise.all(urls.map(sample))).join();
      // Crop to the left half and stretch it, then off the card and back.
      const shown = editor.findBySlot('art')[0];
      fx.applyCrop(shown, { w: 50, h: 100, x: 0, y: 50 });
      shown.set({ scaleY: shown.scaleY * 2 });
      editor.touch();
      const before = t.readFraming(shown);
      await cards.switchCard(1);
      const plain = t.readFraming(editor.findBySlot('art')[0]);
      await cards.switchCard(0);
      const after = t.readFraming(editor.findBySlot('art')[0]);
      await cards.addCard({ copy: true });
      const copy = cards.cardList()[1].framing?.art ?? null;
      state.setDirty(false);
      return { colours, before, plain, after, copy };
    } catch (err) {
      return { error: err.message };
    }
  }, flipPath);
  await page.evaluate((path) => window.TCGForge.api.trash(path).catch(() => {}), flipPath);
  check(
    'flipped, cropped and stretched art stays so across switches, Duplicate and Every card renders',
    flipKept.colours === 'blue,red' && flipKept.plain === null &&
      flipKept.before?.flipX === true && flipKept.before?.crop?.w === 0.5 && flipKept.before?.stretch === 2 &&
      JSON.stringify(flipKept.after) === JSON.stringify(flipKept.before) &&
      JSON.stringify(flipKept.copy) === JSON.stringify(flipKept.before),
    JSON.stringify(flipKept)
  );

  /* *Every card* (export, print, tabletop) asked for while a picture was
     still being placed read the card before it landed: the card was drawn
     without it. Held so the race is open on any machine. */
  const heldRenderPath = `assets/art/smoke-render-${Date.now()}.svg`;
  let releaseHeldRender = () => {};
  const heldRenderGate = new Promise((resolve) => { releaseHeldRender = resolve; });
  let heldRenderSeen = false;
  const heldRenderRoute = `**/files/${heldRenderPath}`;
  await page.route(heldRenderRoute, async (route) => {
    heldRenderSeen = true;
    await heldRenderGate;
    route.continue().catch(() => {});
  });
  await page.evaluate(async (path) => {
    const { state, api } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const cards = await import('/js/core/cards.js');
    await api.writeText(path, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0c0"/></svg>');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    await t.clearFieldImage('art');
    cards.cardList().push({ id: 'card-render-b', values: { title: 'Beta', art: null } });
    state.setDirty(false);
    const panel = await import('/js/ui/assetPanel.js');
    window.__smokeHeldPlace = panel.placeAsset({ category: 'art', path, name: 'held' }).catch((err) => err.message);
    window.__smokeHeldRender = cards.renderCards({ multiplier: 1, squareCorners: true }).catch((err) => err.message);
  }, heldRenderPath);
  for (let i = 0; i < 40 && !heldRenderSeen; i += 1) await page.waitForTimeout(100);
  releaseHeldRender();
  const heldRender = await page.evaluate(async () => {
    try {
      await window.__smokeHeldPlace;
      const urls = await window.__smokeHeldRender;
      if (!Array.isArray(urls)) return { error: String(urls) };
      const box = window.TCGForge.editor.findBySlot('art')[0].tcgArtBox;
      const img = new Image();
      img.src = urls[0];
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const [r, g, b] = ctx.getImageData(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2), 1, 1).data;
      window.TCGForge.state.setDirty(false);
      return { pixel: `${r},${g},${b}` };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.unroute(heldRenderRoute);
  await page.evaluate((path) => window.TCGForge.api.trash(path).catch(() => {}), heldRenderPath);
  check(
    'every card drawn while art is still being placed shows that art',
    heldRenderSeen && heldRender.pixel === '0,204,0',
    JSON.stringify({ heldRenderSeen, heldRender })
  );

  /* Properties → Replace… then a card switch while the picture uploads: the
     replacement went to the card switched to (both cards showing the same
     file share the layer across the switch). The upload is held; the switch
     must wait for it, and the picture land on the card it was chosen on. */
  const replaceFile = path.join(os.tmpdir(), `smoke-replace-${Date.now()}.png`);
  const replaceArtPath = `assets/art/smoke-replace-base-${Date.now()}.svg`;
  const replacePng = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f0f';
    ctx.fillRect(0, 0, 16, 16);
    return c.toDataURL('image/png').split(',')[1];
  });
  fs.writeFileSync(replaceFile, Buffer.from(replacePng, 'base64'));
  await page.evaluate(async (base) => {
    const { state, api, editor } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const cards = await import('/js/core/cards.js');
    await api.writeText(base, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#08f"/></svg>');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    t.setFieldText('title', 'Chosen');
    await t.setFieldImage('art', api.fileURL(base), { assetPath: base });
    await cards.addCard({ copy: true });
    await cards.switchCard(0);
    editor.select(editor.findBySlot('art')[0]);
    state.setDirty(false);
  }, replaceArtPath);
  let releaseUpload = () => {};
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  let uploadHeld = false;
  await page.route('**/api/upload', async (route) => {
    uploadHeld = true;
    await uploadGate;
    route.continue().catch(() => {});
  });
  let replaceStarted = true;
  try {
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.click('[data-action="img-replace"]', { timeout: 3000 });
    await (await chooser).setFiles(replaceFile);
  } catch {
    replaceStarted = false;
  }
  for (let i = 0; i < 40 && !uploadHeld; i += 1) await page.waitForTimeout(100);
  await page.evaluate(async () => {
    const cards = await import('/js/core/cards.js');
    window.__smokeReplaceSwitch = cards.switchCard(1).catch((err) => err.message);
  });
  await page.waitForTimeout(300);
  const replaceWhileHeld = await page.evaluate(() => window.TCGForge.state.project.activeCard);
  releaseUpload();
  const replaced = await page.evaluate(async (base) => {
    try {
      await window.__smokeReplaceSwitch;
      const cards = await import('/js/core/cards.js');
      cards.syncActive();
      const arts = cards.cardList().map((c) => c.values.art);
      const uploaded = arts.find((a) => a && a !== base) || null;
      window.TCGForge.state.setDirty(false);
      return { first: arts[0] === base ? 'old' : /smoke-replace/.test(arts[0] || '') ? 'new' : arts[0], second: arts[1] === base ? 'old' : arts[1], uploaded };
    } catch (err) {
      return { error: err.message };
    }
  }, replaceArtPath);
  await page.unroute('**/api/upload');
  await page.evaluate(async ({ base, uploaded }) => {
    await window.TCGForge.api.trash(base).catch(() => {});
    if (uploaded) await window.TCGForge.api.trash(uploaded).catch(() => {});
  }, { base: replaceArtPath, uploaded: replaced.uploaded });
  fs.rmSync(replaceFile, { force: true });
  check(
    'a picture chosen with Replace… lands on its own card when a switch starts during the upload',
    replaceStarted && uploadHeld && replaceWhileHeld === 0 && replaced.first === 'new' && replaced.second === 'old',
    JSON.stringify({ replaceStarted, uploadHeld, replaceWhileHeld, replaced })
  );

  /* The strip's Copies box during a switch wrote to the incoming card while
     it still showed the outgoing card's count. Refused for that moment. */
  const qtyHeldPath = `assets/art/smoke-qty-${Date.now()}.svg`;
  let releaseQty = () => {};
  const qtyGate = new Promise((resolve) => { releaseQty = resolve; });
  let qtyHeld = false;
  const qtyRoute = `**/files/${qtyHeldPath}`;
  await page.route(qtyRoute, async (route) => {
    qtyHeld = true;
    await qtyGate;
    route.continue().catch(() => {});
  });
  await page.evaluate(async (path) => {
    const { state, api } = window.TCGForge;
    const t = await import('/js/core/templates.js');
    const cards = await import('/js/core/cards.js');
    await api.writeText(path, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#fa0"/></svg>');
    await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
    await t.clearFieldImage('art');
    cards.cardList().push({ id: 'card-qty-b', values: { title: 'Beta', art: path } });
    state.setDirty(false);
    window.__smokeQtySwitch = cards.switchCard(1).catch((err) => err.message);
  }, qtyHeldPath);
  for (let i = 0; i < 40 && !qtyHeld; i += 1) await page.waitForTimeout(100);
  const qtyMidSwitch = await page.evaluate(async () => (await import('/js/core/cards.js')).isSwitching());
  await page.click('#cardQty', { clickCount: 3, timeout: 3000 }).catch(() => {});
  await page.keyboard.type('4');
  releaseQty();
  const qtyAfter = await page.evaluate(async () => {
    try {
      await window.__smokeQtySwitch;
      const cards = await import('/js/core/cards.js');
      await cards.settled();
      await new Promise((r) => setTimeout(r, 50));
      const counts = cards.cardList().map((c) => cards.qtyOf(c)).join(',');
      return { counts, box: document.getElementById('cardQty').value };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.click('#cardQty', { clickCount: 3, timeout: 3000 }).catch(() => {});
  await page.keyboard.type('3');
  const qtyLater = await page.evaluate(async () => {
    const cards = await import('/js/core/cards.js');
    document.activeElement?.blur?.();
    const counts = cards.cardList().map((c) => cards.qtyOf(c)).join(',');
    window.TCGForge.state.setDirty(false);
    return counts;
  });
  await page.unroute(qtyRoute);
  await page.evaluate((path) => window.TCGForge.api.trash(path).catch(() => {}), qtyHeldPath);
  check(
    'a count typed into Copies during a card switch does not land on the other card',
    qtyHeld && qtyMidSwitch === true && qtyAfter.counts === '1,1' && qtyAfter.box === '1' && qtyLater === '1,3',
    JSON.stringify({ qtyHeld, qtyMidSwitch, qtyAfter, qtyLater })
  );

  /* Art shrunk below the cover fit on the canvas: the zoom slider sat at
     100 % beside a 50 % readout, and one step jumped to 105 %. */
  const belowCover = await page.evaluate(async () => {
    try {
      const { api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const { bus, EVT } = await import('/js/util/bus.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      await t.setFieldImage('art', api.fileURL('assets/backgrounds/starfield.svg'), { assetPath: 'assets/backgrounds/starfield.svg' });
      t.applyFraming(editor.findBySlot('art')[0], { zoom: 0.5, x: 0, y: 0 });
      editor.touch();
      bus.emit(EVT.OBJECTS, editor.objects());
      return { slider: document.getElementById('ffz_art')?.value, readout: document.getElementById('ffzo_art')?.textContent };
    } catch (err) {
      return { error: err.message };
    }
  });
  await page.focus('#ffz_art', { timeout: 3000 }).catch(() => {});
  await page.keyboard.press('ArrowRight');
  const belowStep = await page.evaluate(async () => {
    const t = await import('/js/core/templates.js');
    document.activeElement?.blur?.();
    window.TCGForge.state.setDirty(false);
    return t.readFraming(window.TCGForge.editor.findBySlot('art')[0])?.zoom ?? null;
  });
  check(
    'the zoom slider shows art shrunk below the window and steps on from there',
    belowCover.slider === '50' && belowCover.readout === '50%' && belowStep === 0.55,
    JSON.stringify({ belowCover, belowStep })
  );

  /* The feature. Three cards: the second frames its art its own way, the
     third moves its title for itself. The strip marks both, the filter
     finds them with has:changes, Card Fields offers the way back, and the
     card on screen is marked the moment it changes, without a switch. */
  const ownSetup = await page.evaluate(async () => {
    try {
      const { state, api, editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      await t.applyTemplate(await api.readJSON('templates/classic-spell.json'));
      t.setFieldText('title', 'Plain');
      await t.setFieldImage('art', api.fileURL('assets/backgrounds/starfield.svg'), { assetPath: 'assets/backgrounds/starfield.svg' });
      const title = editor.findBySlot('title')[0];
      cards.cardList().push(
        { id: 'card-own-b', values: { title: 'Framed', art: 'assets/backgrounds/starfield.svg' }, framing: { art: { zoom: 2, x: 0, y: 0 } } },
        { id: 'card-own-c', values: { title: 'Moved', art: 'assets/backgrounds/starfield.svg' }, overrides: { [title.tcgId]: { left: title.left + 40 } } }
      );
      cards.syncActive();
      const { bus, EVT } = await import('/js/util/bus.js');
      bus.emit(EVT.CARDS, cards.cardList());
      state.setDirty(false);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });
  const ownTiles = () => page.evaluate(() =>
    [...document.querySelectorAll('#cardTiles .card-tile')]
      .map((tile) => (tile.querySelector('.tile-own') ? 'own' : '-') + (tile.classList.contains('no-match') ? '~' : ''))
      .join(' '));
  const ownStrip = {
    tiles: await ownTiles(),
    label: await page.evaluate(() => document.querySelectorAll('#cardTiles .card-tile')[2]?.getAttribute('aria-label')),
    box: await page.evaluate(() => document.getElementById('cardOwn')?.hidden ?? null),
  };
  await page.fill('#cardFilter', 'has:changes');
  const ownFiltered = { tiles: await ownTiles(), count: await page.textContent('#cardFilterCount') };
  // The card on screen made one of its layers its own: marked at once.
  const ownLive = await page.evaluate(async () => {
    const { editor } = window.TCGForge;
    const cards = await import('/js/core/cards.js');
    cards.setOverride(editor.findBySlot('title')[0], true);
    return { text: document.getElementById('cardOwnText')?.textContent, box: document.getElementById('cardOwn')?.hidden };
  });
  const ownLiveTiles = await ownTiles();
  await page.evaluate(async () => {
    const strip = await import('/js/ui/cardStrip.js');
    strip.clearFilter();
    document.activeElement?.blur?.();
  });
  check(
    'the strip marks the cards that change the layout for themselves, and has:changes finds them',
    ownSetup.ok && ownStrip.tiles === '- own own' && /has its own changes: 1 layer$/.test(ownStrip.label || '') &&
      ownStrip.box === true && ownFiltered.tiles === '-~ own own' && ownFiltered.count === '2 of 3 match' &&
      ownLive.text === 'This card\'s own: 1 layer' && ownLive.box === false && ownLiveTiles === 'own own own',
    JSON.stringify({ ownSetup, ownStrip, ownFiltered, ownLive, ownLiveTiles })
  );

  /* Reset on the third card: its title goes back to the layout and the art
     to the plain fit, the marks go, and Ctrl+Z brings the change back. */
  const ownReset = await page.evaluate(async () => {
    try {
      const { editor } = window.TCGForge;
      const t = await import('/js/core/templates.js');
      const cards = await import('/js/core/cards.js');
      const { history } = await import('/js/core/history.js');
      await cards.switchCard(2);
      t.applyFraming(editor.findBySlot('art')[0], { zoom: 1.5, x: 0, y: 0 });
      editor.touch();
      const layoutLeft = editor.findBySlot('title')[0].tcgBase?.left;
      const movedLeft = editor.findBySlot('title')[0].left;
      const shown = { text: document.getElementById('cardOwnText').textContent };
      document.getElementById('cardOwnReset').click();
      const title = editor.findBySlot('title')[0];
      const after = {
        left: title.left,
        own: !!title.tcgBase,
        framing: t.readFraming(editor.findBySlot('art')[0]),
        box: document.getElementById('cardOwn').hidden,
        tile: !!document.querySelector('#cardTiles .card-tile.active .tile-own'),
      };
      cards.syncActive();
      const record = { overrides: cards.cardList()[2].overrides ?? null, framing: cards.cardList()[2].framing ?? null };
      await history.flush?.();
      await new Promise((r) => setTimeout(r, 400));
      await history.undo();
      const undone = { own: !!editor.findBySlot('title')[0].tcgBase, left: editor.findBySlot('title')[0].left };
      window.TCGForge.state.setDirty(false);
      return { layoutLeft, movedLeft, shown, after, record, undone };
    } catch (err) {
      return { error: err.message };
    }
  });
  check(
    'Reset to layout puts a card\'s own layers and art framing back, and Ctrl+Z undoes it',
    ownReset.shown?.text === 'This card\'s own: 1 layer, framed art' && ownReset.movedLeft === ownReset.layoutLeft + 40 &&
      ownReset.after?.left === ownReset.layoutLeft && ownReset.after.own === false && ownReset.after.framing === null &&
      ownReset.after.box === true && ownReset.after.tile === false &&
      ownReset.record?.overrides === null && ownReset.record?.framing === null &&
      ownReset.undone?.own === true && ownReset.undone?.left === ownReset.movedLeft,
    JSON.stringify(ownReset)
  );

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
