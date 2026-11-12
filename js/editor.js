// Editing tools: pointer interaction on the overlay, selection, inline text editing and the properties panel.
import { S, $, $$, h, sv, uid, commit, emit, status, bbox, norm, moveAnn, frame, localToUser, measureText, FONTS, clamp } from "./state.js";
import { viewOf, viewport, renderOverlay, overlayHooks, textItems, proxyOf, rotationOf, screenBox, toScreen, drawAnn } from "./view.js";

const TOOL_INFO = {
  browse: ["Browse", "Select and copy text, follow links and fill in form fields directly on the page."],
  select: ["Select", "Click an object to select it. Drag to move, drag a corner to resize. Double-click text to edit it. Arrow keys nudge, Delete removes."],
  text: ["Add text", "Click where the text should start, then type. Click outside to finish."],
  edittext: ["Edit text", "Click a line of existing text to replace it. The original is covered and your new text is placed on top. To truly remove text, use Redact."],
  highlight: ["Highlight", "Drag across text to highlight it line by line, or drag over an empty area for a highlight box."],
  ink: ["Draw", "Draw freehand with the mouse, pen or finger."],
  rect: ["Box", "Drag to draw a rectangle."],
  ellipse: ["Ellipse", "Drag to draw an ellipse."],
  line: ["Line", "Drag to draw a straight line. Hold Shift to snap to 45°."],
  arrow: ["Arrow", "Drag from the tail to the point of the arrow. Hold Shift to snap to 45°."],
  image: ["Image", "Click on a page and pick an image to place there."],
  sign: ["Signature", "Pick or create a signature, then click on the page to place it."],
  stamp: ["Stamp", "Pick a stamp, then click on the page to place it."],
  note: ["Note", "Click to drop a sticky-note comment. It is saved as a real PDF comment that other viewers show."],
  whiteout: ["Whiteout", "Drag to cover content with a solid box. The content underneath still exists in the file — use Redact for sensitive information."],
  redact: ["Redact", "Drag over anything that must be removed for good. On download, each redacted page is flattened to an image with the areas blacked out, so the hidden text cannot be recovered."],
  crop: ["Crop", "Drag the area of the page to keep."],
};
const SWATCHES = ["#111111", "#ffffff", "#e11d48", "#ea580c", "#facc15", "#16a34a", "#0ea5e9", "#2563eb", "#7c3aed", "#db2777"];
const HL_SWATCHES = ["#facc15", "#86efac", "#7dd3fc", "#f9a8d4", "#fdba74", "#c4b5fd"];
export const STAMPS = ["APPROVED", "REJECTED", "DRAFT", "CONFIDENTIAL", "FINAL", "PAID", "RECEIVED", "REVIEWED", "COPY", "VOID"];

let drag = null;       // current pointer interaction
let hover = null;      // edittext hover {uid, item}
let clipboard = null;
let pendingImage = null; // {img, w, h} waiting for a click
let editing = null;    // {uid, id, ta}

const findPage = (uid) => S.pages.find((p) => p.uid === uid);
const findAnn = (p, id) => p?.anns.find((a) => a.id === id);
export function selected() { if (!S.sel) return null; const p = findPage(S.sel.uid); const a = findAnn(p, S.sel.id); return a ? { p, a } : null; }

export function setTool(t) {
  finishEdit();
  if (t !== "select") select(null, false);
  S.tool = t;
  document.body.className = document.body.className.replace(/\bt-\w+/g, "").trim() + " t-" + t;
  $$("#toolstrip button").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  hover = null;
  for (const p of S.pages) renderOverlay(p.uid);
  renderProps();
}
export function select(sel, render = true) {
  const prev = S.sel; S.sel = sel;
  if (render) { if (prev) renderOverlay(prev.uid); if (sel && sel.uid !== prev?.uid) renderOverlay(sel.uid); renderProps(); }
}

// ---------------------------------------------------------------- overlay decorations (selection, hover, previews)
overlayHooks.extra = (p, v, gs, gu, vp) => {
  if (drag?.preview && drag.uid === p.uid) gu.append(drag.preview());
  if (hover && hover.uid === p.uid && S.tool === "edittext") {
    const b = screenBox(vp, hover.item.box);
    gs.append(sv("rect", { class: "ti-hover", x: b[0] - 1, y: b[1] - 1, width: b[2] - b[0] + 2, height: b[3] - b[1] + 2, rx: 2 }));
  }
  if (S.searchHits) for (const hit of S.searchHits) if (hit.uid === p.uid) for (const r of hit.rects) {
    const b = screenBox(vp, r);
    gs.append(sv("rect", { class: "search-hit" + (hit === S.searchCur ? " cur" : ""), x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] }));
  }
  const s = selected();
  if (s && s.p.uid === p.uid && S.tool === "select") {
    const b = screenBox(vp, bbox(s.a));
    gs.append(sv("rect", { class: "selbox", x: b[0] - 3, y: b[1] - 3, width: b[2] - b[0] + 6, height: b[3] - b[1] + 6 }));
    for (const hd of handles(s.a, vp)) gs.append(sv("rect", { class: "handle", x: hd.x - 4.5, y: hd.y - 4.5, width: 9, height: 9, "data-h": hd.k, style: `cursor:${hd.cursor}` }));
  }
};
function handles(a, vp) {
  if (a.t === "ink" || a.t === "note") return [];
  if (a.t === "line" || a.t === "arrow") {
    const s = toScreen(vp, a.p[0], a.p[1]), e = toScreen(vp, a.p[2], a.p[3]);
    return [{ k: "p0", x: s[0], y: s[1], cursor: "crosshair" }, { k: "p1", x: e[0], y: e[1], cursor: "crosshair" }];
  }
  const b = screenBox(vp, bbox(a));
  return [{ k: "nw", x: b[0], y: b[1], cursor: "nwse-resize" }, { k: "ne", x: b[2], y: b[1], cursor: "nesw-resize" }, { k: "sw", x: b[0], y: b[3], cursor: "nesw-resize" }, { k: "se", x: b[2], y: b[3], cursor: "nwse-resize" }];
}

// ---------------------------------------------------------------- pointer handling
function pageFromEvent(e) {
  const el = e.target.closest?.(".page"); if (!el) return null;
  const p = findPage(el.dataset.uid), v = viewOf(el.dataset.uid);
  if (!p || !v) return null;
  const r = el.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const vp = v.vp || viewport(p);
  const [x, y] = vp.convertToPdfPoint(sx, sy);
  return { p, v, vp, sx, sy, x, y };
}
function hitTest(p, x, y, vp) {
  const tol = 5 / vp.scale;
  for (let i = p.anns.length - 1; i >= 0; i--) {
    const a = p.anns[i], b = bbox(a);
    if (x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol) {
      if (a.t === "line" || a.t === "arrow") { if (distSeg(x, y, a.p) > tol + a.width) continue; }
      return a;
    }
  }
  return null;
}
function distSeg(x, y, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy || 1;
  const t = clamp(((x - x1) * dx + (y - y1) * dy) / L, 0, 1);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
const P = () => S.props;
function newAnn(t, extra) { return { id: uid("a"), t, ...extra }; }
function addAnn(p, a, sel = true) {
  commit("ann"); p.anns.push(a);
  renderOverlay(p.uid);
  if (sel) { S.sel = { uid: p.uid, id: a.id }; renderProps(); }
  return a;
}

export function bindPointer(root) {
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", () => { drag = null; });
  root.addEventListener("dblclick", onDbl);
}
function onDown(e) {
  if (S.tool === "browse" || e.button > 0) return;
  if (e.target.closest(".inline-edit")) return;
  const hit = pageFromEvent(e); if (!hit) return;
  const { p, x, y, vp } = hit;
  if (editing) { finishEdit(); if (S.tool === "text") return; }
  e.preventDefault();
  const pr = P();
  switch (S.tool) {
    case "select": {
      const hk = e.target.dataset?.h;
      const s = selected();
      if (hk && s && s.p.uid === p.uid) { drag = { kind: "resize", uid: p.uid, k: hk, orig: structuredClone(s.a), x0: x, y0: y, committed: false }; break; }
      const a = hitTest(p, x, y, vp);
      select(a ? { uid: p.uid, id: a.id } : null);
      if (a) drag = { kind: "move", uid: p.uid, x0: x, y0: y, lx: x, ly: y, committed: false };
      break;
    }
    case "text": {
      const R = rotationOf(p);
      const a = newAnn("text", { x, y, R, text: "", size: pr.size, font: pr.font, bold: pr.bold, italic: pr.italic, color: pr.textColor, w: 10, h: pr.size * 1.2 });
      // put the click point at the middle of the first line
      const f = frame(R); a.x -= f.down[0] * pr.size * 0.6; a.y -= f.down[1] * pr.size * 0.6;
      addAnn(p, a); startEdit(p, a, true);
      break;
    }
    case "edittext": { editExisting(hit); break; }
    case "stamp": {
      const a = newAnn("text", { x, y, R: rotationOf(p), text: pr.stamp, size: 22, font: "Helvetica", bold: true, color: pr.stampColor, border: pr.stampColor, opacity: 0.9 });
      Object.assign(a, measureText(a)); centerOn(a, x, y);
      addAnn(p, a); setTool("select"); select({ uid: p.uid, id: a.id });
      break;
    }
    case "note": {
      const a = newAnn("note", { x: x - 10, y: y + 10, text: "", color: "#facc15", author: localStorage.getItem("pk-author") || "" });
      addAnn(p, a); setTool("select"); select({ uid: p.uid, id: a.id });
      setTimeout(() => $("#prop-note")?.focus(), 30);
      break;
    }
    case "image": case "sign": {
      if (pendingImage && pendingImage.tool === S.tool) { const im = pendingImage; if (S.tool === "image") pendingImage = null; placeImage(p, im, x, y); }
      else if (S.tool === "image") pickImage((img) => placeImage(p, img, x, y));
      else emit("need-signature");
      break;
    }
    case "ink": {
      const pts = [x, y];
      drag = { kind: "ink", uid: p.uid, pts, preview: () => { const el = sv("path", { d: inkD(pts), stroke: pr.color, "stroke-width": pr.width, fill: "none", opacity: pr.opacity }); return el; } };
      break;
    }
    default: { // drag shapes
      drag = { kind: "shape", uid: p.uid, x0: x, y0: y, x1: x, y1: y, preview: () => shapePreview(drag) };
    }
  }
  if (drag) { try { hit.v.svg.setPointerCapture(e.pointerId); } catch {} }
}
function inkD(pts) { let d = `M${pts[0]} ${pts[1]}`; for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`; return d; }
function shapeAnn(d) {
  const pr = P(), r = norm([d.x0, d.y0, d.x1, d.y1]);
  switch (S.tool) {
    case "rect": return newAnn("rect", { r, color: pr.color, fill: pr.fill, width: pr.width, opacity: pr.opacity });
    case "ellipse": return newAnn("ellipse", { r, color: pr.color, fill: pr.fill, width: pr.width, opacity: pr.opacity });
    case "line": case "arrow": return newAnn(S.tool, { p: [d.x0, d.y0, d.x1, d.y1], color: pr.color, width: pr.width, opacity: pr.opacity });
    case "highlight": return newAnn("hl", { r, color: pr.hl, opacity: 0.45 });
    case "whiteout": return newAnn("whiteout", { r, fill: pr.whiteFill || "#ffffff" });
    case "redact": return newAnn("redact", { r });
    case "crop": return { t: "cropbox", r };
  }
}
function shapePreview(d) {
  const a = shapeAnn(d); if (!a) return sv("g");
  if (a.t === "cropbox") { const [x0, y0, x1, y1] = a.r; return sv("rect", { class: "crop-edge", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }); }
  return drawAnn(a);
}

function onMove(e) {
  if (S.tool === "edittext" && !drag) { hoverText(e); return; }
  if (!drag) return;
  const hit = pageFromEvent(e);
  const p = findPage(drag.uid), v = viewOf(drag.uid); if (!p || !v) return;
  let x, y;
  if (hit && hit.p.uid === drag.uid) ({ x, y } = hit);
  else { const r = v.el.getBoundingClientRect(); [x, y] = (v.vp || viewport(p)).convertToPdfPoint(e.clientX - r.left, e.clientY - r.top); }
  if (drag.kind === "ink") {
    const n = drag.pts.length, dx = x - drag.pts[n - 2], dy = y - drag.pts[n - 1];
    if (dx * dx + dy * dy > (1.2 / (v.vp?.scale || 1)) ** 2) drag.pts.push(x, y);
  } else if (drag.kind === "shape") {
    if (e.shiftKey && (S.tool === "line" || S.tool === "arrow")) {
      const dx = x - drag.x0, dy = y - drag.y0, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(dx, dy);
      x = drag.x0 + L * Math.cos(ang); y = drag.y0 + L * Math.sin(ang);
    } else if (e.shiftKey && (S.tool === "rect" || S.tool === "ellipse")) {
      const m = Math.max(Math.abs(x - drag.x0), Math.abs(y - drag.y0)); x = drag.x0 + Math.sign(x - drag.x0 || 1) * m; y = drag.y0 + Math.sign(y - drag.y0 || 1) * m;
    }
    drag.x1 = x; drag.y1 = y;
  } else {
    const s = selected(); if (!s) return;
    if (!drag.committed) { if (Math.hypot(x - drag.x0, y - drag.y0) < 1 / (v.vp?.scale || 1)) return; commit("move", { silent: true }); drag.committed = true; }
    if (drag.kind === "move") { moveAnn(s.a, x - drag.lx, y - drag.ly); drag.lx = x; drag.ly = y; }
    else resize(s.a, drag, x, y, e.shiftKey);
  }
  renderOverlay(drag.uid);
}
function resize(a, d, x, y, free) {
  const o = d.orig;
  if (d.k === "p0") { a.p = [x, y, o.p[2], o.p[3]]; return; }
  if (d.k === "p1") { a.p = [o.p[0], o.p[1], x, y]; return; }
  const b = bbox(o);
  // the corner opposite to the grabbed handle (in screen terms) stays fixed: find it in user space
  const v = viewOf(d.uid), vp = v.vp;
  const sb = screenBox(vp, b);
  const opp = { nw: [sb[2], sb[3]], ne: [sb[0], sb[3]], sw: [sb[2], sb[1]], se: [sb[0], sb[1]] }[d.k];
  const [fx, fy] = vp.convertToPdfPoint(opp[0], opp[1]);
  if (o.r) { a.r = norm([fx, fy, x, y]); return; }
  if (a.t === "text" || a.t === "image") {
    const ow = b[2] - b[0], oh = b[3] - b[1];
    let k = Math.max(Math.abs(x - fx) / (ow || 1), Math.abs(y - fy) / (oh || 1));
    k = clamp(k, 0.05, 40);
    if (a.t === "text") {
      a.size = Math.max(2, Math.round(o.size * k * 10) / 10); Object.assign(a, measureText(a));
    } else if (free) {
      const kx = Math.abs(x - fx) / (ow || 1), ky = Math.abs(y - fy) / (oh || 1);
      const swap = Math.abs(frame(a.R).right[1]) > 0.5; // rotated 90/270: local w runs along user y
      a.w = Math.max(4, o.w * (swap ? ky : kx)); a.h = Math.max(4, o.h * (swap ? kx : ky));
    } else { a.w = Math.max(4, o.w * k); a.h = Math.max(4, o.h * k); }
    // keep the fixed corner where it was
    const nb = bbox(a), ob = norm([fx, fy, fx, fy]);
    const cornerX = fx <= (b[0] + b[2]) / 2 ? nb[0] : nb[2], cornerY = fy <= (b[1] + b[3]) / 2 ? nb[1] : nb[3];
    moveAnn(a, ob[0] - cornerX, ob[1] - cornerY);
  }
}
async function onUp(e) {
  const d = drag; drag = null;
  if (!d) return;
  const p = findPage(d.uid); if (!p) return;
  if (d.kind === "ink") {
    if (d.pts.length >= 2) addAnn(p, newAnn("ink", { pts: [simplify(d.pts, 0.35)], color: P().color, width: P().width, opacity: P().opacity }), false);
    else renderOverlay(p.uid);
  } else if (d.kind === "shape") {
    const big = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > 3;
    if (S.tool === "highlight") {
      const rects = await textHighlight(p, d);
      if (rects.length) {
        commit("ann");
        for (const r of rects) p.anns.push(newAnn("hl", { r, color: P().hl, opacity: 0.45 }));
        renderOverlay(p.uid);
      } else if (big) addAnn(p, shapeAnn(d), false);
      else renderOverlay(p.uid);
    } else if (S.tool === "crop") {
      if (big) { commit("crop"); p.crop = norm([d.x0, d.y0, d.x1, d.y1]); renderProps(); emit("pages"); }
      renderOverlay(p.uid);
    } else if (big) addAnn(p, shapeAnn(d), false);
    else renderOverlay(p.uid);
  } else if (d.committed) { emit("ann"); renderProps(); }
}
function simplify(pts, eps) { // radial distance thinning
  if (pts.length <= 4) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    const dx = pts[i] - out[out.length - 2], dy = pts[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= eps * eps) out.push(pts[i], pts[i + 1]);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out.map((v) => Math.round(v * 100) / 100);
}
function onDbl(e) {
  if (S.tool !== "select") return;
  const hit = pageFromEvent(e); if (!hit) return;
  const a = hitTest(hit.p, hit.x, hit.y, hit.vp);
  if (a?.t === "text") startEdit(hit.p, a);
  else if (a?.t === "note") $("#prop-note")?.focus();
}

// smart highlight: follow lines of text between the drag start and end
async function textHighlight(p, d) {
  const items = (await textItems(p)).filter((it) => Math.abs(it.R % 360) < 1);
  if (!items.length) return [];
  const yTop = Math.max(d.y0, d.y1), yBot = Math.min(d.y0, d.y1);
  const lines = [];
  for (const it of items) {
    const [x0, y0, x1, y1] = it.box;
    if (y1 < yBot || y0 > yTop) continue;
    let ln = lines.find((l) => Math.abs(l.base - it.b[1]) < it.size * 0.5);
    if (!ln) lines.push(ln = { base: it.b[1], x0, x1, y0, y1 });
    else { ln.x0 = Math.min(ln.x0, x0); ln.x1 = Math.max(ln.x1, x1); ln.y0 = Math.min(ln.y0, y0); ln.y1 = Math.max(ln.y1, y1); }
  }
  if (!lines.length) return [];
  lines.sort((a, b) => b.base - a.base);
  const start = d.y0 >= d.y1 ? [d.x0, d.y0] : [d.x1, d.y1], end = d.y0 >= d.y1 ? [d.x1, d.y1] : [d.x0, d.y0];
  if (lines.length === 1) {
    const l = lines[0], a = Math.max(l.x0, Math.min(d.x0, d.x1)), b = Math.min(l.x1, Math.max(d.x0, d.x1));
    return b - a > 1 ? [[a, l.y0, b, l.y1]] : [];
  }
  return lines.map((l, i) => {
    const a = i === 0 ? Math.max(l.x0, start[0]) : l.x0, b = i === lines.length - 1 ? Math.min(l.x1, end[0]) : l.x1;
    return b - a > 1 ? [a, l.y0, b, l.y1] : null;
  }).filter(Boolean);
}

// ---------------------------------------------------------------- edit existing text
async function hoverText(e) {
  const hit = pageFromEvent(e);
  let item = null;
  if (hit) {
    const items = await textItems(hit.p);
    item = items.find((it) => hit.x >= it.box[0] && hit.x <= it.box[2] && hit.y >= it.box[1] && hit.y <= it.box[3]) || null;
  }
  const prev = hover;
  hover = item ? { uid: hit.p.uid, item } : null;
  if (prev?.item !== hover?.item) { if (prev) renderOverlay(prev.uid); if (hover && hover.uid !== prev?.uid) renderOverlay(hover.uid); }
}
async function editExisting({ p, v, x, y, vp }) {
  const items = await textItems(p);
  const it = items.find((t) => x >= t.box[0] && x <= t.box[2] && y >= t.box[1] && y <= t.box[3]);
  if (!it) { status("Click directly on a line of text to edit it."); return; }
  let fam = "Helvetica", bold = false, italic = false;
  try {
    const fobj = proxyOf(p).commonObjs.get(it.font); const n = (fobj?.name || "") + " " + (fobj?.loadedName || "");
    if (/times|serif|roman|georgia|garamond|cambria|minion|book/i.test(n) && !/sans/i.test(n)) fam = "Times";
    else if (/courier|mono|consol/i.test(n)) fam = "Courier";
    bold = /bold|black|heavy|semibold|demi/i.test(n); italic = /italic|oblique/i.test(n);
  } catch { if (it.style?.fontFamily === "serif") fam = "Times"; else if (it.style?.fontFamily === "monospace") fam = "Courier"; }
  const cover = sampleColor(v, vp, it.box);
  const f = frame(it.R);
  const a = newAnn("text", { x: it.b[0] - f.down[0] * it.size * 0.8, y: it.b[1] - f.down[1] * it.size * 0.8, R: it.R, text: it.str, size: Math.round(it.size * 10) / 10, font: fam, bold, italic, color: inkColor(v, vp, it.box) });
  Object.assign(a, measureText(a));
  const pad = it.size * 0.06;
  const w = newAnn("whiteout", { r: [it.box[0] - pad, it.box[1] - pad, it.box[2] + pad, it.box[3] + pad], fill: cover, cover: a.id });
  commit("edittext");
  p.anns.push(w, a);
  S.sel = { uid: p.uid, id: a.id };
  renderOverlay(p.uid); renderProps();
  startEdit(p, a, false, true);
}
function canvasPx(v, vp, ux, uy) {
  const [sx, sy] = vp.convertToViewportPoint(ux, uy);
  const k = v.canvas.width / vp.width;
  return [Math.round(sx * k), Math.round(sy * k)];
}
function sampleColor(v, vp, box) {
  try {
    const ctx = v.canvas.getContext("2d", { willReadFrequently: true });
    const pts = [[box[0] - 2, box[1] - 2], [box[2] + 2, box[1] - 2], [box[0] - 2, box[3] + 2], [box[2] + 2, box[3] + 2]];
    const cols = pts.map(([ux, uy]) => { const [cx, cy] = canvasPx(v, vp, ux, uy); return ctx.getImageData(clamp(cx, 0, v.canvas.width - 1), clamp(cy, 0, v.canvas.height - 1), 1, 1).data; });
    const avg = [0, 1, 2].map((i) => Math.round(cols.reduce((s, c) => s + c[i], 0) / cols.length));
    return "#" + avg.map((c) => c.toString(16).padStart(2, "0")).join("");
  } catch { return "#ffffff"; }
}
function inkColor(v, vp, box) {
  // darkest pixel inside the text box approximates the text colour
  try {
    const ctx = v.canvas.getContext("2d", { willReadFrequently: true });
    const [ax, ay] = canvasPx(v, vp, box[0], box[1]), [bx, by] = canvasPx(v, vp, box[2], box[3]);
    const x0 = clamp(Math.min(ax, bx), 0, v.canvas.width - 1), y0 = clamp(Math.min(ay, by), 0, v.canvas.height - 1);
    const w = clamp(Math.abs(bx - ax), 1, v.canvas.width - x0), hh = clamp(Math.abs(by - ay), 1, v.canvas.height - y0);
    const d = ctx.getImageData(x0, y0, w, hh).data;
    let best = 766, col = [17, 17, 17];
    for (let i = 0; i < d.length; i += 16) { const s = d[i] + d[i + 1] + d[i + 2]; if (s < best) { best = s; col = [d[i], d[i + 1], d[i + 2]]; } }
    return "#" + col.map((c) => c.toString(16).padStart(2, "0")).join("");
  } catch { return "#111111"; }
}
function centerOn(a, x, y) {
  const f = frame(a.R || 0);
  a.x = x - f.right[0] * a.w / 2 - f.down[0] * a.h / 2; a.y = y - f.right[1] * a.w / 2 - f.down[1] * a.h / 2;
}

// ---------------------------------------------------------------- images
export function pickImage(cb) {
  const inp = $("#file-any"); inp.accept = "image/*"; inp.multiple = false;
  inp.onchange = async () => { const f = inp.files[0]; inp.value = ""; if (f) cb(await loadImage(f)); };
  inp.click();
}
export async function loadImage(fileOrBlob) {
  const blob = fileOrBlob;
  const bmp = await createImageBitmap(blob);
  let bytes, mime = blob.type;
  if (mime === "image/png" || mime === "image/jpeg") bytes = new Uint8Array(await blob.arrayBuffer());
  else { // convert anything else to PNG
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; c.getContext("2d").drawImage(bmp, 0, 0);
    const png = await new Promise((r) => c.toBlob(r, "image/png")); bytes = new Uint8Array(await png.arrayBuffer()); mime = "image/png";
  }
  const id = uid("img");
  S.images.set(id, { bytes, mime, w: bmp.width, h: bmp.height, url: URL.createObjectURL(new Blob([bytes], { type: mime })) });
  return { img: id, w: bmp.width, h: bmp.height };
}
export function placeImage(p, im, x, y, maxW = 220) {
  const vp1 = viewport(p, 1);
  const k = Math.min(maxW / im.w, (vp1.height * 0.6) / im.h, 1.5);
  const a = newAnn("image", { img: im.img, R: rotationOf(p), w: im.w * k, h: im.h * k, x, y });
  centerOn(a, x, y);
  addAnn(p, a); setTool("select"); select({ uid: p.uid, id: a.id });
}
export function armImage(im, tool = "sign") { pendingImage = { ...im, tool }; }

// ---------------------------------------------------------------- inline text editing
export function startEdit(p, a, isNew = false, selectAll = false) {
  finishEdit();
  const v = viewOf(p.uid); if (!v) return;
  const vp = v.vp;
  if (Math.abs(((a.R || 0) - rotationOf(p)) % 360) > 0.5) { renderProps(); setTimeout(() => $("#prop-text")?.focus(), 20); return; }
  const [sx, sy] = vp.convertToViewportPoint(a.x, a.y);
  const ta = h("textarea", { class: "inline-edit", spellcheck: "true", "aria-label": "Text" });
  const pad = a.border ? a.size * 0.35 : 0;
  Object.assign(ta.style, {
    left: sx + pad * vp.scale + "px", top: sy + pad * vp.scale + "px", fontSize: a.size * vp.scale + "px",
    fontFamily: FONTS[a.font]?.css || "sans-serif", fontWeight: a.bold ? "bold" : "normal", fontStyle: a.italic ? "italic" : "normal", color: a.color,
  });
  ta.value = a.text;
  const fit = () => { ta.style.width = "10px"; ta.style.height = "10px"; ta.style.width = ta.scrollWidth + a.size * vp.scale + "px"; ta.style.height = ta.scrollHeight + "px"; };
  let first = true;
  ta.addEventListener("input", () => {
    if (first && !isNew) commit("text", { silent: true });
    first = false;
    a.text = ta.value; Object.assign(a, measureText(a)); fit();
    renderOverlay(p.uid);
    const pt = $("#prop-text"); if (pt && pt !== document.activeElement) pt.value = a.text;
  });
  ta.addEventListener("keydown", (e) => { if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishEdit(); } e.stopPropagation(); });
  ta.addEventListener("blur", () => setTimeout(() => { if (editing?.ta === ta) finishEdit(); }, 0));
  v.el.append(ta);
  editing = { uid: p.uid, id: a.id, ta };
  // hide the svg copy while typing
  v.svg.querySelector(`[data-id="${a.id}"]`)?.setAttribute("visibility", "hidden");
  fit(); ta.focus(); if (selectAll) ta.select();
}
export function finishEdit() {
  if (!editing) return;
  const { uid: u, id, ta } = editing; editing = null;
  ta.remove();
  const p = findPage(u), a = findAnn(p, id);
  if (a && !a.text.trim()) {
    p.anns = p.anns.filter((x) => x !== a);
  }
  if (p) renderOverlay(u);
  emit("ann"); renderProps();
}
export const isEditing = () => !!editing;

// ---------------------------------------------------------------- selection actions
export function deleteSelected() {
  const s = selected(); if (!s) return false;
  commit("delete");
  s.p.anns = s.p.anns.filter((a) => a !== s.a);
  S.sel = null; renderOverlay(s.p.uid); renderProps(); return true;
}
export function nudge(dx, dy) {
  const s = selected(); if (!s) return false;
  const vp = viewOf(s.p.uid)?.vp; if (!vp) return false;
  const [x0, y0] = vp.convertToPdfPoint(0, 0), [x1, y1] = vp.convertToPdfPoint(dx, dy);
  commit("nudge", { silent: true }); moveAnn(s.a, (x1 - x0), (y1 - y0)); renderOverlay(s.p.uid); emit("ann"); return true;
}
export function copySelected() { const s = selected(); if (s) { clipboard = structuredClone(s.a); return true; } return false; }
export function pasteClipboard() {
  if (!clipboard) return false;
  const p = S.pages[S.current]; if (!p) return false;
  const a = structuredClone(clipboard); a.id = uid("a"); moveAnn(a, 12, -12); clipboard = structuredClone(a);
  addAnn(p, a); setTool("select"); select({ uid: p.uid, id: a.id }); return true;
}
function duplicateSelected() { if (copySelected()) pasteToSame(); }
function pasteToSame() { const s = selected(); const a = structuredClone(clipboard); a.id = uid("a"); moveAnn(a, 12, -12); addAnn(s.p, a); select({ uid: s.p.uid, id: a.id }); }
function reorder(dir) {
  const s = selected(); if (!s) return; commit("order");
  const arr = s.p.anns, i = arr.indexOf(s.a); arr.splice(i, 1);
  if (dir > 0) arr.push(s.a); else arr.unshift(s.a);
  renderOverlay(s.p.uid);
}

// ---------------------------------------------------------------- properties panel
function swatchRow(list, cur, onPick, allowNone = false, custom = true) {
  const row = h("div", { class: "swatches" });
  if (allowNone) row.append(h("button", { class: "none" + (!cur ? " on" : ""), title: "None", type: "button", onclick: () => onPick("") }));
  for (const c of list) row.append(h("button", { class: c.toLowerCase() === (cur || "").toLowerCase() ? "on" : "", style: `background:${c}`, title: c, type: "button", onclick: () => onPick(c) }));
  if (custom) { const inp = h("input", { type: "color", value: cur || "#000000", title: "Custom colour" }); inp.addEventListener("change", () => onPick(inp.value)); row.append(inp); }
  return row;
}
const field = (label, ...kids) => h("label", { class: "field" }, h("span", {}, label), ...kids);
function range(min, max, step, val, on) { const i = h("input", { type: "range", min, max, step, value: val }); let first = true; i.addEventListener("input", () => { on(+i.value, first); first = false; }); i.addEventListener("change", () => { first = true; }); return i; }

function applyProp(key, val, live = false, first = true) {
  S.props[key] = val;
  const s = selected();
  if (s) {
    if (!live || first) commit("prop", { silent: true });
    const k = { textColor: "color", hl: "color", stampColor: "color", whiteFill: "fill" }[key] || key;
    s.a[k] = val;
    if (s.a.t === "text") Object.assign(s.a, measureText(s.a));
    renderOverlay(s.p.uid); emit("ann");
  }
  if (!live) renderProps();
}

export function renderProps() {
  const body = $("#props-body"); if (!body) return;
  const s = selected();
  const t = s && S.tool === "select" ? annKind(s.a) : S.tool;
  const info = TOOL_INFO[t] || TOOL_INFO[S.tool] || ["", ""];
  $("#props-title").textContent = s && S.tool === "select" ? annTitle(s.a) : info[0];
  $("#props-hint").textContent = s && S.tool === "select" ? "" : info[1];
  body.replaceChildren();
  const a = s && S.tool === "select" ? s.a : null;
  const pr = S.props;
  const val = (k, d) => (a && a[k] !== undefined ? a[k] : d);

  if (["rect", "ellipse", "line", "arrow", "ink"].includes(t)) {
    body.append(field("Colour", swatchRow(SWATCHES, val("color", pr.color), (c) => applyProp("color", c), t === "rect" || t === "ellipse")));
    if (t === "rect" || t === "ellipse") body.append(field("Fill", swatchRow(SWATCHES, val("fill", pr.fill), (c) => applyProp("fill", c), true)));
    const wv = h("output", {}, val("width", pr.width) + " pt");
    body.append(field("Thickness", range(0.5, 24, 0.5, val("width", pr.width), (v, f) => { wv.textContent = v + " pt"; applyProp("width", v, true, f); }), wv));
    body.append(opacityField(val("opacity", pr.opacity)));
  }
  if (t === "highlight" || t === "hl") {
    body.append(field("Colour", swatchRow(HL_SWATCHES, val("color", pr.hl), (c) => applyProp("hl", c))));
    if (a) body.append(opacityField(val("opacity", 0.45)));
  }
  if (t === "whiteout") body.append(field("Cover colour", swatchRow(["#ffffff", "#f8fafc", "#fefce8", "#111111"], val("fill", pr.whiteFill || "#ffffff"), (c) => applyProp("whiteFill", c))));
  if (t === "text" || t === "edittext" || t === "stamptext") {
    if (a) {
      const ta = h("textarea", { id: "prop-text", rows: 3 }); ta.value = a.text;
      let first = true;
      ta.addEventListener("input", () => { if (first) commit("text", { silent: true }); first = false; a.text = ta.value; Object.assign(a, measureText(a)); renderOverlay(s.p.uid); });
      ta.addEventListener("change", () => { first = true; emit("ann"); });
      body.append(field("Text", ta));
    }
    const fs = h("select", {});
    for (const [k, lbl] of [["Helvetica", "Sans (Helvetica)"], ["Times", "Serif (Times)"], ["Courier", "Mono (Courier)"], ["Unicode", "Unicode (DejaVu Sans)"]]) fs.append(h("option", { value: k }, lbl));
    for (const [id, f] of S.fonts) fs.append(h("option", { value: "custom:" + id }, f.name));
    fs.append(h("option", { value: "__upload" }, "Upload a font (.ttf/.otf)…"));
    fs.value = val("font", pr.font);
    fs.addEventListener("change", () => { if (fs.value === "__upload") { fs.value = val("font", pr.font); emit("upload-font"); } else applyProp("font", fs.value); });
    body.append(field("Font", fs));
    const size = h("input", { type: "number", min: 2, max: 400, step: 0.5, value: val("size", pr.size) });
    size.addEventListener("change", () => applyProp("size", clamp(+size.value || 12, 2, 400)));
    body.append(h("div", { class: "inline" },
      field("Size", size),
      h("div", { class: "field" }, h("span", {}, "Style"), h("div", { class: "inline" },
        h("button", { type: "button", class: "toggle" + (val("bold", pr.bold) ? " on" : ""), title: "Bold", onclick: () => applyProp("bold", !val("bold", pr.bold)) }, "B"),
        h("button", { type: "button", class: "toggle" + (val("italic", pr.italic) ? " on" : ""), title: "Italic", onclick: () => applyProp("italic", !val("italic", pr.italic)), style: "font-style:italic" }, "I")))));
    body.append(field("Colour", swatchRow(SWATCHES, val("color", pr.textColor), (c) => applyProp("textColor", c))));
    if (a) {
      body.append(field("Border", swatchRow(SWATCHES, a.border || "", (c) => applyProp("border", c), true)));
      body.append(field("Background", swatchRow(["#ffffff", "#fef9c3", "#dcfce7", "#e0f2fe"], a.bg || "", (c) => applyProp("bg", c), true)));
      body.append(opacityField(val("opacity", 1)));
    }
  }
  if (t === "stamp") {
    const row = h("div", { class: "swatches", style: "gap:4px" });
    for (const st of STAMPS) row.append(h("button", { type: "button", class: "btn sm" + (pr.stamp === st ? " primary" : ""), style: "width:auto;height:26px;border-radius:6px", onclick: () => { pr.stamp = st; renderProps(); } }, st));
    const custom = h("input", { type: "text", placeholder: "Custom stamp text", value: STAMPS.includes(pr.stamp) ? "" : pr.stamp });
    custom.addEventListener("input", () => { pr.stamp = custom.value.trim() || "APPROVED"; });
    body.append(field("Stamp", row), field("Custom", custom), field("Colour", swatchRow(["#15803d", "#b91c1c", "#1d4ed8", "#7c3aed", "#111111"], pr.stampColor, (c) => { pr.stampColor = c; renderProps(); })));
    const today = new Date().toLocaleDateString();
    body.append(h("div", { class: "actions" }, h("button", { type: "button", class: "btn sm", onclick: () => { pr.stamp = `${pr.stamp.split("\n")[0]}\n${today}`; renderProps(); } }, "Add today's date")));
  }
  if (t === "note") {
    if (a) {
      const ta = h("textarea", { id: "prop-note", rows: 5, placeholder: "Write a comment…" }); ta.value = a.text;
      let first = true;
      ta.addEventListener("input", () => { if (first) commit("note", { silent: true }); first = false; a.text = ta.value; });
      ta.addEventListener("change", () => { first = true; emit("ann"); });
      const au = h("input", { type: "text", placeholder: "Your name", value: a.author || "" });
      au.addEventListener("change", () => { a.author = au.value; try { localStorage.setItem("pk-author", au.value); } catch {} });
      body.append(field("Comment", ta), field("Author", au), field("Colour", swatchRow(["#facc15", "#86efac", "#7dd3fc", "#f9a8d4", "#fdba74"], a.color, (c) => applyProp("color", c), false, false)));
    }
  }
  if (t === "sign") emit("render-signatures");
  if (t === "image" && !a) body.append(h("div", { class: "actions" }, h("button", { type: "button", class: "btn sm", onclick: () => pickImage((im) => { pendingImage = { ...im, tool: "image" }; status("Now click on the page where the image should go."); }) }, "Choose image first")));
  if (t === "image" && a) body.append(opacityField(val("opacity", 1)), h("p", { class: "hint" }, "Hold Shift while dragging a corner to stretch freely."));
  if (t === "crop") {
    const p = S.pages[S.current];
    body.append(h("p", { class: "hint" }, p?.crop ? `Page ${S.current + 1} is cropped.` : `Page ${S.current + 1} is not cropped.`));
    body.append(h("div", { class: "actions" },
      h("button", { type: "button", class: "btn sm", disabled: !p?.crop, onclick: () => { commit("crop"); const c = p.crop; for (const q of S.pages) if (sameSize(q, p)) q.crop = [...c]; emit("pages"); status("Crop applied to all pages of the same size."); } }, "Apply to all pages"),
      h("button", { type: "button", class: "btn sm", disabled: !p?.crop, onclick: () => { commit("crop"); p.crop = null; emit("pages"); renderProps(); } }, "Reset this page"),
      h("button", { type: "button", class: "btn sm", disabled: !S.pages.some((q) => q.crop), onclick: () => { commit("crop"); for (const q of S.pages) q.crop = null; emit("pages"); renderProps(); } }, "Reset all")));
  }
  if (t === "redact" && !a) body.append(h("div", { class: "note-box" }, "Redacted pages become images when you download. Run OCR afterwards if you need the rest of the text to stay searchable."));
  if (t === "browse") {
    body.append(h("div", { class: "note-box", html:
      `<b>Shortcuts</b><br><span class="kbd">B</span> browse · <span class="kbd">V</span> select · <span class="kbd">T</span> text · <span class="kbd">E</span> edit text · <span class="kbd">H</span> highlight · <span class="kbd">D</span> draw · <span class="kbd">R</span> box · <span class="kbd">X</span> redact<br>` +
      `<span class="kbd">Ctrl Z</span> undo · <span class="kbd">Ctrl Y</span> redo · <span class="kbd">Ctrl S</span> download · <span class="kbd">Ctrl F</span> find · <span class="kbd">Ctrl C/V</span> copy/paste objects · <span class="kbd">Del</span> delete` }));
  }
  if (a) {
    body.append(h("div", { class: "actions" },
      h("button", { type: "button", class: "btn sm", onclick: duplicateSelected }, "Duplicate"),
      h("button", { type: "button", class: "btn sm", onclick: () => reorder(1) }, "To front"),
      h("button", { type: "button", class: "btn sm", onclick: () => reorder(-1) }, "To back"),
      h("button", { type: "button", class: "btn sm danger", onclick: deleteSelected }, "Delete")));
    if (a.t === "text") body.append(h("div", { class: "actions" }, h("button", { type: "button", class: "btn sm", onclick: () => { commit("rot"); a.R = ((a.R || 0) + 270) % 360; renderOverlay(s.p.uid); renderProps(); } }, "Rotate 90°"), h("button", { type: "button", class: "btn sm", onclick: () => startEdit(s.p, a) }, "Edit on page")));
  }
}
function sameSize(a, b) { const va = proxyOf(a).view, vb = proxyOf(b).view; return va.every((x, i) => Math.abs(x - vb[i]) < 1); }
function opacityField(v) {
  const out = h("output", {}, Math.round(v * 100) + "%");
  return field("Opacity", range(0.05, 1, 0.05, v, (x, f) => { out.textContent = Math.round(x * 100) + "%"; applyProp("opacity", x, true, f); }), out);
}
function annKind(a) { return { hl: "hl", whiteout: "whiteout", redact: "redact", text: "text", note: "note", image: "image" }[a.t] || a.t; }
function annTitle(a) { return { rect: "Box", ellipse: "Ellipse", line: "Line", arrow: "Arrow", ink: "Drawing", hl: "Highlight", whiteout: "Whiteout", redact: "Redaction", text: "Text", image: "Image", note: "Note" }[a.t] || "Object"; }
