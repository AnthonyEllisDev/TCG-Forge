/*
 * Developer tool: build the starter templates that ship with TCG Forge.
 *
 * The templates are authored by driving the running app in a headless browser
 * so the JSON they contain is exactly what Fabric.js produces at runtime — no
 * hand-written canvas JSON that can drift out of date.
 *
 * Usage:
 *   python launch.py --no-browser &
 *   npm i playwright && node tools/build_templates.mjs [http://127.0.0.1:7870]
 *
 * End users never need this: the generated files live in workspace/templates.
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:7870';
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;

const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.error('[page]', e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.TCGForge);
await page.waitForTimeout(600);

const written = await page.evaluate(async () => {
  const { editor, state, api } = window.TCGForge;
  const { forEachImageJSON } = await import('/js/core/objects.js');
  const W = 750;
  const H = 1050;

  const controls = {
    transparentCorners: false,
    cornerColor: '#5b7cfa',
    cornerStrokeColor: '#0a0d14',
    borderColor: '#5b7cfa',
    cornerSize: 9,
    cornerStyle: 'circle',
  };

  const addText = (text, o) =>
    editor.canvas.add(
      new fabric.Textbox(text, {
        fontFamily: 'Georgia',
        fill: '#ffffff',
        textAlign: 'left',
        lineHeight: 1.18,
        ...controls,
        ...o,
      })
    );

  const addRect = (o) => editor.canvas.add(new fabric.Rect({ ...controls, ...o }));
  const addCircle = (o) => editor.canvas.add(new fabric.Circle({ ...controls, ...o }));

  const addImage = async (path, o) => {
    const img = await fabric.FabricImage.fromURL(`/files/${path}`, { crossOrigin: 'anonymous' });
    img.set({ _baseWidth: img.width, _baseHeight: img.height, tcgAsset: path, ...controls, ...o });
    editor.canvas.add(img);
    return img;
  };

  const cover = (img, box) => {
    const scale = Math.max(box.width / img.width, box.height / img.height);
    img.set({
      scaleX: scale,
      scaleY: scale,
      left: box.left + (box.width - img.width * scale) / 2,
      top: box.top + (box.height - img.height * scale) / 2,
    });
  };

  const save = async (meta) => {
    // The browser resolves an image's src to an absolute URL, port included;
    // a template has to name the workspace path instead or it only works on
    // the port it happened to be built on.
    const canvas = editor.toJSON();
    forEachImageJSON(canvas, (obj) => {
      if (obj.tcgAsset) obj.src = api.fileURL(obj.tcgAsset);
    });
    const template = {
      format: 'tcgforge.template',
      version: 1,
      id: meta.id,
      name: meta.name,
      description: meta.description,
      author: 'TCG Forge',
      tags: meta.tags,
      card: { ...state.card },
      fields: meta.fields,
      canvas,
    };
    const res = await fetch('/api/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: `templates/${meta.id}.json`,
        content: JSON.stringify(template, null, 2),
      }),
    });
    const data = await res.json();
    return data.path;
  };

  const reset = (background) => {
    editor.canvas.clear();
    Object.assign(state.card, { width: W, height: H, dpi: 300, radius: 36, background, preset: 'poker' });
    editor.canvas.setDimensions({ width: W, height: H });
    editor.canvas.backgroundColor = background;
    editor.applyCardClip();
  };

  const results = [];

  /* ------------------------------------------------ 1. Classic Spell ---- */
  reset('#1a1410');
  {
    const bg = await addImage('assets/backgrounds/ember.svg', {
      tcgKind: 'background',
      tcgName: 'Background',
    });
    cover(bg, { left: 0, top: 0, width: W, height: H });

    addRect({
      left: 56, top: 100, width: 638, height: 422,
      fill: 'rgba(12,6,4,0.55)', tcgKind: 'art', tcgName: 'Art window', tcgSlot: 'art',
    });

    addRect({
      left: 56, top: 570, width: 638, height: 292, rx: 8, ry: 8,
      fill: 'rgba(14,8,6,0.62)', tcgKind: 'shape', tcgName: 'Text panel',
    });

    const frame = await addImage('assets/frames/ornate-gold.svg', {
      tcgKind: 'frame', tcgName: 'Frame',
    });
    frame.set({ left: 0, top: 0, scaleX: W / frame.width, scaleY: H / frame.height });

    addText('Ember Wyrm', {
      left: 70, top: 42, width: 520, fontSize: 44, fontWeight: 'bold',
      fill: '#f6e7c1', tcgSlot: 'title', tcgName: 'Title',
    });
    // The gem and the plate below follow their fields: a card with no cost or
    // no stats loses the ornament along with the number.
    addCircle({
      left: 616, top: 31, radius: 36,
      fill: '#5a1d12', stroke: '#e0b765', strokeWidth: 3,
      tcgKind: 'shape', tcgName: 'Cost gem', tcgShowIf: 'cost',
    });
    addText('3', {
      left: 616, top: 40, width: 72, fontSize: 46, fontWeight: 'bold', textAlign: 'center',
      fill: '#f6e7c1', tcgSlot: 'cost', tcgName: 'Cost',
    });
    addText('Creature — Dragon', {
      left: 70, top: 528, width: 610, fontSize: 25, fontStyle: 'italic',
      fill: '#f0dfb8', tcgSlot: 'type', tcgName: 'Type line',
    });
    addText(
      'Flying, haste.\n\nWhen Ember Wyrm enters the battlefield, it deals 2 damage to any target.',
      {
        left: 80, top: 592, width: 592, height: 210, fontSize: 26,
        fill: '#f4e8cd', tcgSlot: 'rules', tcgName: 'Rules text',
        tcgAutoFit: true, tcgFitHeight: 210, tcgFitSize: 26,
      }
    );
    addText('“The sky burns where it passes.”', {
      left: 80, top: 812, width: 592, fontSize: 20, fontStyle: 'italic',
      fill: '#d9c69a', tcgSlot: 'flavor', tcgName: 'Flavour text',
    });
    addRect({
      left: 510, top: 892, width: 170, height: 64, rx: 12, ry: 12,
      fill: 'rgba(14,8,6,0.72)', stroke: '#c9a45c', strokeWidth: 2,
      tcgKind: 'shape', tcgName: 'Stats plate', tcgShowIf: 'stats',
    });
    addText('4 / 4', {
      left: 510, top: 900, width: 170, fontSize: 44, fontWeight: 'bold', textAlign: 'center',
      fill: '#f6e7c1', tcgSlot: 'stats', tcgName: 'Power / toughness',
    });
    addText('TCG Forge · Starter Set · 001', {
      left: 70, top: 972, width: 420, fontSize: 15,
      fill: '#c8b99a', tcgSlot: 'footer', tcgName: 'Footer',
    });

    results.push(await save({
      id: 'classic-spell',
      name: 'Classic Spell Frame',
      description: 'Ornate fantasy frame with cost, type line, rules box and stats.',
      tags: ['fantasy', 'starter'],
      fields: [
        { id: 'title', label: 'Card name', type: 'text', order: 1 },
        { id: 'cost', label: 'Cost', type: 'text', order: 2 },
        { id: 'art', label: 'Artwork', type: 'image', order: 3 },
        { id: 'type', label: 'Type line', type: 'text', order: 4 },
        { id: 'rules', label: 'Rules text', type: 'multiline', order: 5 },
        { id: 'flavor', label: 'Flavour text', type: 'multiline', order: 6 },
        { id: 'stats', label: 'Power / toughness', type: 'text', order: 7 },
        { id: 'footer', label: 'Footer', type: 'text', order: 8 },
      ],
    }));
  }

  /* ------------------------------------------------ 2. Neon Unit ------- */
  reset('#05070f');
  {
    const bg = await addImage('assets/backgrounds/starfield.svg', {
      tcgKind: 'background', tcgName: 'Background',
    });
    cover(bg, { left: 0, top: 0, width: W, height: H });

    addRect({
      left: 64, top: 124, width: 622, height: 392,
      fill: '#0d1626', tcgKind: 'art', tcgName: 'Art window', tcgSlot: 'art',
    });

    const frame = await addImage('assets/frames/tech-neon.svg', {
      tcgKind: 'frame', tcgName: 'Frame',
    });
    frame.set({ left: 0, top: 0, scaleX: W / frame.width, scaleY: H / frame.height });

    addText('VOID SENTINEL', {
      left: 62, top: 48, width: 520, fontSize: 38, fontWeight: 'bold', fontFamily: 'Trebuchet MS',
      fill: '#4de3ff', charSpacing: 60, tcgSlot: 'title', tcgName: 'Title', tcgUppercase: true,
    });

    const icon = await addImage('assets/icons/element-dark.svg', {
      tcgKind: 'icon', tcgName: 'Element icon', tcgSlot: 'icon',
    });
    icon.set({ left: 606, top: 44, scaleX: 70 / icon.width, scaleY: 70 / icon.height });

    addRect({
      left: 60, top: 552, width: 630, height: 300, rx: 8, ry: 8,
      fill: 'rgba(8,18,34,0.82)', stroke: '#2a6cf6', strokeWidth: 2,
      tcgKind: 'shape', tcgName: 'Text panel',
    });
    addText('[ Construct / Guardian ]', {
      left: 82, top: 572, width: 586, fontSize: 24, fontFamily: 'Trebuchet MS',
      fill: '#7bb6ff', tcgSlot: 'type', tcgName: 'Type line',
    });
    addText(
      'Once per turn, when this unit is targeted by an effect: negate that effect and draw a card.',
      {
        left: 82, top: 616, width: 586, height: 180, fontSize: 24, fontFamily: 'Trebuchet MS',
        fill: '#dbe9ff', tcgSlot: 'rules', tcgName: 'Rules text',
        tcgAutoFit: true, tcgFitHeight: 180, tcgFitSize: 24,
      }
    );
    addText('ATK 2400   DEF 2100', {
      left: 300, top: 800, width: 368, fontSize: 28, fontWeight: 'bold', textAlign: 'right',
      fontFamily: 'Trebuchet MS', fill: '#4de3ff', tcgSlot: 'stats', tcgName: 'Stats',
    });
    addText('TCG Forge · Neon Series', {
      left: 62, top: 968, width: 400, fontSize: 15, fontFamily: 'Trebuchet MS',
      fill: '#5f7ea8', tcgSlot: 'footer', tcgName: 'Footer',
    });

    results.push(await save({
      id: 'neon-unit',
      name: 'Neon Unit',
      description: 'Sci-fi frame with element icon, stat line and translucent rules panel.',
      tags: ['scifi', 'starter'],
      fields: [
        { id: 'title', label: 'Unit name', type: 'text', order: 1 },
        { id: 'art', label: 'Artwork', type: 'image', order: 2 },
        { id: 'icon', label: 'Element icon', type: 'image', order: 3 },
        { id: 'type', label: 'Type line', type: 'text', order: 4 },
        { id: 'rules', label: 'Effect text', type: 'multiline', order: 5 },
        { id: 'stats', label: 'ATK / DEF', type: 'text', order: 6 },
        { id: 'footer', label: 'Footer', type: 'text', order: 7 },
      ],
    }));
  }

  /* ------------------------------------------------ 3. Minimal Modern -- */
  reset('#0f1117');
  {
    addRect({
      left: 0, top: 0, width: W, height: 660,
      fill: '#1b2130', tcgKind: 'art', tcgName: 'Art window', tcgSlot: 'art',
    });

    const panel = new fabric.Rect({
      left: 0, top: 620, width: W, height: 430, ...controls,
      tcgKind: 'shape', tcgName: 'Gradient panel',
    });
    panel.set(
      'fill',
      new fabric.Gradient({
        type: 'linear',
        gradientUnits: 'pixels',
        coords: { x1: 0, y1: 0, x2: 0, y2: 430 },
        colorStops: [
          { offset: 0, color: 'rgba(15,17,23,0)' },
          { offset: 0.32, color: '#0f1117' },
          { offset: 1, color: '#0f1117' },
        ],
      })
    );
    editor.canvas.add(panel);

    addRect({
      left: 62, top: 742, width: 84, height: 4, fill: '#f0a53a',
      tcgKind: 'shape', tcgName: 'Accent rule',
    });
    addText('Silver Fox', {
      left: 60, top: 660, width: 630, fontSize: 62, fontWeight: 'bold', fontFamily: 'Georgia',
      fill: '#f5f7fb', tcgSlot: 'title', tcgName: 'Title',
    });
    addText('AGILITY · 7', {
      left: 62, top: 772, width: 400, fontSize: 22, charSpacing: 120, fontFamily: 'Trebuchet MS',
      fill: '#f0a53a', tcgSlot: 'type', tcgName: 'Subtitle', tcgUppercase: true,
    });
    addText(
      'Move through any space occupied by an opponent. When you do, steal one resource card at random.',
      {
        left: 60, top: 828, width: 630, height: 150, fontSize: 25, fontFamily: 'Georgia',
        fill: '#c3ccdd', tcgSlot: 'rules', tcgName: 'Rules text',
        tcgAutoFit: true, tcgFitHeight: 150, tcgFitSize: 25,
      }
    );
    addText('012 / 120', {
      left: 490, top: 980, width: 200, fontSize: 18, textAlign: 'right', fontFamily: 'Trebuchet MS',
      fill: '#6c7890', tcgSlot: 'footer', tcgName: 'Collector number',
    });

    results.push(await save({
      id: 'minimal-modern',
      name: 'Minimal Modern',
      description: 'Full-bleed artwork with a gradient fade and clean typography — no frame image.',
      tags: ['modern', 'minimal', 'starter'],
      fields: [
        { id: 'title', label: 'Card name', type: 'text', order: 1 },
        { id: 'art', label: 'Artwork', type: 'image', order: 2 },
        { id: 'type', label: 'Subtitle', type: 'text', order: 3 },
        { id: 'rules', label: 'Rules text', type: 'multiline', order: 4 },
        { id: 'footer', label: 'Collector number', type: 'text', order: 5 },
      ],
    }));
  }

  /* ------------------------------------------------ 4. Blank card ------ */
  reset('#12161f');
  {
    addRect({
      left: 24, top: 24, width: W - 48, height: H - 48, rx: 20, ry: 20,
      fill: '', stroke: '#3b4763', strokeWidth: 3, strokeDashArray: [14, 10],
      tcgKind: 'shape', tcgName: 'Guide border',
    });
    addText('Card name', {
      left: 60, top: 60, width: 630, fontSize: 46, fontWeight: 'bold',
      fill: '#e8ecf5', tcgSlot: 'title', tcgName: 'Title',
    });
    addRect({
      left: 60, top: 150, width: 630, height: 470,
      fill: '#1b2231', stroke: '#5b7cfa', strokeWidth: 3, strokeDashArray: [12, 8],
      tcgKind: 'art', tcgName: 'Art window', tcgSlot: 'art',
    });
    addText('Write your rules text here.', {
      left: 60, top: 660, width: 630, height: 260, fontSize: 26,
      fill: '#c3ccdd', tcgSlot: 'rules', tcgName: 'Rules text',
      tcgAutoFit: true, tcgFitHeight: 260, tcgFitSize: 26,
    });

    results.push(await save({
      id: 'blank-starter',
      name: 'Blank Starter',
      description: 'Empty card with a title, art window and rules box — a clean place to begin.',
      tags: ['blank', 'starter'],
      fields: [
        { id: 'title', label: 'Card name', type: 'text', order: 1 },
        { id: 'art', label: 'Artwork', type: 'image', order: 2 },
        { id: 'rules', label: 'Rules text', type: 'multiline', order: 3 },
      ],
    }));
  }

  return results;
});

console.log('Templates written:');
for (const path of written) console.log('  ' + path);

await browser.close();
