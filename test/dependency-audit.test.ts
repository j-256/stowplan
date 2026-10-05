import { describe, expect, it } from "vitest";
import { reviewDependencyAudit } from "../scripts/audit-dependencies.mjs";

const advisory = {
  name: "braces",
  dependency: "braces",
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
};

function report(vulnerabilities: Record<string, unknown>) {
  return {
    metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } },
    vulnerabilities,
  };
}

describe("dependency audit policy", () => {
  it("accepts an empty audit", () => {
    expect(reviewDependencyAudit(report({}), {})).toEqual({
      ok: true,
      exception: false,
    });
  });

  it("accepts the reviewed braces advisory only through development tools", () => {
    const decision = reviewDependencyAudit(
      report({
        braces: { isDirect: false, via: [advisory] },
        "build-tool": { isDirect: true, via: ["braces"] },
      }),
      { devDependencies: { "build-tool": "1.0.0" } },
    );
    expect(decision).toEqual({ ok: true, exception: true });
  });

  it("rejects any additional advisory", () => {
    const decision = reviewDependencyAudit(
      report({
        braces: { isDirect: false, via: [advisory] },
        other: {
          isDirect: true,
          via: [
            {
              name: "other",
              dependency: "other",
              url: "https://github.com/advisories/GHSA-example",
            },
          ],
        },
      }),
      { devDependencies: { other: "1.0.0" } },
    );
    expect(decision.ok).toBe(false);
  });

  it("rejects the advisory when it reaches a runtime dependency", () => {
    const decision = reviewDependencyAudit(
      report({
        braces: { isDirect: false, via: [advisory] },
        runtime: { isDirect: true, via: ["braces"] },
      }),
      { dependencies: { runtime: "1.0.0" } },
    );
    expect(decision.ok).toBe(false);
  });
});
