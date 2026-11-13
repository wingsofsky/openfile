import { describe, expect, it } from "vitest";
import { assertDevRequest } from "../scripts/dev-request.mjs";

const config = { port: 1420 };
const req = (method = "POST", extra = {}) => ({
  method,
  headers: {
    host: "127.0.0.1:1420",
    origin: "http://127.0.0.1:1420",
    "content-type": "application/json",
    "x-openfile-request": "1",
    ...extra,
  },
});

describe("dev bridge request boundary", () => {
  it("rejects cross-origin forms and spoofed origins before any route runs", () => {
    for (const origin of ["http://evil.example", "http://127.0.0.1:1483", "null"]) {
      expect(() => assertDevRequest(req("POST", { origin }), config)).toThrow();
    }
    expect(() => assertDevRequest(req("POST", {
      "content-type": "text/plain", "x-openfile-request": undefined,
    }), config)).toThrow();
    expect(() => assertDevRequest(req("POST", { "x-openfile-request": undefined }), config)).toThrow();
    expect(() => assertDevRequest(req("POST", { "content-type": "text/plain" }), config)).toThrow();
  });

  it("rejects rebinding, malformed hosts and wrong server ports, including reads", () => {
    for (const host of ["evil.example:1420", "127.0.0.1:1421", "evil@127.0.0.1:1420", "127.0.0.1:1420/path"]) {
      expect(() => assertDevRequest(req("GET", { host, origin: undefined }), config)).toThrow();
    }
    expect(() => assertDevRequest(req("GET", { origin: "http://evil.example" }), config)).toThrow();
    expect(() => assertDevRequest(req("OPTIONS"), config)).toThrow();
    for (const site of ["same-site", "cross-site"]) {
      expect(() => assertDevRequest(req("GET", {
        origin: undefined, "sec-fetch-site": site, "sec-fetch-dest": "script",
      }), config, true)).toThrow();
    }
  });

  it("accepts the actual same origin and explicit non-browser clients", () => {
    expect(() => assertDevRequest(req(), config)).not.toThrow();
    expect(() => assertDevRequest(req("POST", { origin: undefined }), config)).not.toThrow();
    expect(() => assertDevRequest(req("GET", { origin: undefined, "x-openfile-request": undefined }), config)).not.toThrow();
    expect(() => assertDevRequest(req("POST", {
      host: "localhost:1420", origin: "http://localhost:1420",
    }), config)).not.toThrow();
    expect(() => assertDevRequest(req("POST", {
      host: "[::1]:1420", origin: "http://[::1]:1420",
    }), config)).not.toThrow();
  });

  it("allows opaque HTML frames only to load passive raw resources", () => {
    const resource = req("GET", { origin: "null", "sec-fetch-dest": "font" });
    expect(() => assertDevRequest(resource, config, true)).not.toThrow();
    expect(() => assertDevRequest(resource, config, false)).toThrow();
    expect(() => assertDevRequest(req("GET", { origin: "null", "sec-fetch-dest": "empty" }), config, true)).toThrow();
  });
});
