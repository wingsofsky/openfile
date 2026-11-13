// @vitest-environment node
import { expect, it } from "vitest";
import { resolveConfig } from "vite";

it("dev 父页面配置限制 iframe 导航，仍允许本地/blob 预览", async () => {
  const config = await resolveConfig({ logLevel: "silent" }, "serve");
  expect(config.server.headers?.["Content-Security-Policy"])
    .toBe("frame-src 'self' asset: http://asset.localhost blob:");
});
