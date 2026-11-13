import { getCurrentWindow } from "@tauri-apps/api/window";

export type Theme = "auto" | "light" | "dark";

const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");

/** Applies the theme to the page (CSS tokens) and the native window (title bar, scrollbars). */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  getCurrentWindow()
    .setTheme(theme === "auto" ? null : theme)
    .catch(() => {});
  window.dispatchEvent(new Event("themechange"));
}

/** Whether the page is currently dark, for components that need colors in JS (editor, terminal). */
export function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === "light") return false;
  if (t === "dark") return true;
  return media()?.matches ?? true;
}

/** Calls `fn` whenever the effective theme may have changed (user choice or system setting). */
export function onThemeChange(fn: () => void): () => void {
  const m = media();
  window.addEventListener("themechange", fn);
  m?.addEventListener("change", fn);
  return () => {
    window.removeEventListener("themechange", fn);
    m?.removeEventListener("change", fn);
  };
}
