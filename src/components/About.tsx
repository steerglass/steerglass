import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Globe, Mail, X } from "lucide-react";
import { useStore } from "../store";
import { Logo } from "./Logo";

const SITE = "https://steerglass.com";
const EMAIL = "hello@steerglass.com";

export function AboutDialog() {
  const open = useStore((s) => s.aboutOpen);
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion);
  }, []);
  if (!open) return null;
  const close = () => useStore.getState().set({ aboutOpen: false });

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog about" role="dialog" aria-label="About Steerglass" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <button className="icon-btn about-close" onClick={close} aria-label="Close" autoFocus>
          <X size={15} />
        </button>
        <div className="about-mark">
          <Logo size={72} />
        </div>
        <h2>Steerglass</h2>
        <p className="about-tagline">Fast, friendly control of all your Kubernetes clusters.</p>
        <div className="about-version">
          <span>Version {version}</span>
        </div>
        <div className="about-author">
          <span className="muted">Designed and built by</span>
          <b>Davide Bettio</b>
        </div>
        <div className="about-links">
          <button className="btn" onClick={() => openUrl(SITE)}>
            <Globe size={13} /> steerglass.com
          </button>
          <button className="btn" onClick={() => openUrl(`mailto:${EMAIL}`)}>
            <Mail size={13} /> Contact
          </button>
        </div>
        <p className="about-legal">© 2026 Davide Bettio. Kubernetes is a registered trademark of The Linux Foundation.</p>
      </div>
    </div>
  );
}
