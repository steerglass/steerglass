import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { oneDark } from "@codemirror/theme-one-dark";
import { RotateCcw, Save } from "lucide-react";
import { api, errText, type ObjRef } from "../api";
import { guardProd, useStore } from "../store";
import { modKey } from "../util";

import { isDark, onThemeChange } from "../theme";

const editorTheme = () => (isDark() ? [oneDark] : []);

export type CodeLanguage = "yaml" | "json" | "toml" | "ini" | "properties" | "env" | "shell" | "xml" | "nginx" | "text";

const LANGUAGES: Record<CodeLanguage, () => Extension> = {
  yaml: () => yaml(),
  json: () => json(),
  toml: () => StreamLanguage.define(toml),
  ini: () => StreamLanguage.define(properties),
  properties: () => StreamLanguage.define(properties),
  env: () => StreamLanguage.define(properties),
  shell: () => StreamLanguage.define(shell),
  xml: () => StreamLanguage.define(xml),
  nginx: () => StreamLanguage.define(nginx),
  text: () => [],
};

/** CodeMirror wrapper reused by the YAML tab, the "Apply YAML" dialog and the ConfigMap/Secret values. */
export function CodeEditor({
  value,
  onChange,
  onSave,
  language = "yaml",
  readOnly = false,
}: {
  value: string;
  onChange?: (v: string) => void;
  onSave?: () => void;
  language?: CodeLanguage;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    const theme = new Compartment();
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          LANGUAGES[language](),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          theme.of(editorTheme()),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                handlers.current.onSave?.();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    const off = onThemeChange(() => v.dispatch({ effects: theme.reconfigure(editorTheme()) }));
    return () => {
      off();
      v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="code" ref={host} />;
}

export function YamlEditor({ objRef }: { objRef: ObjRef }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Edits the last save made that Kubernetes ignored (fields under status). */
  const [ignored, setIgnored] = useState<{ path: string; specPath?: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const { toast } = useStore.getState();
  const dirty = original !== null && text !== original;
  const specPaths = [...new Set(ignored.flatMap((f) => (f.specPath ? [f.specPath] : [])))];

  const load = () =>
    api
      .getYaml(objRef)
      .then((y) => {
        setOriginal(y);
        setText(y);
        setError(null);
        setIgnored([]);
      })
      .catch((e) => setError(errText(e)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objRef]);

  const save = async () => {
    if (!dirty || saving) return;
    const doSave = async () => {
      setSaving(true);
      try {
        const saved = await api.replaceYaml(objRef, text, original ?? undefined);
        setOriginal(saved.yaml);
        setText(saved.yaml);
        setError(null);
        setIgnored(saved.ignored);
        if (!saved.ignored.length) toast(`Saved ${objRef.name}`, "success");
      } catch (e) {
        setError(errText(e));
      } finally {
        setSaving(false);
      }
    };
    guardProd(objRef.context, `Save changes to ${objRef.name}?`, "The edited YAML replaces the object on this production cluster.", "Save", doSave);
  };

  if (original === null && !error) return <div className="pad muted">Loading…</div>;

  return (
    <div className="yaml-tab">
      <div className="subbar">
        <button className="btn small primary" disabled={!dirty || saving} onClick={save}>
          <Save size={12} /> {saving ? "Saving…" : `Save (${modKey}S)`}
        </button>
        <button className="btn small" onClick={load} title="Discard changes and reload">
          <RotateCcw size={12} /> Reload
        </button>
        {dirty && <span className="muted small">Unsaved changes</span>}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {ignored.length > 0 && (
        <div className="error-banner warn-banner">
          <b>
            Saved, but Kubernetes ignored your change to {ignored.length === 1 ? "" : "these fields: "}
            {ignored.map((f, i) => (
              <span key={f.path}>
                {i > 0 && ", "}
                <code>{f.path}</code>
              </span>
            ))}
            .
          </b>
          <span>
            The cluster writes status itself and reports what is actually running.
            {specPaths.length > 0 && (
              <>
                {" "}To change it, edit{" "}
                {specPaths.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ", "}
                    <code>{p}</code>
                  </span>
                ))}{" "}
                instead.
              </>
            )}
          </span>
        </div>
      )}
      <CodeEditor value={text} onChange={setText} onSave={save} />
    </div>
  );
}
