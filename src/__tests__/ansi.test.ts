import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "../ansi";

// Real line from a zerolog console writer (pinger container).
const PINGER =
  "\x1b[90m2026-10-30T22:00:12Z\x1b[0m \x1b[32mINF\x1b[0m \x1b[1mquality check complete\x1b[0m \x1b[36mjitterMs=\x1b[0m0.56";

describe("ansi", () => {
  it("strips escapes", () => {
    expect(stripAnsi(PINGER)).toBe("2026-10-30T22:00:12Z INF quality check complete jitterMs=0.56");
  });

  it("parses colors and resets", () => {
    const spans = parseAnsi(PINGER);
    expect(spans.map((s) => s.text).join("")).toBe(stripAnsi(PINGER));
    expect(spans[0]).toEqual({ text: "2026-10-30T22:00:12Z", style: { fg: "var(--ansi-8)" } });
    expect(spans[1]).toEqual({ text: " ", style: {} });
    expect(spans[2].style.fg).toBe("var(--ansi-2)");
    expect(spans[4]).toEqual({ text: "quality check complete", style: { bold: true } });
    expect(spans[6].style.fg).toBe("var(--ansi-6)");
    expect(spans[7]).toEqual({ text: "0.56", style: {} });
  });

  it("handles 256 and truecolor, and drops non-SGR sequences", () => {
    const spans = parseAnsi("\x1b[38;5;196mred\x1b[48;2;1;2;3m bg\x1b[2K\x1b[39;49m plain");
    expect(spans[0].style.fg).toBe("rgb(255,0,0)");
    expect(spans[1].style.bg).toBe("rgb(1,2,3)");
    expect(spans.map((s) => s.text).join("")).toBe("red bg plain");
    expect(spans[2].style).toEqual({});
  });

  it("returns plain lines untouched", () => {
    expect(parseAnsi("hello")).toEqual([{ text: "hello", style: {} }]);
  });
});
