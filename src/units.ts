/** CPU in cores → "250m" / "1.42". */
export function fmtCores(c: number): string {
  if (c < 1) return `${Math.round(c * 1000)}m`;
  return c < 10 ? c.toFixed(2) : c.toFixed(1);
}

/** Bytes → "241 Mi" / "3.1 Gi". */
export function fmtBytes(b: number): string {
  const mi = b / 1048576;
  if (mi < 1024) return `${Math.round(mi)} Mi`;
  const gi = mi / 1024;
  return `${gi < 100 ? gi.toFixed(1) : Math.round(gi)} Gi`;
}

/** Share of `of` used by `v`, as a fraction; null when there is nothing to compare with. */
export function share(v: number, of?: number | null): number | null {
  return of ? v / of : null;
}

export const pct = (f: number) => `${Math.round(f * 100)}%`;

const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};

/** Any Kubernetes quantity ("2", "500m", "4Gi", "1k") as a number; null when unparsable. */
export function parseQuantity(q: string | number | undefined | null): number | null {
  if (q === undefined || q === null) return null;
  const m = /^\s*([+-]?[\d.]+(?:e[+-]?\d+)?)\s*([a-zA-Z]*)\s*$/.exec(String(q));
  if (!m) return null;
  const mult = m[2] ? SUFFIX[m[2]] : 1;
  return mult === undefined ? null : Number(m[1]) * mult;
}
