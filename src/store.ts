import { create } from "zustand";
import { api, errText, type ClusterSummary, type ForwardInfo, type Issue, type KindRef, type Scan, type LoadReport, type ObjRef, type PodUsage } from "./api";
import { PODS } from "./kinds";
import { resolveEnv, type Env, type EnvChoice } from "./env";
import type { Theme } from "./theme";

export type DetailTab = "overview" | "resources" | "yaml" | "logs" | "shell" | "events" | "ai";

export interface Detail {
  ref: ObjRef;
  tab: DetailTab;
  container?: string;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

export interface Confirm {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the user must type this value to confirm (used for production-like contexts). */
  typeToConfirm?: string;
  /** When set, shows a text input pre-filled with this value; its content is passed to onConfirm. */
  input?: string;
  /** A production context the change goes to: the dialog says so in red. */
  prod?: string;
  /** Objects the change goes to, grouped by cluster (bulk actions); long lists are shortened. */
  list?: { group: string; items: string[] }[];
  /** An optional checkbox (e.g. "Force"); its state is passed to onConfirm. */
  check?: string;
  onConfirm: (value: string, checked: boolean) => void | Promise<void>;
}

type Probe = { state: "loading" } | { state: "ok"; data: ClusterSummary } | { state: "error"; error: string };

/** Latest pod usage of a cluster, by "namespace/name"; `available` is false without metrics-server. */
export interface Usage {
  available: boolean;
  byKey: Map<string, PodUsage>;
  at: number;
}

/** Problems found in a cluster, with when they were last checked. */
export type Issues = { items: Issue[]; at: number } | { error: string; at: number };
/** A full health scan of a cluster, running or done. */
export type Scans = { running: true; at: number } | (Scan & { at: number }) | { error: string; at: number };

interface Persisted {
  contexts: string[];
  kind: KindRef;
  namespace: string;
  favorites: string[];
  detailWidth: number;
  /** Environment picked by the user per context; contexts not listed are auto-detected. */
  envs: Record<string, EnvChoice>;
  theme: Theme;
  /** Last version whose "What's new" the user has seen. */
  seenVersion: string;
  /** Ask before every change to a production cluster. */
  confirmProd: boolean;
  /** Namespaces picked last, most recent first: listed first in the namespace picker. */
  recentNamespaces: string[];
}

const STORAGE_KEY = "steerglass.ui.v1";

function loadPersisted(): Partial<Persisted> {
  try {
    // Fall back to the settings saved before the rename to Steerglass.
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("kubecontrol.ui.v1") ?? "{}");
  } catch {
    return {};
  }
}

interface State extends Persisted {
  report: LoadReport | null;
  /** Built for the Mac App Store, which updates the app itself. */
  appStore: boolean;
  view: "overview" | "resources" | "ai";
  filter: string;
  selected: string | null;
  selectedRef: ObjRef | null;
  /** Rows marked for a bulk action (Space, ⌘-click, shift-click, ⌘A), by row key. */
  marked: Map<string, ObjRef>;
  detail: Detail | null;
  probes: Record<string, Probe>;
  /** Bumped when the kubeconfig is read again: open watches restart with the new clients. */
  epoch: number;
  issues: Record<string, Issues>;
  scans: Record<string, Scans>;
  usage: Record<string, Usage>;
  /** Active port-forwards, kept in sync with the backend's "forwards" event. */
  forwards: ForwardInfo[];
  discovered: Record<string, KindRef[]>;
  namespaces: Record<string, string[]>;
  toasts: Toast[];
  paletteOpen: boolean;
  settingsOpen: boolean;
  /** The Settings section to show when it opens (then cleared). */
  settingsSection: string | null;
  aboutOpen: boolean;
  /** "What's new" dialog: the version to list changes after ("" = all), or null when closed. */
  whatsNew: string | null;
  helpOpen: boolean;
  applyOpen: boolean;
  /** YAML and cluster to open the Apply dialog with (a change proposed by the AI). */
  applyDraft: { yaml: string; context: string } | null;
  confirm: Confirm | null;

  /** False if the kubeconfig couldn't be read (the error is shown as a toast). */
  loadContexts: (reload?: boolean) => Promise<boolean>;
  /** Reconnects if the kubeconfig files changed since they were read (at most every few seconds). */
  syncKubeconfig: () => Promise<void>;
  /** Hides a cluster from the sidebar and the overview, or shows it again. */
  setHidden: (ctx: string, hidden: boolean) => Promise<void>;
  probe: (ctx: string) => Promise<void>;
  /** Probes every context; with `onlyMissing`, skips those already probed or in flight. */
  probeAll: (onlyMissing?: boolean) => Promise<void>;
  loadIssues: (ctx: string) => Promise<void>;
  /** Full health scans (every resource kind) of these clusters, a few at a time. */
  scanClusters: (ctxs: string[]) => Promise<void>;
  /** Samples the pods' CPU and memory (this also feeds the history behind the charts). */
  sampleUsage: (ctx: string) => Promise<void>;
  loadForwards: () => Promise<void>;
  /** Sets a context's environment; "auto" goes back to detecting it from the name. */
  setEnv: (ctx: string, env: EnvChoice | "auto") => void;
  /** Opens clusters in the resource view. */
  openResources: (contexts: string[], kind?: KindRef, namespace?: string) => Promise<void>;
  toggleContext: (ctx: string, additive: boolean) => Promise<void>;
  setKind: (kind: KindRef) => void;
  setNamespace: (ns: string) => void;
  setFilter: (f: string) => void;
  select: (key: string | null, ref?: ObjRef) => void;
  /** Marks or unmarks rows; `on` undefined toggles each. */
  mark: (rows: [key: string, ref: ObjRef][], on?: boolean) => void;
  clearMarks: () => void;
  openDetail: (ref: ObjRef, tab?: DetailTab, container?: string) => void;
  closeDetail: () => void;
  setDetailTab: (tab: DetailTab, container?: string) => void;
  toggleFavorite: (ctx: string) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  ask: (c: Confirm) => void;
  set: (p: Partial<State>) => void;
  ensureDiscovery: (ctx: string) => Promise<void>;
  /** Loads a cluster's namespaces; `refresh` reads them again even when already known. */
  ensureNamespaces: (ctx: string, refresh?: boolean) => Promise<void>;
}

const persisted = loadPersisted();
let toastId = 0;

let lastSync = 0;

export const useStore = create<State>((set, get) => ({
  contexts: persisted.contexts ?? [],
  kind: persisted.kind ?? PODS,
  namespace: persisted.namespace ?? "",
  favorites: persisted.favorites ?? [],
  detailWidth: persisted.detailWidth ?? 560,
  envs: persisted.envs ?? {},
  theme: persisted.theme ?? "auto",
  seenVersion: persisted.seenVersion ?? "",
  confirmProd: persisted.confirmProd ?? true,
  recentNamespaces: persisted.recentNamespaces ?? [],
  report: null,
  appStore: false,
  view: persisted.contexts?.length ? "resources" : "overview",
  filter: "",
  selected: null,
  selectedRef: null,
  marked: new Map(),
  detail: null,
  probes: {},
  epoch: 0,
  issues: {},
  scans: {},
  usage: {},
  forwards: [],
  discovered: {},
  namespaces: {},
  toasts: [],
  paletteOpen: false,
  settingsOpen: false,
  settingsSection: null,
  aboutOpen: false,
  whatsNew: null,
  helpOpen: false,
  applyOpen: false,
  applyDraft: null,
  confirm: null,

  async loadContexts(reload = false) {
    try {
      const report = reload ? await api.reloadContexts() : await api.listContexts();
      const names = new Set(report.contexts.map((c) => c.name));
      const contexts = get().contexts.filter((c) => names.has(c));
      set({ report, contexts, view: contexts.length ? get().view : "overview" });
      if (reload) {
        set((s) => ({ probes: {}, discovered: {}, namespaces: {}, epoch: s.epoch + 1 }));
        // The open clusters reconnect right away (the overview probes the rest).
        contexts.forEach((c) => {
          get().probe(c);
          get().ensureDiscovery(c);
          get().ensureNamespaces(c);
        });
      }
      return true;
    } catch (e) {
      get().toast(errText(e), "error");
      return false;
    }
  },

  async syncKubeconfig() {
    const now = Date.now();
    if (now - lastSync < 3000) return;
    lastSync = now;
    try {
      if (await api.reloadIfChanged()) await get().loadContexts(true);
    } catch {
      // Not worth a toast: F5 reports errors.
    }
  },

  async setHidden(ctx, hidden) {
    try {
      const settings = await api.getSettings();
      const hiddenContexts = hidden ? [...settings.hiddenContexts.filter((c) => c !== ctx), ctx] : settings.hiddenContexts.filter((c) => c !== ctx);
      const report = await api.updateSettings({ ...settings, hiddenContexts });
      set((s) => {
        // A hidden cluster no longer counts in the overview (connected, unreachable).
        const { [ctx]: _, ...probes } = s.probes;
        return { report, contexts: s.contexts.filter((c) => c !== ctx || !hidden), probes: hidden ? probes : s.probes };
      });
      if (!hidden) get().probe(ctx);
    } catch (e) {
      get().toast(errText(e), "error");
    }
  },

  async probe(ctx) {
    set((s) => ({ probes: { ...s.probes, [ctx]: { state: "loading" } } }));
    try {
      const data = await api.clusterSummary(ctx);
      set((s) => ({ probes: { ...s.probes, [ctx]: { state: "ok", data } } }));
      get().loadIssues(ctx);
    } catch (e) {
      set((s) => ({ probes: { ...s.probes, [ctx]: { state: "error", error: errText(e) } } }));
      get().syncKubeconfig();
    }
  },

  async probeAll(onlyMissing = false) {
    const names = (get().report?.contexts.map((c) => c.name) ?? []).filter(
      (n) => !onlyMissing || !get().probes[n],
    );
    // Bounded concurrency: auth plugins (gcloud, aws) are slow to spawn in bulk.
    const queue = [...names];
    const worker = async () => {
      while (queue.length) await get().probe(queue.shift()!);
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  },

  async loadIssues(ctx) {
    try {
      const items = await api.clusterIssues(ctx);
      set((s) => ({ issues: { ...s.issues, [ctx]: { items, at: Date.now() } } }));
    } catch (e) {
      set((s) => ({ issues: { ...s.issues, [ctx]: { error: errText(e), at: Date.now() } } }));
    }
  },

  async scanClusters(ctxs) {
    const put = (ctx: string, v: Scans) => set((s) => ({ scans: { ...s.scans, [ctx]: v } }));
    for (const c of ctxs) put(c, { running: true, at: Date.now() });
    const queue = [...ctxs];
    const worker = async () => {
      while (queue.length) {
        const ctx = queue.shift()!;
        try {
          put(ctx, { ...(await api.clusterScan(ctx)), at: Date.now() });
        } catch (e) {
          put(ctx, { error: errText(e), at: Date.now() });
        }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
  },

  async loadForwards() {
    set({ forwards: await api.portForwards() });
  },

  async sampleUsage(ctx) {
    try {
      const report = await api.podUsage(ctx);
      const byKey = new Map(report.pods.map((p) => [`${p.namespace}/${p.name}`, p]));
      set((s) => ({ usage: { ...s.usage, [ctx]: { available: report.available, byKey, at: Date.now() } } }));
    } catch {
      /* connection errors show in the table */
    }
  },

  setEnv: (ctx, env) =>
    set((s) => {
      const envs = { ...s.envs };
      if (env === "auto") delete envs[ctx];
      else envs[ctx] = env;
      return { envs };
    }),

  async openResources(contexts, kind, namespace) {
    if (contexts.length === 0) return;
    set((s) => ({
      view: "resources",
      contexts,
      kind: kind ?? s.kind,
      namespace: namespace ?? (contexts.length === 1 && !sameContexts(contexts, s.contexts) ? "" : s.namespace),
      selected: null,
      marked: new Map(),
      filter: "",
    }));
    contexts.forEach((c) => {
      if (!get().probes[c]) get().probe(c);
      get().ensureDiscovery(c);
      get().ensureNamespaces(c);
    });
  },

  async toggleContext(ctx, additive) {
    const cur = get().contexts;
    if (!additive) return get().openResources([ctx]);
    const next = cur.includes(ctx) ? cur.filter((c) => c !== ctx) : [...cur, ctx];
    if (next.length === 0) return set({ view: "overview", contexts: [] });
    get().openResources(next);
  },

  setKind: (kind) => set((s) => ({ kind, selected: null, marked: sameKind(kind, s.kind) ? s.marked : new Map(), view: "resources" })),
  setNamespace: (namespace) =>
    set((s) => ({
      namespace,
      selected: null,
      marked: new Map(),
      recentNamespaces: namespace ? [namespace, ...s.recentNamespaces.filter((n) => n !== namespace)].slice(0, 8) : s.recentNamespaces,
    })),
  setFilter: (filter) => set({ filter }),
  select: (selected, ref) => set({ selected, selectedRef: selected ? (ref ?? null) : null }),
  mark: (rows, on) =>
    set((s) => {
      const marked = new Map(s.marked);
      for (const [key, ref] of rows) {
        if (on ?? !marked.has(key)) marked.set(key, ref);
        else marked.delete(key);
      }
      return { marked };
    }),
  clearMarks: () => set((s) => (s.marked.size ? { marked: new Map() } : {})),
  openDetail: (ref, tab = "overview", container) => set({ detail: { ref, tab, container } }),
  closeDetail: () => set({ detail: null }),
  setDetailTab: (tab, container) => {
    const d = get().detail;
    if (d) set({ detail: { ...d, tab, container: container ?? d.container } });
  },
  toggleFavorite: (ctx) =>
    set((s) => ({ favorites: s.favorites.includes(ctx) ? s.favorites.filter((f) => f !== ctx) : [...s.favorites, ctx] })),

  toast(text, kind = "info") {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 8000 : 3500);
  },
  ask: (confirm) => set({ confirm }),
  set: (p) => set(p),

  async ensureDiscovery(ctx) {
    if (get().discovered[ctx]) return;
    try {
      const kinds = await api.discover(ctx);
      set((s) => ({ discovered: { ...s.discovered, [ctx]: kinds } }));
    } catch {
      /* the table shows connection errors */
    }
  },

  async ensureNamespaces(ctx, refresh = false) {
    if (!refresh && get().namespaces[ctx]) return;
    try {
      const ns = await api.listNamespaces(ctx);
      const old = get().namespaces[ctx];
      if (old && old.length === ns.length && old.every((n, i) => n === ns[i])) return;
      set((s) => ({ namespaces: { ...s.namespaces, [ctx]: ns } }));
    } catch {
      /* ignore */
    }
  },
}));

const sameKind = (a: KindRef, b: KindRef) => a.group === b.group && a.version === b.version && a.plural === b.plural;

function sameContexts(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

useStore.subscribe((s) => {
  const p: Persisted = {
    contexts: s.contexts,
    kind: s.kind,
    namespace: s.namespace,
    favorites: s.favorites,
    detailWidth: s.detailWidth,
    envs: s.envs,
    theme: s.theme,
    seenVersion: s.seenVersion,
    confirmProd: s.confirmProd,
    recentNamespaces: s.recentNamespaces,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
});

/** A context's environment: the user's choice, else guessed from its name. */
export const envOf = (ctx: string): Env | null => resolveEnv(useStore.getState().envs, ctx);


/** Production contexts get an extra confirmation step for destructive actions. */
export const isProdLike = (ctx: string) => envOf(ctx) === "prod";

/** The production context to warn about in a confirmation, when confirmations for production are on. */
export const prodWarning = (ctx: string) => (useStore.getState().confirmProd && isProdLike(ctx) ? ctx : undefined);

/** Runs a change to a cluster, first asking for confirmation when it is production (unless turned off in Settings). */
export function guardProd(ctx: string, title: string, body: string, confirmLabel: string, run: () => unknown) {
  if (!prodWarning(ctx)) return void run();
  useStore.getState().ask({ title, body, confirmLabel, prod: ctx, onConfirm: async () => void (await run()) });
}

/** Context order used everywhere (sidebar, overview, shortcuts): favorites first, then alphabetical. */
export function orderedContexts<T extends { name: string }>(contexts: T[], favorites: string[]): T[] {
  return [...contexts].sort((a, b) => {
    const fa = favorites.includes(a.name) ? 0 : 1;
    const fb = favorites.includes(b.name) ? 0 : 1;
    return fa - fb || a.name.localeCompare(b.name);
  });
}

/** Contexts reachable with Cmd/Ctrl+1…9: the starred ones in display order, or the first nine if none are starred. */
export function shortcutContexts(report: LoadReport | null, favorites: string[]): string[] {
  const ordered = orderedContexts(report?.contexts ?? [], favorites).map((c) => c.name);
  const starred = ordered.filter((n) => favorites.includes(n));
  return (starred.length ? starred : ordered).slice(0, 9);
}

// Dev only: when this module is hot-reloaded, components re-bind to the new store but one-shot
// startup effects (loading contexts) don't run again. Carry the previous data over,
// keeping the new action implementations.
if (import.meta.hot) {
  const g = globalThis as { __kcStore?: typeof useStore };
  const prev = g.__kcStore;
  if (prev && prev !== useStore) {
    const fresh = useStore.getState();
    const actions = Object.fromEntries(Object.entries(fresh).filter(([, v]) => typeof v === "function"));
    useStore.setState({ ...prev.getState(), ...actions });
  }
  g.__kcStore = useStore;
}
