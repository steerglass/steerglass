// Shared helpers of the site pages outside the landing (install, changelog, compare, security, privacy).
"use strict";

/** Records an analytics event (Umami, cookieless); a no-op when the tracker is blocked or absent. */
function track(name, data) {
  try { window.umami && window.umami.track(name, data); } catch (e) {}
}

// Every download link, wherever it is: the file name says the platform.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest('a[href*="/download/"]');
  if (a) track("download", { file: a.pathname.split("/").pop(), page: location.pathname });
});

/** Latest published version, from the update manifest. */
async function latestRelease() {
  try {
    const r = await fetch("/updates/latest.json", { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}


const SVG_NS = "http://www.w3.org/2000/svg";
/** Element builder: el("div", { class: "x", onclick }, "text", child…). Text is never parsed as HTML. */
function el(tag, attrs, ...children) {
  const n = tag === "svg" || tag === "path" || tag === "rect" || tag === "circle" ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

function show(root, ...children) {
  root.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

function copyBlock(text) {
  const btn = el("button", { type: "button", onclick: async () => { await navigator.clipboard.writeText(text); track("copy-command", { page: location.pathname, command: text.split("\n").pop().slice(0, 60) }); btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1500); } }, "Copy");
  return el("div", { class: "copy" }, el("pre", { class: "cmd" }, text), btn);
}
