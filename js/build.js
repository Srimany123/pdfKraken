// Export: turns the editor state into a real PDF with pdf-lib.
//
// Normal mode keeps the first document's structure (bookmarks, form fields, metadata, links) and
// re-arranges its page tree; pages from other files are copied in with their forms flattened.
// Objects no longer reachable (deleted pages etc.) are dropped before saving.
// Clean mode (forced when anything is redacted) builds a brand-new file from copies of the pages only.
import { S, frame, localToUser, hexToRgb, winAnsiOk, LINE_H, ASCENT, measureText } from "./state.js";
import { pdfjsLib, openPdf } from "./pdfjs.js";
import { arrowHead } from "./view.js";

const L = () => window.PDFLib;
let unicodeFontBytes = null;
async function unicodeBytes() {
  if (!unicodeFontBytes) unicodeFontBytes = new Uint8Array(await (await fetch(new URL("../vendor/fonts/DejaVuSans.ttf", import.meta.url))).arrayBuffer());
  return unicodeFontBytes;
}
const srcById = (id) => S.sources.find((s) => s.id === id);

export async function sourceBytes(src) {
  // Form values typed into the page live in pdf.js' annotation storage; let pdf.js write them into the file.
  if (src.pdf.annotationStorage.size > 0) {
    try { return new Uint8Array(await src.pdf.saveDocument()); } catch (e) { console.warn("saveDocument failed, using original bytes", e); }
  }
  return src.bytes;
}
async function loadLib(src, flatten) {
  const { PDFDocument } = L();
  const bytes = await sourceBytes(src);
  const opts = { updateMetadata: false, ignoreEncryption: false };
  let doc;
  try { doc = await PDFDocument.load(bytes, src.password != null ? { ...opts, password: src.password } : opts); }
  catch (e) {
    if (/encrypt/i.test(String(e?.message))) doc = await PDFDocument.load(bytes, { ...opts, password: src.password ?? "" });
    else throw e;
  }
  if (flatten) { try { const f = doc.getForm(); if (f.getFields().length) { try { f.updateFieldAppearances(); } catch {} f.flatten(); } } catch (e) { console.warn("flatten", e); } }
  return doc;
}

export function needsClean(pages = S.pages) { return pages.some((p) => p.anns.some((a) => a.t === "redact")); }

/**
 * @param {object} o
 * @param {Array} [o.pages]      subset of S.pages (defaults to all)
 * @param {boolean} [o.clean]    build a fresh file (no bookmarks/forms structure)
 * @param {boolean} [o.flatten]  flatten form fields into the page
 * @param {object} [o.encrypt]   {userPassword, ownerPassword, permissions}
 * @param {boolean} [o.meta]     apply S.meta (default true)
 * @param {function} [o.progress]
 */
export async function buildPdf(o = {}) {
  const { PDFDocument, degrees } = L();
  const pages = o.pages || S.pages;
  if (!pages.length) throw new Error("There are no pages to save.");
  const progress = o.progress || (() => {});
  const clean = !!o.clean || needsClean(pages);
  const primary = srcById(pages[0].src);
  const libs = new Map();
  const lib = async (src) => {
    if (!libs.has(src.id)) libs.set(src.id, await loadLib(src, o.flatten || clean || (src !== primary)));
    return libs.get(src.id);
  };

  let doc;
  const plan = pages.map((p) => ({ p, raster: p.anns.some((a) => a.t === "redact") }));
  if (clean) {
    doc = await PDFDocument.create();
    for (const it of plan) if (!it.raster) { const [pg] = await doc.copyPages(await lib(srcById(it.p.src)), [it.p.idx]); it.page = pg; }
  } else {
    doc = await lib(primary);
    const orig = doc.getPages(), used = new Set();
    for (const it of plan) {
      if (it.raster) continue;
      if (it.p.src === primary.id && !used.has(it.p.idx)) { used.add(it.p.idx); it.page = orig[it.p.idx]; }
    }
    for (const it of plan) if (!it.raster && !it.page) { const [pg] = await doc.copyPages(await lib(srcById(it.p.src)), [it.p.idx]); it.page = pg; }
  }
  // redacted pages: flatten to an image with the areas painted black
  for (let i = 0; i < plan.length; i++) {
    const it = plan[i]; if (!it.raster) continue;
    progress(`Redacting page ${i + 1}…`);
    it.page = await rasterPage(doc, it.p);
  }
  setPageTree(doc, plan.map((it) => it.page));

  const fonts = new Map();
  for (let i = 0; i < plan.length; i++) {
    const { p, page, raster } = plan[i];
    progress(`Writing page ${i + 1} of ${plan.length}…`, i / plan.length);
    const proxy = srcById(p.src).proxies[p.idx];
    const base = raster ? proxy.rotate : page.getRotation().angle;
    page.setRotation(degrees((((base + p.rot) % 360) + 360) % 360));
    if (p.crop) { const [x0, y0, x1, y1] = p.crop; page.setCropBox(x0, y0, x1 - x0, y1 - y0); }
    for (const a of p.anns) await drawAnn(doc, page, a, fonts);
    if (p.ocr?.length) await drawOcr(doc, page, p.ocr, fonts);
  }

  if (o.meta !== false) applyMeta(doc);
  if (!clean) gc(doc);
  if (o.encrypt) doc.encrypt({ algorithm: "AES-256", ...o.encrypt });
  progress("Saving…", 1);
  return await doc.save({ useObjectStreams: true });
}

function applyMeta(doc) {
  const m = S.meta;
  if (m) {
    if (m.title != null) doc.setTitle(m.title, { showInWindowTitleBar: !!m.title });
    if (m.author != null) doc.setAuthor(m.author);
    if (m.subject != null) doc.setSubject(m.subject);
    if (m.keywords != null) doc.setKeywords(String(m.keywords).split(/[,;]\s*/).filter(Boolean));
    if (m.creator != null) doc.setCreator(m.creator);
  }
  doc.setProducer("pdfKraken (pdf.elvoid.com)");
  doc.setModificationDate(new Date());
}

// Replace the document's page tree with a flat one holding exactly these pages, in order.
// Inheritable attributes are copied onto each page first so nothing is lost with the old tree.
function setPageTree(doc, pages) {
  const { PDFName } = L();
  const ctx = doc.context;
  for (const pg of pages) {
    for (const k of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
      const name = PDFName.of(k);
      if (!pg.node.get(name)) { const v = pg.node.getInheritableAttribute?.(name); if (v) pg.node.set(name, v); }
    }
  }
  const tree = L().PDFPageTree.withContext(ctx);
  const treeRef = ctx.register(tree);
  for (const pg of pages) tree.pushLeafNode(pg.ref);
  for (const pg of pages) pg.node.set(PDFName.of("Parent"), treeRef);
  doc.catalog.set(PDFName.of("Pages"), treeRef);
  doc.pageCache?.invalidate?.();
}

// Remove objects nothing points at any more (deleted pages, replaced content, old xref streams).
function gc(doc) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = L();
  const ctx = doc.context, seen = new Set(), stack = [];
  const t = ctx.trailerInfo;
  for (const r of [t.Root, t.Info, t.ID]) if (r) stack.push(r);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) { const k = o.tag || o.toString(); if (seen.has(k)) continue; seen.add(k); const v = ctx.lookup(o); if (v) stack.push(v); }
    else if (o instanceof PDFDict) { for (const [, v] of o.entries()) stack.push(v); }
    else if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) stack.push(o.get(i)); }
    else if (o instanceof PDFStream) stack.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag || ref.toString())) ctx.delete(ref);
}

async function rasterPage(doc, p) {
  const src = srcById(p.src), proxy = src.proxies[p.idx];
  const dpi = S.redactDpi || 200, vp = proxy.getViewport({ scale: dpi / 72, rotation: 0 });
  const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await proxy.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
  ctx.fillStyle = "#000";
  for (const a of p.anns) if (a.t === "redact") {
    const q = vp.convertToViewportPoint(a.r[0], a.r[1]), r = vp.convertToViewportPoint(a.r[2], a.r[3]);
    ctx.fillRect(Math.min(q[0], r[0]) - 1, Math.min(q[1], r[1]) - 1, Math.abs(r[0] - q[0]) + 2, Math.abs(r[1] - q[1]) + 2);
  }
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const [x0, y0, x1, y1] = proxy.view;
  const page = L().PDFPage.create(doc);
  page.setMediaBox(x0, y0, x1 - x0, y1 - y0);
  page.drawImage(img, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  return page;
}

// ---------------------------------------------------------------- drawing
const col = (hex) => { const { r, g, b } = hexToRgb(hex); return L().rgb(r, g, b); };
const STD = {
  Helvetica: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  Times: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  Courier: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
};
export async function fontFor(doc, a, fonts) {
  let key = a.font || "Helvetica";
  if (STD[key] && !winAnsiOk(a.text)) key = "Unicode";
  const variant = (a.bold ? 1 : 0) + (a.italic ? 2 : 0);
  const k = STD[key] ? key + variant : key;
  if (fonts.has(k)) return fonts.get(k);
  let f;
  if (STD[key]) f = await doc.embedFont(L().StandardFonts[STD[key][variant]]);
  else {
    doc.registerFontkit(window.fontkit);
    const bytes = key.startsWith("custom:") ? S.fonts.get(key.slice(7))?.bytes : await unicodeBytes();
    f = await doc.embedFont(bytes || (await unicodeBytes()), { subset: true });
  }
  fonts.set(k, f);
  return f;
}
const svgPath = (pts) => pts.map((q, i) => (i ? "L" : "M") + q[0] + " " + -q[1]).join(" ");
function inkSvg(s) {
  // same smoothing as the on-screen path, with y flipped for drawSvgPath
  if (s.length < 4) return `M${s[0]} ${-s[1]} L${s[0] + 0.01} ${-s[1]}`;
  let d = `M${s[0]} ${-s[1]}`;
  for (let i = 2; i < s.length - 2; i += 2) { const mx = (s[i] + s[i + 2]) / 2, my = (s[i + 1] + s[i + 3]) / 2; d += ` Q${s[i]} ${-s[i + 1]} ${mx} ${-my}`; }
  return d + ` L${s[s.length - 2]} ${-s[s.length - 1]}`;
}

async function drawAnn(doc, page, a, fonts) {
  const { degrees, BlendMode, LineCapStyle, PDFHexString, PDFString } = L();
  const op = a.opacity ?? 1;
  switch (a.t) {
    case "rect": case "whiteout": case "hl": {
      const [x0, y0, x1, y1] = a.r;
      const o = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      if (a.t === "whiteout") page.drawRectangle({ ...o, color: col(a.fill || "#ffffff"), borderWidth: 0 });
      else if (a.t === "hl") page.drawRectangle({ ...o, color: col(a.color), opacity: a.opacity ?? 0.45, borderWidth: 0, blendMode: BlendMode.Multiply });
      else page.drawRectangle({ ...o, color: a.fill ? col(a.fill) : undefined, opacity: op, borderColor: a.color ? col(a.color) : undefined, borderWidth: a.color ? a.width : 0, borderOpacity: op });
      break;
    }
    case "ellipse": {
      const [x0, y0, x1, y1] = a.r;
      page.drawEllipse({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, xScale: (x1 - x0) / 2, yScale: (y1 - y0) / 2, color: a.fill ? col(a.fill) : undefined, opacity: op, borderColor: a.color ? col(a.color) : undefined, borderWidth: a.color ? a.width : 0, borderOpacity: op });
      break;
    }
    case "line": case "arrow": {
      page.drawLine({ start: { x: a.p[0], y: a.p[1] }, end: { x: a.p[2], y: a.p[3] }, thickness: a.width, color: col(a.color), opacity: op, lineCap: LineCapStyle.Round });
      if (a.t === "arrow") page.drawSvgPath(svgPath(arrowHead(a)) + " Z", { x: 0, y: 0, color: col(a.color), opacity: op, borderWidth: 0 });
      break;
    }
    case "ink": {
      for (const s of a.pts) page.drawSvgPath(inkSvg(s), { x: 0, y: 0, borderColor: col(a.color), borderWidth: a.width, borderOpacity: op, borderLineCap: LineCapStyle.Round });
      break;
    }
    case "text": {
      if (!String(a.text).trim()) break;
      const f = frame(a.R || 0), font = await fontFor(doc, a, fonts);
      const m = a.w ? a : { ...a, ...measureText(a) };
      if (a.bg || a.border) {
        const bl = localToUser(a, a.border ? a.size * 0.12 : 0, m.h - (a.border ? a.size * 0.12 : 0));
        const inset = a.border ? a.size * 0.24 : 0;
        if (a.bg) { const b0 = localToUser(a, 0, m.h); page.drawRectangle({ x: b0[0], y: b0[1], width: m.w, height: m.h, rotate: degrees(a.R || 0), color: col(a.bg), opacity: op, borderWidth: 0 }); }
        if (a.border) page.drawRectangle({ x: bl[0], y: bl[1], width: m.w - inset, height: m.h - inset, rotate: degrees(a.R || 0), borderColor: col(a.border), borderWidth: Math.max(1, a.size / 12), borderOpacity: op });
      }
      const pad = a.border ? a.size * 0.35 : 0;
      String(a.text).split("\n").forEach((line, i) => {
        if (!line) return;
        const [x, y] = localToUser(a, pad, pad + a.size * (ASCENT + i * LINE_H));
        let txt = line;
        try { font.encodeText(txt); } catch { txt = [...line].map((ch) => { try { font.encodeText(ch); return ch; } catch { return "?"; } }).join(""); }
        page.drawText(txt, { x, y, size: a.size, font, color: col(a.color || "#000000"), opacity: op, rotate: degrees(a.R || 0) });
      });
      void f;
      break;
    }
    case "image": {
      const im = S.images.get(a.img); if (!im) break;
      const key = "img:" + a.img;
      let emb = fonts.get(key);
      if (!emb) { emb = im.mime === "image/jpeg" ? await doc.embedJpg(im.bytes) : await doc.embedPng(im.bytes); fonts.set(key, emb); }
      const [x, y] = localToUser(a, 0, a.h);
      page.drawImage(emb, { x, y, width: a.w, height: a.h, rotate: degrees(a.R || 0), opacity: op });
      break;
    }
    case "note": {
      const ctx = doc.context, c = hexToRgb(a.color || "#facc15");
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Text", Rect: [a.x, a.y - 20, a.x + 20, a.y], Name: "Comment", F: 4, Open: false,
        C: [c.r, c.g, c.b], Contents: PDFHexString.fromText(a.text || ""), T: PDFHexString.fromText(a.author || "pdfKraken"),
        M: PDFString.fromDate(new Date()),
      });
      page.node.addAnnot(ctx.register(annot));
      break;
    }
  }
}

// invisible OCR text so scanned pages become searchable/selectable
async function drawOcr(doc, page, words, fonts) {
  const { pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode } = L();
  const font = await fontFor(doc, { font: "Helvetica", text: "a" }, fonts);
  const ufont = await fontFor(doc, { font: "Unicode", text: "a" }, fonts);
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
  for (const w of words) {
    const f = winAnsiOk(w.text) ? font : ufont;
    let size = w.h * 0.9;
    const width = f.widthOfTextAtSize(w.text, size);
    if (width > 0) size = Math.min(size * 1.4, size * (w.w / width));
    try { page.drawText(w.text, { x: w.x, y: w.y, size: Math.max(1, size), font: f }); } catch {}
  }
  page.pushOperators(popGraphicsState());
}

// Build, then load the result back with pdf.js (for rendering previews / images / text export).
export async function buildAndOpen(o) {
  const bytes = await buildPdf(o);
  return { bytes, pdf: await openPdf(bytes) };
}
