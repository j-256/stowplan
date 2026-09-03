import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import { GET } from "../app/api/version/route";

describe("version route", () => {
  it("returns the packaged version as uncached plain text", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await expect(response.text()).resolves.toBe(`${packageMetadata.version}\n`);
  });
});
