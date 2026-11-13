import { describe, expect, it } from "vitest";
import { detectFormat, parsePairs, parsePem, prettyJson, sniffBinary } from "../configFormat";

// openssl req -x509 -newkey ec ... -subj "/O=Steerglass Test/CN=demo.example.com"
//   -addext "subjectAltName=DNS:demo.example.com,DNS:*.demo.example.com,IP:10.0.0.1"
const CERT = `-----BEGIN CERTIFICATE-----
MIIB0jCCAXigAwIBAgIUNp6MHyIQ8bHvQ+NJKuO+C3e37iQwCgYIKoZIzj0EAwIw
NTEYMBYGA1UECgwPU3RlZXJnbGFzcyBUZXN0MRkwFwYDVQQDDBBkZW1vLmV4YW1w
bGUuY29tMB4XDTI2MTEwMTIzNTU0MFoXDTI3MTEwMTIzNTU0MFowNTEYMBYGA1UE
CgwPU3RlZXJnbGFzcyBUZXN0MRkwFwYDVQQDDBBkZW1vLmV4YW1wbGUuY29tMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOMZcO28n1iD7dihlNW8f6suWO08KeVUR
iavRkoayZytU8C8wQHrQhq8MXMNc+u2xuzXY10g1Rxp5nEiWdRxrnKNmMGQwHQYD
VR0OBBYEFIClUQkIqSGDYbs4Rt7L5wF3E5RsMDUGA1UdEQQuMCyCEGRlbW8uZXhh
bXBsZS5jb22CEiouZGVtby5leGFtcGxlLmNvbYcECgAAATAMBgNVHRMBAf8EAjAA
MAoGCCqGSM49BAMCA0gAMEUCIQCT9XnSudGPY7Hn39RdLvQSHpEn51co9tyNbJxk
EhIqkgIgeY9WwjaOrOvB+CVykxGawoYRZxydbDXTcArFSmMPUOE=
-----END CERTIFICATE-----`;

describe("detectFormat", () => {
  it("trusts the key's extension", () => {
    expect(detectFormat("app.json", "{}")).toBe("json");
    expect(detectFormat("values.yml", "a: 1")).toBe("yaml");
    expect(detectFormat("Cargo.toml", "[package]")).toBe("toml");
    expect(detectFormat("ca.crt", CERT)).toBe("pem");
    expect(detectFormat("nginx.conf", "events {}\nhttp {\n  server { listen 80; }\n}")).toBe("nginx");
    expect(detectFormat("my.conf", "[mysqld]\nport=3306")).toBe("ini");
  });

  it("looks at the content when there is no extension", () => {
    expect(detectFormat("settings", '{"a":1,"b":[1,2]}')).toBe("json");
    expect(detectFormat("broken", '{"a":')).toBe("line");
    expect(detectFormat("LOG_LEVEL", "debug")).toBe("line");
    expect(detectFormat("ca", CERT)).toBe("pem");
    expect(detectFormat("entrypoint", "#!/bin/sh\nexec app")).toBe("shell");
    expect(detectFormat("defaults", "# comment\nFOO=1\nexport BAR=\"two\"\n")).toBe("env");
    expect(detectFormat("config", "server:\n  port: 8080\nlogging:\n  level: info\n")).toBe("yaml");
    expect(detectFormat("pom", "<project>\n</project>")).toBe("xml");
    expect(detectFormat("motd", "Welcome!\nHave a nice day.")).toBe("text");
  });
});

describe("helpers", () => {
  it("pretty-prints JSON", () => {
    expect(prettyJson('{"a":[1]}')).toBe('{\n  "a": [\n    1\n  ]\n}');
  });

  it("reads KEY=VALUE pairs", () => {
    expect(parsePairs("# c\nFOO=1\nexport BAR='two'\n\nBAZ = a=b", "env")).toEqual([
      ["FOO", "1"],
      ["BAR", "two"],
      ["BAZ", "a=b"],
    ]);
    expect(parsePairs("server.port: 8080\n! comment\nname=x", "properties")).toEqual([
      ["server.port", "8080"],
      ["name", "x"],
    ]);
  });

  it("sniffs binary data", () => {
    expect(sniffBinary(btoa("\x89PNG\r\n\x1a\n"))).toBe("PNG image");
    expect(sniffBinary(btoa("\x1f\x8b\x08\x00"))).toBe("gzip");
    expect(sniffBinary(btoa("hello"))).toBe("binary");
  });
});

describe("parsePem", () => {
  it("decodes a certificate", () => {
    const [block] = parsePem(CERT);
    expect(block.label).toBe("CERTIFICATE");
    expect(block.cert).toEqual({
      subject: "O=Steerglass Test, CN=demo.example.com",
      issuer: "O=Steerglass Test, CN=demo.example.com",
      notBefore: new Date("2026-11-01T23:55:40Z"),
      notAfter: new Date("2027-11-01T23:55:40Z"),
      sans: ["demo.example.com", "*.demo.example.com", "10.0.0.1"],
      isCA: false,
      selfSigned: true,
    });
  });

  it("names blocks it does not decode and survives garbage", () => {
    const blocks = parsePem(CERT + "\n-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----");
    expect(blocks.map((b) => b.label)).toEqual(["CERTIFICATE", "PUBLIC KEY", "CERTIFICATE"]);
    expect(blocks[2].error).toBeTruthy();
  });
});
