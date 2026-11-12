// pdf.js setup shared by every module.
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

const base = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";

export { pdfjsLib };
export const DOC_OPTS = {
  cMapUrl: base + "cmaps/", cMapPacked: true,
  standardFontDataUrl: base + "standard_fonts/",
  isEvalSupported: false, enableXfa: false,
};
export function openPdf(bytes, password) {
  return pdfjsLib.getDocument({ ...DOC_OPTS, data: bytes.slice(), password }).promise;
}
