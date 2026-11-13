import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { shortcutContexts, useStore } from "./store";
import { api } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Overview } from "./components/Overview";
import { ResourceTable } from "./components/ResourceTable";
import { DetailPanel } from "./components/DetailPanel";
import { CommandPalette } from "./components/CommandPalette";
import { ApplyDialog, ConfirmDialog, Toasts } from "./components/Dialogs";
import { SettingsDialog } from "./components/Settings";
import { isMac, typingIn } from "./util";
import { HelpDialog } from "./components/Help";
import { UpdateBanner, useUpdateChecks } from "./components/Updates";
import { AboutDialog } from "./components/About";
import { openFeedback } from "./feedback";
import { WhatsNewDialog, useWhatsNewAfterUpdate } from "./components/WhatsNew";

const SAMPLE_EVERY_MS = 15_000;

/** Samples pod CPU and memory of the open clusters, building the history the charts draw. */
function useUsageSampler(contexts: string[]) {
  useEffect(() => {
    if (!contexts.length) return;
    const sample = () => contexts.forEach((c) => useStore.getState().sampleUsage(c));
    sample();
    const id = setInterval(sample, SAMPLE_EVERY_MS);
    return () => clearInterval(id);
  }, [contexts]);
}

export default function App() {
  const view = useStore((s) => s.view);
  const detail = useStore((s) => s.detail);
  const contexts = useStore((s) => s.contexts);
  const ready = useStore((s) => s.report !== null);
  useUpdateChecks();
  useUsageSampler(contexts);
  useWhatsNewAfterUpdate();

  // Port-forwards started, stopped or ended: the ports and Settings show them.
  useEffect(() => {
    const { loadForwards } = useStore.getState();
    loadForwards();
    const off = listen("forwards", () => loadForwards());
    return () => {
      off.then((f) => f());
    };
  }, []);

  // macOS app menu: About, Settings and Help open the in-app dialogs; feedback opens a GitHub issue.
  useEffect(() => {
    const off = listen<string>("menu", (e) => {
      const set = useStore.getState().set;
      if (e.payload === "about") set({ aboutOpen: true });
      else if (e.payload === "settings") set({ settingsOpen: true });
      else if (e.payload === "help") set({ helpOpen: true });
      else if (e.payload === "feedback") openFeedback("feedback");
      else if (e.payload === "bug") openFeedback("bug");
    });
    return () => {
      off.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const s = useStore.getState();
    api.appStoreBuild().then((appStore) => s.set({ appStore }));
    s.loadContexts().then(() => {
      const st = useStore.getState();
      if (st.contexts.length) st.openResources(st.contexts);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "k" || e.key === "p")) {
        e.preventDefault();
        s.set({ paletteOpen: !s.paletteOpen });
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        s.set({ settingsOpen: true });
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        s.set({ view: "overview" });
        return;
      }
      // Cmd+1..9 jumps to the Nth favorite (or Nth context).
      if (mod && /^[1-9]$/.test(e.key)) {
        const target = shortcutContexts(s.report, s.favorites)[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          s.openResources([target]);
        }
        return;
      }
      if (e.key === "F1" || (e.key === "?" && !typingIn(e))) {
        e.preventDefault();
        s.set({ helpOpen: !s.helpOpen, paletteOpen: false });
        return;
      }
      // ":" opens the palette like k9s' command mode.
      if (e.key === ":" && !typingIn(e)) {
        e.preventDefault();
        s.set({ paletteOpen: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close the detail panel when the context set or kind changes underneath it.
  useEffect(() => {
    const d = useStore.getState().detail;
    if (d && !contexts.includes(d.ref.context)) useStore.getState().closeDetail();
  }, [contexts]);

  return (
    <div className={`app ${isMac ? "mac" : ""}`}>
      <Sidebar />
      <main className="main">{!ready ? null : view === "overview" || contexts.length === 0 ? <Overview /> : <ResourceTable />}</main>
      {detail && view === "resources" && <DetailPanel />}
      <CommandPalette />
      <SettingsDialog />
      <AboutDialog />
      <WhatsNewDialog />
      <ApplyDialog />
      <HelpDialog />
      {/* After the other dialogs: it can be opened on top of them (Apply YAML on a production cluster). */}
      <ConfirmDialog />
      <UpdateBanner />
      <Toasts />
    </div>
  );
}
