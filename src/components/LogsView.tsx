import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine, Copy, Search } from "lucide-react";
import { api, errText, type ObjRef } from "../api";
import { useStore } from "../store";
import { hasAnsi, parseAnsi, stripAnsi, type Span } from "../ansi";

const MAX_LINES = 50_000;
/** Lines dropped at once when the buffer is full, so trimming isn't an O(n) shift on every batch. */
const TRIM_LINES = 5_000;

/** `raw` keeps ANSI escapes for rendering; `plain` is used for search and copy (the same string
 * when there are no escapes); `lower` is filled in the first time the line is searched. */
interface Line {
  raw: string;
  plain: string;
  lower?: string;
}

const lowerOf = (l: Line) => (l.lower ??= l.plain.toLowerCase());

export function LogsView({ objRef, initialContainer }: { objRef: ObjRef; initialContainer?: string }) {
  const [containers, setContainers] = useState<string[]>([]);
  const [container, setContainer] = useState<string | undefined>(initialContainer);
  const [previous, setPrevious] = useState(false);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("connecting");
  const [tick, setTick] = useState(0);
  const lines = useRef<Line[]>([]);
  /** Bumped when old lines are dropped, which invalidates the incremental search below. */
  const trimmed = useRef(0);
  const search = useRef<{ q: string; trimmed: number; scanned: number; matches: Line[] }>({ q: "", trimmed: 0, scanned: 0, matches: [] });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getObject(objRef).then((o) => {
      const names = [...(o.spec?.initContainers ?? []), ...(o.spec?.containers ?? [])].map((c: any) => c.name);
      setContainers(names);
      setContainer((c) => c ?? o.spec?.containers?.[0]?.name);
    });
  }, [objRef]);

  useEffect(() => {
    if (!container) return;
    lines.current = [];
    trimmed.current++;
    setTick((t) => t + 1);
    setStatus("connecting");
    let id: number | null = null;
    let disposed = false;
    let frame = 0;
    api
      .logs(
        { context: objRef.context, namespace: objRef.namespace!, pod: objRef.name, container, previous, timestamps, tailLines: 2000 },
        (m) => {
          if (disposed) return;
          if (m.type === "lines") {
            const buf = lines.current;
            for (const l of m.lines) buf.push({ raw: l, plain: hasAnsi(l) ? stripAnsi(l) : l });
            if (buf.length > MAX_LINES) {
              buf.splice(0, buf.length - MAX_LINES + TRIM_LINES);
              trimmed.current++;
            }
            setStatus("streaming");
          } else if (m.type === "end") setStatus("ended");
          else setStatus(`error: ${m.message}`);
          if (!frame) frame = requestAnimationFrame(() => ((frame = 0), setTick((t) => t + 1)));
        },
      )
      .then((i) => {
        if (disposed) api.stopStream(i);
        else id = i;
      })
      .catch((e) => setStatus(`error: ${errText(e)}`));
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (id !== null) api.stopStream(id);
    };
  }, [objRef, container, previous, timestamps]);

  const q = query.toLowerCase();
  const all = lines.current;
  // `tick` changes on every batch (the buffer is mutated in place, so its identity never changes).
  // While following a stream with a search, only the newly arrived lines are scanned.
  const shown = useMemo(() => {
    if (!q) return all;
    let s = search.current;
    if (s.q !== q || s.trimmed !== trimmed.current || s.scanned > all.length) {
      s = search.current = { q, trimmed: trimmed.current, scanned: 0, matches: [] };
    }
    for (let i = s.scanned; i < all.length; i++) if (lowerOf(all[i]).includes(q)) s.matches.push(all[i]);
    s.scanned = all.length;
    return s.matches.slice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, all, tick]);

  const virt = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 30,
    measureElement: wrap ? (el) => el.getBoundingClientRect().height : undefined,
  });

  useEffect(() => {
    if (!follow || !shown.length) return;
    virt.scrollToIndex(shown.length - 1, { align: "end" });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, follow, virt]);

  /** When the user last scrolled by hand. The view scrolls itself while following, and those
   * scrolls must not turn following off. */
  const userScrolledAt = useRef(0);
  const markUserScroll = () => (userScrolledAt.current = Date.now());
  const onScroll = () => {
    if (Date.now() - userScrolledAt.current > 500) return;
    const el = scrollRef.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    // Scrolling up stops following; scrolling back to the end starts it again.
    if (atBottom !== follow) setFollow(atBottom);
  };

  return (
    <div className="logs">
      <div className="subbar">
        {containers.length > 1 && (
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        <div className="filter small">
          <Search size={12} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search logs" spellCheck={false} />
        </div>
        <label>
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Timestamps
        </label>
        <label>
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} /> Previous
        </label>
        <label>
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <div className="spacer" />
        <span className={`small ${status.startsWith("error") ? "error" : "muted"}`}>{status === "streaming" ? `${shown.length} lines` : status}</span>
        <button
          className="icon-btn"
          title="Copy visible logs"
          onClick={() => {
            navigator.clipboard.writeText(shown.map((l) => l.plain).join("\n"));
            useStore.getState().toast(`Copied ${shown.length} lines`);
          }}
        >
          <Copy size={13} />
        </button>
        <button
          className={`btn small ${follow ? "on" : ""}`}
          title={follow ? "Following new lines — click or scroll up to stop" : "Jump to the end and follow new lines"}
          aria-pressed={follow}
          onClick={() => setFollow((f) => !f)}
        >
          <ArrowDownToLine size={12} /> Follow
        </button>
      </div>
      <div
        className={`log-body ${wrap ? "wrap" : ""}`}
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={markUserScroll}
        onKeyDown={markUserScroll}
        tabIndex={0}
      >
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => (
            <div key={v.key} className="log-line" data-index={v.index} ref={wrap ? virt.measureElement : undefined} style={{ transform: `translateY(${v.start}px)` }}>
              {renderLine(shown[v.index], q)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function styleOf(sp: Span): React.CSSProperties | undefined {
  const st = sp.style;
  if (!st.fg && !st.bg && !st.bold && !st.dim && !st.italic && !st.underline && !st.inverse) return undefined;
  const fg = st.inverse ? (st.bg ?? "var(--bg-2)") : st.fg;
  const bg = st.inverse ? (st.fg ?? "var(--text)") : st.bg;
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: st.bold ? 650 : undefined,
    opacity: st.dim ? 0.65 : undefined,
    fontStyle: st.italic ? "italic" : undefined,
    textDecoration: st.underline ? "underline" : undefined,
  };
}

/** Renders ANSI colors and highlights every occurrence of `q` (matched on the plain text). */
function renderLine(line: Line, q: string): React.ReactNode {
  if (!q && !hasAnsi(line.raw)) return line.raw;
  const spans = parseAnsi(line.raw);
  const ranges: [number, number][] = [];
  if (q) {
    const lower = lowerOf(line);
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) ranges.push([i, i + q.length]);
  }
  const out: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;
  for (const sp of spans) {
    const style = styleOf(sp);
    const end = pos + sp.text.length;
    let cur = pos;
    // Split the span at highlight boundaries.
    for (const [a, b] of ranges) {
      if (b <= cur || a >= end) continue;
      if (a > cur) out.push(<span key={key++} style={style}>{sp.text.slice(cur - pos, a - pos)}</span>);
      const hs = Math.max(a, cur);
      const he = Math.min(b, end);
      out.push(<mark key={key++} style={style}>{sp.text.slice(hs - pos, he - pos)}</mark>);
      cur = he;
    }
    if (cur < end) out.push(style ? <span key={key++} style={style}>{sp.text.slice(cur - pos)}</span> : sp.text.slice(cur - pos));
    pos = end;
  }
  return out;
}
