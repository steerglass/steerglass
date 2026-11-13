import { useMemo } from "react";
import type { ObjRef } from "../api";
import { BUILTIN } from "../kinds";
import { useWatch } from "../useWatch";
import { age, useNow } from "../util";

const EVENTS = BUILTIN.find((b) => b.ref.kind === "Event")!.ref;

export function EventsView({ objRef }: { objRef: ObjRef }) {
  const fieldSelector = `involvedObject.name=${objRef.name},involvedObject.kind=${objRef.kind.kind}`;
  const contexts = useMemo(() => [objRef.context], [objRef.context]);
  const { rows, synced, errors } = useWatch(contexts, EVENTS, objRef.namespace ?? "", { fieldSelector });
  const now = useNow(5000);
  const sorted = useMemo(() => [...rows].sort((a, b) => Date.parse(b.created ?? "") - Date.parse(a.created ?? "")), [rows]);

  if (errors[objRef.context]) return <div className="pad error">{errors[objRef.context]}</div>;
  if (!synced.has(objRef.context)) return <div className="pad muted">Loading…</div>;
  if (!sorted.length) return <div className="pad muted">No recent events. Kubernetes keeps events for about an hour.</div>;

  // Event cells: Type, Reason, Object, Count, Message
  return (
    <div className="events">
      {sorted.map((r) => (
        <div key={r.key} className={`event ${r.cells[0] === "Warning" ? "warn" : ""}`}>
          <div className="event-head">
            <b>{r.cells[1]}</b>
            {Number(r.cells[3]) > 1 && <span className="tag">×{r.cells[3]}</span>}
            <span className="muted small">{age(r.created, now)} ago</span>
          </div>
          <div className="small">{r.cells[4]}</div>
        </div>
      ))}
    </div>
  );
}
