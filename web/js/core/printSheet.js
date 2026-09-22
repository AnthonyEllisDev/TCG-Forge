/*
 * Print sheets — lay rendered cards out on a real page at their true physical
 * size, ready to print and cut.
 *
 * This module is deliberately not part of the editor. It never touches the
 * Fabric canvas, the slot system or the project file: it takes images that are
 * already finished and paints them onto a plain 2D canvas at a page size
 * measured in inches. That is why it is short, and why nothing here can
 * corrupt a card.
 *
 * The geometry is the whole point. A card exported at 750 × 1050 px from a
 * 300 dpi layout is 2.5 × 3.5 inches of paper, and it has to come out of the
 * printer at exactly that size or the cards do not fit their sleeves.
 */

const MM_PER_INCH = 25.4;

export const PAGE_SIZES = {
  a4:      { label: 'A4 (210 × 297 mm)',        inches: [8.2677, 11.6929] },
  letter:  { label: 'US Letter (8.5 × 11 in)',  inches: [8.5, 11] },
  legal:   { label: 'US Legal (8.5 × 14 in)',   inches: [8.5, 14] },
  a3:      { label: 'A3 (297 × 420 mm)',        inches: [11.6929, 16.5354] },
  tabloid: { label: 'Tabloid (11 × 17 in)',     inches: [11, 17] },
};

export const CUT_GUIDES = {
  crop: 'Crop marks in the margins',
  lines: 'Full-page cut lines',
  none: 'No guides',
};

const mmToInches = (mm) => Number(mm || 0) / MM_PER_INCH;

/* ------------------------------------------------------------------ plan -- */

/**
 * Work out how many cards fit on a page and where each one goes.
 *
 * Everything returned is in device pixels at `dpi`, except `trimInches`, which
 * is the physical card size the sheet is built around.
 */
export function planSheet({
  cardWidth,
  cardHeight,
  cardDpi = 300,
  page = 'a4',
  landscape = false,
  dpi = 300,
  marginMm = 6,
  gapMm = 0,
  bleedMm = 0,
} = {}) {
  const size = PAGE_SIZES[page];
  if (!size) throw new Error(`unknown page size: ${page}`);
  if (!(cardWidth > 0) || !(cardHeight > 0)) throw new Error('the card has no size');

  const [pageW, pageH] = landscape ? [size.inches[1], size.inches[0]] : size.inches;
  const trimW = cardWidth / cardDpi;
  const trimH = cardHeight / cardDpi;
  const margin = mmToInches(marginMm);
  const bleed = mmToInches(bleedMm);
  // Bleed spills outwards, so neighbours have to be held apart by at least
  // twice it or the artwork of one card prints over the next.
  const gap = Math.max(mmToInches(gapMm), bleed * 2);

  const usableW = pageW - margin * 2;
  const usableH = pageH - margin * 2;
  const cols = Math.floor((usableW + gap) / (trimW + gap));
  const rows = Math.floor((usableH + gap) / (trimH + gap));
  if (cols < 1 || rows < 1) {
    throw new Error(
      `a ${trimW.toFixed(2)} × ${trimH.toFixed(2)} in card does not fit on ` +
        `${size.label} with a ${marginMm} mm margin`
    );
  }

  const blockW = cols * trimW + (cols - 1) * gap;
  const blockH = rows * trimH + (rows - 1) * gap;
  const originX = (pageW - blockW) / 2;
  const originY = (pageH - blockH) / 2;

  const px = (inches) => inches * dpi;
  const slots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      slots.push({
        left: px(originX + col * (trimW + gap)),
        top: px(originY + row * (trimH + gap)),
        width: px(trimW),
        height: px(trimH),
      });
    }
  }

  return {
    page,
    label: size.label,
    landscape,
    dpi,
    cols,
    rows,
    perPage: cols * rows,
    slots,
    bleed: px(bleed),
    pageWidth: Math.round(px(pageW)),
    pageHeight: Math.round(px(pageH)),
    pagePoints: [pageW * 72, pageH * 72],
    trimInches: [trimW, trimH],
  };
}

/* --------------------------------------------------------------- compose -- */

/** Load a URL into an image element. Rejects rather than hanging. */
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${String(url).slice(0, 80)}`));
    img.src = url;
  });
}

/**
 * Paint one page. `images` are already-loaded image elements, at most
 * `plan.perPage` of them; the rest of the page is left blank.
 */
export function composePage(images, plan, { guides = 'crop', background = '#ffffff' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = plan.pageWidth;
  canvas.height = plan.pageHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';

  const used = [];
  images.slice(0, plan.perPage).forEach((image, index) => {
    const slot = plan.slots[index];
    if (!slot || !image) return;
    // The bleed is drawn outside the trim box; the marks stay on the trim box,
    // so cutting on the marks removes it.
    const b = plan.bleed;
    ctx.drawImage(image, slot.left - b, slot.top - b, slot.width + b * 2, slot.height + b * 2);
    used.push(slot);
  });

  if (guides !== 'none' && used.length) drawGuides(ctx, plan, used, guides);
  return canvas;
}

function drawGuides(ctx, plan, used, mode) {
  ctx.save();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = Math.max(1, Math.round(plan.dpi / 600));
  ctx.setLineDash([]);

  if (mode === 'lines') {
    // One line per card edge, running the full width and height of the page:
    // the easiest thing to follow under a guillotine.
    const xs = new Set();
    const ys = new Set();
    for (const slot of used) {
      xs.add(slot.left);
      xs.add(slot.left + slot.width);
      ys.add(slot.top);
      ys.add(slot.top + slot.height);
    }
    ctx.beginPath();
    for (const x of xs) {
      ctx.moveTo(round(x), 0);
      ctx.lineTo(round(x), plan.pageHeight);
    }
    for (const y of ys) {
      ctx.moveTo(0, round(y));
      ctx.lineTo(plan.pageWidth, round(y));
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  /* Crop marks live in the page margins, never between the cards: with the
     usual zero gap a tick drawn beside a card edge is a tick drawn on top of
     its neighbour's artwork. Marking every cut line at the edge of the block
     is what you actually line a ruler up against anyway. */
  const len = plan.dpi * 0.14;
  const clear = plan.dpi * 0.04;
  const block = boundsOf(used);
  const xs = new Set();
  const ys = new Set();
  for (const slot of used) {
    xs.add(slot.left);
    xs.add(slot.left + slot.width);
    ys.add(slot.top);
    ys.add(slot.top + slot.height);
  }

  ctx.beginPath();
  for (const x of xs) {
    const at = round(x);
    ctx.moveTo(at, block.top - clear);
    ctx.lineTo(at, Math.max(0, block.top - clear - len));
    ctx.moveTo(at, block.bottom + clear);
    ctx.lineTo(at, Math.min(plan.pageHeight, block.bottom + clear + len));
  }
  for (const y of ys) {
    const at = round(y);
    ctx.moveTo(block.left - clear, at);
    ctx.lineTo(Math.max(0, block.left - clear - len), at);
    ctx.moveTo(block.right + clear, at);
    ctx.lineTo(Math.min(plan.pageWidth, block.right + clear + len), at);
  }
  ctx.stroke();
  ctx.restore();
}

function boundsOf(slots) {
  return {
    left: Math.min(...slots.map((s) => s.left)),
    top: Math.min(...slots.map((s) => s.top)),
    right: Math.max(...slots.map((s) => s.left + s.width)),
    bottom: Math.max(...slots.map((s) => s.top + s.height)),
  };
}

const round = (n) => Math.round(n) + 0.5; // sit the hairline on a pixel centre

/* ----------------------------------------------------------------- build -- */

/**
 * Turn a list of image URLs into finished sheets.
 *
 * Returns one entry per page: the canvas it was painted on plus how many cards
 * landed on it. Loading is done here so callers can report progress without
 * knowing anything about images.
 */
export async function buildSheets(urls, plan, { guides = 'crop', onProgress = () => {} } = {}) {
  const images = [];
  for (let i = 0; i < urls.length; i += 1) {
    onProgress({ loaded: i, total: urls.length });
    images.push(await loadImage(urls[i]));
  }
  onProgress({ loaded: urls.length, total: urls.length });

  const pages = [];
  for (let start = 0; start < images.length; start += plan.perPage) {
    const slice = images.slice(start, start + plan.perPage);
    pages.push({ canvas: composePage(slice, plan, { guides }), cards: slice.length });
  }
  return pages;
}
