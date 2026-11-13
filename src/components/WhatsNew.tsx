import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { X } from "lucide-react";
import changelog from "../../website/changelog.json";
import { useStore } from "../store";

interface Entry {
  version: string;
  date: string;
  title: string;
  items: string[];
}

const ENTRIES = changelog as Entry[];

const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/** After an update, shows what changed since the last version the user saw (not on a first install). */
export function useWhatsNewAfterUpdate() {
  useEffect(() => {
    getVersion().then((version) => {
      const s = useStore.getState();
      if (s.seenVersion && newer(version, s.seenVersion) && ENTRIES.some((e) => newer(e.version, s.seenVersion))) {
        s.set({ whatsNew: s.seenVersion });
      }
      if (s.seenVersion !== version) s.set({ seenVersion: version });
    });
  }, []);
}

/** `whatsNew` holds the version to show changes after; "" shows the whole history. */
export function WhatsNewDialog() {
  const since = useStore((s) => s.whatsNew);
  const [current, setCurrent] = useState("");
  useEffect(() => {
    getVersion().then(setCurrent);
  }, []);
  if (since === null) return null;
  const close = () => useStore.getState().set({ whatsNew: null });
  const entries = ENTRIES.filter((e) => (!since || newer(e.version, since)) && (!current || !newer(e.version, current)));
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog whats-new" role="dialog" aria-label="What's new" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="dialog-head">
          <h2>{since ? `What's new in Steerglass ${current}` : "What's new"}</h2>
          <button className="icon-btn" onClick={close} aria-label="Close" autoFocus>
            <X size={15} />
          </button>
        </div>
        <div className="wn-list">
          {entries.map((e) => (
            <section key={e.version} className="wn-entry">
              <div className="wn-head">
                <span className="wn-version">{e.version}</span>
                <b>{e.title}</b>
                <span className="muted small">{new Date(e.date).toLocaleDateString()}</span>
              </div>
              <ul>
                {e.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
