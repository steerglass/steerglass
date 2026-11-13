// Recognises what a ConfigMap (or Secret) value holds, so the detail panel can show it properly:
// JSON pretty-printed, config files highlighted, KEY=VALUE files as a table, certificates decoded.

export type Format = "line" | "json" | "yaml" | "toml" | "ini" | "properties" | "env" | "shell" | "xml" | "nginx" | "pem" | "text";

export const FORMAT_LABEL: Record<Format, string> = {
  line: "Value",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  ini: "INI",
  properties: "Properties",
  env: ".env",
  shell: "Shell",
  xml: "XML",
  nginx: "nginx",
  pem: "PEM",
  text: "Text",
};

const EXT: Record<string, Format> = {
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  properties: "properties",
  env: "env",
  sh: "shell",
  bash: "shell",
  xml: "xml",
  pem: "pem",
  crt: "pem",
  cer: "pem",
};

const NGINX = /\b(server|http|location|upstream|events)\s*[^;{]*\{/;
const ENV_LINE = /^(export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=/;
const YAML_LINE = /^\s*(- )?[\w."'/-]+:(\s|$)/;
const INI_SECTION = /^\s*\[[^\]]+\]\s*$/m;

const isJson = (v: string) => {
  const t = v.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};

/** Lines that carry content: not blank, not comments. */
const contentLines = (v: string) => v.split("\n").filter((l) => l.trim() && !/^\s*[#;!]/.test(l));

export function detectFormat(key: string, value: string): Format {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1].toLowerCase();
  if (ext === "conf") return NGINX.test(value) ? "nginx" : INI_SECTION.test(value) ? "ini" : "text";
  if (ext && EXT[ext]) return EXT[ext];
  const t = value.trim();
  if (isJson(t)) return "json";
  if (t.startsWith("-----BEGIN ")) return "pem";
  if (!value.includes("\n")) return "line";
  if (t.startsWith("#!")) return "shell";
  if (/^<(\?xml|[A-Za-z])/.test(t) && t.endsWith(">")) return "xml";
  if (NGINX.test(value)) return "nginx";
  const lines = contentLines(value);
  if (lines.length && lines.every((l) => ENV_LINE.test(l.trim()))) return "env";
  if (INI_SECTION.test(value) && lines.some((l) => /=/.test(l))) return "ini";
  if (lines.filter((l) => YAML_LINE.test(l)).length >= Math.max(1, lines.length / 2)) return "yaml";
  return "text";
}

export const prettyJson = (v: string) => JSON.stringify(JSON.parse(v), null, 2);

/** KEY=VALUE pairs of a .env or .properties file (comments and blank lines dropped). */
export function parsePairs(value: string, format: "env" | "properties"): [string, string][] {
  return contentLines(value).flatMap((raw) => {
    const l = raw.trim().replace(/^export\s+/, "");
    const m = format === "env" ? /^([^=\s]+)\s*=\s*(.*)$/.exec(l) : /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(l);
    if (!m) return [];
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    return [[m[1], v] as [string, string]];
  });
}

export function byteSize(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A guess at what base64 binaryData holds, from its first bytes. */
export function sniffBinary(b64: string): string {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64.slice(0, 64)), (c) => c.charCodeAt(0));
  } catch {
    return "binary";
  }
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "PNG image";
  if (starts(0xff, 0xd8, 0xff)) return "JPEG image";
  if (starts(0x47, 0x49, 0x46)) return "GIF image";
  if (starts(0x1f, 0x8b)) return "gzip";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "zip";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "PDF";
  if (starts(0x00, 0x61, 0x73, 0x6d)) return "WebAssembly";
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return "ELF executable";
  return "binary";
}

// ---------------------------------------------------------------- certificates

export interface CertInfo {
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  sans: string[];
  isCA: boolean;
  selfSigned: boolean;
}

export interface PemBlock {
  label: string;
  cert?: CertInfo;
  error?: string;
}

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function tlv(b: Uint8Array, off: number): Tlv {
  const tag = b[off];
  let len = b[off + 1];
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("unsupported length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[start + i];
    start += n;
  }
  if (tag === undefined || start + len > b.length) throw new Error("truncated");
  return { tag, start, end: start + len };
}

function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let off = t.start; off < t.end; ) {
    const c = tlv(b, off);
    out.push(c);
    off = c.end;
  }
  return out;
}

function oid(b: Uint8Array, t: Tlv): string {
  const parts = [Math.floor(b[t.start] / 40), b[t.start] % 40];
  let n = 0;
  for (let i = t.start + 1; i < t.end; i++) {
    n = n * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}

const text = (b: Uint8Array, t: Tlv) => new TextDecoder().decode(b.subarray(t.start, t.end));

const NAME_ATTR: Record<string, string> = { "2.5.4.3": "CN", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST" };

function name(b: Uint8Array, t: Tlv): string {
  return children(b, t)
    .flatMap((set) => children(b, set))
    .map((atv) => {
      const [type, value] = children(b, atv);
      const o = oid(b, type);
      return `${NAME_ATTR[o] ?? o}=${text(b, value)}`;
    })
    .join(", ");
}

function time(b: Uint8Array, t: Tlv): Date {
  const s = text(b, t);
  const full = t.tag === 0x17 ? (Number(s.slice(0, 2)) >= 50 ? "19" : "20") + s : s;
  const [y, mo, d, h, mi, se] = [0, 4, 6, 8, 10, 12].map((i, k) => Number(full.slice(i, k ? i + 2 : 4)));
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se || 0));
}

function ip(bytes: Uint8Array): string {
  if (bytes.length === 4) return [...bytes].join(".");
  const groups: string[] = [];
  for (let i = 0; i < bytes.length; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
}

export function parseCertificate(der: Uint8Array): CertInfo {
  const cert = tlv(der, 0);
  const tbs = children(der, children(der, cert)[0]);
  let i = tbs[0].tag === 0xa0 ? 1 : 0; // optional [0] version
  i += 2; // serial, signature algorithm
  const issuer = name(der, tbs[i++]);
  const [nb, na] = children(der, tbs[i++]);
  const subject = name(der, tbs[i++]);
  const info: CertInfo = {
    subject,
    issuer,
    notBefore: time(der, nb),
    notAfter: time(der, na),
    sans: [],
    isCA: false,
    selfSigned: subject === issuer,
  };
  const ext = tbs.find((t) => t.tag === 0xa3);
  for (const e of ext ? children(der, children(der, ext)[0]) : []) {
    const parts = children(der, e);
    const id = oid(der, parts[0]);
    const value = tlv(der, parts[parts.length - 1].start);
    if (id === "2.5.29.17") {
      for (const g of children(der, value)) {
        const raw = der.subarray(g.start, g.end);
        if (g.tag === 0x82 || g.tag === 0x81 || g.tag === 0x86) info.sans.push(text(der, g));
        else if (g.tag === 0x87) info.sans.push(ip(raw));
      }
    } else if (id === "2.5.29.19") {
      const ca = children(der, value)[0];
      info.isCA = ca?.tag === 0x01 && der[ca.start] !== 0;
    }
  }
  return info;
}

/** Every PEM block in the value; certificates are decoded, other blocks (keys, CSRs) only named. */
export function parsePem(value: string): PemBlock[] {
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  return [...value.matchAll(re)].map(([, label, body]) => {
    if (label !== "CERTIFICATE") return { label };
    try {
      const der = Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
      return { label, cert: parseCertificate(der) };
    } catch (e) {
      return { label, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
