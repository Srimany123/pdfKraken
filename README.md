# pdfKraken

A full PDF editor in the browser. It runs in two modes from the same files:

| | URL | What runs where |
| --- | --- | --- |
| **Static** (GitHub Pages) | https://pdf.elvoid.com | Everything runs in the browser tab. Files never leave the device. |
| **Server** (Raspberry Pi) | https://pdfserver.elvoid.com | Same editor, plus server tools that need native programs: Ghostscript compression, OCRmyPDF, qpdf repair / linearize, PDF/A, LibreOffice Office → PDF. |

The static site can also use the server: **Settings → Processing server → `https://pdfserver.elvoid.com`**.

## Features

**Edit and annotate:** add text (any font size, bold/italic, colour, border, background, Unicode, your own TTF/OTF fonts) · edit existing text (covers the original line and places editable text with the matching font, size and colour) · highlight that follows lines of text · freehand drawing · boxes, ellipses, lines, arrows · images · signatures (draw, type or upload; remembered in the browser) · stamps (APPROVED, DRAFT, … or custom, with date) · sticky-note comments saved as real PDF comments · whiteout · **true redaction** (redacted pages are flattened to images with the areas blacked out) · find & redact (text or regular expression) · fill in form fields · select, move, resize, duplicate, reorder, copy/paste, nudge with the arrow keys, undo/redo.

**Pages:** thumbnails with drag-and-drop reordering · multi-select · rotate · delete · duplicate · insert blank pages · merge PDFs and images · insert a file at any position · split (every N pages, ranges, single pages, halves) · extract · reverse / custom order / interleave duplex scans · crop (draw an area or trim margins on many pages).

**Document:** watermarks (centred, tiled, top/bottom, any angle) · page numbers, headers and footers that renumber themselves when pages move · title/author/subject/keywords · AES-256 password protection with permissions · opening password-protected PDFs · compress (recompress images in the browser, or Ghostscript on the server) · OCR (Tesseract.js in the browser, OCRmyPDF on the server) · search with highlighted hits · bookmarks panel · links work.

**Convert:** PDF → PNG/JPEG/WebP (zip) · PDF → text · images → PDF · Office/ODF/RTF/TXT/HTML → PDF (server) · PDF/A (server) · print.

How saving works: the first opened PDF keeps its structure (bookmarks, form fields, links, metadata); its page tree is rebuilt in the new order and unreachable objects (for example deleted pages) are dropped before saving. Pages from other files are copied in with their forms flattened. Any redaction forces a clean rebuild, so nothing hidden survives.

## Layout

```
index.html, css/, js/       the editor (ES modules, no build step)
vendor/                      pdf.js, pdf-lib (cantoo fork), fontkit, JSZip, DejaVu Sans
server/app.py                Flask processing server (also serves the editor)
server/pdfkraken.service     systemd unit for the Pi
```

`js/` modules: `state.js` (state, undo, helpers) · `view.js` (rendering, overlay) · `editor.js` (tools, selection, properties panel) · `build.js` (export with pdf-lib) · `tools.js` (Tools menu) · `docs.js` (opening files) · `server.js` (server client) · `app.js` (shell).

## Run locally

```sh
python3 -m http.server 8765          # static mode: http://localhost:8765
python3 server/app.py                # server mode: http://localhost:8095 (needs flask; gs, qpdf, ocrmypdf, soffice are optional)
```

## Raspberry Pi deployment

```sh
sudo apt install qpdf ghostscript ocrmypdf tesseract-ocr-eng libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui python3-flask python3-waitress
rsync -a --delete --exclude /.git/ ./ pi3@192.168.1.86:/home/pi3/pdfkraken/
sudo cp /home/pi3/pdfkraken/server/pdfkraken.service /etc/systemd/system/ && sudo systemctl enable --now pdfkraken
```

Server settings (environment): `PORT` (8095), `PK_WORK` (job folder), `PK_MAX_MB` (150), `PK_RETENTION` seconds a finished job is kept (1800), `PK_MAX_QUEUE` (12), `PK_CORS` (origins allowed to call the API, e.g. `https://pdf.elvoid.com`).

Jobs run one at a time. The browser uploads, polls `/api/jobs/<id>` and downloads `/api/jobs/<id>/result`; the server deletes the files once the result is fetched, or after 30 minutes.

## License

MIT. Bundled libraries keep their own licenses, see `vendor/THIRD_PARTY.md`.
