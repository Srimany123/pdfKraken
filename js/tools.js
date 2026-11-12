// Document-level tools, reached from the Tools menu.
import { S, h, uid, commit, emit, status, withBusy, download, baseName, parseRanges, parseGroups, fmtBytes, measureText, frame, $ } from "./state.js";
import { dialog, field, select, input, check } from "./ui.js";
import { buildPdf, buildAndOpen, needsClean } from "./build.js";
import { addFiles, insertBlank, replaceWithBytes, PAGE_SIZES } from "./docs.js";
import { viewport, rotationOf, proxyOf, srcOf, textItems } from "./view.js";
import { has, runJob } from "./server.js";
import { pdfjsLib, openPdf } from "./pdfjs.js";

const n = () => S.pages.length;
const curRange = () => S.selectedPages.size ? [...S.selectedPages].map((u) => S.pages.findIndex((p) => p.uid === u)).filter((i) => i >= 0).sort((a, b) => a - b).map((i) => i + 1).join(",") : "all";
const rangeField = (value = "all", label = "Pages") => { const i = input({ name: "range", value, placeholder: "e.g. 1-3, 5, 8-  ·  all · odd · even" }); return [field(label, i), i]; };
function pagesFrom(str) { const idx = parseRanges(str, n()); if (!idx.length) throw new Error("No pages match that range."); return idx; }
const checkRange = (inp) => () => { try { pagesFrom(inp.value); } catch (e) { return e.message; } };
function pickFiles(accept, multiple = true) {
  return new Promise((res) => {
    const inp = $("#file-any"); inp.accept = accept; inp.multiple = multiple;
    inp.onchange = () => { const f = [...inp.files]; inp.value = ""; res(f); };
    inp.click();
  });
}
const outName = (suffix, ext = ".pdf") => baseName(S.name) + suffix + ext;
async function zipOrSingle(files, zipName) {
  if (files.length === 1) return download(files[0].data, files[0].name, files[0].type);
  const zip = new window.JSZip();
  for (const f of files) zip.file(f.name, f.data);
  download(await zip.generateAsync({ type: "blob" }), zipName, "application/zip");
}
async function offerResult(bytes, name, before) {
  const size = bytes.byteLength;
  const body = [h("p", {}, before ? `Result: ${fmtBytes(size)} (was ${fmtBytes(before)}, ${size < before ? Math.round((1 - size / before) * 100) + "% smaller" : "not smaller"}).` : `Result: ${fmtBytes(size)}.`)];
  const r = await dialog({ title: "Done", body, ok: "Download", extra: [{ label: "Open in editor", value: "open" }], cancel: "Close" });
  if (r === "ok") download(bytes, name);
  else if (r === "open") await replaceWithBytes(new Uint8Array(bytes), name);
}
const engineField = (tool, browserLabel = "In this browser", serverLabel = "On the server") => {
  const srv = has(tool);
  const s = select("engine", srv ? [["server", serverLabel], ["browser", browserLabel]] : [["browser", browserLabel]], srv ? "server" : "browser");
  return [field("Run", s), s];
};

// ================================================================ menu
export const TOOLS = [
  ["Organize"],
  ["merge", "Merge PDFs", "Append other PDFs or images to the end"],
  ["insert", "Insert pages", "Put pages from another file at any position"],
  ["split", "Split", "Into ranges, every N pages, or single pages"],
  ["extract", "Extract pages", "Save a selection of pages as a new PDF"],
  ["delete", "Delete pages", "Remove pages by number"],
  ["rotate", "Rotate pages", "Turn pages by 90°, 180° or 270°"],
  ["reorder", "Reorder", "Reverse, custom order, or interleave duplex scans"],
  ["blank", "Blank pages", "Insert empty pages of any size"],
  ["Edit"],
  ["watermark", "Watermark", "Text across or tiled over pages"],
  ["numbers", "Page numbers", "Page numbers, headers and footers"],
  ["cropall", "Crop margins", "Trim the same margin from many pages"],
  ["metadata", "Properties", "Title, author, subject, keywords"],
  ["redactfind", "Find & redact", "Black out every occurrence of a word"],
  ["clearanns", "Remove my edits", "Clear added objects from pages"],
  ["Protect & optimize"],
  ["protect", "Password protect", "AES-256 encryption and permissions"],
  ["compress", "Compress", "Shrink images or the whole file"],
  ["ocr", "OCR", "Make scanned pages searchable"],
  ["repair", "Repair", "Fix damaged or malformed PDFs", "server"],
  ["linearize", "Fast web view", "Linearize for streaming", "server"],
  ["pdfa", "PDF/A", "Convert for long-term archiving", "server"],
  ["Convert"],
  ["toimages", "PDF to images", "PNG or JPEG of each page"],
  ["totext", "PDF to text", "Plain text of every page"],
  ["fromimages", "Images to PDF", "Add photos or scans as pages"],
  ["office", "Office to PDF", "Word, Excel, PowerPoint, ODF…", "server"],
  ["print", "Print", "Print the edited document"],
  ["saveas", "Save as…", "Filename, flatten forms, clean copy"],
];
export async function toolsMenu() {
  const grid = h("div", { class: "toolgrid" });
  let picked = null;
  const r = dialog({ title: "Tools", body: grid, wide: true, ok: null, cancel: null, noFooter: true });
  for (const t of TOOLS) {
    if (t.length === 1) { grid.append(h("h3", {}, t[0])); continue; }
    const [id, title, desc, need] = t;
    const off = need === "server" && !has(id === "office" ? "office" : id);
    const b = h("button", { type: "button", disabled: off || (!n() && !["merge", "fromimages", "office"].includes(id)), title: off ? "Needs the processing server (see Settings)" : desc, onclick: () => { picked = id; b.closest("dialog").close("ok"); } },
      h("b", {}, title), h("span", {}, desc), need === "server" ? h("em", {}, off ? "Server only" : "Server") : null);
    grid.append(b);
  }
  await r;
  if (picked) await runTool(picked);
}
export async function runTool(id) {
  try { await (T[id] || (() => status("Unknown tool")))(); }
  catch (e) { console.error(e); status(e.message || String(e), true); }
}

// ================================================================ tools
const T = {
  async merge() { const f = await pickFiles("application/pdf,.pdf,image/*"); if (f.length) await withBusy("Adding files…", () => addFiles(f)); },
  async fromimages() { const f = await pickFiles("image/*"); if (f.length) await withBusy("Adding images…", () => addFiles(f)); },
  async office() {
    const f = await pickFiles(".docx,.doc,.odt,.rtf,.txt,.xlsx,.xls,.ods,.csv,.pptx,.ppt,.odp,.html,.epub");
    if (f.length) await withBusy("Converting on the server…", () => addFiles(f));
  },
  async insert() {
    const pos = select("pos", [["end", "At the end"], ["start", "At the start"], ["after", "After page…"]], "after");
    const after = input({ type: "number", name: "after", min: 0, max: n(), value: S.current + 1 });
    const r = await dialog({ title: "Insert pages from a file", body: [h("div", { class: "grid2" }, field("Where", pos), field("Page", after))], ok: "Choose file…" });
    if (!r) return;
    const at = pos.value === "end" ? n() : pos.value === "start" ? 0 : Math.max(0, Math.min(n(), +after.value || 0));
    const f = await pickFiles("application/pdf,.pdf,image/*");
    if (f.length) await withBusy("Inserting…", () => addFiles(f, at));
  },
  async split() {
    const mode = select("mode", [["every", "Every N pages"], ["ranges", "Custom ranges (one file each)"], ["single", "Each page as its own file"], ["half", "Into two halves"]], "every");
    const every = input({ type: "number", name: "every", min: 1, value: 1 });
    const ranges = input({ name: "ranges", placeholder: "1-3, 4-6, 7-" });
    const r = await dialog({ title: "Split document", body: [field("Split", mode), field("N (pages per file)", every), field("Ranges", ranges), h("p", { class: "hint" }, `The document has ${n()} pages. Several files download as one .zip.`)], ok: "Split",
      validate: () => { if (mode.value === "ranges") { try { if (!parseGroups(ranges.value, n()).length) return "Enter at least one range."; } catch (e) { return e.message; } } } });
    if (!r) return;
    let groups = [];
    const all = [...Array(n()).keys()];
    if (mode.value === "every") { const k = Math.max(1, +every.value || 1); for (let i = 0; i < n(); i += k) groups.push(all.slice(i, i + k)); }
    else if (mode.value === "single") groups = all.map((i) => [i]);
    else if (mode.value === "half") { const m = Math.ceil(n() / 2); groups = [all.slice(0, m), all.slice(m)].filter((g) => g.length); }
    else groups = parseGroups(ranges.value, n());
    await withBusy("Splitting…", async (prog) => {
      const files = [];
      for (let g = 0; g < groups.length; g++) {
        prog(`Building part ${g + 1} of ${groups.length}…`, g / groups.length);
        const idx = groups[g];
        const label = idx.length === 1 ? `p${idx[0] + 1}` : `p${idx[0] + 1}-${idx[idx.length - 1] + 1}`;
        files.push({ name: outName("_" + label), data: await buildPdf({ pages: idx.map((i) => S.pages[i]) }), type: "application/pdf" });
      }
      await zipOrSingle(files, outName("_split", ".zip"));
    });
  },
  async extract() {
    const [f, inp] = rangeField(curRange());
    const [c1, del] = check("Remove these pages from this document afterwards");
    const r = await dialog({ title: "Extract pages", body: [f, c1], ok: "Extract", validate: checkRange(inp) });
    if (!r) return;
    const idx = pagesFrom(inp.value);
    const bytes = await withBusy("Extracting…", () => buildPdf({ pages: idx.map((i) => S.pages[i]) }));
    download(bytes, outName("_pages"));
    if (del.checked) { commit("delete", { silent: true }); const set = new Set(idx); S.pages = S.pages.filter((_, i) => !set.has(i)); emit("pages"); }
  },
  async delete() {
    const [f, inp] = rangeField(curRange() === "all" ? "" : curRange());
    const r = await dialog({ title: "Delete pages", body: [f], ok: "Delete", danger: true, validate: () => { const e = checkRange(inp)(); if (e) return e; if (pagesFrom(inp.value).length >= n()) return "That would delete every page."; } });
    if (!r) return;
    const set = new Set(pagesFrom(inp.value));
    commit("delete", { silent: true }); S.pages = S.pages.filter((_, i) => !set.has(i)); S.selectedPages.clear(); emit("pages");
    status(`Deleted ${set.size} page${set.size > 1 ? "s" : ""}.`);
  },
  async rotate() {
    const [f, inp] = rangeField(curRange());
    const ang = select("angle", [["90", "90° clockwise"], ["270", "90° counter-clockwise"], ["180", "180°"]], "90");
    const r = await dialog({ title: "Rotate pages", body: [f, field("Rotation", ang)], ok: "Rotate", validate: checkRange(inp) });
    if (!r) return;
    commit("rotate", { silent: true });
    for (const i of pagesFrom(inp.value)) S.pages[i].rot = (S.pages[i].rot + +ang.value) % 360;
    emit("pages");
  },
  async reorder() {
    const mode = select("mode", [["reverse", "Reverse all pages"], ["custom", "Custom order"], ["interleave", "Interleave duplex scan (fronts, then backs in reverse)"], ["interleave2", "Interleave (fronts, then backs in order)"], ["oddeven", "Odd pages first, then even"]], "reverse");
    const order = input({ name: "order", placeholder: "e.g. 3, 1, 2, 4-" });
    const r = await dialog({ title: "Reorder pages", body: [field("Order", mode), field("Custom order (pages not listed are dropped)", order), h("p", { class: "hint" }, "Tip: you can also drag thumbnails in the Pages panel.")], ok: "Reorder",
      validate: () => { if (mode.value === "custom") { try { if (!parseRanges(order.value, n()).length) return "Enter an order."; } catch (e) { return e.message; } } } });
    if (!r) return;
    const P = S.pages; let out;
    if (mode.value === "reverse") out = [...P].reverse();
    else if (mode.value === "custom") out = parseRanges(order.value, n()).map((i) => (i === undefined ? null : P[i])).filter(Boolean).map((p, k, arr) => arr.indexOf(p) === k ? p : { ...structuredClone(p), uid: uid("p") });
    else if (mode.value === "oddeven") out = [...P.filter((_, i) => i % 2 === 0), ...P.filter((_, i) => i % 2 === 1)];
    else {
      const m = Math.ceil(P.length / 2), fronts = P.slice(0, m), backs = P.slice(m);
      if (mode.value === "interleave") backs.reverse();
      out = []; for (let i = 0; i < m; i++) { out.push(fronts[i]); if (backs[i]) out.push(backs[i]); }
    }
    commit("reorder", { silent: true }); S.pages = out; emit("pages");
  },
  async blank() {
    const size = select("size", [["same", "Same as current page"], ...Object.keys(PAGE_SIZES).map((k) => [k, k])], "same");
    const orient = select("orient", [["portrait", "Portrait"], ["landscape", "Landscape"]], "portrait");
    const count = input({ type: "number", name: "count", min: 1, max: 500, value: 1 });
    const pos = input({ type: "number", name: "pos", min: 0, max: n(), value: S.current + 1 });
    const r = await dialog({ title: "Insert blank pages", body: [h("div", { class: "grid2" }, field("Size", size), field("Orientation", orient), field("How many", count), field("After page (0 = at start)", pos))], ok: "Insert" });
    if (!r) return;
    let dims;
    if (size.value === "same" && n()) { const vp = viewport(S.pages[S.current], 1); dims = [vp.width, vp.height]; }
    else dims = [...(PAGE_SIZES[size.value] || PAGE_SIZES.A4)];
    if (size.value !== "same" && orient.value === "landscape") dims.reverse();
    await insertBlank(Math.max(0, Math.min(n(), +pos.value || 0)), dims, Math.max(1, Math.min(500, +count.value || 1)));
  },

  async watermark() {
    const text = input({ name: "text", value: "CONFIDENTIAL", required: true });
    const size = input({ type: "number", name: "size", value: 60, min: 6, max: 300 });
    const color = h("input", { type: "color", value: "#dc2626" });
    const opacity = input({ type: "number", name: "op", value: 25, min: 5, max: 100 });
    const angle = select("angle", [["45", "Diagonal ↗"], ["0", "Horizontal"], ["-45", "Diagonal ↘"], ["90", "Vertical"]], "45");
    const layout = select("layout", [["center", "Once, centred"], ["tile", "Tiled across the page"], ["top", "Top of page"], ["bottom", "Bottom of page"]], "center");
    const font = select("font", [["Helvetica", "Sans"], ["Times", "Serif"], ["Courier", "Mono"], ["Unicode", "Unicode"]], "Helvetica");
    const [c1, bold] = check("Bold", { checked: true });
    const [f, inp] = rangeField("all");
    const r = await dialog({ title: "Add watermark", body: [field("Text", text), h("div", { class: "grid2" }, field("Font size", size), field("Font", font), field("Colour", color), field("Opacity %", opacity), field("Angle", angle), field("Layout", layout)), c1, f, h("p", { class: "hint" }, "The watermark is added as editable objects: undo, move or delete them like anything else, or remove them all from Tools → Remove my edits.")], ok: "Add watermark", validate: checkRange(inp) });
    if (!r) return;
    commit("watermark", { silent: true });
    const group = uid("wm");
    for (const i of pagesFrom(inp.value)) {
      const p = S.pages[i], vp = viewport(p, 1), R = rotationOf(p) + +angle.value;
      const base = { t: "text", text: text.value, size: +size.value || 60, font: font.value, bold: bold.checked, color: color.value, opacity: (+opacity.value || 25) / 100, R, wm: group };
      const m = measureText(base);
      const spots = [];
      if (layout.value === "tile") { const sx = m.w * 0.9 + 80, sy = m.h * 3 + 60; for (let y = sy / 2; y < vp.height + sy; y += sy) for (let x = (Math.round(y / sy) % 2 ? sx / 2 : 0); x < vp.width + sx; x += sx) spots.push([x, y]); }
      else spots.push([vp.width / 2, layout.value === "top" ? m.h + 24 : layout.value === "bottom" ? vp.height - m.h - 24 : vp.height / 2]);
      for (const [sx, sy] of spots) {
        const [ux, uy] = vp.convertToPdfPoint(sx, sy);
        const a = { id: uid("a"), ...base, ...m };
        const fr = frame(R); a.x = ux - fr.right[0] * m.w / 2 - fr.down[0] * m.h / 2; a.y = uy - fr.right[1] * m.w / 2 - fr.down[1] * m.h / 2;
        p.anns.push(a);
      }
    }
    emit("pages"); status("Watermark added.");
  },
  async numbers() {
    const fmt = select("fmt", [["{n}", "1"], ["Page {n}", "Page 1"], ["Page {n} of {total}", "Page 1 of 9"], ["{n} / {total}", "1 / 9"], ["- {n} -", "- 1 -"], ["custom", "Custom text…"]], "Page {n} of {total}");
    const custom = input({ name: "custom", placeholder: "e.g. {title} · {date} · Page {n}" });
    const pos = select("pos", [["bc", "Bottom centre"], ["br", "Bottom right"], ["bl", "Bottom left"], ["tc", "Top centre"], ["tr", "Top right"], ["tl", "Top left"]], "bc");
    const size = input({ type: "number", name: "size", value: 10, min: 4, max: 72 });
    const start = input({ type: "number", name: "start", value: 1 });
    const margin = input({ type: "number", name: "margin", value: 28, min: 0, max: 200 });
    const color = h("input", { type: "color", value: "#333333" });
    const font = select("font", [["Helvetica", "Sans"], ["Times", "Serif"], ["Courier", "Mono"], ["Unicode", "Unicode"]], "Helvetica");
    const [f, inp] = rangeField("all", "Pages to number");
    const [c1, skip] = check("Don't number the first page (cover)");
    const r = await dialog({ title: "Page numbers, header & footer", body: [field("Format", fmt), field("Custom text ({n}, {total}, {date}, {title}, {file})", custom), h("div", { class: "grid2" }, field("Position", pos), field("Font", font), field("Size", size), field("Colour", color), field("Start at", start), field("Margin (pt)", margin)), f, c1], ok: "Add", validate: checkRange(inp) });
    if (!r) return;
    commit("numbers", { silent: true });
    const group = uid("pn");
    let idx = pagesFrom(inp.value); if (skip.checked) idx = idx.filter((i) => i !== 0);
    const total = idx.length + (+start.value || 1) - 1;
    const tpl = fmt.value === "custom" ? custom.value || "{n}" : fmt.value;
    idx.forEach((i, k) => {
      const p = S.pages[i], vp = viewport(p, 1), R = rotationOf(p);
      const a = { id: uid("a"), t: "text", text: fillTpl(tpl, k + (+start.value || 1), total), size: +size.value || 10, font: font.value, color: color.value, R, pn: group, tpl, start: +start.value || 1, pnPos: pos.value, mg: +margin.value || 0 };
      placeNumber(a, p);
      p.anns.push(a);
      void vp;
    });
    emit("pages"); status(`Numbered ${idx.length} pages.`);
  },
  async cropall() {
    const mg = ["top", "right", "bottom", "left"].map((k) => input({ type: "number", name: k, value: 36, min: 0 }));
    const [f, inp] = rangeField(curRange());
    const r = await dialog({ title: "Crop margins", body: [h("p", {}, "Trim this many points from each edge (72 pt = 1 inch, 28.35 pt = 1 cm). Measured as the page appears on screen."), h("div", { class: "grid2" }, field("Top", mg[0]), field("Right", mg[1]), field("Bottom", mg[2]), field("Left", mg[3])), f, h("p", { class: "hint" }, "For a custom area on one page use the Crop tool in the toolbar.")], ok: "Crop", validate: checkRange(inp) });
    if (!r) return;
    commit("crop", { silent: true });
    const [t, rt, b, l] = mg.map((m) => Math.max(0, +m.value || 0));
    for (const i of pagesFrom(inp.value)) {
      const p = S.pages[i], vp = viewport(p, 1);
      if (l + rt >= vp.width || t + b >= vp.height) continue;
      const a = vp.convertToPdfPoint(l, t), c = vp.convertToPdfPoint(vp.width - rt, vp.height - b);
      p.crop = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
    }
    emit("pages");
  },
  async metadata() {
    let info = {};
    try { info = (await S.sources.find((s) => s.id === S.pages[0]?.src)?.pdf.getMetadata())?.info || {}; } catch {}
    const m = S.meta || {};
    const fields = ["title", "author", "subject", "keywords", "creator"].map((k) => input({ name: k, value: m[k] ?? (k === "keywords" ? info.Keywords : info[k[0].toUpperCase() + k.slice(1)]) ?? "" }));
    const name = input({ name: "fname", value: S.name });
    const r = await dialog({ title: "Document properties", body: [field("File name", name), ...["Title", "Author", "Subject", "Keywords (comma separated)", "Creator"].map((l, i) => field(l, fields[i])), h("p", { class: "hint" }, `Pages: ${n()} · Producer: ${info.Producer || "—"} · PDF ${info.PDFFormatVersion || "—"}`)], ok: "Save" });
    if (!r) return;
    commit("meta", { silent: true });
    S.meta = Object.fromEntries(["title", "author", "subject", "keywords", "creator"].map((k, i) => [k, fields[i].value]));
    S.name = /\.pdf$/i.test(name.value) ? name.value : (name.value || "document") + ".pdf";
    emit("meta"); status("Properties updated. They are written when you download.");
  },
  async redactfind() {
    const q = input({ name: "q", required: true, placeholder: "Name, number, e-mail…" });
    const [c1, cs] = check("Match case");
    const [c2, ww] = check("Whole words only");
    const [c3, rx] = check("Regular expression (e.g. \\d{3}-\\d{2}-\\d{4})");
    const r = await dialog({ title: "Find & redact", body: [field("Text to remove", q), c1, c2, c3, h("p", { class: "hint" }, "Every match gets a redaction box; review them, then download. Redacted pages are flattened to images.")], ok: "Mark matches",
      validate: () => { if (rx.checked) { try { new RegExp(q.value); } catch (e) { return "Invalid expression: " + e.message; } } } });
    if (!r) return;
    const hits = await findAll(q.value, { matchCase: cs.checked, wholeWord: ww.checked, regex: rx.checked });
    if (!hits.length) return status("No matches found.");
    commit("redact", { silent: true });
    for (const hit of hits) { const p = S.pages.find((x) => x.uid === hit.uid); for (const rr of hit.rects) p.anns.push({ id: uid("a"), t: "redact", r: [rr[0] - 1, rr[1] - 1, rr[2] + 1, rr[3] + 1] }); }
    emit("pages"); status(`Marked ${hits.length} match${hits.length > 1 ? "es" : ""} for redaction.`);
  },
  async clearanns() {
    const what = select("what", [["all", "Everything I added"], ["wm", "Watermarks only"], ["pn", "Page numbers only"], ["redact", "Redaction marks only"], ["hl", "Highlights only"], ["note", "Notes only"]], "all");
    const [f, inp] = rangeField("all");
    const r = await dialog({ title: "Remove my edits", body: [field("Remove", what), f, h("p", { class: "hint" }, "This only removes objects added in pdfKraken in this session. Undo brings them back.")], ok: "Remove", danger: true, validate: checkRange(inp) });
    if (!r) return;
    commit("clear", { silent: true });
    const test = { all: () => true, wm: (a) => a.wm, pn: (a) => a.pn, redact: (a) => a.t === "redact", hl: (a) => a.t === "hl", note: (a) => a.t === "note" }[what.value];
    let k = 0;
    for (const i of pagesFrom(inp.value)) { const p = S.pages[i]; const before = p.anns.length; p.anns = p.anns.filter((a) => !test(a)); k += before - p.anns.length; }
    S.sel = null; emit("pages"); status(`Removed ${k} object${k === 1 ? "" : "s"}.`);
  },

  async protect() {
    const cur = S.security || {};
    const user = input({ type: "password", name: "user", value: cur.userPassword || "", autocomplete: "new-password", placeholder: "Needed to open the file" });
    const owner = input({ type: "password", name: "owner", value: cur.ownerPassword || "", autocomplete: "new-password", placeholder: "Needed to change permissions" });
    const perms = [["printing", "Allow printing"], ["copying", "Allow copying text and images"], ["modifying", "Allow editing"], ["annotating", "Allow comments"], ["fillingForms", "Allow filling forms"], ["contentAccessibility", "Allow screen readers"], ["documentAssembly", "Allow inserting/rotating pages"]]
      .map(([k, l]) => { const [lab, c] = check(l, { checked: cur.permissions ? !!cur.permissions[k] : true }); c.dataset.k = k; return [lab, c]; });
    const [cshow, show] = check("Show passwords");
    show.addEventListener("change", () => { user.type = owner.type = show.checked ? "text" : "password"; });
    const body = [h("p", {}, "The file is encrypted with AES-256 when you download it. Without the open password nobody can read it; the permissions apply to people who open it with the open password only."),
      field("Open password", user), field("Permissions password (owner)", owner), cshow, h("div", { class: "field" }, h("span", {}, "Permissions"), ...perms.map((p) => p[0]))];
    if (srcOf(S.pages[0] || {})?.password) body.unshift(h("div", { class: "note-box" }, "This document was opened with a password. It downloads without one unless you set one here."));
    const r = await dialog({ title: "Password protect", body, ok: "Use these settings", extra: S.security ? [{ label: "Remove protection", value: "remove", novalidate: true }] : [],
      validate: (v) => { if (v === "ok" && !user.value && !owner.value) return "Enter at least one password."; } });
    if (r === "remove") { S.security = null; emit("meta"); return status("Protection removed: the download will not be encrypted."); }
    if (!r) return;
    const permissions = {};
    for (const [, c] of perms) if (c.checked) permissions[c.dataset.k] = c.dataset.k === "printing" ? "highResolution" : true;
    S.security = { userPassword: user.value, ownerPassword: owner.value || user.value + "\u0001" + Math.random().toString(36).slice(2), permissions };
    emit("meta"); status("Protection set. It is applied when you download.");
  },
  async compress() {
    const [ef, eng] = engineField("compress", "In this browser (recompress images)", "On the server (Ghostscript)");
    const level = select("level", [["screen", "Smallest (72 dpi images)"], ["ebook", "Balanced (150 dpi)"], ["printer", "High quality (300 dpi)"]], "ebook");
    const quality = input({ type: "number", name: "q", min: 20, max: 95, value: 70 });
    const [cr, raster] = check("Browser: also flatten every page to an image (smallest, but text is no longer selectable)");
    const r = await dialog({ title: "Compress", body: [ef, field("Level", level), field("JPEG quality (browser)", quality), cr, h("p", { class: "hint" }, "Your edits are applied first. The browser method shrinks large photos and scans; the server method rewrites the whole file and usually does better on text-heavy PDFs.")], ok: "Compress" });
    if (!r) return;
    const dpi = { screen: 72, ebook: 150, printer: 300 }[level.value];
    const { input0, out } = await withBusy("Compressing…", async (prog) => {
      const input0 = await buildPdf({ progress: prog });
      let out;
      if (eng.value === "server") out = new Uint8Array(await (await runJob("compress", new File([input0], outName("")), { level: level.value }, prog)).blob.arrayBuffer());
      else if (raster.checked) out = await rasterizeAll(input0, dpi, (+quality.value || 70) / 100, prog);
      else out = await recompressImages(input0, dpi, (+quality.value || 70) / 100, prog);
      return { input0, out };
    });
    await offerResult(out.byteLength < input0.byteLength ? out : input0, outName("_compressed"), input0.byteLength);
  },
  async ocr() {
    const [ef, eng] = engineField("ocr", "In this browser (Tesseract.js, slower)", "On the server (OCRmyPDF)");
    const langs = [["eng", "English"], ["hin", "Hindi"], ["tel", "Telugu"], ["tam", "Tamil"], ["kan", "Kannada"], ["mar", "Marathi"], ["ben", "Bengali"], ["fra", "French"], ["deu", "German"], ["spa", "Spanish"], ["ita", "Italian"], ["por", "Portuguese"], ["nld", "Dutch"], ["rus", "Russian"], ["ara", "Arabic"], ["chi_sim", "Chinese (simplified)"], ["jpn", "Japanese"], ["kor", "Korean"]];
    const lang = select("lang", langs, "eng");
    const [f, inp] = rangeField("all");
    const [c1, skip] = check("Skip pages that already contain text", { checked: true });
    const [c2, deskew] = check("Server: deskew and clean up scans");
    const srvLangs = S.caps?.ocr_languages;
    const r = await dialog({ title: "OCR — recognise text", body: [ef, field("Language", lang), f, c1, c2, h("p", { class: "hint" }, "Adds an invisible text layer so scanned pages can be searched, selected and copied. Browser OCR downloads about 10–20 MB of language data the first time." + (srvLangs ? ` Server languages: ${srvLangs.join(", ")}.` : ""))], ok: "Run OCR", validate: checkRange(inp) });
    if (!r) return;
    if (eng.value === "server") {
      if (srvLangs && !srvLangs.includes(lang.value)) throw new Error(`The server has no ${lang.selectedOptions[0].text} language pack. Available: ${srvLangs.join(", ")}.`);
      await withBusy("Running OCR on the server…", async (prog) => {
        const pdf = await buildPdf({ progress: prog });
        const { blob } = await runJob("ocr", new File([pdf], outName("")), { lang: lang.value, skip_text: skip.checked ? 1 : 0, deskew: deskew.checked ? 1 : 0, pages: inp.value.trim().toLowerCase() === "all" ? "" : pagesFrom(inp.value).map((i) => i + 1).join(",") }, prog);
        await replaceWithBytes(new Uint8Array(await blob.arrayBuffer()), S.name);
      });
      return status("OCR finished: the text is now searchable.");
    }
    await browserOcr(pagesFrom(inp.value), lang.value, skip.checked);
  },
  async repair() { await serverPass("repair", "Repairing…", "_repaired"); },
  async linearize() { await serverPass("linearize", "Optimising for web…", "_web"); },
  async pdfa() { await serverPass("pdfa", "Converting to PDF/A…", "_pdfa"); },

  async toimages() {
    const fmt = select("fmt", [["png", "PNG (sharp, larger)"], ["jpeg", "JPEG (smaller)"], ["webp", "WebP"]], "png");
    const dpi = select("dpi", [["72", "72 dpi (screen)"], ["150", "150 dpi"], ["200", "200 dpi"], ["300", "300 dpi (print)"]], "150");
    const [f, inp] = rangeField(curRange());
    const r = await dialog({ title: "PDF to images", body: [h("div", { class: "grid2" }, field("Format", fmt), field("Resolution", dpi)), f], ok: "Convert", validate: checkRange(inp) });
    if (!r) return;
    const idx = pagesFrom(inp.value);
    await withBusy("Rendering pages…", async (prog) => {
      const { pdf } = await buildAndOpen({ pages: idx.map((i) => S.pages[i]) });
      const files = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        prog(`Rendering page ${i} of ${pdf.numPages}…`, i / pdf.numPages);
        const page = await pdf.getPage(i), vp = page.getViewport({ scale: +dpi.value / 72 });
        const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
        const blob = await new Promise((res) => c.toBlob(res, "image/" + fmt.value, 0.9));
        files.push({ name: `${baseName(S.name)}_p${idx[i - 1] + 1}.${fmt.value === "jpeg" ? "jpg" : fmt.value}`, data: blob, type: blob.type });
        c.width = c.height = 0;
      }
      pdf.destroy();
      await zipOrSingle(files, outName("_images", ".zip"));
    });
  },
  async totext() {
    const [f, inp] = rangeField("all");
    const [c1, marks] = check("Mark page breaks", { checked: true });
    const r = await dialog({ title: "PDF to text", body: [f, c1], ok: "Export", validate: checkRange(inp) });
    if (!r) return;
    const idx = pagesFrom(inp.value);
    await withBusy("Extracting text…", async () => {
      const { pdf } = await buildAndOpen({ pages: idx.map((i) => S.pages[i]), meta: false });
      let out = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent();
        let line = "", text = "";
        for (const it of tc.items) { line += it.str; if (it.hasEOL) { text += line + "\n"; line = ""; } }
        text += line;
        out += (marks.checked ? `\n===== Page ${idx[i - 1] + 1} =====\n` : i > 1 ? "\n\f" : "") + text.trim() + "\n";
      }
      pdf.destroy();
      download(new Blob([out.trimStart()], { type: "text/plain;charset=utf-8" }), outName("", ".txt"));
      if (!out.replace(/=+ Page \d+ =+/g, "").trim()) status("No text found. If this is a scan, run OCR first.", true);
    });
  },
  async print() {
    const bytes = await withBusy("Preparing to print…", () => buildPdf({ encrypt: null }));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const fr = h("iframe", { src: url, style: "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0" });
    fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch { window.open(url, "_blank"); } setTimeout(() => { fr.remove(); URL.revokeObjectURL(url); }, 120000); };
    document.body.append(fr);
  },
  async saveas() {
    const name = input({ name: "fname", value: S.name, required: true });
    const [c1, flat] = check("Flatten form fields (values become part of the page)");
    const [c2, clean] = check("Clean copy: rebuild from the pages only (drops bookmarks, form structure and leftovers of deleted pages)", { checked: needsClean() });
    if (needsClean()) clean.disabled = true;
    const enc = S.security ? h("div", { class: "note-box" }, "🔒 The download will be password protected (Tools → Password protect to change).") : null;
    const r = await dialog({ title: "Save as", body: [field("File name", name), c1, c2, enc], ok: "Download" });
    if (!r) return;
    S.name = /\.pdf$/i.test(name.value) ? name.value : name.value + ".pdf";
    await save({ flatten: flat.checked, clean: clean.checked });
  },
};

export async function save(o = {}) {
  const bytes = await withBusy("Building PDF…", (prog) => buildPdf({ ...o, encrypt: S.security, progress: prog }));
  download(bytes, S.name);
  S.dirty = false; emit("saved");
  status(`Downloaded ${S.name} (${fmtBytes(bytes.byteLength)}).`);
}

async function serverPass(tool, msg, suffix) {
  const { out, before } = await withBusy(msg, async (prog) => {
    const pdf = await buildPdf({ progress: prog });
    const { blob } = await runJob(tool, new File([pdf], outName("")), {}, prog);
    return { out: new Uint8Array(await blob.arrayBuffer()), before: pdf.byteLength };
  });
  await offerResult(out, outName(suffix), before);
}

// ---------------------------------------------------------------- browser compression
async function recompressImages(bytes, dpi, quality, prog) {
  const { PDFDocument, PDFName, PDFRawStream, PDFNumber, decodePDFRawStream } = window.PDFLib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const maxPx = Math.round((dpi / 72) * 842); // longest side for an A4-ish page at this dpi
  const objs = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  let done = 0, saved = 0;
  for (const [ref, st] of objs) {
    prog(`Compressing images ${++done} of ${objs.length}…`, done / objs.length);
    const d = st.dict;
    const W = d.get(PDFName.of("Width"))?.asNumber?.(), H = d.get(PDFName.of("Height"))?.asNumber?.();
    if (!W || !H || d.get(PDFName.of("ImageMask")) || d.get(PDFName.of("Mask")) || d.get(PDFName.of("SMask"))?.constructor?.name === "PDFArray") continue;
    const filter = d.get(PDFName.of("Filter"));
    const fname = filter instanceof PDFName ? filter.asString() : filter?.size?.() === 1 ? filter.get(0).asString() : null;
    const cs = d.lookup(PDFName.of("ColorSpace"));
    let csName = cs instanceof PDFName ? cs.asString() : null;
    if (!csName && cs?.size?.() === 2 && cs.get(0) === PDFName.of("ICCBased")) {
      const nComp = doc.context.lookup(cs.get(1))?.dict?.get(PDFName.of("N"))?.asNumber?.();
      csName = nComp === 3 ? "/DeviceRGB" : nComp === 1 ? "/DeviceGray" : null;
    }
    if (d.get(PDFName.of("Decode"))) continue;
    const bpc = d.get(PDFName.of("BitsPerComponent"))?.asNumber?.();
    let bmp = null;
    try {
      if (fname === "/DCTDecode" && (csName === "/DeviceRGB" || csName === "/DeviceGray")) bmp = await createImageBitmap(new Blob([st.contents], { type: "image/jpeg" }));
      else if (fname === "/FlateDecode" && bpc === 8 && (csName === "/DeviceRGB" || csName === "/DeviceGray") && !d.get(PDFName.of("DecodeParms"))) {
        const raw = decodePDFRawStream(st).decode(), ch = csName === "/DeviceRGB" ? 3 : 1;
        if (raw.length < W * H * ch) continue;
        const id = new ImageData(W, H), px = id.data;
        for (let i = 0, j = 0; i < W * H; i++, j += ch) { px[i * 4] = raw[j]; px[i * 4 + 1] = raw[j + (ch === 3 ? 1 : 0)]; px[i * 4 + 2] = raw[j + (ch === 3 ? 2 : 0)]; px[i * 4 + 3] = 255; }
        bmp = await createImageBitmap(id);
      }
    } catch { bmp = null; }
    if (!bmp) continue;
    const k = Math.min(1, maxPx / Math.max(W, H));
    const w = Math.max(1, Math.round(W * k)), hh = Math.max(1, Math.round(H * k));
    const c = document.createElement("canvas"); c.width = w; c.height = hh;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, hh); ctx.drawImage(bmp, 0, 0, w, hh);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
    const jpg = new Uint8Array(await blob.arrayBuffer());
    if (jpg.length >= st.contents.length * 0.92) continue;
    const nd = doc.context.obj({ Type: "XObject", Subtype: "Image", Width: w, Height: hh, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode", Length: jpg.length });
    const sm = d.get(PDFName.of("SMask")); if (sm) nd.set(PDFName.of("SMask"), sm);
    const intent = d.get(PDFName.of("Intent")); if (intent) nd.set(PDFName.of("Intent"), intent);
    saved += st.contents.length - jpg.length;
    doc.context.assign(ref, PDFRawStream.of(nd, jpg));
    void PDFNumber;
  }
  prog(`Saving (images ${fmtBytes(saved)} smaller)…`);
  return await doc.save({ useObjectStreams: true });
}
async function rasterizeAll(bytes, dpi, quality, prog) {
  const { PDFDocument } = window.PDFLib;
  const pdf = await openPdf(bytes), out = await PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    prog(`Flattening page ${i} of ${pdf.numPages}…`, i / pdf.numPages);
    const page = await pdf.getPage(i), vp1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
    const jpg = await out.embedJpg(new Uint8Array(await (await new Promise((r) => c.toBlob(r, "image/jpeg", quality))).arrayBuffer()));
    out.addPage([vp1.width, vp1.height]).drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    c.width = c.height = 0;
  }
  pdf.destroy();
  return await out.save();
}

// ---------------------------------------------------------------- browser OCR (Tesseract.js from jsDelivr, loaded on demand)
const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
function loadScript(src) { return new Promise((res, rej) => { if ([...document.scripts].some((s) => s.src === src)) return res(); const s = h("script", { src, crossorigin: "anonymous" }); s.onload = res; s.onerror = () => rej(new Error("Could not download the OCR engine. Check your connection.")); document.head.append(s); }); }
async function browserOcr(idx, lang, skipText) {
  await withBusy("Loading OCR engine…", async (prog) => {
    await loadScript(TESS);
    const worker = await window.Tesseract.createWorker(lang, 1, { logger: (m) => { if (m.status && m.progress != null && /loading|initializ/.test(m.status)) prog(`${m.status[0].toUpperCase() + m.status.slice(1)}…`, m.progress); } });
    commit("ocr", { silent: true });
    let done = 0, words = 0;
    try {
      for (const i of idx) {
        const p = S.pages[i];
        prog(`Recognising page ${i + 1} (${++done} of ${idx.length})…`, (done - 1) / idx.length);
        if (skipText && (await textItems(p)).length > 3) continue;
        const proxy = proxyOf(p), scale = 2.4, vp = proxy.getViewport({ scale, rotation: 0 });
        const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        await proxy.render({ canvasContext: ctx, viewport: vp }).promise;
        const { data } = await worker.recognize(c);
        p.ocr = (data.words || []).filter((w) => w.text.trim() && w.confidence > 30).map((w) => {
          const [x0, yb] = vp.convertToPdfPoint(w.bbox.x0, w.bbox.y1), [x1, yt] = vp.convertToPdfPoint(w.bbox.x1, w.bbox.y0);
          return { text: w.text, x: Math.min(x0, x1), y: Math.min(yb, yt) + Math.abs(yt - yb) * 0.18, w: Math.abs(x1 - x0), h: Math.abs(yt - yb) };
        });
        words += p.ocr.length;
        c.width = c.height = 0;
      }
    } finally { await worker.terminate(); }
    emit("ocr");
    status(words ? `OCR found ${words} words. They are added as an invisible text layer when you download.` : "OCR found no text on those pages.");
  });
}

// ---------------------------------------------------------------- search (shared with the sidebar)
export async function findAll(q, { matchCase = false, wholeWord = false, regex = false } = {}) {
  if (!q) return [];
  let re;
  const src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  re = new RegExp(wholeWord ? `\\b(?:${src})\\b` : src, matchCase ? "g" : "gi");
  const hits = [];
  for (const p of S.pages) {
    const items = await textItems(p);
    const all = [...items, ...(p.ocr || []).map((w) => ({ str: w.text, b: [w.x, w.y], R: 0, w: w.w, size: w.h, box: [w.x, w.y - w.h * 0.2, w.x + w.w, w.y + w.h * 0.8] }))];
    // join items into one string, remembering which item each character came from
    let text = "";
    const map = [], starts = [];
    all.forEach((it, k) => { if (k) { text += " "; map.push(-1); } starts.push(text.length); for (let c = 0; c < it.str.length; c++) map.push(k); text += it.str; });
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const rects = [], s = m.index, e = m.index + m[0].length;
      const byItem = new Map();
      for (let c = s; c < e; c++) { const k = map[c]; if (k < 0) continue; const r = byItem.get(k) || [Infinity, -Infinity]; const off = c - starts[k]; r[0] = Math.min(r[0], off); r[1] = Math.max(r[1], off + 1); byItem.set(k, r); }
      for (const [k, [a, b]] of byItem) {
        const it = all[k], f = frame(it.R || 0);
        const t0 = frac(it, a) * it.w, t1 = frac(it, b) * it.w, up = [-f.down[0], -f.down[1]];
        const pts = [[t0, -0.22], [t1, -0.22], [t0, 0.92], [t1, 0.92]].map(([t, u]) => [it.b[0] + f.right[0] * t + up[0] * u * it.size, it.b[1] + f.right[1] * t + up[1] * u * it.size]);
        const xs = pts.map((q2) => q2[0]), ys = pts.map((q2) => q2[1]);
        rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
      let before = text.slice(Math.max(0, s - 36), s), after = text.slice(e, e + 36);
      if (s > 36) before = "…" + before.replace(/^\S*\s/, "");
      if (e + 36 < text.length) after = after.replace(/\s\S*$/, "") + "…";
      hits.push({ uid: p.uid, rects, before, match: m[0], after });
    }
  }
  return hits;
}

// Page numbers follow the page order: after pages are moved, deleted or duplicated they are renumbered.
function fillTpl(tpl, n, total) {
  return tpl.replaceAll("{n}", String(n)).replaceAll("{total}", String(total)).replaceAll("{date}", new Date().toLocaleDateString()).replaceAll("{title}", S.meta?.title || baseName(S.name)).replaceAll("{file}", S.name);
}
function placeNumber(a, p) {
  const vp = viewport(p, 1);
  Object.assign(a, measureText(a));
  const ps = a.pnPos || "bc", mg = a.mg ?? 28;
  const sx = ps[1] === "c" ? (vp.width - a.w) / 2 : ps[1] === "l" ? mg : vp.width - mg - a.w;
  const sy = ps[0] === "t" ? mg : vp.height - mg - a.h;
  [a.x, a.y] = vp.convertToPdfPoint(sx, sy);
  a.R = rotationOf(p);
}
export function refreshPageNumbers() {
  const groups = new Map();
  for (const p of S.pages) for (const a of p.anns) if (a.pn && a.tpl) { if (!groups.has(a.pn)) groups.set(a.pn, []); groups.get(a.pn).push([p, a]); }
  let changed = false;
  for (const list of groups.values()) {
    const start = list[0][1].start ?? 1, total = list.length + start - 1;
    list.forEach(([p, a], k) => {
      const txt = fillTpl(a.tpl, k + start, total);
      if (txt !== a.text || (a.R || 0) !== rotationOf(p)) { a.text = txt; placeNumber(a, p); changed = true; }
    });
  }
  return changed;
}

// fraction of an item's width taken by its first `n` characters, using a similar font's metrics
const mctx = document.createElement("canvas").getContext("2d");
function frac(it, n) {
  const L = it.str.length || 1;
  if (n <= 0) return 0; if (n >= L) return 1;
  const fam = it.style?.fontFamily === "serif" ? "Times New Roman, serif" : it.style?.fontFamily === "monospace" ? "monospace" : "Helvetica, Arial, sans-serif";
  mctx.font = "100px " + fam;
  const all = mctx.measureText(it.str).width;
  return all > 0 ? mctx.measureText(it.str.slice(0, n)).width / all : n / L;
}
