import { api, errText, type ObjRef } from "./api";
import { restartable, scalable } from "./kinds";
import { guardProd, isProdLike, prodWarning, useStore, type DetailTab } from "./store";

export interface Action {
  id: string;
  label: string;
  shortcut?: string;
  danger?: boolean;
  run: () => void;
}

const st = () => useStore.getState();

async function attempt(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    st().toast(label, "success");
  } catch (e) {
    st().toast(errText(e), "error");
  }
}

const describe = (r: ObjRef) => `${r.kind.kind.toLowerCase()}/${r.name}${r.namespace ? ` in ${r.namespace}` : ""}`;

export function actionsFor(ref: ObjRef): Action[] {
  const { kind } = ref;
  const open = (tab: DetailTab) => () => st().openDetail(ref, tab);
  const list: Action[] = [{ id: "details", label: "Details", shortcut: "↵", run: open("overview") }];
  const isPod = kind.group === "" && kind.kind === "Pod";

  if (isPod) {
    list.push({ id: "logs", label: "Logs", shortcut: "L", run: open("logs") });
    list.push({ id: "shell", label: "Shell", shortcut: "S", run: open("shell") });
  }
  if (kind.group === "" && kind.kind === "Node") list.push({ id: "shell", label: "Node shell", shortcut: "S", run: open("shell") });
  list.push({ id: "yaml", label: "Edit YAML", shortcut: "E", run: open("yaml") });
  list.push({ id: "events", label: "Events", run: open("events") });

  if (scalable(kind)) {
    list.push({
      id: "scale",
      label: "Scale…",
      run: async () => {
        let current = "";
        try {
          current = String((await api.getObject(ref))?.spec?.replicas ?? "");
        } catch {
          /* ignore */
        }
        st().ask({
          title: `Scale ${describe(ref)}`,
          body: "Number of replicas",
          confirmLabel: "Scale",
          input: current,
          prod: prodWarning(ref.context),
          onConfirm: (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0) return st().toast("Replicas must be a non-negative integer", "error");
            return attempt(`Scaled ${ref.name} to ${n}`, () => api.scale(ref, n));
          },
        });
      },
    });
  }
  if (restartable(kind)) {
    list.push({
      id: "restart",
      label: "Rollout restart",
      shortcut: "R",
      run: () =>
        confirmIfNeeded(ref, `Restart ${describe(ref)}?`, "Pods will be replaced with a rolling update.", "Restart", false, false, () =>
          attempt(`Restarted ${ref.name}`, () => api.rolloutRestart(ref)),
        ),
    });
  }
  if (kind.group === "" && kind.kind === "Node") {
    const cordon = (on: boolean) => () =>
      guardProd(
        ref.context,
        `${on ? "Cordon" : "Uncordon"} node ${ref.name}?`,
        on ? "No new pods will be scheduled on this node." : "New pods can be scheduled on this node again.",
        on ? "Cordon" : "Uncordon",
        () => attempt(`${on ? "Cordoned" : "Uncordoned"} ${ref.name}`, () => api.setCordon(ref.context, ref.name, on)),
      );
    list.push({ id: "cordon", label: "Cordon", run: cordon(true) });
    list.push({ id: "uncordon", label: "Uncordon", run: cordon(false) });
  }
  if (kind.group === "batch" && kind.kind === "CronJob") {
    const suspend = (on: boolean) => () =>
      guardProd(
        ref.context,
        `${on ? "Suspend" : "Resume"} ${describe(ref)}?`,
        on ? "No new jobs will start until it is resumed." : "Jobs will start again on schedule.",
        on ? "Suspend" : "Resume",
        () => attempt(`${on ? "Suspended" : "Resumed"} ${ref.name}`, () => api.suspendCronjob(ref.context, ref.namespace!, ref.name, on)),
      );
    list.push({ id: "suspend", label: "Suspend", run: suspend(true) });
    list.push({ id: "resume", label: "Resume", run: suspend(false) });
  }
  list.push({
    id: "copy",
    label: "Copy name",
    shortcut: "C",
    run: () => {
      navigator.clipboard.writeText(ref.name);
      st().toast(`Copied ${ref.name}`);
    },
  });
  if (!kind.verbs || kind.verbs.length === 0 || kind.verbs.includes("delete")) {
    list.push({
      id: "delete",
      label: "Delete",
      shortcut: "⌫",
      danger: true,
      run: () =>
        confirmIfNeeded(ref, `Delete ${describe(ref)}?`, `Context: ${ref.context}. This cannot be undone.`, "Delete", true, true, () =>
          attempt(`Deleted ${ref.name}`, () => api.deleteObject(ref)),
        ),
    });
  }
  return list;
}

/** Destructive actions always ask. With `typeName`, production contexts also require typing the object's name,
 * even when confirmations for production are turned off. */
function confirmIfNeeded(ref: ObjRef, title: string, body: string, confirmLabel: string, danger: boolean, typeName: boolean, run: () => Promise<void>) {
  st().ask({
    title,
    body,
    confirmLabel,
    danger,
    typeToConfirm: typeName && isProdLike(ref.context) ? ref.name : undefined,
    prod: prodWarning(ref.context) ?? (typeName && isProdLike(ref.context) ? ref.context : undefined),
    onConfirm: run,
  });
}

export function runShortcut(ref: ObjRef, key: string): boolean {
  const map: Record<string, string> = { l: "logs", s: "shell", e: "yaml", y: "yaml", r: "restart", c: "copy", Delete: "delete", Backspace: "delete" };
  const id = map[key];
  if (!id) return false;
  const a = actionsFor(ref).find((x) => x.id === id);
  if (!a) return false;
  a.run();
  return true;
}
