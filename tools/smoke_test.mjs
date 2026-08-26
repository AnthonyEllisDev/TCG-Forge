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

const BASE = process.argv[2] || 'http://127.0.0.1:7870';
const LAUNCH_OPTIONS = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : {};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

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

  await page.screenshot({ path: 'smoke-ui.png' });

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
