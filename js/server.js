// Optional processing server (the Raspberry Pi build at pdfserver.elvoid.com).
// The static site works without it; when a server answers /api/caps, extra tools light up.
import { S } from "./state.js";

const KEY = "pk-server";
export function savedServer() { try { return localStorage.getItem(KEY); } catch { return null; } }
export function saveServer(url) { try { url == null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, url); } catch {} }
const api = (path) => (S.server ? S.server.replace(/\/+$/, "") + "/" : "") + "api/" + path;

export async function probe(base) {
  const url = (base ? base.replace(/\/+$/, "") + "/" : "") + "api/caps";
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { cache: "no-store", signal: ctl.signal }); clearTimeout(t);
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return null;
    const j = await r.json();
    return j && j.app === "pdfKraken" ? j : null;
  } catch { return null; }
}
export async function detect() {
  // 1. same origin (served by the Pi) 2. a server the user configured in Settings
  let caps = await probe("");
  if (caps) { S.server = ""; S.caps = caps; return caps; }
  const saved = savedServer();
  if (saved) { caps = await probe(saved); if (caps) { S.server = saved; S.caps = caps; return caps; } }
  S.caps = null; return null;
}
export const has = (tool) => !!S.caps?.tools?.[tool];

// Run a server job: upload, poll until done, return the result as a Blob.
export async function runJob(tool, file, params = {}, onProgress = () => {}) {
  const fd = new FormData();
  fd.append("tool", tool);
  for (const [k, v] of Object.entries(params)) if (v != null) fd.append(k, String(v));
  fd.append("file", file instanceof Blob ? file : new Blob([file], { type: "application/pdf" }), file.name || "input.pdf");
  onProgress("Uploading…");
  let r = await fetch(api("jobs"), { method: "POST", body: fd });
  let j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
  const id = j.id;
  for (let i = 0; ; i++) {
    await new Promise((res) => setTimeout(res, i < 5 ? 700 : 1500));
    r = await fetch(api("jobs/" + id), { cache: "no-store" });
    j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
    if (j.state === "done") break;
    if (j.state === "error") throw new Error(j.error || "The server could not process this file.");
    onProgress(j.state === "queued" ? `Waiting in queue (position ${j.position})…` : `${j.label || "Processing"} on the server… ${j.elapsed ? Math.round(j.elapsed) + "s" : ""}`);
  }
  onProgress("Downloading result…");
  r = await fetch(api("jobs/" + id + "/result"));
  if (!r.ok) throw new Error("Could not download the result.");
  const blob = await r.blob();
  fetch(api("jobs/" + id), { method: "DELETE" }).catch(() => {});
  return { blob, name: j.name };
}
