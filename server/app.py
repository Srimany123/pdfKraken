"""pdfKraken processing server.

Serves the same editor as the static site and adds heavy tools that need native programs:
  compress  Ghostscript pdfwrite
  ocr       OCRmyPDF + Tesseract
  repair    qpdf
  linearize qpdf --linearize
  pdfa      OCRmyPDF (PDF/A-2b via Ghostscript)
  office    LibreOffice headless (Word, Excel, PowerPoint, ODF, RTF, TXT, HTML -> PDF)

Jobs run one at a time on a worker thread (the Pi has little RAM). The browser uploads a file,
polls /api/jobs/<id> and downloads the result. Files are deleted when fetched or after RETENTION.

Run:  python3 server/app.py            (PORT, default 8095)
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from collections import OrderedDict

from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the repo: index.html, js/, css/, vendor/
WORK = os.environ.get("PK_WORK", os.path.join(tempfile.gettempdir(), "pdfkraken"))
MAX_MB = int(os.environ.get("PK_MAX_MB", "150"))
RETENTION = int(os.environ.get("PK_RETENTION", "1800"))      # seconds a finished job is kept
MAX_QUEUE = int(os.environ.get("PK_MAX_QUEUE", "12"))
CORS = [o.strip() for o in os.environ.get("PK_CORS", "https://pdf.elvoid.com,http://localhost:8765,http://127.0.0.1:8765").split(",") if o.strip()]
VERSION = "1.0.0"
STATIC_DIRS = {"css", "js", "vendor"}
STATIC_FILES = {"index.html", "favicon.svg"}

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_MB * 1024 * 1024
os.makedirs(WORK, exist_ok=True)


def which(*names):
    return next((shutil.which(n) for n in names if shutil.which(n)), None)


GS, QPDF, OCRMYPDF, SOFFICE, TESS = which("gs"), which("qpdf"), which("ocrmypdf"), which("soffice", "libreoffice"), which("tesseract")


def ocr_languages():
    if not TESS:
        return []
    try:
        out = subprocess.run([TESS, "--list-langs"], capture_output=True, text=True, timeout=20).stdout
        return sorted(l.strip() for l in out.splitlines()[1:] if l.strip() and l.strip() != "osd")
    except Exception:
        return []


LANGS = ocr_languages()
TOOLS = {
    "compress": bool(GS), "ocr": bool(OCRMYPDF and TESS), "repair": bool(QPDF), "linearize": bool(QPDF),
    "pdfa": bool(OCRMYPDF and GS), "office": bool(SOFFICE),
}
LABELS = {"compress": "Compressing", "ocr": "Running OCR", "repair": "Repairing", "linearize": "Optimising", "pdfa": "Converting to PDF/A", "office": "Converting"}
OFFICE_EXT = re.compile(r"\.(docx?|odt|rtf|txt|xlsx?|ods|csv|pptx?|odp|html?|epub)$", re.I)

# ------------------------------------------------------------------ jobs
jobs = OrderedDict()   # id -> dict
lock = threading.Lock()
wake = threading.Condition(lock)


def public(j):
    out = {k: j[k] for k in ("id", "tool", "state", "error", "name") if k in j}
    out["label"] = LABELS.get(j["tool"], "Processing")
    if j["state"] == "queued":
        out["position"] = 1 + sum(1 for x in jobs.values() if x["state"] == "queued" and x["created"] < j["created"])
    if j.get("started"):
        out["elapsed"] = (j.get("finished") or time.time()) - j["started"]
    return out


def run(cmd, timeout, cwd=None, env=None):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env)
    return p.returncode, (p.stderr or p.stdout or "").strip()


def last_line(msg):
    lines = [l for l in (msg or "").splitlines() if l.strip()]
    return lines[-1][:300] if lines else "unknown error"


def do_job(j):
    d, src, tool, prm = j["dir"], j["input"], j["tool"], j["params"]
    out = os.path.join(d, "output.pdf")
    if tool == "compress":
        level = prm.get("level", "ebook")
        if level not in ("screen", "ebook", "printer", "prepress"):
            level = "ebook"
        code, msg = run([GS, "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.6", f"-dPDFSETTINGS=/{level}", "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER",
                         "-dDetectDuplicateImages=true", "-dCompressFonts=true", "-dAutoRotatePages=/None", f"-sOutputFile={out}", src], 900)
        if code != 0 or not os.path.exists(out):
            raise RuntimeError("Ghostscript failed: " + last_line(msg))
        if os.path.getsize(out) >= os.path.getsize(src):
            shutil.copyfile(src, out)
    elif tool == "ocr":
        lang = "+".join(l for l in re.split(r"[+,\s]+", prm.get("lang", "eng")) if l in LANGS) or ("eng" if "eng" in LANGS else (LANGS[0] if LANGS else "eng"))
        cmd = [OCRMYPDF, "-l", lang, "--output-type", "pdf", "--jobs", "2", "--tesseract-timeout", "300", "--optimize", "1"]
        if prm.get("deskew") == "1":
            cmd += ["--deskew", "--clean"] if shutil.which("unpaper") else ["--deskew"]
            cmd += ["--skip-text"]
        elif prm.get("skip_text", "1") == "1":
            cmd += ["--skip-text"]
        else:
            cmd += ["--redo-ocr"]
        pages = prm.get("pages", "").strip()
        if pages and re.fullmatch(r"[0-9,\-\s]+", pages):
            cmd += ["--pages", pages.replace(" ", "")]
        code, msg = run(cmd + [src, out], 1800)
        if code not in (0, 6) or not os.path.exists(out):  # 6 = page already had text (with --skip-text that's fine)
            raise RuntimeError("OCR failed: " + last_line(msg))
    elif tool == "repair":
        code, msg = run([QPDF, "--object-streams=generate", src, out], 600)
        if code not in (0, 3) or not os.path.exists(out):
            raise RuntimeError("qpdf could not repair this file: " + last_line(msg))
    elif tool == "linearize":
        code, msg = run([QPDF, "--linearize", "--object-streams=generate", src, out], 600)
        if code not in (0, 3) or not os.path.exists(out):
            raise RuntimeError("qpdf failed: " + last_line(msg))
    elif tool == "pdfa":
        code, msg = run([OCRMYPDF, "--skip-text", "--tesseract-timeout", "0", "--output-type", "pdfa-2", "--optimize", "0", src, out], 1200)
        if code not in (0, 6) or not os.path.exists(out):
            raise RuntimeError("PDF/A conversion failed: " + last_line(msg))
    elif tool == "office":
        profile = os.path.join(WORK, "lo-profile")
        env = dict(os.environ, HOME=os.path.join(WORK, "lo-home"))
        os.makedirs(env["HOME"], exist_ok=True)
        code, msg = run([SOFFICE, f"-env:UserInstallation=file://{profile}", "--headless", "--norestore", "--nolockcheck",
                         "--convert-to", "pdf", "--outdir", d, src], 600, cwd=d, env=env)
        produced = os.path.splitext(src)[0] + ".pdf"
        if not os.path.exists(produced):
            raise RuntimeError("LibreOffice could not convert this file: " + last_line(msg))
        os.replace(produced, out)
    else:
        raise RuntimeError("Unknown tool")
    j["output"] = out


def worker():
    while True:
        with wake:
            j = None
            while j is None:
                j = next((x for x in jobs.values() if x["state"] == "queued"), None)
                if j is None:
                    wake.wait()
            j["state"], j["started"] = "running", time.time()
        try:
            do_job(j)
            j["state"] = "done"
        except subprocess.TimeoutExpired:
            j["state"], j["error"] = "error", "This took too long and was stopped. Try fewer pages or a smaller file."
        except Exception as e:  # noqa: BLE001 - report any failure to the browser
            j["state"], j["error"] = "error", str(e)[:400]
        j["finished"] = time.time()
        try:
            os.remove(j["input"])
        except OSError:
            pass


def janitor():
    while True:
        time.sleep(60)
        now = time.time()
        with lock:
            for jid in [k for k, j in jobs.items() if j["state"] in ("done", "error") and now - j.get("finished", now) > RETENTION]:
                drop(jid)
        # stray directories (e.g. after a crash)
        for name in os.listdir(WORK):
            p = os.path.join(WORK, name)
            if name.startswith("job-") and name[4:] not in jobs and now - os.path.getmtime(p) > RETENTION:
                shutil.rmtree(p, ignore_errors=True)


def drop(jid):
    j = jobs.pop(jid, None)
    if j:
        shutil.rmtree(j["dir"], ignore_errors=True)


# ------------------------------------------------------------------ http
@app.after_request
def headers(resp):
    origin = request.headers.get("Origin")
    if origin and origin in CORS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/<path:_p>", methods=["OPTIONS"])
def preflight(_p):
    return Response(status=204)


@app.get("/api/caps")
def caps():
    return jsonify(app="pdfKraken", version=VERSION, tools=TOOLS, ocr_languages=LANGS, max_mb=MAX_MB,
                   queue=sum(1 for j in jobs.values() if j["state"] in ("queued", "running")))


@app.post("/api/jobs")
def create_job():
    tool = request.form.get("tool", "")
    if not TOOLS.get(tool):
        return jsonify(error=f"The server can't do “{tool}”."), 400
    f = request.files.get("file")
    if not f:
        return jsonify(error="No file was uploaded."), 400
    with lock:
        if sum(1 for j in jobs.values() if j["state"] in ("queued", "running")) >= MAX_QUEUE:
            return jsonify(error="The server is busy. Try again in a few minutes."), 503
    jid = uuid.uuid4().hex
    d = os.path.join(WORK, "job-" + jid)
    os.makedirs(d)
    name = re.sub(r"[^\w.\- ]+", "_", os.path.basename(f.filename or "input"))[:100] or "input"
    if tool == "office":
        if not OFFICE_EXT.search(name):
            shutil.rmtree(d, ignore_errors=True)
            return jsonify(error="That file type can't be converted."), 400
        src = os.path.join(d, "input" + os.path.splitext(name)[1].lower())
    else:
        src = os.path.join(d, "input.pdf")
    f.save(src)
    if tool != "office":
        with open(src, "rb") as fh:
            if b"%PDF" not in fh.read(1024):
                shutil.rmtree(d, ignore_errors=True)
                return jsonify(error="That isn't a PDF."), 400
    params = {k: v for k, v in request.form.items() if k not in ("tool",)}
    out_name = os.path.splitext(name)[0] + ".pdf"
    with wake:
        jobs[jid] = {"id": jid, "tool": tool, "state": "queued", "created": time.time(), "dir": d, "input": src, "params": params, "name": out_name}
        wake.notify()
        return jsonify(public(jobs[jid])), 202


@app.get("/api/jobs/<jid>")
def job_status(jid):
    with lock:
        j = jobs.get(jid)
        if not j:
            return jsonify(error="Unknown or expired job."), 404
        return jsonify(public(j))


@app.get("/api/jobs/<jid>/result")
def job_result(jid):
    with lock:
        j = jobs.get(jid)
    if not j or j["state"] != "done":
        return jsonify(error="Not ready."), 404
    return send_file(j["output"], mimetype="application/pdf", as_attachment=True, download_name=j["name"])


@app.delete("/api/jobs/<jid>")
def job_delete(jid):
    with lock:
        j = jobs.get(jid)
        if j and j["state"] in ("done", "error"):
            drop(jid)
    return Response(status=204)


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:path>")
def static_files(path):
    top = path.split("/", 1)[0]
    if path in STATIC_FILES or (top in STATIC_DIRS and ".." not in path):
        resp = send_from_directory(ROOT, path)
        if top == "vendor":
            resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp
    abort(404)


@app.errorhandler(413)
def too_big(_e):
    return jsonify(error=f"File is larger than {MAX_MB} MB."), 413


threading.Thread(target=worker, daemon=True).start()
threading.Thread(target=janitor, daemon=True).start()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8095"))
    print(f"pdfKraken server on http://0.0.0.0:{port}  tools: {json.dumps(TOOLS)}  ocr: {LANGS}", flush=True)
    try:
        from waitress import serve
        serve(app, host="0.0.0.0", port=port, threads=6, max_request_body_size=MAX_MB * 1024 * 1024)
    except ImportError:
        app.run(host="0.0.0.0", port=port, threaded=True)
