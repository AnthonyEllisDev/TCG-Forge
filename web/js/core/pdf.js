/*
 * A very small PDF writer: one JPEG per page, nothing else.
 *
 * Why this exists at all. An image file cannot state how big it is meant to be
 * on paper, so "print at 100%" is meaningless for a PNG — every printer driver
 * guesses, and the cards come out the wrong size. A PDF carries a MediaBox in
 * points, which is a physical measurement, so a print sheet in this format
 * lands at exactly 2.5 × 3.5 inches per card.
 *
 * The standard-library-only rule leaves no room for a PDF dependency, and this
 * is the smallest thing that does the job honestly: a catalogue, a page tree,
 * and for each page a content stream that paints one DCTDecode (JPEG) image
 * across the whole MediaBox. No fonts, no transparency, no compression beyond
 * the JPEG itself.
 */

/** Decode a `data:image/jpeg;base64,…` URL into raw bytes. */
export function dataURLToBytes(dataURL) {
  const base64 = String(dataURL).slice(String(dataURL).indexOf(',') + 1);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function latin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const escapeText = (value) => String(value).replace(/([\\()])/g, '\\$1');
const pt = (value) => Number(value).toFixed(2);

/**
 * Build a PDF from already-encoded JPEG pages.
 *
 * Each page is `{ jpeg, pixelWidth, pixelHeight, widthPt, heightPt }`: the
 * bytes, the image's own pixel size, and the physical page size in points
 * (1/72 in). The image is stretched over the whole page, which is exactly what
 * a print sheet wants — the sheet canvas was built at the page's proportions.
 */
export function buildPDF(pages, { title = 'Print sheet' } = {}) {
  if (!pages.length) throw new Error('a PDF needs at least one page');

  const chunks = [];
  let length = 0;
  const push = (data) => {
    const buf = typeof data === 'string' ? latin1(data) : data;
    chunks.push(buf);
    length += buf.length;
  };

  const offsets = [];
  const object = (number, body, stream = null) => {
    offsets[number] = length;
    push(`${number} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };

  /* Object numbers: 1 catalogue, 2 page tree, then three per page, then info. */
  const pageNumber = (index) => 3 + index * 3;
  const infoNumber = 3 + pages.length * 3;
  const total = infoNumber + 1;

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [ ` +
      pages.map((_, i) => `${pageNumber(i)} 0 R`).join(' ') +
      ' ] >>'
  );

  pages.forEach((page, index) => {
    const self = pageNumber(index);
    const contents = self + 1;
    const image = self + 2;
    const w = pt(page.widthPt);
    const h = pt(page.heightPt);

    object(
      self,
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${w} ${h} ] ` +
        `/Resources << /XObject << /Im0 ${image} 0 R >> >> ` +
        `/Contents ${contents} 0 R >>`
    );

    const stream = latin1(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`);
    object(contents, `<< /Length ${stream.length} >>`, stream);

    object(
      image,
      '<< /Type /XObject /Subtype /Image ' +
        `/Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
        `/Length ${page.jpeg.length} >>`,
      page.jpeg
    );
  });

  object(
    infoNumber,
    `<< /Title (${escapeText(title)}) /Producer (TCG Forge) /Creator (TCG Forge) >>`
  );

  const xref = length;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n += 1) {
    table += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  push(table);
  push(
    `trailer\n<< /Size ${total} /Root 1 0 R /Info ${infoNumber} 0 R >>\n` +
      `startxref\n${xref}\n%%EOF\n`
  );

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Wrap the bytes back up as a data URL, which is what the export API takes. */
export function pdfDataURL(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return `data:application/pdf;base64,${btoa(binary)}`;
}
