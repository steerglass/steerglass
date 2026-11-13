import { useEffect, useState } from "react";
import { api, errText, type KindRef, type Row } from "./api";

export interface CtxRow extends Row {
  key: string;
  context: string;
}

export interface WatchState {
  rows: CtxRow[];
  columns: string[];
  /** Contexts whose initial list has completed. */
  synced: Set<string>;
  errors: Record<string, string>;
}

const EMPTY: WatchState = { rows: [], columns: [], synced: new Set(), errors: {} };

/**
 * Watches `kind` on every context and keeps a merged, live list of rows.
 * Updates are coalesced into one React render per animation frame.
 */
export function useWatch(
  contexts: string[],
  kind: KindRef | null,
  namespace: string,
  opts: { fieldSelector?: string; labelSelector?: string } = {},
): WatchState {
  const [state, setState] = useState<WatchState>(EMPTY);
  const ctxKey = contexts.join("\u0000");
  const kindKey = kind ? `${kind.group}/${kind.version}/${kind.plural}` : "";

  useEffect(() => {
    if (!kind || contexts.length === 0) {
      setState(EMPTY);
      return;
    }
    const map = new Map<string, CtxRow>();
    let columns: string[] = [];
    const synced = new Set<string>();
    const errors: Record<string, string> = {};
    let disposed = false;
    let frame = 0;
    const ids: number[] = [];

    const schedule = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (disposed) return;
        setState({ rows: [...map.values()], columns, synced: new Set(synced), errors: { ...errors } });
      });
    };
    setState({ ...EMPTY, columns: [] });

    for (const ctx of contexts) {
      api
        .watch(
          ctx,
          kind,
          kind.namespaced ? namespace : undefined,
          (m) => {
            if (disposed) return;
            switch (m.type) {
              case "upsert":
                for (const r of m.rows) {
                  const key = `${ctx}|${r.uid}`;
                  map.set(key, { ...r, key, context: ctx });
                }
                break;
              case "delete":
                for (const uid of m.uids) map.delete(`${ctx}|${uid}`);
                break;
              case "synced": {
                const keep = new Set(m.uids);
                for (const [key, r] of map) if (r.context === ctx && !keep.has(r.uid)) map.delete(key);
                synced.add(ctx);
                delete errors[ctx];
                break;
              }
              case "error":
                errors[ctx] = m.message;
                break;
            }
            schedule();
          },
          opts,
        )
        .then((res) => {
          if (disposed) {
            api.stopStream(res.id);
            return;
          }
          ids.push(res.id);
          columns = res.columns;
          schedule();
        })
        .catch((e) => {
          if (disposed) return;
          errors[ctx] = errText(e);
          synced.add(ctx);
          schedule();
        });
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      ids.forEach((id) => api.stopStream(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey, kindKey, namespace, opts.fieldSelector, opts.labelSelector]);

  return state;
}
