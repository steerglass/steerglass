import { MessageSquare, X } from "lucide-react";
import { openFeedback } from "../feedback";
import { useStore } from "../store";
import { modKey, modName } from "../util";

type Row = [keys: string[], description: string];

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: "Anywhere",
    rows: [
      [[`${modKey}K`, ":"], "Command palette: jump to any resource, cluster, namespace or action"],
      [["?", "F1"], "Show this help"],
      [[`${modKey}0`], "Clusters overview"],
      [[`${modKey}1…9`], "Open the cluster with that number badge: starred clusters in sidebar order (or the first nine if none is starred)"],
      [[`${modKey},`], "Settings (kubeconfig files, environments, port-forwards)"],
      [["Esc"], "Close dialog / detail panel, then clear filter, then selection"],
    ],
  },
  {
    title: "Resource table",
    rows: [
      [["/", `${modKey}F`], "Focus the filter"],
      [["N"], "Pick a namespace: type to search, ↑ ↓ and ↵ to choose"],
      [["↓", "↵"], "From the filter: jump into the table"],
      [["↑ ↓", "j k"], "Move selection"],
      [["PgUp PgDn"], "Move by 20 rows"],
      [["g", "G"], "First / last row"],
      [["↵", "double-click"], "Open details"],
      [["right-click"], "All actions for the row"],
    ],
  },
  {
    title: "Actions on the selected row",
    rows: [
      [["L"], "Logs (pods)"],
      [["S"], "Shell (pods)"],
      [["E", "Y"], "Edit YAML"],
      [["R"], "Rollout restart (deployments, statefulsets, daemonsets)"],
      [["C"], "Copy name"],
      [["⌫", "Delete"], "Delete (asks for confirmation)"],
    ],
  },
  {
    title: "Editors and logs",
    rows: [
      [[`${modKey}S`], "Save YAML / apply manifest"],
      [["scroll up"], "Pause log follow; the ↓ button resumes it"],
    ],
  },
];

const TIPS: [string, string][] = [
  ["Multi-cluster view", `${modName}-click several clusters in the sidebar to see the same resource of all of them in one live table, with a Cluster column.`],
  ["Filter syntax", "Words are matched on name, namespace and every column (all words must match). Type status:bad to see only failing or warning rows, or status:error, status:warn, status:ok."],
  ["Health colors", "The dot before each name is green when healthy, yellow when degraded or in progress, red when failing, grey when neutral (e.g. completed jobs)."],
  ["Port-forward", "Click a container port in a pod's details, or a port in a service's details. While it runs the port shows the local address, with buttons to open it, copy it and stop it. Settings lists every active forward."],
  ["Production safety", "On contexts whose name contains prod, prd, production or live, delete and restart require typing the object name, and YAML saves ask for confirmation."],
  ["Kubeconfig", "Steerglass reads $KUBECONFIG, ~/.kube/config and the other kubeconfig files in ~/.kube, like kubectl. Credential plugins (gcloud, aws, kubelogin) work as in your terminal."],
  ["Custom resources", "CRDs installed in the first selected cluster appear under Custom resources in the sidebar and in the command palette."],
];

export function HelpDialog() {
  const open = useStore((s) => s.helpOpen);
  if (!open) return null;
  const close = () => useStore.getState().set({ helpOpen: false });
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog help" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()} tabIndex={-1} ref={(el) => el?.focus()}>
        <div className="dialog-head">
          <h2>Steerglass help</h2>
          <button className="btn small help-feedback" onClick={() => openFeedback("feedback")}>
            <MessageSquare size={13} /> Send feedback
          </button>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="help-cols">
          <div>
            {SECTIONS.map((s) => (
              <section key={s.title}>
                <h3>{s.title}</h3>
                <table className="keys">
                  <tbody>
                    {s.rows.map(([keys, desc]) => (
                      <tr key={desc}>
                        <td>
                          {keys.map((k, i) => (
                            <span key={k}>
                              {i > 0 && <span className="muted"> or </span>}
                              <kbd className="key">{k}</kbd>
                            </span>
                          ))}
                        </td>
                        <td>{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
          <div>
            <h3>Tips</h3>
            {TIPS.map(([title, body]) => (
              <div key={title} className="tip">
                <b>{title}</b>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
