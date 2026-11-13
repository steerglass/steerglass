import type { ReactNode } from "react";

/** One setting: title and explanation on the left, its control aligned on the right. */
export function SettingRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <div className="set-title">{title}</div>
        {desc && <div className="set-desc">{desc}</div>}
      </div>
      {children && <div className="set-control">{children}</div>}
    </div>
  );
}

export function SettingGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="set-group">
      {title && <h3>{title}</h3>}
      <div className="set-card">{children}</div>
    </section>
  );
}
