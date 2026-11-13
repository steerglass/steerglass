/** Minimal ANSI SGR parser for log lines (colors, bold, dim, italic, underline, inverse). */

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Span {
  text: string;
  style: AnsiStyle;
}

// CSI sequences, OSC sequences (e.g. hyperlinks), and two-char escapes.
const ESCAPES = /\x1b\[([0-9;:?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

export const hasAnsi = (s: string) => s.includes("\x1b");

export function stripAnsi(s: string): string {
  return hasAnsi(s) ? s.replace(ESCAPES, "") : s;
}

/** Basic 16 colors map to CSS variables so they follow the light/dark theme. */
const base = (i: number) => `var(--ansi-${i})`;

function color256(n: number): string {
  if (n < 16) return base(n);
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
}

function applySgr(params: number[], st: AnsiStyle): AnsiStyle {
  const s = { ...st };
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      for (const k of Object.keys(s)) delete s[k as keyof AnsiStyle];
    } else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) s.bold = s.dim = false;
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p >= 30 && p <= 37) s.fg = base(p - 30);
    else if (p >= 90 && p <= 97) s.fg = base(p - 90 + 8);
    else if (p === 39) delete s.fg;
    else if (p >= 40 && p <= 47) s.bg = base(p - 40);
    else if (p >= 100 && p <= 107) s.bg = base(p - 100 + 8);
    else if (p === 49) delete s.bg;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        s[key] = color256(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
        s[key] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        i += 4;
      }
    }
  }
  return s;
}

export function parseAnsi(line: string): Span[] {
  if (!hasAnsi(line)) return [{ text: line, style: {} }];
  const spans: Span[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  ESCAPES.lastIndex = 0;
  for (let m = ESCAPES.exec(line); m; m = ESCAPES.exec(line)) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index), style });
    last = ESCAPES.lastIndex;
    // Only SGR ("m") changes styling; cursor movement and other sequences are dropped.
    if (m[2] === "m") {
      const params = m[1] === "" ? [] : m[1].split(/[;:]/).map((x) => Number(x) || 0);
      style = applySgr(params, style);
    }
  }
  if (last < line.length) spans.push({ text: line.slice(last), style });
  return spans;
}
