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
 *
 * Card backs are the same idea turned over. A duplex sheet is the same grid
 * mirrored about the page centre line, because that is what the paper does
 * when the printer turns it round; a gutterfold sheet puts fronts and backs on
 * one side of one page, either side of a fold, with the backs upside down.
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

export const BACK_MODES = {
  off: 'Single-sided',
  duplex: 'Double-sided — backs on their own pages',
  gutterfold: 'Gutterfold — one page, folded in half',
};

/* Which way the printer turns the paper over decides which axis the backs are
   mirrored about. Getting this wrong is the classic duplex failure: every card
   comes out with its back belonging to the card on the opposite side. */
export const FLIP_EDGES = {
  long: 'Long edge — backs mirrored left to right',
  short: 'Short edge — backs mirrored top to bottom',
};

const mmToInches = (mm) => Number(mm || 0) / MM_PER_INCH;

/* ------------------------------------------------------------------ plan -- */

/**
 * Work out how many cards fit on a page and where each one goes.
 *
 * Everything returned is in device pixels at `dpi`, except `trimInches`, which
 * is the physical card size the sheet is built around. When backs are in play
 * `backSlots` runs parallel to `slots`: back `i` is the reverse of front `i`.
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
  backMode = 'off',
  flipEdge = 'long',
  shiftXMm = 0,
  shiftYMm = 0,
} = {}) {
  const size = PAGE_SIZES[page];
  if (!size) throw new Error(`unknown page size: ${page}`);
  if (!(cardWidth > 0) || !(cardHeight > 0)) throw new Error('the card has no size');
  if (!BACK_MODES[backMode]) throw new Error(`unknown back mode: ${backMode}`);

  const [pageW, pageH] = landscape ? [size.inches[1], size.inches[0]] : size.inches;
  const trimW = cardWidth / cardDpi;
  const trimH = cardHeight / cardDpi;
  const margin = mmToInches(marginMm);
  const bleed = mmToInches(bleedMm);
  // Bleed spills outwards, so neighbours have to be held apart by at least
  // twice it or the artwork of one card prints over the next.
  const gap = Math.max(mmToInches(gapMm), bleed * 2);
  const folded = backMode === 'gutterfold';

  const usableW = pageW - margin * 2;
  // A gutterfold sheet is folded across the middle, so the cards have to fit
  // in one half of it, held clear of the fold by the same margin as the edge.
  const usableH = (folded ? pageH / 2 : pageH) - margin * 2;
  const cols = Math.floor((usableW + gap) / (trimW + gap));
  const rows = Math.floor((usableH + gap) / (trimH + gap));
  if (cols < 1 || rows < 1) {
    throw new Error(
      `a ${trimW.toFixed(2)} × ${trimH.toFixed(2)} in card does not fit on ` +
        `${folded ? 'half of ' : ''}${size.label} with a ${marginMm} mm margin`
    );
  }

  const blockW = cols * trimW + (cols - 1) * gap;
  const blockH = rows * trimH + (rows - 1) * gap;
  const originX = (pageW - blockW) / 2;
  // Fronts sit in the lower half of a folded sheet; the backs go above the
  // fold, so the reader's half is the one nearest them when the sheet is shut.
  const originY = folded
    ? pageH / 2 + margin + (usableH - blockH) / 2
    : (pageH - blockH) / 2;

  const px = (inches) => inches * dpi;
  const pageWidth = Math.round(px(pageW));
  const pageHeight = Math.round(px(pageH));

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

  const plan = {
    page,
    label: size.label,
    landscape,
    dpi,
    cols,
    rows,
    perPage: cols * rows,
    slots,
    bleed: px(bleed),
    pageWidth,
    pageHeight,
    pagePoints: [pageW * 72, pageH * 72],
    trimInches: [trimW, trimH],
    backMode,
    flipEdge,
    backSlots: null,
    backRotated: folded,
    foldY: folded ? pageHeight / 2 : 0,
  };

  if (backMode !== 'off') {
    // The block is centred on the page, so mirroring a slot about the page
    // centre line is the same as reversing its position in the grid — but
    // doing it as arithmetic on the page is right whatever the margins are.
    const mirrorX = flipEdge === 'long' && !folded;
    const shiftX = folded ? 0 : px(mmToInches(shiftXMm));
    const shiftY = folded ? 0 : px(mmToInches(shiftYMm));
    plan.backSlots = slots.map((slot) => ({
      left: (mirrorX ? pageWidth - slot.left - slot.width : slot.left) + shiftX,
      // A folded sheet mirrors about the fold, which is the page centre line;
      // a short-edge duplex flip mirrors about exactly the same line.
      top: (mirrorX ? slot.top : pageHeight - slot.top - slot.height) + shiftY,
      width: slot.width,
      height: slot.height,
    }));
  }

  return plan;
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
 * Paint one page from one or more blocks of cards.
 *
 * A block is `{ images, slots, rotate }`: the images to lay down, the slot
 * rectangles to lay them in (the plan's own grid by default) and whether they
 * go on upside down, which is what a gutterfold back needs.
 */
export function composeBlocks(blocks, plan, { guides = 'crop', background = '#ffffff', label = '' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = plan.pageWidth;
  canvas.height = plan.pageHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';

  const used = [];
  for (const block of blocks) {
    const slots = block.slots || plan.slots;
    (block.images || []).slice(0, slots.length).forEach((image, index) => {
      const slot = slots[index];
      if (!slot || !image) return;
      drawCard(ctx, image, slot, plan.bleed, block.rotate);
      used.push(slot);
    });
  }

  if (guides !== 'none' && used.length) drawGuides(ctx, plan, used, guides);
  if (plan.foldY) drawFoldLine(ctx, plan);
  if (label) drawLabel(ctx, plan, label);
  return canvas;
}

/**
 * Paint one plain page of fronts. The simple case, kept as its own name
 * because most sheets are exactly this.
 */
export function composePage(images, plan, options = {}) {
  return composeBlocks([{ images }], plan, options);
}

function drawCard(ctx, image, slot, bleed, rotate) {
  // The bleed is drawn outside the trim box; the marks stay on the trim box,
  // so cutting on the marks removes it.
  const b = bleed;
  const w = slot.width + b * 2;
  const h = slot.height + b * 2;
  if (!rotate) {
    ctx.drawImage(image, slot.left - b, slot.top - b, w, h);
    return;
  }
  // Folding the top half down behind the bottom half turns its content through
  // half a turn, so it has to be printed through half a turn to come back.
  ctx.save();
  ctx.translate(slot.left + slot.width / 2, slot.top + slot.height / 2);
  ctx.rotate(Math.PI);
  ctx.drawImage(image, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawFoldLine(ctx, plan) {
  ctx.save();
  ctx.strokeStyle = '#808080';
  ctx.lineWidth = Math.max(1, Math.round(plan.dpi / 600));
  ctx.setLineDash([plan.dpi * 0.08, plan.dpi * 0.06]);
  ctx.beginPath();
  ctx.moveTo(0, round(plan.foldY));
  ctx.lineTo(plan.pageWidth, round(plan.foldY));
  ctx.stroke();
  ctx.restore();
}

/* The bottom-left corner is the one part of the page neither the crop marks
   nor the cut lines ever reach, and a stack of loose duplex sheets is
   unpairable without it. */
function drawLabel(ctx, plan, text) {
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.font = `${Math.round(plan.dpi * 0.085)}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, Math.round(plan.dpi * 0.12), Math.round(plan.pageHeight - plan.dpi * 0.1));
  ctx.restore();
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
 * Pair a list of back images with a list of fronts.
 *
 * One back covers a whole set — the common case, since most games have a
 * single card back. Any other count has to match the fronts exactly, because
 * guessing which card lost its back is worse than refusing.
 */
export function pairBacks(backs, count) {
  const list = (backs || []).filter(Boolean);
  if (!list.length) throw new Error('choose a folder of card backs, or print single-sided');
  if (list.length === 1) return Array.from({ length: count }, () => list[0]);
  if (list.length !== count) {
    throw new Error(
      `${list.length} backs for ${count} cards — use one back for the whole set, or one per card`
    );
  }
  return list;
}

/**
 * Turn a list of image URLs into finished sheets.
 *
 * Returns one entry per page: the canvas it was painted on, how many cards
 * landed on it and which side it is. With `backMode: 'duplex'` each sheet
 * yields a front page and a back page, in that order, which is the order a
 * duplex printer wants them.
 */
export async function buildSheets(
  urls,
  plan,
  { backs = [], guides = 'crop', pageLabel = '', onProgress = () => {} } = {}
) {
  const wantBacks = plan.backMode !== 'off' && plan.backSlots;
  const backURLs = wantBacks ? pairBacks(backs, urls.length) : [];
  const queue = urls.concat(backURLs);

  // The same URL is usually asked for many times — one back for sixty cards,
  // or the current card repeated across a page. Decode it once.
  const decoded = new Map();
  const images = [];
  for (let i = 0; i < queue.length; i += 1) {
    onProgress({ loaded: i, total: queue.length });
    const url = queue[i];
    if (!decoded.has(url)) decoded.set(url, await loadImage(url));
    images.push(decoded.get(url));
  }
  onProgress({ loaded: queue.length, total: queue.length });

  const fronts = images.slice(0, urls.length);
  const backImages = images.slice(urls.length);
  const sheets = Math.ceil(fronts.length / plan.perPage);
  const pages = [];

  for (let sheet = 0; sheet < sheets; sheet += 1) {
    const start = sheet * plan.perPage;
    const front = fronts.slice(start, start + plan.perPage);
    const back = backImages.slice(start, start + plan.perPage);
    const where = `sheet ${sheet + 1} of ${sheets}`;

    if (plan.backMode === 'gutterfold') {
      pages.push({
        canvas: composeBlocks(
          [{ images: front }, { images: back, slots: plan.backSlots, rotate: true }],
          plan,
          { guides, label: labelFor(pageLabel, where, 'fold') }
        ),
        cards: front.length,
        side: 'fold',
      });
    } else if (plan.backMode === 'duplex') {
      pages.push({
        canvas: composeBlocks([{ images: front }], plan, {
          guides,
          label: labelFor(pageLabel, where, 'front'),
        }),
        cards: front.length,
        side: 'front',
      });
      pages.push({
        canvas: composeBlocks([{ images: back, slots: plan.backSlots }], plan, {
          guides,
          label: labelFor(pageLabel, where, 'back'),
        }),
        cards: back.length,
        side: 'back',
      });
    } else {
      pages.push({
        canvas: composeBlocks([{ images: front }], plan, {
          guides,
          label: labelFor(pageLabel, where, ''),
        }),
        cards: front.length,
        side: 'front',
      });
    }
  }
  return pages;
}

function labelFor(stem, where, side) {
  if (!stem) return '';
  return [stem, where, side].filter(Boolean).join(' · ');
}
