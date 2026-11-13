import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useStore } from "../store";
import { fuzzy, typingIn } from "../util";

type Option = { value: string; label: string; recent?: boolean };

/**
 * Namespace selector with a search field: substring matches first, then fuzzy ones; recently
 * picked namespaces on top while the search is empty. Opens with a click or the N key.
 */
export function NamespacePicker({ namespaces, onOpen }: { namespaces: string[]; onOpen: () => void }) {
  const namespace = useStore((s) => s.namespace);
  const setNamespace = useStore((s) => s.setNamespace);
  const recent = useStore((s) => s.recentNamespaces);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const show = () => {
    onOpen();
    setQ("");
    setIdx(0);
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const pick = (ns: string) => {
    setNamespace(ns);
    setOpen(false);
  };

  // N opens the picker from anywhere in the resource view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.paletteOpen || st.confirm || st.helpOpen || st.settingsOpen || st.applyOpen) return;
      if ((e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey && !e.altKey && !typingIn(e)) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("blur", () => setOpen(false), { once: true });
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const options = useMemo<Option[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) {
      const known = new Set(namespaces);
      const rec = recent.filter((n) => known.has(n)).slice(0, 5);
      return [
        { value: "", label: "All namespaces" },
        ...rec.map((n) => ({ value: n, label: n, recent: true })),
        ...namespaces.filter((n) => !rec.includes(n)).map((n) => ({ value: n, label: n })),
      ];
    }
    const direct = namespaces
      .map((n) => ({ n, i: n.toLowerCase().indexOf(query) }))
      .filter((x) => x.i >= 0)
      .sort((a, b) => a.i - b.i || a.n.localeCompare(b.n))
      .map((x) => x.n);
    const loose = namespaces.filter((n) => !direct.includes(n) && fuzzy(query, n) >= 0);
    const out = [...direct, ...loose].map((n) => ({ value: n, label: n }));
    if ("all namespaces".includes(query)) out.unshift({ value: "", label: "All namespaces" });
    return out;
  }, [q, namespaces, recent]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".ns-opt.active")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (options[idx]) pick(options[idx].value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const firstOther = options.findIndex((o) => o.value && !o.recent);
  const hasRecent = options.some((o) => o.recent);

  return (
    <div className="ns-picker" ref={rootRef}>
      <button className={`ns-button${open ? " open" : ""}`} onClick={() => (open ? setOpen(false) : show())} title="Namespace (N)">
        <span className="ns-current">{namespace || "All namespaces"}</span>
        <ChevronDown size={13} className="muted" />
      </button>
      {open && (
        <div className="ns-pop">
          <div className="ns-search">
            <Search size={13} className="muted" />
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search namespaces" spellCheck={false} />
          </div>
          <div className="ns-list" ref={listRef}>
            {options.length === 0 && <div className="ns-empty muted">No namespace matches</div>}
            {options.map((o, i) => (
              <div key={o.value || "__all"}>
                {!q && hasRecent && o.recent && i === 1 && <div className="ns-group">Recent</div>}
                {!q && hasRecent && i === firstOther && <div className="ns-group">All</div>}
                <button className={`ns-opt${i === idx ? " active" : ""}`} onMouseEnter={() => setIdx(i)} onClick={() => pick(o.value)}>
                  <span className={o.value ? "" : "muted"}>{o.label}</span>
                  {o.value === namespace && <Check size={13} />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
