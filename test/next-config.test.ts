import { beforeEach, expect, it, vi } from "vitest";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants.js";

const initializeCloudflare = vi.hoisted(() => vi.fn());
vi.mock("@opennextjs/cloudflare", () => ({
  initOpenNextCloudflareForDev: initializeCloudflare,
}));

beforeEach(() => {
  vi.resetModules();
  initializeCloudflare.mockClear();
});

it("does not create a development Worker while evaluating a production build", async () => {
  const { default: configure } = await import("../next.config");
  expect(initializeCloudflare).not.toHaveBeenCalled();
  const config = configure(PHASE_PRODUCTION_BUILD);
  expect(config.output).toBe("standalone");
  expect(initializeCloudflare).not.toHaveBeenCalled();
});

it("initializes Cloudflare bindings only for the Next development server", async () => {
  const { default: configure } = await import("../next.config");
  configure(PHASE_DEVELOPMENT_SERVER);
  expect(initializeCloudflare).toHaveBeenCalledOnce();
});
