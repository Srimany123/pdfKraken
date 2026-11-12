// Shared editor state, undo history and small helpers.
//
// Coordinates: every annotation is stored in the PDF user space of its source page (points, y up),
// so page rotation and zoom never touch the stored geometry. Text and images also keep `R`, the
// view rotation they were placed at, so they stay upright the way the user put them.

export const S = {
  sources: [],          // {id, name, bytes:Uint8Array, pdf:PDFDocumentProxy, password, proxies:[PDFPageProxy], hasForm, outline}
  pages: [],            // {uid, src, idx, rot, crop:[x0,y0,x1,y1]|null, anns:[...]}
  images: new Map(),    // id -> {bytes:Uint8Array, mime, w, h, url}
  fonts: new Map(),     // id -> {name, bytes, family}
  meta: null,           // {title, author, subject, keywords}
  name: "document.pdf",
  scale: 1,
  zoomMode: "fit",
  tool: "browse",
  sel: null,            // {uid, id}
  selectedPages: new Set(),
  current: 0,           // index of the page in view
  props: {
    color: "#e11d48", fill: "", width: 2, opacity: 1,
    font: "Helvetica", size: 14, bold: false, italic: false, textColor: "#111111", border: "",
    hl: "#facc15", stamp: "APPROVED", stampColor: "#15803d",
  },
  caps: null,           // processing-server capabilities, or null in browser-only mode
  server: "",           // base URL of the processing server ("" = same origin)
  dirty: false,
};

let n = 0;
export const uid = (p = "x") => p + Date.now().toString(36) + (n++).toString(36);

// ---------------------------------------------------------------- undo / redo
const undo = [], redo = [];
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
function snap() { return JSON.stringify({ pages: S.pages, meta: S.meta }); }
function restore(s) { const o = JSON.parse(s); S.pages = o.pages; S.meta = o.meta; S.sel = null; }
export function commit(what = "edit", opts = {}) {
  // Call BEFORE mutating: records the state to go back to.
  undo.push(snap()); if (undo.length > 200) undo.shift();
  redo.length = 0; S.dirty = true;
  if (!opts.silent) emit(what);
}
export function emit(what, ...args) { for (const fn of listeners) fn(what, ...args); }
export function doUndo() { if (!undo.length) return false; redo.push(snap()); restore(undo.pop()); emit("history"); return true; }
export function doRedo() { if (!redo.length) return false; undo.push(snap()); restore(redo.pop()); emit("history"); return true; }
export const canUndo = () => undo.length > 0;
export const canRedo = () => redo.length > 0;
export function resetHistory() { undo.length = 0; redo.length = 0; S.dirty = false; }

// ---------------------------------------------------------------- helpers
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
export const SVGNS = "http://www.w3.org/2000/svg";
export function sv(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
}
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let statusTimer;
export function status(msg, err = false, ms = 3800) {
  const el = $("#status"); el.textContent = msg; el.classList.toggle("err", err); el.classList.add("show");
  clearTimeout(statusTimer); statusTimer = setTimeout(() => el.classList.remove("show"), err ? Math.max(ms, 6000) : ms);
}
let busyDepth = 0;
export function busy(msg, frac) {
  const el = $("#busy");
  if (msg === false) { busyDepth = Math.max(0, busyDepth - 1); if (!busyDepth) el.hidden = true; return; }
  if (el.hidden) busyDepth++;
  el.hidden = false; $("#busy-msg").textContent = msg || "Working…";
  const bar = $("#busy-bar"); bar.hidden = frac == null; if (frac != null) bar.value = frac;
}
export async function withBusy(msg, fn) {
  busy(msg);
  try { return await fn((m, f) => busy(m, f)); }
  finally { busy(false); }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function download(data, name, type = "application/pdf") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export const baseName = (n) => (n || "document").replace(/\.[^.]+$/, "");
export const fmtBytes = (b) => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(2) + " MB";

// "1-3, 5, 8-" -> [0,1,2,4,7,...] (0-based), within 1..total
export function parseRanges(str, total) {
  const out = [];
  const s = String(str || "").trim();
  if (!s || s.toLowerCase() === "all") return [...Array(total).keys()];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    let a, b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : total; }
    else if (/^\d+$/.test(part)) a = b = +part;
    else if (/^odd$/i.test(part)) { for (let i = 0; i < total; i += 2) out.push(i); continue; }
    else if (/^even$/i.test(part)) { for (let i = 1; i < total; i += 2) out.push(i); continue; }
    else throw new Error(`"${part}" is not a page or range`);
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.push(i - 1);
  }
  return out;
}
// groups for splitting: "1-3, 4-6" -> [[0,1,2],[3,4,5]]
export function parseGroups(str, total) {
  return String(str || "").split(/[,;]+/).map((p) => p.trim()).filter(Boolean).map((p) => parseRanges(p, total)).filter((g) => g.length);
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return { r: 0, g: 0, b: 0 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16 & 255) / 255, g: (v >> 8 & 255) / 255, b: (v & 255) / 255 };
}

// Annotation geometry ------------------------------------------------------------
// Local frame for upright items (text, image): x = right on screen, y = down on screen, at rotation R.
export function frame(R) {
  const r = (R * Math.PI) / 180, fix = (v) => Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v;
  const c = fix(Math.cos(r)), s = fix(Math.sin(r));
  return { right: [c, s], down: [s, -c] };
}
export function localToUser(a, lx, ly) {
  const f = frame(a.R || 0);
  return [a.x + f.right[0] * lx + f.down[0] * ly, a.y + f.right[1] * lx + f.down[1] * ly];
}
// bounding box in user space [x0,y0,x1,y1]
export function bbox(a) {
  switch (a.t) {
    case "rect": case "ellipse": case "hl": case "whiteout": case "redact": return norm(a.r);
    case "line": case "arrow": { const pad = (a.width || 1) / 2 + 2; return [Math.min(a.p[0], a.p[2]) - pad, Math.min(a.p[1], a.p[3]) - pad, Math.max(a.p[0], a.p[2]) + pad, Math.max(a.p[1], a.p[3]) + pad]; }
    case "ink": {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of a.pts) for (let i = 0; i < s.length; i += 2) { x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]); y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]); }
      const pad = (a.width || 1) / 2; return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    }
    case "note": return [a.x, a.y - 20, a.x + 20, a.y];
    case "text": case "image": {
      const cs = [localToUser(a, 0, 0), localToUser(a, a.w, 0), localToUser(a, 0, a.h), localToUser(a, a.w, a.h)];
      const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
  }
  return [0, 0, 0, 0];
}
export const norm = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
export function moveAnn(a, dx, dy) {
  if (a.r) a.r = [a.r[0] + dx, a.r[1] + dy, a.r[2] + dx, a.r[3] + dy];
  if (a.p) a.p = [a.p[0] + dx, a.p[1] + dy, a.p[2] + dx, a.p[3] + dy];
  if (a.pts) a.pts = a.pts.map((s) => s.map((v, i) => v + (i % 2 ? dy : dx)));
  if (a.x != null) { a.x += dx; a.y += dy; }
}

// Fonts ----------------------------------------------------------------------------
export const FONTS = {
  Helvetica: { css: 'Helvetica, Arial, "Liberation Sans", sans-serif' },
  Times: { css: '"Times New Roman", Times, "Liberation Serif", serif' },
  Courier: { css: '"Courier New", Courier, "Liberation Mono", monospace' },
  Unicode: { css: '"PK Unicode", "DejaVu Sans", sans-serif' },
};
export function fontCss(a) {
  if (a.font && a.font.startsWith("custom:")) { const f = S.fonts.get(a.font.slice(7)); if (f) return `"${f.family}", sans-serif`; }
  return (FONTS[a.font] || FONTS.Helvetica).css;
}
// Characters the standard 14 fonts (WinAnsi) can encode.
const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function winAnsiOk(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 10 || c === 13 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255)) continue;
    if (!WINANSI_EXTRA.includes(ch)) return false;
  }
  return true;
}
export const LINE_H = 1.2, ASCENT = 0.8;
const mctx = document.createElement("canvas").getContext("2d");
export function measureText(a) {
  mctx.font = `${a.italic ? "italic " : ""}${a.bold ? "bold " : ""}${a.size}px ${fontCss(a)}`;
  const lines = String(a.text).split("\n");
  const w = Math.max(4, ...lines.map((l) => mctx.measureText(l).width));
  const pad = a.border ? a.size * 0.35 : 0;
  return { w: w + pad * 2, h: lines.length * a.size * LINE_H + pad * 2, pad };
}
