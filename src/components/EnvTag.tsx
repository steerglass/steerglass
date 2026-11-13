import { Lock } from "lucide-react";
import { ENV_NAME, ENV_TAG, type Env } from "../env";

/** Small colored tag ("PROD", "DEV"…); `full` spells it out, with a lock for production. */
export function EnvTag({ env, full }: { env: Env | null; full?: boolean }) {
  if (!env) return null;
  return (
    <span className={`env-tag env-${env} ${full ? "full" : ""}`} title={ENV_NAME[env]}>
      {full && env === "prod" && <Lock size={10} strokeWidth={2.6} />}
      {full ? ENV_NAME[env].toUpperCase() : ENV_TAG[env]}
    </span>
  );
}
