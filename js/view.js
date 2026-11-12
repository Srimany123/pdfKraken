// Page view: renders pages (canvas + text layer + form/link layer) and the SVG overlay that shows annotations.
import { pdfjsLib } from "./pdfjs.js";
import { S, $, h, sv, bbox, frame, fontCss, LINE_H, ASCENT, emit } from "./state.js";

const views = new Map();          // uid -> view
const textCache = new WeakMap();  // PDFPageProxy -> Promise<textContent>
const annotCache = new WeakMap(); // PDFPageProxy -> Promise<annotations>
let io = null;
export const viewOf = (uid) => views.get(uid);
export const srcOf = (p) => S.sources.find((s) => s.id === p.src);
export const proxyOf = (p) => srcOf(p).proxies[p.idx];
export const rotationOf = (p) => (((proxyOf(p).rotate + p.rot) % 360) + 360) % 360;
export const viewport = (p, scale = S.scale) => proxyOf(p).getViewport({ scale, rotation: rotationOf(p) });
export const pageIndex = (uid) => S.pages.findIndex((p) => p.uid === uid);
export function textContent(proxy) {
  if (!textCache.has(proxy)) textCache.set(proxy, proxy.getTextContent());
  return textCache.get(proxy);
}
function annotations(proxy) {
  if (!annotCache.has(proxy)) annotCache.set(proxy, proxy.getAnnotations({ intent: "display" }).catch(() => []));
  return annotCache.get(proxy);
}

// Text items as boxes in user space: {str, b:[x,y] baseline, R, w, size, box:[x0,y0,x1,y1], font}
export async function textItems(p) {
  const proxy = proxyOf(p);
  const tc = await textContent(proxy);
  return tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
    const t = it.transform, R = Math.round((Math.atan2(t[1], t[0]) * 180) / Math.PI);
    const size = Math.hypot(t[2], t[3]) || it.height || 10;
    const f = frame(R), b = [t[4], t[5]];
    const w = it.width;
    const up = [-f.down[0], -f.down[1]];
    const corners = [
      [b[0] - up[0] * size * 0.25, b[1] - up[1] * size * 0.25],
      [b[0] + f.right[0] * w - up[0] * size * 0.25, b[1] + f.right[1] * w - up[1] * size * 0.25],
      [b[0] + up[0] * size * 0.95, b[1] + up[1] * size * 0.95],
      [b[0] + f.right[0] * w + up[0] * size * 0.95, b[1] + f.right[1] * w + up[1] * size * 0.95],
    ];
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    return { str: it.str, b, R, w, size, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], font: it.fontName, style: tc.styles[it.fontName] };
  });
}

// ---------------------------------------------------------------- link service for the annotation layer
function linkService(src) {
  return {
    externalLinkEnabled: true, externalLinkTarget: 2, externalLinkRel: "noopener noreferrer nofollow",
    isInPresentationMode: false, rotation: 0,
    get pagesCount() { return S.pages.length; }, get page() { return S.current + 1; }, set page(n) { goToPage(n - 1); },
    addLinkAttributes(link, url) { link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer nofollow"; },
    getDestinationHash() { return "#"; }, getAnchorUrl() { return "#"; },
    async goToDestination(dest) { await goToDest(src, dest); },
    navigateTo(dest) { goToDest(src, dest); },
    goToPage(n) { goToPage(n - 1); },
    setHash() {}, executeNamedAction(a) { if (a === "NextPage") goToPage(S.current + 1); else if (a === "PrevPage") goToPage(S.current - 1); else if (a === "FirstPage") goToPage(0); else if (a === "LastPage") goToPage(S.pages.length - 1); },
    executeSetOCGState() {}, cachePageRef() {}, isPageVisible() { return true; }, isPageCached() { return true; },
  };
}
export async function goToDest(src, dest) {
  try {
    const explicit = typeof dest === "string" ? await src.pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return;
    const ref = explicit[0];
    const idx = typeof ref === "object" ? await src.pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : -1;
    const i = S.pages.findIndex((p) => p.src === src.id && p.idx === idx);
    if (i >= 0) goToPage(i);
  } catch (e) { console.warn("link", e); }
}
export function goToPage(i, smooth = false) {
  i = Math.max(0, Math.min(S.pages.length - 1, i));
  const v = views.get(S.pages[i]?.uid); if (!v) return;
  const viewer = $("#viewer");
  viewer.scrollTo({ top: v.el.offsetTop - 14, behavior: smooth ? "smooth" : "auto" });
  S.current = i; emit("current");
}

// ---------------------------------------------------------------- DOM sync
export function syncPages() {
  const host = $("#pages");
  if (!io) io = new IntersectionObserver(onIntersect, { root: $("#viewer"), rootMargin: "1200px 0px" });
  const keep = new Set(S.pages.map((p) => p.uid));
  for (const [uid, v] of views) if (!keep.has(uid)) { io.unobserve(v.el); v.task?.cancel(); v.el.remove(); views.delete(uid); }
  S.pages.forEach((p, i) => {
    let v = views.get(p.uid);
    if (!v) v = makeView(p);
    v.pn.textContent = String(i + 1);
    const vp = viewport(p);
    const key = `${S.scale}|${rotationOf(p)}|${p.src}|${p.idx}`;
    if (v.key !== key) {
      v.key = key; v.vp = vp; v.stale = true;
      v.el.style.width = vp.width + "px"; v.el.style.height = vp.height + "px";
      v.el.style.setProperty("--scale-factor", vp.scale);
      v.el.style.setProperty("--total-scale-factor", vp.scale);
      if (v.visible) render(v, p);
    }
    renderOverlay(p.uid);
    if (host.children[i] !== v.el) host.insertBefore(v.el, host.children[i] || null);
  });
}
function makeView(p) {
  const el = h("div", { class: "page", "data-uid": p.uid });
  const canvas = h("canvas", { class: "base" });
  const tl = h("div", { class: "textLayer" });
  const al = h("div", { class: "annotationLayer" });
  const svg = sv("svg", { class: "ov" });
  const pn = h("span", { class: "pn" });
  el.append(canvas, tl, al, svg, pn);
  const v = { uid: p.uid, el, canvas, tl, al, svg, pn, key: "", stale: true, visible: false, task: null, gen: 0 };
  views.set(p.uid, v); io.observe(el);
  return v;
}
function onIntersect(entries) {
  for (const e of entries) {
    const v = views.get(e.target.dataset.uid); if (!v) continue;
    v.visible = e.isIntersecting;
    const p = S.pages.find((x) => x.uid === v.uid); if (!p) continue;
    if (v.visible && v.stale) render(v, p);
    else if (!v.visible && !v.stale) { v.task?.cancel(); v.canvas.width = v.canvas.height = 0; v.tl.replaceChildren(); v.al.replaceChildren(); v.stale = true; }
  }
}
async function render(v, p) {
  v.stale = false;
  const gen = ++v.gen;
  const proxy = proxyOf(p), src = srcOf(p);
  const vp = viewport(p); v.vp = vp;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const c = document.createElement("canvas");
  c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
  v.task?.cancel();
  const task = proxy.render({
    canvasContext: c.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  });
  v.task = task;
  try { await task.promise; } catch (e) { if (e?.name !== "RenderingCancelledException") console.warn(e); return; }
  if (gen !== v.gen) return;
  c.className = "base"; v.canvas.replaceWith(c); v.canvas = c;
  // text layer (selection, copy)
  try {
    const tc = await textContent(proxy);
    if (gen !== v.gen) return;
    v.tl.replaceChildren();
    await new pdfjsLib.TextLayer({ textContentSource: tc, container: v.tl, viewport: vp }).render();
  } catch (e) { console.warn("text layer", e); }
  // links and form fields
  try {
    const annots = await annotations(proxy);
    if (gen !== v.gen) return;
    v.al.replaceChildren();
    if (annots.length) {
      const vpd = vp.clone({ dontFlip: true });
      const layer = new pdfjsLib.AnnotationLayer({ div: v.al, accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, page: proxy, viewport: vpd, structTreeLayer: null });
      src.links ||= linkService(src);
      await layer.render({ viewport: vpd, div: v.al, annotations: annots, page: proxy, linkService: src.links, renderForms: true, annotationStorage: src.pdf.annotationStorage, enableScripting: false, hasJSActions: false, fieldObjects: null, imageResourcesPath: "", downloadManager: null });
    }
  } catch (e) { console.warn("annotation layer", e); }
  emit("rendered:" + p.uid);
}
export function rerenderAll() { for (const v of views.values()) { v.key = ""; } syncPages(); }

// ---------------------------------------------------------------- overlay
export const overlayHooks = { extra: null }; // set by the editor: (p, v, gScreen, gUser) => void
export function renderOverlay(uid) {
  const v = views.get(uid); const p = S.pages.find((x) => x.uid === uid);
  if (!v || !p) return;
  const vp = v.vp || viewport(p);
  const svg = v.svg;
  svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);
  svg.replaceChildren();
  const gu = sv("g", { transform: `matrix(${vp.transform.join(" ")})` });
  svg.append(gu);
  for (const a of p.anns) gu.append(drawAnn(a));
  if (p.crop) {
    const [vx0, vy0, vx1, vy1] = proxyOf(p).view, [cx0, cy0, cx1, cy1] = p.crop;
    gu.append(sv("path", { class: "crop-shade", "fill-rule": "evenodd", d: `M${vx0} ${vy0}H${vx1}V${vy1}H${vx0}Z M${cx0} ${cy0}H${cx1}V${cy1}H${cx0}Z` }));
    gu.append(sv("rect", { class: "crop-edge", x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 }));
  }
  const gs = sv("g", { class: "screen" });
  svg.append(gs);
  overlayHooks.extra?.(p, v, gs, gu, vp);
}
const colorOr = (c, d = "none") => (c ? c : d);
export function drawAnn(a) {
  let el;
  switch (a.t) {
    case "rect": case "whiteout": {
      const [x0, y0, x1, y1] = a.r;
      el = sv("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      if (a.t === "whiteout") el.setAttribute("fill", a.fill || "#ffffff");
      else { el.setAttribute("fill", colorOr(a.fill)); el.setAttribute("stroke", colorOr(a.color)); el.setAttribute("stroke-width", a.width); }
      break;
    }
    case "redact": { const [x0, y0, x1, y1] = a.r; el = sv("rect", { class: "redact-mark", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }); break; }
    case "hl": { const [x0, y0, x1, y1] = a.r; el = sv("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: a.color, style: "mix-blend-mode:multiply" }); break; }
    case "ellipse": {
      const [x0, y0, x1, y1] = a.r;
      el = sv("ellipse", { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: Math.abs(x1 - x0) / 2, ry: Math.abs(y1 - y0) / 2, fill: colorOr(a.fill), stroke: colorOr(a.color), "stroke-width": a.width });
      break;
    }
    case "line": case "arrow": {
      el = sv("g", { stroke: a.color, "stroke-width": a.width, fill: a.color });
      el.append(sv("line", { x1: a.p[0], y1: a.p[1], x2: a.p[2], y2: a.p[3] }));
      if (a.t === "arrow") el.append(sv("path", { d: arrowHead(a).map((q, i) => (i ? "L" : "M") + q[0] + " " + q[1]).join("") + "Z", stroke: "none" }));
      break;
    }
    case "ink": {
      el = sv("path", { d: a.pts.map(inkPath).join(" "), stroke: a.color, "stroke-width": a.width, fill: "none" });
      break;
    }
    case "text": {
      const f = frame(a.R || 0);
      el = sv("g", { transform: `matrix(${f.right[0]} ${f.right[1]} ${f.down[0]} ${f.down[1]} ${a.x} ${a.y})` });
      if (a.bg) el.append(sv("rect", { x: 0, y: 0, width: a.w, height: a.h, fill: a.bg }));
      if (a.border) el.append(sv("rect", { x: a.size * 0.12, y: a.size * 0.12, width: a.w - a.size * 0.24, height: a.h - a.size * 0.24, fill: "none", stroke: a.border, "stroke-width": Math.max(1, a.size / 12), rx: a.size * 0.2 }));
      const pad = a.border ? a.size * 0.35 : 0;
      const t = sv("text", { "font-size": a.size, fill: a.color, "font-family": fontCss(a), "font-weight": a.bold ? "bold" : null, "font-style": a.italic ? "italic" : null, style: "white-space:pre" });
      String(a.text).split("\n").forEach((line, i) => { const ts = sv("tspan", { x: pad, y: pad + a.size * (ASCENT + i * LINE_H) }); ts.textContent = line || " "; t.append(ts); });
      el.append(t);
      break;
    }
    case "image": {
      const f = frame(a.R || 0), img = S.images.get(a.img);
      el = sv("g", { transform: `matrix(${f.right[0]} ${f.right[1]} ${f.down[0]} ${f.down[1]} ${a.x} ${a.y})` });
      el.append(sv("image", { href: img?.url || "", x: 0, y: 0, width: a.w, height: a.h, preserveAspectRatio: "none" }));
      break;
    }
    case "note": {
      el = sv("g", { class: "note-icon", transform: `translate(${a.x} ${a.y - 20})` });
      el.append(sv("path", { d: "M0 0H20V14L14 20H0Z", fill: a.color || "#facc15", stroke: "#a16207", "stroke-width": 1 }));
      el.append(sv("path", { d: "M4 14H10M4 10H16M4 6H16", stroke: "#713f12", "stroke-width": 1.2, transform: "matrix(1 0 0 -1 0 20)" }));
      break;
    }
    default: el = sv("g");
  }
  if (a.opacity != null && a.opacity !== 1) el.setAttribute("opacity", a.opacity);
  el.dataset.id = a.id;
  return el;
}
export function inkPath(s) {
  if (s.length < 4) return `M${s[0]} ${s[1]}l0.01 0`;
  let d = `M${s[0]} ${s[1]}`;
  for (let i = 2; i < s.length - 2; i += 2) { const mx = (s[i] + s[i + 2]) / 2, my = (s[i + 1] + s[i + 3]) / 2; d += `Q${s[i]} ${s[i + 1]} ${mx} ${my}`; }
  return d + `L${s[s.length - 2]} ${s[s.length - 1]}`;
}
export function arrowHead(a) {
  const [x1, y1, x2, y2] = a.p, ang = Math.atan2(y2 - y1, x2 - x1), L = Math.max(11, a.width * 5), w = 0.45;
  return [[x2, y2], [x2 - L * Math.cos(ang - w), y2 - L * Math.sin(ang - w)], [x2 - L * Math.cos(ang + w), y2 - L * Math.sin(ang + w)]];
}
export function toScreen(vp, x, y) { return vp.convertToViewportPoint(x, y); }
export function screenBox(vp, b) {
  const a = vp.convertToViewportPoint(b[0], b[1]), c = vp.convertToViewportPoint(b[2], b[3]);
  return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
}
export { bbox };
