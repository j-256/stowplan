import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKSPACE_ACCESS_REQUEST_MAX_BYTES } from "../src/server/request-body";

interface EdgeRule {
  description: string;
  expression: string;
}

interface EdgeProfile {
  phases: {
    http_ratelimit: EdgeRule[];
    http_request_firewall_custom: EdgeRule[];
  };
}

interface EdgeConfiguration {
  profiles: Record<string, EdgeProfile>;
  workspace_access_request_body_limit_bytes: number;
}

const configuration = JSON.parse(readFileSync(
  new URL("../cloudflare/edge-rules.json", import.meta.url),
  "utf8",
)) as EdgeConfiguration;

describe("Cloudflare edge configuration", () => {
  it("rate-limits member workspace APIs in every plan profile", () => {
    for (const profile of Object.values(configuration.profiles)) {
      expect(profile.phases.http_ratelimit.some(
        rule => rule.expression.includes("/api/workspaces"),
      )).toBe(true);
    }
  });

  it("rate-limits fixed and legacy guest confirmation APIs", () => {
    const rules = Object.values(configuration.profiles).flatMap(
      profile => profile.phases.http_ratelimit.filter(
        candidate => candidate.description ===
          "[stowplan] Limit guest redemption requests by source",
      ),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.expression).toContain(
        'http.request.uri.path eq "/api/auth/guest"',
      );
      expect(rule.expression).toContain(
        'starts_with(http.request.uri.path, "/api/auth/guest/")',
      );
    }
  });

  it("keeps the Enterprise workspace body limit aligned with the server", () => {
    expect(configuration.workspace_access_request_body_limit_bytes)
      .toBe(WORKSPACE_ACCESS_REQUEST_MAX_BYTES);
    const rule = configuration.profiles.enterprise_advanced
      ?.phases.http_request_firewall_custom.find(
        candidate => candidate.description ===
          "[stowplan] Block oversized workspace access request bodies",
      );
    expect(rule?.expression).toContain(
      `http.request.body.size gt ${WORKSPACE_ACCESS_REQUEST_MAX_BYTES}`,
    );
  });
});
