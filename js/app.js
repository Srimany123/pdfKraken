// pdfKraken: app shell. Wires the UI to the viewer, the editor and the tools.
import { S, $, $$, h, uid, onChange, commit, emit, doUndo, doRedo, canUndo, canRedo, status, busy, withBusy, clamp, baseName } from "./state.js";
import { syncPages, goToPage, viewport, viewOf, renderOverlay, srcOf, proxyOf, goToDest, rerenderAll } from "./view.js";
import { setTool, bindPointer, renderProps, deleteSelected, nudge, copySelected, pasteClipboard, isEditing, finishEdit, loadImage, armImage, selected, select } from "./editor.js";
import { addFiles, newDocument, insertBlank } from "./docs.js";
import { toolsMenu, runTool, save, findAll, refreshPageNumbers } from "./tools.js";
import { dialog, field, select as sel, input } from "./ui.js";
import { detect, probe, saveServer, savedServer } from "./server.js";
import { buildPdf } from "./build.js";

// ---------------------------------------------------------------- theme
const THEME_KEY = "pk-theme";
function applyTheme(t) { if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch {}

// ---------------------------------------------------------------- server / mode badge
async function refreshMode() {
  const caps = await detect();
  const badge = $("#mode");
  document.body.classList.toggle("server", !!caps);
  if (caps) {
    badge.textContent = S.server ? "Browser + server" : "Server";
    badge.title = `Processing server ${S.server || location.host}: ${Object.keys(caps.tools).filter((k) => caps.tools[k]).join(", ")}`;
    $("#privacy-line").textContent = S.server
      ? `Editing happens in this tab. Server tools (OCR, compression, Office conversion…) upload the file to ${S.server}, which deletes it after processing.`
      : "Editing happens in this tab. Server tools (OCR, compression, Office conversion…) send the file to this server, which deletes it after processing.";
  } else {
    badge.textContent = "Browser"; badge.title = "Everything runs in this browser tab. Files never leave your device.";
    $("#privacy-line").textContent = "Files never leave your device: everything runs in this browser tab.";
  }
}

// ---------------------------------------------------------------- opening files
async function openFiles(files, mode = "auto") {
  if (!files?.length) return;
  const replace = mode === "replace" || (mode === "auto" && !S.pages.length);
  if (replace && S.pages.length && S.dirty) {
    const r = await dialog({ title: "Open another document?", body: h("p", {}, "Your current edits haven't been downloaded. Replace the document, or add the new files to it?"), ok: "Replace", extra: [{ label: "Add to this document", value: "add" }] });
    if (!r) return;
    if (r === "add") return openFiles(files, "add");
  }
  try { await withBusy("Opening…", () => addFiles(files, null, { replace })); }
  catch (e) { console.error(e); status(e.message || String(e), true); }
}
$("#btn-open").onclick = $("#btn-open2").onclick = () => { $("#file-open").click(); };
$("#file-open").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; openFiles(f, S.pages.length ? "replace" : "auto"); };
$("#btn-new").onclick = () => withBusy("Creating…", newDocument);

// drag and drop anywhere
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("#dropmask").hidden = false; });
addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("#dropmask").hidden = true; } });
addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $("#dropmask").hidden = true;
  if (e.target.closest?.("#thumbs")) return; // handled by the thumbnail list (insert position)
  const files = [...e.dataTransfer.files];
  // dropping an image onto a page while editing places it on that page
  const pageEl = e.target.closest?.(".page");
  if (pageEl && S.pages.length && files.length === 1 && /^image\//.test(files[0].type)) {
    const p = S.pages.find((x) => x.uid === pageEl.dataset.uid), v = viewOf(p.uid), r = pageEl.getBoundingClientRect();
    const [x, y] = v.vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
    loadImage(files[0]).then((im) => import("./editor.js").then((m) => m.placeImage(p, im, x, y)));
    return;
  }
  openFiles(files, S.pages.length ? "add" : "auto");
});

// ---------------------------------------------------------------- change handling
onChange((what, arg) => {
  if (what === "doc") onDoc();
  else if (what === "pages" || what === "history" || what === "ocr") { refreshPageNumbers(); if (S.zoomMode === "fit" || S.zoomMode === "page") computeZoom(); syncPages(); renderThumbs(); renderProps(); updateCount(); }
  else if (what === "current") updateCurrent();
  else if (what === "busy") busy(arg);
  else if (what === "need-signature") signatureDialog();
  else if (what === "render-signatures") renderSignatures();
  else if (what === "upload-font") uploadFont();
  if (what === "busy" || what.startsWith("rendered:")) return;
  if (what === "saved") S.dirty = false;
  $("#btn-undo").disabled = !canUndo(); $("#btn-redo").disabled = !canRedo();
  document.title = S.pages.length ? `${S.dirty ? "• " : ""}${S.name} — pdfKraken` : "pdfKraken";
});
async function onDoc() {
  document.body.classList.toggle("has-doc", S.pages.length > 0);
  $("#btn-save").disabled = !S.pages.length;
  S.current = 0;
  computeZoom();
  syncPages(); renderThumbs(); updateCount(); renderOutline(); clearSearch();
  setTool(S.tool === "browse" || !S.pages.length ? "browse" : S.tool);
  $("#viewer").scrollTop = 0;
  updateCurrent();
}
function updateCount() { $("#page-count").textContent = "/ " + S.pages.length; $("#page-num").max = S.pages.length; $("#btn-save").disabled = !S.pages.length; document.body.classList.toggle("has-doc", S.pages.length > 0); }
function updateCurrent() {
  $("#page-num").value = S.current + 1;
  $$(".thumb").forEach((t) => t.classList.toggle("cur", t.dataset.uid === S.pages[S.current]?.uid));
  $$(".page").forEach((p) => p.classList.toggle("cur", p.dataset.uid === S.pages[S.current]?.uid));
  const t = $(`.thumb[data-uid="${S.pages[S.current]?.uid}"]`);
  if (t && !t.matches(":hover")) t.scrollIntoView({ block: "nearest" });
  if (S.tool === "crop") renderProps();
}

// ---------------------------------------------------------------- zoom & scroll
function computeZoom() {
  if (!S.pages.length) return;
  const viewer = $("#viewer"), avail = viewer.clientWidth - 40, availH = viewer.clientHeight - 50;
  const p = S.pages[S.current] || S.pages[0], vp = viewport(p, 1);
  if (S.zoomMode === "fit") S.scale = clamp(avail / Math.max(...S.pages.slice(0, 50).map((q) => viewport(q, 1).width)), 0.2, 4);
  else if (S.zoomMode === "page") S.scale = clamp(Math.min(avail / vp.width, availH / vp.height), 0.2, 4);
  S.scale = Math.round(S.scale * 1000) / 1000;
  const z = $("#zoom");
  if (S.zoomMode === "fit" || S.zoomMode === "page") z.value = S.zoomMode;
  else { if (![...z.options].some((o) => o.value === String(S.scale))) { $$("option.custom", z).forEach((o) => o.remove()); z.append(h("option", { class: "custom", value: String(S.scale) }, Math.round(S.scale * 100) + "%")); } z.value = String(S.scale); }
}
function setZoom(mode) {
  const viewer = $("#viewer"), cur = S.current;
  const v = viewOf(S.pages[cur]?.uid);
  const rel = v ? (viewer.scrollTop - v.el.offsetTop) / v.el.offsetHeight : 0;
  S.zoomMode = mode;
  if (typeof mode === "number") { S.scale = clamp(mode, 0.2, 5); S.zoomMode = "custom"; }
  computeZoom(); syncPages();
  const v2 = viewOf(S.pages[cur]?.uid);
  if (v2) viewer.scrollTop = v2.el.offsetTop + rel * v2.el.offsetHeight;
}
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const zoomStep = (dir) => { const s = S.scale; const next = dir > 0 ? STEPS.find((x) => x > s + 0.001) : [...STEPS].reverse().find((x) => x < s - 0.001); setZoom(next || s); };
$("#zoom").onchange = (e) => setZoom(isNaN(+e.target.value) ? e.target.value : +e.target.value);
$("#btn-zoom-in").onclick = () => zoomStep(1);
$("#btn-zoom-out").onclick = () => zoomStep(-1);
$("#viewer").addEventListener("wheel", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomStep(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (S.zoomMode === "fit" || S.zoomMode === "page") setZoom(S.zoomMode); }, 150); });
let scrollRaf = 0;
$("#viewer").addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const viewer = $("#viewer"), mid = viewer.scrollTop + viewer.clientHeight * 0.35;
    let best = 0;
    for (let i = 0; i < S.pages.length; i++) { const v = viewOf(S.pages[i].uid); if (!v) continue; if (v.el.offsetTop <= mid) best = i; else break; }
    if (best !== S.current) { S.current = best; updateCurrent(); }
  });
});
$("#page-num").onchange = (e) => goToPage((+e.target.value || 1) - 1);

// ---------------------------------------------------------------- thumbnails
const thumbIO = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) drawThumb(e.target); }, { root: $("#tab-pages"), rootMargin: "400px 0px" });
function renderThumbs() {
  const host = $("#thumbs");
  const existing = new Map($$(".thumb", host).map((t) => [t.dataset.uid, t]));
  const frag = [];
  S.pages.forEach((p, i) => {
    let t = existing.get(p.uid);
    const key = `${p.src}|${p.idx}|${p.rot}|${p.crop}`;
    if (!t) {
      t = h("div", { class: "thumb", draggable: "true", "data-uid": p.uid },
        h("canvas", {}), h("span", { class: "n" }),
        h("div", { class: "ops" },
          h("button", { type: "button", title: "Rotate", html: '<svg><use href="#i-rotr"/></svg>', onclick: (e) => { e.stopPropagation(); pageOp("rotr", [p.uid]); } }),
          h("button", { type: "button", title: "Duplicate", html: '<svg><use href="#i-copy"/></svg>', onclick: (e) => { e.stopPropagation(); pageOp("dup", [p.uid]); } }),
          h("button", { type: "button", title: "Delete", html: '<svg><use href="#i-trash"/></svg>', onclick: (e) => { e.stopPropagation(); pageOp("del", [p.uid]); } })));
      thumbIO.observe(t);
    }
    if (t.dataset.key !== key) { t.dataset.key = key; t.dataset.drawn = ""; if (t.isConnected) queueMicrotask(() => drawThumb(t)); }
    t.querySelector(".n").textContent = i + 1;
    t.classList.toggle("sel", S.selectedPages.has(p.uid));
    t.classList.toggle("cur", i === S.current);
    existing.delete(p.uid);
    frag.push(t);
  });
  for (const t of existing.values()) { thumbIO.unobserve(t); t.remove(); }
  frag.forEach((t, i) => { if (host.children[i] !== t) host.insertBefore(t, host.children[i] || null); });
}
async function drawThumb(t) {
  if (t.dataset.drawn === t.dataset.key) return;
  const p = S.pages.find((x) => x.uid === t.dataset.uid); if (!p) return;
  t.dataset.drawn = t.dataset.key;
  const vp1 = viewport(p, 1), k = 150 / Math.max(vp1.width, vp1.height * 0.8);
  const vp = viewport(p, k * Math.min(devicePixelRatio || 1, 2));
  const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  c.style.width = Math.round(vp1.width * k) + "px"; c.style.height = Math.round(vp1.height * k) + "px";
  try { await proxyOf(p).render({ canvasContext: c.getContext("2d"), viewport: vp }).promise; } catch { t.dataset.drawn = ""; return; }
  t.querySelector("canvas").replaceWith(c);
}
let lastClicked = null;
$("#thumbs").addEventListener("click", (e) => {
  const t = e.target.closest(".thumb"); if (!t) return;
  const u = t.dataset.uid, i = S.pages.findIndex((p) => p.uid === u);
  if (e.shiftKey && lastClicked) {
    const j = S.pages.findIndex((p) => p.uid === lastClicked);
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++) S.selectedPages.add(S.pages[k].uid);
  } else if (e.ctrlKey || e.metaKey) { S.selectedPages.has(u) ? S.selectedPages.delete(u) : S.selectedPages.add(u); lastClicked = u; }
  else { S.selectedPages.clear(); S.selectedPages.add(u); lastClicked = u; goToPage(i); }
  renderThumbs();
});
$("#thumbs").addEventListener("dblclick", (e) => { if (e.target.closest(".thumb")) { S.selectedPages.clear(); renderThumbs(); } });
// drag to reorder (and drop files at a position)
let dragUid = null;
$("#thumbs").addEventListener("dragstart", (e) => { const t = e.target.closest(".thumb"); if (!t) return; dragUid = t.dataset.uid; if (!S.selectedPages.has(dragUid)) { S.selectedPages.clear(); S.selectedPages.add(dragUid); renderThumbs(); } t.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragUid); });
$("#thumbs").addEventListener("dragend", () => { dragUid = null; $$(".thumb").forEach((t) => t.classList.remove("dragging", "drop-before", "drop-after")); });
function dropTarget(e) {
  const ts = $$(".thumb"); if (!ts.length) return { index: 0 };
  for (const t of ts) { const r = t.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) return { t, before: true, index: S.pages.findIndex((p) => p.uid === t.dataset.uid) }; }
  const t = ts[ts.length - 1]; return { t, before: false, index: S.pages.length };
}
$("#thumbs").addEventListener("dragover", (e) => {
  e.preventDefault();
  $$(".thumb").forEach((t) => t.classList.remove("drop-before", "drop-after"));
  const d = dropTarget(e); d.t?.classList.add(d.before ? "drop-before" : "drop-after");
});
$("#tab-pages").addEventListener("dragover", (e) => e.preventDefault());
$("#tab-pages").addEventListener("drop", (e) => {
  e.preventDefault();
  $$(".thumb").forEach((t) => t.classList.remove("drop-before", "drop-after"));
  const d = dropTarget(e);
  if (hasFiles(e) && e.dataTransfer.files.length) { withBusy("Inserting…", () => addFiles([...e.dataTransfer.files], d.index)); return; }
  if (!dragUid) return;
  const moving = S.pages.filter((p) => S.selectedPages.has(p.uid));
  const anchor = S.pages[d.index];
  commit("move-pages", { silent: true });
  const rest = S.pages.filter((p) => !S.selectedPages.has(p.uid));
  let at = anchor ? rest.indexOf(anchor) : rest.length; if (at < 0) at = rest.length;
  rest.splice(at, 0, ...moving);
  S.pages = rest; dragUid = null; emit("pages");
});

async function pageOp(op, uids) {
  uids = uids || (S.selectedPages.size ? [...S.selectedPages] : S.pages[S.current] ? [S.pages[S.current].uid] : []);
  if (!uids.length) return;
  const set = new Set(uids);
  if (op === "extract") {
    const pages = S.pages.filter((p) => set.has(p.uid));
    const bytes = await withBusy("Extracting…", () => buildPdf({ pages }));
    const { download } = await import("./state.js");
    download(bytes, baseName(S.name) + "_pages.pdf"); return;
  }
  if (op === "blank") { const i = Math.max(...uids.map((u) => S.pages.findIndex((p) => p.uid === u))); const vp = viewport(S.pages[i], 1); await insertBlank(i + 1, [vp.width, vp.height]); return; }
  if (op === "del" && set.size >= S.pages.length) { status("A PDF needs at least one page.", true); return; }
  commit(op, { silent: true });
  if (op === "rotr" || op === "rotl") for (const p of S.pages) if (set.has(p.uid)) p.rot = (p.rot + (op === "rotr" ? 90 : 270)) % 360;
  if (op === "del") { S.pages = S.pages.filter((p) => !set.has(p.uid)); S.selectedPages.clear(); S.current = Math.min(S.current, S.pages.length - 1); }
  if (op === "dup") {
    const out = [];
    for (const p of S.pages) { out.push(p); if (set.has(p.uid)) out.push({ ...structuredClone(p), uid: uid("p"), anns: p.anns.map((a) => ({ ...structuredClone(a), id: uid("a") })) }); }
    S.pages = out;
  }
  emit("pages");
}
$$("[data-pg]").forEach((b) => (b.onclick = () => pageOp(b.dataset.pg)));

// ---------------------------------------------------------------- sidebar tabs, outline, search
$$(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function showTab(name) {
  $$(".tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
  $$(".sidebar .tab").forEach((t) => (t.hidden = t.id !== "tab-" + name));
  if (name === "search") setTimeout(() => $("#search-q").focus(), 0);
}
async function renderOutline() {
  const host = $("#outline"); host.replaceChildren();
  const src = S.sources.find((s) => s.id === S.pages[0]?.src);
  let ol = null;
  try { ol = await src?.pdf.getOutline(); } catch {}
  if (!ol?.length) { host.append(h("p", { class: "hint" }, "No bookmarks in this document.")); return; }
  const build = (items) => h("ul", {}, ...items.map((it) => h("li", {}, h("a", { onclick: () => it.dest && goToDest(src, it.dest), title: it.title, style: it.bold ? "font-weight:600" : null }, it.title), it.items?.length ? build(it.items) : null)));
  host.append(build(ol));
}
let hits = [], hitIdx = -1;
function clearSearch() { hits = []; hitIdx = -1; S.searchHits = null; S.searchCur = null; $("#search-results").replaceChildren(); $("#search-count").textContent = ""; }
$("#search-form").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("#search-q").value.trim();
  const prev = new Set((S.searchHits || []).map((x) => x.uid));
  clearSearch();
  for (const u of prev) renderOverlay(u);
  if (!q) return;
  $("#search-count").textContent = "Searching…";
  hits = await findAll(q, { matchCase: $("#search-case").checked });
  S.searchHits = hits;
  $("#search-count").textContent = hits.length ? `${hits.length} match${hits.length > 1 ? "es" : ""}` : "No matches";
  const list = $("#search-results");
  hits.forEach((hit, i) => {
    const pi = S.pages.findIndex((p) => p.uid === hit.uid);
    list.append(h("li", { onclick: () => showHit(i) }, h("b", {}, "p." + (pi + 1)), hit.before, h("mark", {}, hit.match), hit.after));
  });
  for (const u of new Set(hits.map((x) => x.uid))) renderOverlay(u);
  if (hits.length) showHit(0);
};
$("#search-q").addEventListener("input", (e) => { if (!e.target.value) { const prev = new Set((S.searchHits || []).map((x) => x.uid)); clearSearch(); for (const u of prev) renderOverlay(u); } });
function showHit(i) {
  if (!hits.length) return;
  hitIdx = (i + hits.length) % hits.length;
  const prev = S.searchCur; S.searchCur = hits[hitIdx];
  if (prev) renderOverlay(prev.uid);
  const hit = hits[hitIdx], pi = S.pages.findIndex((p) => p.uid === hit.uid);
  renderOverlay(hit.uid);
  $$("#search-results li").forEach((li, k) => li.classList.toggle("cur", k === hitIdx));
  $$("#search-results li")[hitIdx]?.scrollIntoView({ block: "nearest" });
  const v = viewOf(hit.uid); if (!v) return;
  const [, sy] = v.vp.convertToViewportPoint(hit.rects[0][0], hit.rects[0][3]);
  $("#viewer").scrollTo({ top: v.el.offsetTop + sy - $("#viewer").clientHeight / 3 });
  S.current = pi; updateCurrent();
  $("#search-count").textContent = `${hitIdx + 1} of ${hits.length}`;
}
$("#search-next").onclick = () => showHit(hitIdx + 1);
$("#search-prev").onclick = () => showHit(hitIdx - 1);

// ---------------------------------------------------------------- signatures
const SIG_KEY = "pk-signatures";
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY) || "[]"); } catch { return []; } };
const storeSigs = (l) => { try { localStorage.setItem(SIG_KEY, JSON.stringify(l.slice(-12))); } catch { status("Couldn't remember the signature in this browser (storage is full or blocked).", true); } };
let activeSig = null;
async function useSig(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const im = await loadImage(blob);
  armImage(im); activeSig = dataUrl;
  setTool("sign");
  status("Click on the page where the signature should go.");
}
function renderSignatures() {
  const body = $("#props-body");
  const list = h("div", { class: "sig-list" });
  for (const s of loadSigs()) {
    list.append(h("div", { class: "sig" + (s === activeSig ? " on" : ""), title: "Use this signature", onclick: () => useSig(s) },
      h("img", { src: s, alt: "Signature" }),
      h("button", { type: "button", title: "Forget", onclick: (e) => { e.stopPropagation(); storeSigs(loadSigs().filter((x) => x !== s)); renderProps(); } }, "×")));
  }
  body.append(h("div", { class: "field" }, h("span", {}, "Your signatures"), list.children.length ? list : h("p", { class: "hint" }, "None yet.")),
    h("div", { class: "actions" }, h("button", { type: "button", class: "btn sm primary", onclick: signatureDialog }, "New signature")),
    h("p", { class: "hint" }, "Signatures are remembered only in this browser."));
}
async function signatureDialog() {
  const tabs = h("div", { class: "seg" });
  const pane = h("div", {});
  let mode = "draw";
  // draw
  const pad = h("canvas", { class: "sigpad" });
  let ctx, drawing = false, any = false, penColor = "#0b2a6f";
  const sizePad = () => { const r = pad.getBoundingClientRect(); const k = devicePixelRatio || 1; pad.width = r.width * k; pad.height = r.height * k; ctx = pad.getContext("2d"); ctx.scale(k, k); ctx.lineCap = ctx.lineJoin = "round"; ctx.lineWidth = 2.4; ctx.strokeStyle = penColor; };
  const pos = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  pad.addEventListener("pointerdown", (e) => { drawing = true; any = true; pad.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y); ctx.stroke(); });
  pad.addEventListener("pointermove", (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); });
  pad.addEventListener("pointerup", () => { drawing = false; });
  const colors = h("div", { class: "swatches" }, ...["#0b2a6f", "#111111", "#1d4ed8", "#b91c1c"].map((c) => h("button", { type: "button", style: `background:${c}`, onclick: () => { penColor = c; if (ctx) ctx.strokeStyle = c; } })),
    h("button", { type: "button", class: "btn sm", style: "width:auto;border-radius:6px", onclick: () => { ctx.clearRect(0, 0, pad.width, pad.height); any = false; } }, "Clear"));
  // type
  const typed = input({ placeholder: "Type your name", style: "font-size:18px" });
  const fontSel = sel("font", [["'Segoe Script','Brush Script MT','Snell Roundhand',cursive", "Script"], ["'Lucida Handwriting','Bradley Hand',cursive", "Handwriting"], ["Georgia,serif", "Serif"], ["Helvetica,Arial,sans-serif", "Sans"]]);
  const preview = h("div", { style: "height:90px;border:1px solid var(--line);border-radius:8px;background:#fff;color:#0b2a6f;display:grid;place-items:center;font-size:40px;overflow:hidden;white-space:nowrap" });
  const upd = () => { preview.textContent = typed.value || "Your name"; preview.style.fontFamily = fontSel.value; };
  typed.addEventListener("input", upd); fontSel.addEventListener("change", upd); upd();
  // upload
  const up = h("input", { type: "file", accept: "image/*" });
  const [remember] = [h("input", { type: "checkbox", checked: true })];
  const show = (m) => {
    mode = m; tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    pane.replaceChildren(...(m === "draw" ? [pad, colors] : m === "type" ? [field("Name", typed), field("Style", fontSel), preview] : [field("Image of your signature (transparent PNG works best)", up)]));
    if (m === "draw") requestAnimationFrame(sizePad);
  };
  for (const [m, l] of [["draw", "Draw"], ["type", "Type"], ["upload", "Upload"]]) tabs.append(h("button", { type: "button", "data-m": m, onclick: () => show(m) }, l));
  const r = dialog({ title: "Create signature", body: [tabs, pane, h("label", { class: "chk", style: "margin-top:10px" }, remember, "Remember in this browser")], ok: "Use signature", wide: true,
    validate: () => { if (mode === "draw" && !any) return "Draw your signature first."; if (mode === "type" && !typed.value.trim()) return "Type your name first."; if (mode === "upload" && !up.files[0]) return "Choose an image."; } });
  show("draw");
  if (!(await r)) return;
  let url;
  if (mode === "draw") url = trimCanvas(pad);
  else if (mode === "type") {
    const c = document.createElement("canvas"); c.width = 900; c.height = 220; const x = c.getContext("2d");
    x.font = `110px ${fontSel.value}`; x.fillStyle = "#0b2a6f"; x.textBaseline = "middle"; x.fillText(typed.value.trim(), 20, 115);
    url = trimCanvas(c);
  } else url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(up.files[0]); });
  if (remember.checked) storeSigs([...loadSigs().filter((s) => s !== url), url]);
  await useSig(url);
}
function trimCanvas(c) {
  const x = c.getContext("2d"), { width: w, height: hh } = c, d = x.getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = 0, y1 = 0;
  for (let y = 0; y < hh; y++) for (let xx = 0; xx < w; xx++) if (d[(y * w + xx) * 4 + 3] > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) return c.toDataURL("image/png");
  const pad = 6, o = document.createElement("canvas"); o.width = x1 - x0 + pad * 2; o.height = y1 - y0 + pad * 2;
  o.getContext("2d").drawImage(c, x0 - pad, y0 - pad, o.width, o.height, 0, 0, o.width, o.height);
  return o.toDataURL("image/png");
}

// ---------------------------------------------------------------- custom fonts
function uploadFont() {
  const inp = $("#file-any"); inp.accept = ".ttf,.otf,font/ttf,font/otf"; inp.multiple = false;
  inp.onchange = async () => {
    const f = inp.files[0]; inp.value = ""; if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const id = uid("f"), family = "PKFont-" + id;
    try { const face = new FontFace(family, bytes); await face.load(); document.fonts.add(face); }
    catch { status("That file isn't a font this browser can read.", true); return; }
    S.fonts.set(id, { name: baseName(f.name), bytes, family });
    const s = selected();
    if (s && s.a.t === "text") { commit("font", { silent: true }); s.a.font = "custom:" + id; renderOverlay(s.p.uid); }
    S.props.font = "custom:" + id; renderProps();
    status(`Font “${baseName(f.name)}” added. It will be embedded in the PDF.`);
  };
  inp.click();
}

// ---------------------------------------------------------------- settings
$("#btn-settings").onclick = async () => {
  let theme = "auto"; try { theme = localStorage.getItem(THEME_KEY) || "auto"; } catch {}
  const th = sel("theme", [["auto", "Match system"], ["light", "Light"], ["dark", "Dark"]], theme);
  const onPi = S.caps && !S.server;
  const srv = input({ type: "url", name: "server", value: savedServer() || "", placeholder: "https://pdfserver.elvoid.com" });
  const test = h("span", { class: "hint" });
  const author = input({ name: "author", value: (() => { try { return localStorage.getItem("pk-author") || ""; } catch { return ""; } })() });
  const body = [field("Theme", th), field("Your name (for comments)", author)];
  if (onPi) body.push(h("div", { class: "note-box" }, `Connected to this server (${location.host}). Server tools: ${Object.keys(S.caps.tools).filter((k) => S.caps.tools[k]).join(", ")}.`));
  else body.push(field("Processing server (optional)", srv), h("div", { class: "inline" }, h("button", { type: "button", class: "btn sm", onclick: async () => { test.textContent = "Testing…"; const c = await probe(srv.value.trim()); test.textContent = c ? `OK: ${Object.keys(c.tools).filter((k) => c.tools[k]).join(", ")}` : "No pdfKraken server answered at that address."; } }, "Test"), test),
    h("p", { class: "hint" }, "A pdfKraken server adds OCR with OCRmyPDF, Ghostscript compression, Office → PDF, repair and PDF/A. Server tools upload the document to that server; everything else stays in your browser. Leave empty to stay fully offline."));
  const r = await dialog({ title: "Settings", body, ok: "Save" });
  if (!r) return;
  try { th.value === "auto" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, th.value); localStorage.setItem("pk-author", author.value); } catch {}
  applyTheme(th.value);
  if (!onPi) { saveServer(srv.value.trim() || null); await refreshMode(); status(S.caps ? "Processing server connected." : srv.value.trim() ? "Couldn't reach that server; using the browser only." : "Browser-only mode."); }
};

// ---------------------------------------------------------------- toolbar & keyboard
$$("#toolstrip button").forEach((b) => (b.onclick = () => { if (!S.pages.length) return; setTool(b.dataset.tool); if (b.dataset.tool === "sign" && !activeSig) { const s = loadSigs(); if (s.length) useSig(s[s.length - 1]); else signatureDialog(); } }));
$("#btn-tools").onclick = () => toolsMenu();
$("#btn-save").onclick = () => save().catch((e) => status(e.message || String(e), true));
$("#btn-undo").onclick = () => { finishEdit(); doUndo(); };
$("#btn-redo").onclick = () => { finishEdit(); doRedo(); };
bindPointer($("#pages"));

const KEYS = { b: "browse", v: "select", t: "text", e: "edittext", h: "highlight", d: "ink", r: "rect", o: "ellipse", l: "line", a: "arrow", i: "image", s: "sign", n: "note", w: "whiteout", x: "redact", c: "crop" };
addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]") || isEditing();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (S.pages.length) (e.shiftKey ? runTool("saveas") : save()).catch?.((er) => status(er.message, true)); return; }
  if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); $("#file-open").click(); return; }
  if (mod && e.key.toLowerCase() === "p" && S.pages.length) { e.preventDefault(); runTool("print"); return; }
  if (mod && e.key.toLowerCase() === "f" && S.pages.length) { e.preventDefault(); showTab("search"); return; }
  if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomStep(1); return; }
  if (mod && e.key === "-") { e.preventDefault(); zoomStep(-1); return; }
  if (mod && e.key === "0") { e.preventDefault(); setZoom("fit"); return; }
  if (typing || document.querySelector("dialog[open]")) return;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
  if (mod && e.key.toLowerCase() === "c") { if (copySelected()) { e.preventDefault(); status("Copied."); } return; }
  if (mod && e.key.toLowerCase() === "v") { if (pasteClipboard()) e.preventDefault(); return; }
  if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); if (copySelected()) pasteClipboard(); return; }
  if (mod) return;
  if (e.key === "Delete" || e.key === "Backspace") { if (deleteSelected()) e.preventDefault(); else if (S.selectedPages.size && document.activeElement?.closest?.(".sidebar")) pageOp("del"); return; }
  if (e.key === "Escape") { if (S.sel) select(null); else setTool("browse"); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key] && S.sel) { e.preventDefault(); const [dx, dy] = arrows[e.key]; nudge(dx * (e.shiftKey ? 10 : 1), dy * (e.shiftKey ? 10 : 1)); return; }
  if ((e.key === "PageDown" || e.key === "PageUp") && S.pages.length) { e.preventDefault(); goToPage(S.current + (e.key === "PageDown" ? 1 : -1)); return; }
  if (e.key === "Home" && S.pages.length && !S.sel) { goToPage(0); return; }
  if (e.key === "End" && S.pages.length && !S.sel) { goToPage(S.pages.length - 1); return; }
  const t = KEYS[e.key.toLowerCase()];
  if (t && S.pages.length) { setTool(t); if (t === "sign") $('#toolstrip [data-tool="sign"]').click(); }
});
addEventListener("beforeunload", (e) => { if (S.dirty && S.pages.length) { e.preventDefault(); e.returnValue = ""; } });

// open a PDF passed as ?url= (same-origin or CORS-enabled)
async function openFromUrl() {
  const u = new URLSearchParams(location.search).get("url"); if (!u) return;
  try {
    const r = await fetch(u); if (!r.ok) throw new Error(r.status);
    const blob = await r.blob(); const name = decodeURIComponent(new URL(u, location.href).pathname.split("/").pop() || "document.pdf");
    await openFiles([new File([blob], name, { type: blob.type || "application/pdf" })]);
  } catch (e) { status("Couldn't load that link (" + (e.message || e) + "). Download it and open it instead.", true); }
}

// ---------------------------------------------------------------- boot
setTool("browse");
refreshMode();
openFromUrl();
window.pdfKraken = { S, emit, rerenderAll, srcOf }; // handy for debugging in the console
