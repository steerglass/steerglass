import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

export const REPO = "https://github.com/steerglass/steerglass";

/** The system, as shown in the issue. */
function platformName() {
  const p = navigator.userAgent;
  return /Mac/.test(p) ? "macOS" : /Win/.test(p) ? "Windows" : "Linux";
}

/** Opens a new GitHub issue (a bug report or an idea) with this app's version and system filled in. */
export async function openFeedback(kind: "bug" | "feedback" = "feedback") {
  const body = `\n\n---\nSteerglass ${await getVersion()} on ${platformName()}`;
  const q = new URLSearchParams({ body, ...(kind === "bug" ? { labels: "bug" } : {}) });
  await openUrl(`${REPO}/issues/new?${q}`);
}
