// Where releases and the website are uploaded: an rsync destination such as
// user@host:/var/www/steerglass, from $STEERGLASS_REMOTE or from .secrets/release.env
// (a line STEERGLASS_REMOTE=...). It is kept out of the repository.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function remote() {
  if (process.env.STEERGLASS_REMOTE) return process.env.STEERGLASS_REMOTE;
  const file = fileURLToPath(new URL("../.secrets/release.env", import.meta.url));
  if (existsSync(file)) {
    const m = readFileSync(file, "utf8").match(/^STEERGLASS_REMOTE=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("set STEERGLASS_REMOTE (e.g. user@host:/var/www/steerglass) or add it to .secrets/release.env");
}
