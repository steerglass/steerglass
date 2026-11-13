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
  errors: string[];
}

export interface Settings {
  extraKubeconfigs: string[];
  scanKubeDir: boolean;
}

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

/** Something that needs attention in a cluster (see `cluster_issues`). */
export interface Issue {
  kind: "Pod" | "Node" | "Job";
  namespace?: string;
  name: string;
  reason: string;
  since?: string;
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
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings: Settings) => invoke<LoadReport>("update_settings", { settings }),
  grantAccess: (path: string) => invoke<LoadReport>("grant_access", { path }),
  environment: () => invoke<{ sandboxed: boolean; kubeDir?: string }>("environment"),
  clusterSummary: (context: string) => invoke<ClusterSummary>("cluster_summary", { context }),
  clusterIssues: (context: string) => invoke<Issue[]>("cluster_issues", { context }),
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
};
