/** The environment a cluster belongs to: drives its color and the production safeguards. */
export type Env = "prod" | "stage" | "dev" | "local";

/** What the user picked for a context: an environment, "none", or nothing (auto-detected). */
export type EnvChoice = Env | "none";

export const ENVS: Env[] = ["prod", "stage", "dev", "local"];

export const ENV_TAG: Record<Env, string> = { prod: "PROD", stage: "STAGE", dev: "DEV", local: "LOCAL" };
export const ENV_NAME: Record<Env, string> = { prod: "Production", stage: "Staging", dev: "Development", local: "Local" };

const LOCAL = /^(minikube|docker-desktop|docker-for-desktop|rancher-desktop|orbstack|colima)$|^(kind|k3d)-|localhost|127\.0\.0\.1/i;
const STAGE = /(^|[-_.:/@])(stage|staging|stg|uat|qa|pre-?prod)([-_.:/@]|$)/i;
const PROD = /(^|[-_.:/@])(prod|prd|production|live)([-_.:/@]|$)/i;
const DEV = /(^|[-_.:/@])(dev|develop|development|test|testing|sandbox|sbx)([-_.:/@]|$)/i;

/** Guesses the environment from the context name ("shop-prod", "kind-local", "gke_acme-staging_…"). */
export function detectEnv(ctx: string): Env | null {
  if (LOCAL.test(ctx)) return "local";
  // Before PROD, so "pre-prod" counts as staging.
  if (STAGE.test(ctx)) return "stage";
  if (PROD.test(ctx)) return "prod";
  if (DEV.test(ctx)) return "dev";
  return null;
}

export function resolveEnv(choices: Record<string, EnvChoice>, ctx: string): Env | null {
  const c = choices[ctx];
  if (c === undefined) return detectEnv(ctx);
  return c === "none" ? null : c;
}

/** The most sensitive environment among `envs` (production first). */
export function strictestEnv(envs: (Env | null)[]): Env | null {
  for (const e of ENVS) if (envs.includes(e)) return e;
  return null;
}
