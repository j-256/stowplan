import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  runtimeEnv: vi.fn(),
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: runtime.runtimeEnv,
}));

import { GET } from "../app/api/health/route";

describe("health route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a missing binding without claiming readiness", async () => {
    runtime.runtimeEnv.mockResolvedValue({});
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      storage: "missing",
    });
  });

  it("probes the collaboration schema before reporting readiness", async () => {
    const first = vi.fn().mockResolvedValue({ has_snapshots: 0 });
    runtime.runtimeEnv.mockResolvedValue({
      DB: {
        prepare: vi.fn(() => ({ first })),
      },
    });
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      schema: "ready",
      storage: "configured",
    });
    expect(first).toHaveBeenCalledOnce();
  });

  it("returns unavailable without exposing a schema error", async () => {
    runtime.runtimeEnv.mockResolvedValue({
      DB: {
        prepare: vi.fn(() => ({
          first: vi.fn().mockRejectedValue(new Error("no such table: users")),
        })),
      },
    });
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      schema: "unavailable",
      storage: "configured",
    });
    expect(JSON.stringify(body)).not.toContain("users");
  });
});
