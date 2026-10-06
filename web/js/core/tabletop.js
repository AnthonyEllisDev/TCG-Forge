/*
 * Deck sheets for virtual tabletops.
 *
 * Tabletop Simulator — and the tables that copy its format — builds a deck
 * from one picture holding every face in a grid of up to ten columns and
 * seven rows. The importer is told the grid and the number of cards, and the
 * slot at the bottom right of the grid is never a card: it is the face shown
 * to the other players while a card is hidden in someone's hand. So a sheet
 * carries at most 69 cards, and a bigger deck is several sheets, each its own
 * import.
 *
 * Like the print sheet this is composition of finished images and nothing
 * else: no editor, no slots, no project. The size limit is the table's, not
 * ours — a sheet much past 4096 px on its long edge is refused or blurred by
 * the graphics cards people play on — so the cards are scaled down to fit
 * rather than the grid spilling past it.
 */

import { loadImage } from './printSheet.js';

export const TABLETOP_FORMAT = 'tcgforge.tabletop';
export const TABLETOP_FILE = 'tabletop.json';

export const MAX_COLUMNS = 10;
export const MAX_ROWS = 7;
// The last slot is the hidden face, so one fewer card than slots.
export const CARDS_PER_SHEET = MAX_COLUMNS * MAX_ROWS - 1;
export const MAX_EDGE = 4096;
// The importer will not take a grid narrower or shorter than two.
const MIN_SIDE = 2;

/**
 * The smallest grid that holds `count` cards and the hidden face; between
 * grids of the same size, the squarer sheet, so a small deck is not a long
 * strip and a big one is not scaled down further than it has to be.
 */
export function gridFor(count, cardWidth = 1, cardHeight = 1) {
  const slots = count + 1;
  let best = null;
  for (let columns = MIN_SIDE; columns <= MAX_COLUMNS; columns += 1) {
    for (let rows = MIN_SIDE; rows <= MAX_ROWS; rows += 1) {
      if (columns * rows < slots) continue;
      const area = columns * rows;
      const skew = Math.abs(Math.log((columns * cardWidth) / (rows * cardHeight)));
      if (!best || area < best.area || (area === best.area && skew < best.skew)) {
        best = { columns, rows, area, skew };
      }
    }
  }
  if (!best) throw new Error(`a sheet holds at most ${CARDS_PER_SHEET} cards`);
  return { columns: best.columns, rows: best.rows };
}

/**
 * Split a deck into sheets and size the cards on them.
 *
 * Every sheet of one deck uses the same card size, so a deck spread over
 * three imports does not hold cards of three different sharpnesses. The size
 * is the cards' own, scaled down only as far as the widest and tallest grid
 * needs to stay inside `maxEdge`.
 */
export function planTabletop({ count, cardWidth, cardHeight, maxEdge = MAX_EDGE }) {
  const total = Math.floor(Number(count));
  if (!(total > 0)) throw new Error('there are no cards to lay out');
  const width = Math.round(Number(cardWidth));
  const height = Math.round(Number(cardHeight));
  if (!(width > 0 && height > 0)) throw new Error('the cards have no size');

  const sheets = [];
  for (let start = 0; start < total; start += CARDS_PER_SHEET) {
    const number = Math.min(CARDS_PER_SHEET, total - start);
    sheets.push({ start, number, ...gridFor(number, width, height) });
  }
  const columns = Math.max(...sheets.map((sheet) => sheet.columns));
  const rows = Math.max(...sheets.map((sheet) => sheet.rows));
  const scale = Math.min(1, maxEdge / (columns * width), maxEdge / (rows * height));
  const cell = {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
  for (const sheet of sheets) {
    sheet.width = sheet.columns * cell.width;
    sheet.height = sheet.rows * cell.height;
    // The importer reads the hidden face from the grid's last slot, not from
    // the slot after the last card.
    sheet.hiddenSlot = sheet.columns * sheet.rows - 1;
  }
  return { cell, sheets, total, scale };
}

/** Where slot `index` of a sheet sits, in sheet pixels. */
export function slotRect(sheet, cell, index) {
  return {
    left: (index % sheet.columns) * cell.width,
    top: Math.floor(index / sheet.columns) * cell.height,
    width: cell.width,
    height: cell.height,
  };
}

/**
 * Paint one sheet: `images` in reading order, then `hidden` (the card back,
 * or nothing) in the last slot. Empty slots stay the background colour; the
 * importer never shows them, because `number` stops before them.
 */
export function composeTabletopSheet(images, sheet, cell, { hidden = null, background = '#000000' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = sheet.width;
  canvas.height = sheet.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  const draw = (image, index) => {
    const r = slotRect(sheet, cell, index);
    ctx.drawImage(image, r.left, r.top, r.width, r.height);
  };
  images.slice(0, sheet.number).forEach((image, index) => image && draw(image, index));
  if (hidden) draw(hidden, sheet.hiddenSlot);
  return canvas;
}

/**
 * Turn a list of image URLs (already repeated by their copies) into sheets.
 *
 * Each distinct URL is decoded once however often it repeats. The card size
 * comes from the first image: a deck is one card size, and an image of a
 * different shape is stretched into its slot rather than breaking the grid.
 */
export async function buildTabletopSheets(urls, { back = null, maxEdge = MAX_EDGE, onProgress = () => {} } = {}) {
  if (!urls.length) throw new Error('there are no cards to lay out');
  const decoded = new Map();
  let loaded = 0;
  const distinct = new Set(urls).size;
  for (const url of urls) {
    if (decoded.has(url)) continue;
    decoded.set(url, await loadImage(url));
    loaded += 1;
    onProgress({ loaded, total: distinct });
  }
  const first = decoded.get(urls[0]);
  const plan = planTabletop({
    count: urls.length,
    cardWidth: first.naturalWidth || first.width,
    cardHeight: first.naturalHeight || first.height,
    maxEdge,
  });
  const hidden = back ? await loadImage(back) : null;
  const images = urls.map((url) => decoded.get(url));
  const sheets = plan.sheets.map((sheet) => ({
    ...sheet,
    canvas: composeTabletopSheet(images.slice(sheet.start, sheet.start + sheet.number), sheet, plan.cell, {
      hidden,
    }),
  }));
  return { ...plan, sheets, hidden };
}

/**
 * What to type into the importer, written beside the sheets so the numbers
 * are still there next week. `files` runs parallel to the plan's sheets.
 */
export function buildTabletopManifest(name, plan, files, back = null) {
  return {
    format: TABLETOP_FORMAT,
    version: 1,
    name: name || 'Deck',
    cards: plan.total,
    cardSize: [plan.cell.width, plan.cell.height],
    back,
    sheets: plan.sheets.map((sheet, index) => ({
      file: files[index],
      width: sheet.columns,
      height: sheet.rows,
      number: sheet.number,
      first: sheet.start + 1,
    })),
  };
}
