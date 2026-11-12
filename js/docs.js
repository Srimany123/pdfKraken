// Loading documents: PDFs, images and (via the server) Office files become sources and pages.
import { S, uid, commit, emit, status, resetHistory, baseName, h } from "./state.js";
import { pdfjsLib, DOC_OPTS } from "./pdfjs.js";
import { loadImage } from "./editor.js";
import { dialog } from "./ui.js";
import { has, runJob } from "./server.js";

export const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008], A3: [841.89, 1190.55], A5: [419.53, 595.28] };
const isPdf = (f, bytes) => f.type === "application/pdf" || /\.pdf$/i.test(f.name) || (bytes && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
const isImage = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(f.name);
const OFFICE = /\.(docx?|odt|rtf|txt|xlsx?|ods|csv|pptx?|odp|html?|epub)$/i;

async function askPassword(name, wrong) {
  const inp = h("input", { type: "password", name: "pw", autocomplete: "current-password", required: true, autofocus: true });
  const r = await dialog({
    title: "Password required",
    body: [h("p", {}, wrong ? `That password didn't open “${name}”. Try again.` : `“${name}” is protected. Enter its password to open it.`), h("label", { class: "field" }, h("span", {}, "Password"), inp)],
    ok: "Open",
  });
  return r ? inp.value : null;
}

export async function openPdfSource(bytes, name) {
  let password;
  const task = pdfjsLib.getDocument({ ...DOC_OPTS, data: bytes.slice() });
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) { task.destroy(); return; }
    password = pw; update(pw);
  };
  let pdf;
  try { pdf = await task.promise; }
  catch (e) {
    if (e?.name === "PasswordException" || /destroy/i.test(e?.message)) throw new Error(`“${name}” was not opened (no password).`);
    throw new Error(`“${name}” could not be read as a PDF (${e?.message || e}).`);
  }
  const proxies = [];
  for (let i = 1; i <= pdf.numPages; i++) proxies.push(await pdf.getPage(i));
  const src = { id: uid("s"), name, bytes, pdf, password, proxies };
  try { src.encrypted = !!(await pdf.getMetadata()).info?.EncryptFilterName || password != null; } catch {}
  S.sources.push(src);
  return src;
}

async function imagesToPdf(files) {
  const { PDFDocument } = window.PDFLib;
  const doc = await PDFDocument.create();
  for (const f of files) {
    const im = await loadImage(f); const img = S.images.get(im.img);
    const emb = img.mime === "image/jpeg" ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
    let w = im.w * 0.75, hh = im.h * 0.75; // 96 dpi
    const k = Math.min(1, 1190 / Math.max(w, hh)); w *= k; hh *= k;
    const page = doc.addPage([w, hh]); page.drawImage(emb, { x: 0, y: 0, width: w, height: hh });
    S.images.delete(im.img); URL.revokeObjectURL(img.url);
  }
  return new Uint8Array(await doc.save());
}
export async function blankPdf(size = PAGE_SIZES.A4, count = 1) {
  const { PDFDocument } = window.PDFLib;
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage(size);
  return new Uint8Array(await doc.save());
}
function pagesOf(src) { return src.proxies.map((_, idx) => ({ uid: uid("p"), src: src.id, idx, rot: 0, crop: null, anns: [] })); }

/** Turn dropped/picked files into pages. `at` = insert position (default: end). */
export async function addFiles(files, at = null, { replace = false } = {}) {
  files = [...files];
  if (!files.length) return;
  const imgs = files.filter((f) => isImage(f) && !/\.pdf$/i.test(f.name));
  const rest = files.filter((f) => !imgs.includes(f));
  const newPages = [];
  const failed = [];
  const firstName = files[0].name;
  for (const f of rest) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (isPdf(f, bytes)) { const src = await openPdfSource(bytes, f.name); newPages.push(...pagesOf(src)); }
      else if (OFFICE.test(f.name)) {
        if (!has("office")) { failed.push(`${f.name}: converting Office files needs the processing server (see Settings).`); continue; }
        emit("busy", `Converting ${f.name} on the server…`);
        const { blob } = await runJob("office", f, {}, (m) => emit("busy", m));
        const out = new Uint8Array(await blob.arrayBuffer());
        const src = await openPdfSource(out, baseName(f.name) + ".pdf"); newPages.push(...pagesOf(src));
      } else failed.push(`${f.name}: not a PDF or image.`);
    } catch (e) { failed.push(e.message || String(e)); }
  }
  if (imgs.length) {
    try { const bytes = await imagesToPdf(imgs); const src = await openPdfSource(bytes, imgs.length === 1 ? imgs[0].name : "images.pdf"); newPages.push(...pagesOf(src)); }
    catch (e) { failed.push("Images: " + (e.message || e)); }
  }
  if (failed.length) status(failed.join(" "), true);
  if (!newPages.length) return 0;
  if (replace || !S.pages.length) {
    if (replace) { for (const s of S.sources) if (!newPages.some((p) => p.src === s.id)) s.pdf.destroy().catch(() => {}); S.sources = S.sources.filter((s) => newPages.some((p) => p.src === s.id)); }
    S.pages = newPages; S.meta = null; S.name = /\.pdf$/i.test(firstName) ? firstName : baseName(firstName) + ".pdf";
    S.selectedPages.clear(); S.sel = null; resetHistory();
    emit("doc");
  } else {
    commit("insert", { silent: true });
    const i = at == null ? S.pages.length : Math.max(0, Math.min(S.pages.length, at));
    S.pages.splice(i, 0, ...newPages);
    emit("pages");
    status(`Added ${newPages.length} page${newPages.length > 1 ? "s" : ""}.`);
  }
  return newPages.length;
}

/** Replace the whole document with new bytes (e.g. a server result). Edits are baked into those bytes. */
export async function replaceWithBytes(bytes, name = S.name) {
  const src = await openPdfSource(bytes, name);
  const old = S.sources.filter((s) => s !== src);
  S.sources = [src];
  for (const s of old) s.pdf.destroy().catch(() => {});
  S.pages = pagesOf(src); S.sel = null; S.selectedPages.clear(); resetHistory();
  S.name = name; emit("doc");
}

export async function insertBlank(at, size, count = 1) {
  const bytes = await blankPdf(size, count);
  const src = await openPdfSource(bytes, "blank.pdf");
  commit("blank", { silent: true });
  S.pages.splice(at, 0, ...pagesOf(src));
  emit("pages");
}
export async function newDocument() {
  const bytes = await blankPdf(PAGE_SIZES.A4, 1);
  const src = await openPdfSource(bytes, "untitled.pdf");
  S.sources = [src]; S.pages = pagesOf(src); S.name = "untitled.pdf"; S.meta = null; resetHistory(); emit("doc");
}
