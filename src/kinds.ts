import type { KindRef } from "./api";

const k = (group: string, version: string, kind: string, plural: string, namespaced = true): KindRef => ({
  group,
  version,
  kind,
  plural,
  namespaced,
});

export interface KindEntry {
  ref: KindRef;
  label: string;
  aliases: string[];
}

const e = (ref: KindRef, label: string, ...aliases: string[]): KindEntry => ({ ref, label, aliases });

/** Built-in kinds, shown before discovery completes. Versions are the GA ones. */
export const CATEGORIES: { name: string; kinds: KindEntry[] }[] = [
  {
    name: "Workloads",
    kinds: [
      e(k("", "v1", "Pod", "pods"), "Pods", "po", "pod"),
      e(k("apps", "v1", "Deployment", "deployments"), "Deployments", "deploy", "deployment"),
      e(k("apps", "v1", "StatefulSet", "statefulsets"), "StatefulSets", "sts"),
      e(k("apps", "v1", "DaemonSet", "daemonsets"), "DaemonSets", "ds"),
      e(k("apps", "v1", "ReplicaSet", "replicasets"), "ReplicaSets", "rs"),
      e(k("batch", "v1", "Job", "jobs"), "Jobs", "job"),
      e(k("batch", "v1", "CronJob", "cronjobs"), "CronJobs", "cj", "cronjob"),
    ],
  },
  {
    name: "Network",
    kinds: [
      e(k("", "v1", "Service", "services"), "Services", "svc", "service"),
      e(k("networking.k8s.io", "v1", "Ingress", "ingresses"), "Ingresses", "ing", "ingress"),
      e(k("", "v1", "Endpoints", "endpoints"), "Endpoints", "ep"),
      e(k("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies"), "Network Policies", "netpol"),
    ],
  },
  {
    name: "Config",
    kinds: [
      e(k("", "v1", "ConfigMap", "configmaps"), "ConfigMaps", "cm", "configmap"),
      e(k("", "v1", "Secret", "secrets"), "Secrets", "secret"),
      e(k("autoscaling", "v2", "HorizontalPodAutoscaler", "horizontalpodautoscalers"), "HPA", "hpa"),
      e(k("policy", "v1", "PodDisruptionBudget", "poddisruptionbudgets"), "Pod Disruption Budgets", "pdb"),
      e(k("", "v1", "ResourceQuota", "resourcequotas"), "Resource Quotas", "quota", "resourcequota"),
      e(k("", "v1", "LimitRange", "limitranges"), "Limit Ranges", "limits", "limitrange"),
    ],
  },
  {
    name: "Storage",
    kinds: [
      e(k("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims"), "PVC", "pvc"),
      e(k("", "v1", "PersistentVolume", "persistentvolumes", false), "PV", "pv"),
      e(k("storage.k8s.io", "v1", "StorageClass", "storageclasses", false), "Storage Classes", "sc"),
    ],
  },
  {
    name: "Cluster",
    kinds: [
      e(k("", "v1", "Node", "nodes", false), "Nodes", "no", "node"),
      e(k("", "v1", "Namespace", "namespaces", false), "Namespaces", "ns", "namespace"),
      e(k("", "v1", "Event", "events"), "Events", "ev", "event"),
      e(k("", "v1", "ServiceAccount", "serviceaccounts"), "Service Accounts", "sa"),
      e(k("rbac.authorization.k8s.io", "v1", "Role", "roles"), "Roles", "role"),
      e(k("rbac.authorization.k8s.io", "v1", "RoleBinding", "rolebindings"), "Role Bindings", "rb"),
      e(k("rbac.authorization.k8s.io", "v1", "ClusterRole", "clusterroles", false), "Cluster Roles", "cr"),
      e(k("rbac.authorization.k8s.io", "v1", "ClusterRoleBinding", "clusterrolebindings", false), "Cluster Role Bindings", "crb"),
      e(k("apiextensions.k8s.io", "v1", "CustomResourceDefinition", "customresourcedefinitions", false), "CRDs", "crd"),
    ],
  },
];

export const BUILTIN: KindEntry[] = CATEGORIES.flatMap((c) => c.kinds);
export const PODS = BUILTIN[0].ref;

export const kindKey = (r: KindRef) => `${r.group}/${r.kind}`;

const builtinKeys = new Set(BUILTIN.map((b) => kindKey(b.ref)));
export const isBuiltin = (r: KindRef) => builtinKeys.has(kindKey(r));

/** Discovered kinds not covered by the built-in list, grouped by API group. */
export function customGroups(discovered: KindRef[]): { group: string; kinds: KindRef[] }[] {
  const map = new Map<string, KindRef[]>();
  for (const r of discovered) {
    if (isBuiltin(r) || !r.group || r.group.endsWith(".k8s.io") || r.group === "apps" || r.group === "batch") continue;
    if (["autoscaling", "policy", "coordination.k8s.io", "discovery.k8s.io"].includes(r.group)) continue;
    const list = map.get(r.group) ?? [];
    list.push(r);
    map.set(r.group, list);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([group, kinds]) => ({ group, kinds }));
}

export const kindLabel = (r: KindRef) => BUILTIN.find((b) => kindKey(b.ref) === kindKey(r))?.label ?? r.kind;

export const scalable = (r: KindRef) => r.group === "apps" && ["Deployment", "StatefulSet", "ReplicaSet"].includes(r.kind);
export const restartable = (r: KindRef) => r.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet"].includes(r.kind);
