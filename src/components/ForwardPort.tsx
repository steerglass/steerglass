import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, ExternalLink, Loader2, Plug, X } from "lucide-react";
import { api, errText, type ForwardInfo } from "../api";
import { useStore } from "../store";

/** Web address of a forward: HTTPS for the usual TLS ports, HTTP otherwise. */
export function forwardUrl(f: ForwardInfo) {
  return `${[443, 8443].includes(f.remotePort) ? "https" : "http"}://localhost:${f.localPort}`;
}

export async function stopForward(f: ForwardInfo) {
  await api.stopStream(f.id);
}

/**
 * A pod's or service's port: click to port-forward it. While a forward is running it shows the local
 * address, with actions to open it, copy it and stop it (clicking again never starts a second one).
 */
export function ForwardPort({ context, namespace, kind, name, port, children }: {
  context: string;
  namespace: string;
  kind: "Pod" | "Service";
  name: string;
  port: number;
  children: React.ReactNode;
}) {
  const target = `${kind.toLowerCase()}/${name}`;
  const active = useStore((s) => s.forwards.find((f) => f.context === context && f.namespace === namespace && f.target === target && f.remotePort === port));
  const [starting, setStarting] = useState(false);
  const { toast } = useStore.getState();

  if (!active) {
    const start = async () => {
      setStarting(true);
      try {
        const f = await api.portForward({ context, namespace, kind, name, port });
        await useStore.getState().loadForwards();
        toast(`Forwarding localhost:${f.localPort} → ${name}:${port}`, "success");
      } catch (e) {
        toast(errText(e), "error");
      } finally {
        setStarting(false);
      }
    };
    return (
      <button className="chip clickable" onClick={start} disabled={starting} title="Port-forward to localhost">
        {starting ? <Loader2 size={10} className="spin" /> : <Plug size={10} />} {children}
      </button>
    );
  }

  const url = forwardUrl(active);
  return (
    <span className="chip forward-on" title={`Forwarding ${url} → ${name}:${port}`}>
      <span className="fwd-dot" />
      {children}
      <span className="fwd-arrow">→</span>
      <button className="fwd-addr mono" onClick={() => openUrl(url)} title={`Open ${url}`}>
        localhost:{active.localPort}
      </button>
      <button className="fwd-act" onClick={() => openUrl(url)} title="Open in browser" aria-label="Open in browser">
        <ExternalLink size={11} />
      </button>
      <button
        className="fwd-act"
        onClick={() => {
          navigator.clipboard.writeText(`localhost:${active.localPort}`);
          toast(`Copied localhost:${active.localPort}`, "success");
        }}
        title="Copy address"
        aria-label="Copy address"
      >
        <Copy size={11} />
      </button>
      <button className="fwd-act stop" onClick={() => stopForward(active).catch((e) => toast(errText(e), "error"))} title="Stop port-forward" aria-label="Stop port-forward">
        <X size={12} />
      </button>
    </span>
  );
}
