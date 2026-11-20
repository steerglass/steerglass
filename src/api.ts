import { Channel, invoke } from "@tauri-apps/api/core";

export type Health = "ok" | "warn" | "error" | "neutral";

export interface ContextInfo {
  name: string;
  cluster: string;
  user?: string;
  namespace?: string;
  server?: string;
  source: string;
  isCurrent: boolean;
}

export interface LoadReport {
  contexts: ContextInfo[];
  files: string[];
  /** Files found but switched off in Settings. */
  excluded: string[];
  /** Contexts hidden from the sidebar and the overview. */
  hidden: string[];
  errors: string[];
}

export interface Settings {
  extraKubeconfigs: string[];
  scanKubeDir: boolean;
  excludedKubeconfigs: string[];
  hiddenContexts: string[];
  ai: AiSettings;
}

export type AiProvider = "openai" | "anthropic" | "ollama" | "lmstudio" | "deepseek" | "mistral" | "openrouter" | "custom";

/** Optional AI help. The API key isn't here: it is kept in the system keychain. */
export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  /** Empty: the provider's usual address. */
  baseUrl: string;
  model: string;
  /** Also offered on clusters marked as production. */
  onProduction: boolean;
  /** The language of the answers ("Italian"…); empty: English. */
  language: string;
}

/** A change suggested by the AI in the chat, applied by the user. */
export interface Proposal {
  id: string;
  cluster: string;
  action: "scale" | "restart" | "cordon" | "uncordon" | "suspend" | "resume" | "apply";
  kind?: KindRef | null;
  namespace?: string | null;
  name?: string | null;
  replicas?: number | null;
  manifest?: string | null;
  reason: string;
}

/** What ⌘K in plain words turned into. */
export type PaletteAction =
  | { action: "navigate"; clusters?: string[]; kind?: string; namespace?: string; filter?: string; open?: string }
  | { action: "ask" };

export type ChatMsg =
  | { type: "delta"; text: string }
  | { type: "toolStart"; id: string; label: string }
  | { type: "toolEnd"; id: string; ok: boolean; summary: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "done" }
  | { type: "error"; message: string };

export interface AiKeyStatus {
  set: boolean;
  storedIn?: "keychain" | "file" | null;
}

export type AiTask =
  | { type: "explain"; context: string; kind: KindRef; namespace?: string; name: string }
  | { type: "logs"; pod: string; container?: string; lines: string[] };

export type AiMsg =
  | { type: "sent"; text: string; destination: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface KindRef {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  verbs?: string[];
}

export interface Row {
  uid: string;
  name: string;
  namespace?: string;
  created?: string;
  cells: string[];
  health: Health;
  /** Pods: when a container last restarted. */
  lastRestart?: string;
}

/** CPU in cores, memory in bytes (from metrics-server; requests and limits from the pod spec). */
export interface PodUsage {
  namespace: string;
  name: string;
  cpu: number;
  mem: number;
  cpuRequest: number;
  memRequest: number;
  cpuLimit?: number | null;
  memLimit?: number | null;
}

export interface PodUsageReport {
  available: boolean;
  pods: PodUsage[];
}

export interface UsageSample {
  t: number;
  cpu: number;
  mem: number;
}

export interface ContainerUsage {
  name: string;
  cpu: number;
  mem: number;
  cpuRequest: number;
  memRequest: number;
  cpuLimit?: number | null;
  memLimit?: number | null;
}

export interface PodHistory {
  available: boolean;
  samples: UsageSample[];
  containers: ContainerUsage[];
  cpuRequest: number;
  memRequest: number;
  cpuLimit?: number | null;
  memLimit?: number | null;
}

export interface NodeUsage {
  name: string;
  cpu?: number | null;
  mem?: number | null;
  cpuAllocatable: number;
  memAllocatable: number;
  cpuRequested: number;
  memRequested: number;
  pods: number;
}

export interface NodeUsageReport {
  available: boolean;
  nodes: NodeUsage[];
  top: { namespace: string; name: string; cpu: number; mem: number }[];
}

/** Something that needs attention in a cluster (see `health.rs`). */
export interface Issue {
  group: string;
  kind: string;
  namespace?: string;
  name: string;
  reason: string;
  since?: string;
  severity: "error" | "warn";
}

/** A full health scan of a cluster: every resource kind, custom resources included. */
export interface Scan {
  items: Issue[];
  /** How many resource kinds were checked. */
  kinds: number;
  /** Kinds that couldn't be read, as `Kind.group`. */
  skipped: string[];
}

export interface ClusterSummary {
  version: string;
  platform: string;
  nodes: number;
  nodesReady: number;
  pods?: number;
  namespaces?: number;
  latencyMs: number;
}

export interface ForwardInfo {
  id: number;
  context: string;
  namespace: string;
  target: string;
  remotePort: number;
  localPort: number;
}

export type WatchMsg =
  | { type: "upsert"; rows: Row[] }
  | { type: "delete"; uids: string[] }
  | { type: "synced"; uids: string[] }
  | { type: "error"; message: string };

export type LogMsg =
  | { type: "lines"; lines: string[] }
  | { type: "end" }
  | { type: "error"; message: string };

export type ExecMsg = { type: "data"; data: number[] } | { type: "exit"; message?: string };

export interface ObjRef {
  context: string;
  kind: KindRef;
  namespace?: string;
  name: string;
}

export const errText = (e: unknown) => {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
  return s;
};
export const api = {
  listContexts: () => invoke<LoadReport>("list_contexts"),
  reloadContexts: () => invoke<LoadReport>("reload_contexts"),
  reloadIfChanged: () => invoke<boolean>("reload_if_changed"),
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings: Settings) => invoke<LoadReport>("update_settings", { settings }),
  grantAccess: (path: string) => invoke<LoadReport>("grant_access", { path }),
  environment: () => invoke<{ sandboxed: boolean; kubeDir?: string }>("environment"),
  clusterSummary: (context: string) => invoke<ClusterSummary>("cluster_summary", { context }),
  clusterIssues: (context: string) => invoke<Issue[]>("cluster_issues", { context }),
  clusterScan: (context: string) => invoke<Scan>("cluster_scan", { context }),
  podUsage: (context: string, namespace?: string) => invoke<PodUsageReport>("pod_usage", { context, namespace }),
  podHistory: (context: string, namespace: string, name: string, seconds: number) =>
    invoke<PodHistory>("pod_history", { context, namespace, name, seconds }),
  nodeUsage: (context: string) => invoke<NodeUsageReport>("node_usage", { context }),
  listNamespaces: (context: string) => invoke<string[]>("list_namespaces", { context }),
  discover: (context: string, refresh = false) => invoke<KindRef[]>("discover", { context, refresh }),
  getObject: (r: ObjRef) => invoke<any>("get_object", { ...r }),
  configUsage: (context: string, kind: string, namespace: string, name: string) =>
    invoke<{ kind: string; name: string; via: string[] }[]>("config_usage", { context, kind, namespace, name }),
  getYaml: (r: ObjRef) => invoke<string>("get_yaml", { ...r }),
  /** `original` is the YAML that was loaded, so edits Kubernetes ignores (under status) can be reported. */
  replaceYaml: (r: ObjRef, yaml: string, original?: string) =>
    invoke<{ yaml: string; ignored: { path: string; specPath?: string }[] }>("replace_yaml", { ...r, yaml, original }),
  applyManifest: (context: string, yaml: string, defaultNamespace?: string) =>
    invoke<string[]>("apply_manifest", { context, yaml, defaultNamespace }),
  deleteObject: (r: ObjRef, force = false) => invoke<void>("delete_object", { ...r, force }),
  /** Deletes objects of one kind across clusters; one entry per ref, null when deleted, else the error. */
  deleteObjects: (kind: KindRef, refs: ObjRef[], force = false) =>
    invoke<(string | null)[]>("delete_objects", { kind, items: refs.map((r) => ({ context: r.context, namespace: r.namespace ?? null, name: r.name })), force }),
  scale: (r: ObjRef, replicas: number) => invoke<void>("scale", { ...r, replicas }),
  rolloutRestart: (r: ObjRef) => invoke<void>("rollout_restart", { ...r }),
  setCordon: (context: string, name: string, cordon: boolean) => invoke<void>("set_cordon", { context, name, cordon }),
  suspendCronjob: (context: string, namespace: string, name: string, suspend: boolean) =>
    invoke<void>("suspend_cronjob", { context, namespace, name, suspend }),
  stopStream: (id: number) => invoke<void>("stream_stop", { id }),

  async watch(
    context: string,
    kind: KindRef,
    namespace: string | undefined,
    onMsg: (m: WatchMsg) => void,
    opts: { labelSelector?: string; fieldSelector?: string } = {},
  ) {
    const onEvent = new Channel<WatchMsg>();
    onEvent.onmessage = onMsg;
    return invoke<{ id: number; columns: string[] }>("watch_start", {
      context,
      kind,
      namespace: namespace || null,
      labelSelector: opts.labelSelector ?? null,
      fieldSelector: opts.fieldSelector ?? null,
      onEvent,
    });
  },

  async logs(
    p: { context: string; namespace: string; pod: string; container?: string; tailLines?: number; previous?: boolean; timestamps?: boolean },
    onMsg: (m: LogMsg) => void,
  ) {
    const onEvent = new Channel<LogMsg>();
    onEvent.onmessage = onMsg;
    return invoke<number>("logs_start", { ...p, onEvent });
  },

  async exec(
    p: { context: string; namespace: string; pod: string; container?: string; command?: string[]; cols: number; rows: number },
    onMsg: (m: ExecMsg) => void,
  ) {
    const onEvent = new Channel<ExecMsg>();
    onEvent.onmessage = onMsg;
    return invoke<number>("exec_start", { ...p, onEvent });
  },
  /** `kubectl debug`: adds an ephemeral container with `image` to the pod and attaches a terminal to it. */
  async debug(
    p: { context: string; namespace: string; pod: string; target?: string; image: string; cols: number; rows: number },
    onMsg: (m: ExecMsg) => void,
  ) {
    const onEvent = new Channel<ExecMsg>();
    onEvent.onmessage = onMsg;
    return invoke<number>("debug_start", { ...p, onEvent });
  },
  /** `kubectl debug node`: a privileged pod on the node, entering the host; deleted when the session ends. */
  async nodeShell(p: { context: string; node: string; image: string; cols: number; rows: number }, onMsg: (m: ExecMsg) => void) {
    const onEvent = new Channel<ExecMsg>();
    onEvent.onmessage = onMsg;
    return invoke<number>("node_shell_start", { ...p, onEvent });
  },
  execInput: (id: number, data: string) => invoke<void>("exec_input", { id, data }),
  execResize: (id: number, cols: number, rows: number) => invoke<void>("exec_resize", { id, cols, rows }),

  portForward: (p: { context: string; namespace: string; kind: string; name: string; port: number; localPort?: number }) =>
    invoke<ForwardInfo>("portforward_start", p),
  portForwards: () => invoke<ForwardInfo[]>("portforward_list"),

  appStoreBuild: () => invoke<boolean>("app_store_build"),

  aiKeyStatus: (provider: AiProvider) => invoke<AiKeyStatus>("ai_key_status", { provider }),
  /** An empty key removes it. */
  aiSetKey: (provider: AiProvider, key: string) => invoke<AiKeyStatus>("ai_set_key", { provider, key }),
  aiUpdateSettings: (ai: AiSettings) => invoke<void>("ai_update_settings", { ai }),
  async aiChatSend(
    p: { chat: number; text: string; contexts: { name: string; env?: string | null }[]; hiddenProduction: number; seed?: { question: string; answer: string } },
    onMsg: (m: ChatMsg) => void,
  ) {
    const onEvent = new Channel<ChatMsg>();
    onEvent.onmessage = onMsg;
    return invoke<number>("ai_chat_send", { ...p, seed: p.seed ?? null, onEvent });
  },
  aiPalette: (query: string, app: { clusters: { name: string; env?: string | null }[]; kinds: string[]; namespaces: string[]; current: unknown }) =>
    invoke<PaletteAction>("ai_palette", { query, app }),
  aiCommand: (request: string, target: { pod?: string; container?: string; image?: string; node?: string; screen: string }) =>
    invoke<{ command: string }>("ai_command", { request, target }),
  aiChatReset: (chat: number) => invoke<void>("ai_chat_reset", { chat }),
  aiModels: (ai: AiSettings) => invoke<string[]>("ai_models", { ai }),
  /** What would be sent for a task, and where, without sending it. */
  aiPrepare: (task: AiTask) => invoke<{ text: string; destination: string }>("ai_prepare", { task }),
  async aiRun(task: AiTask, onMsg: (m: AiMsg) => void) {
    const onEvent = new Channel<AiMsg>();
    onEvent.onmessage = onMsg;
    return invoke<number>("ai_run", { task, onEvent });
  },
};
