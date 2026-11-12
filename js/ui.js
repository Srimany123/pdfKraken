// Modal dialogs.
import { h } from "./state.js";

/**
 * Show a modal. Resolves with the value of the button pressed ("ok" or an extra button's value), or null.
 * `validate()` may return an error string to keep the dialog open.
 */
export function dialog({ title, body, ok = "OK", cancel = "Cancel", wide = false, extra = [], danger = false, validate = null, noFooter = false, onOpen = null }) {
  const errEl = h("p", { class: "warn", hidden: true });
  const bodyEl = h("div", { class: "dlg-body" }, ...(Array.isArray(body) ? body : [body]), errEl);
  const foot = h("footer", {});
  if (cancel) foot.append(h("button", { class: "btn", value: "cancel", formnovalidate: true }, cancel));
  for (const b of extra) foot.append(h("button", { class: "btn" + (b.primary ? " primary" : ""), value: b.value, formnovalidate: b.novalidate || false }, b.label));
  if (ok) foot.append(h("button", { class: "btn " + (danger ? "danger" : "primary"), value: "ok" }, ok));
  const form = h("form", { method: "dialog" },
    h("header", {}, h("h2", {}, title), h("button", { class: "icon", value: "cancel", formnovalidate: true, "aria-label": "Close", html: '<svg><use href="#i-x"/></svg>' })),
    bodyEl, noFooter ? null : foot);
  const dlg = h("dialog", { class: "dlg" + (wide ? " wide" : "") }, form);
  form.addEventListener("submit", (e) => {
    const v = e.submitter?.value;
    if (v && v !== "cancel" && validate) {
      const err = validate(v);
      if (err) { e.preventDefault(); errEl.textContent = err; errEl.hidden = false; }
    }
  });
  document.body.append(dlg);
  dlg.showModal();
  onOpen?.(dlg);
  return new Promise((res) => dlg.addEventListener("close", () => {
    const v = dlg.returnValue; dlg.remove();
    res(v && v !== "cancel" ? v : null);
  }));
}
export const field = (label, ...kids) => h("label", { class: "field" }, h("span", {}, label), ...kids);
export function select(name, options, value) {
  const s = h("select", { name });
  for (const o of options) { const [v, l] = Array.isArray(o) ? o : [o, o]; s.append(h("option", { value: v }, l)); }
  if (value != null) s.value = value;
  return s;
}
export const input = (attrs) => h("input", { type: "text", ...attrs });
export const check = (label, attrs = {}) => { const c = h("input", { type: "checkbox", ...attrs }); return [h("label", { class: "chk" }, c, label), c]; };
