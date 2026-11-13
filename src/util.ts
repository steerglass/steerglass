import { useEffect, useState } from "react";

export function age(created: string | undefined, now: number): string {
  if (!created) return "";
  const t = Date.parse(created);
  if (Number.isNaN(t)) return "";
  let s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 && h < 10 ? `${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  s = Math.floor(d / 365);
  return `${s}y${d % 365 ? `${d % 365}d` : ""}`;
}

/** Re-renders the caller every `ms` milliseconds and returns the current time. */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Subsequence match: every char of `q` appears in order in `text`. Returns a score or -1. */
export function fuzzy(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct - t.length / 100;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    score += found === last + 1 ? 5 : 1;
    last = found;
    ti = found + 1;
  }
  return score;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** Prefix for a shortcut key: "⌘S" on macOS, "Ctrl+S" elsewhere. */
export const modKey = isMac ? "⌘" : "Ctrl+";
/** The modifier on its own, for prose ("⌘-click", "Ctrl-click"). */
export const modName = isMac ? "⌘" : "Ctrl";

/** True when the event target is a text input, so single-key shortcuts must not fire. */
export function typingIn(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || !!el.closest(".cm-editor, .xterm");
}

export function shortContext(name: string): string {
  // gke_project_zone_cluster -> cluster; arn:aws:eks:region:acct:cluster/name -> name
  if (name.startsWith("gke_")) return name.split("_").slice(-1)[0];
  if (name.startsWith("arn:aws:eks:")) return name.split("/").slice(-1)[0];
  return name;
}

export function b64decode(s: string): string {
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return s;
  }
}
