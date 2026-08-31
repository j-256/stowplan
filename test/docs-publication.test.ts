import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DocumentationPublicationUsageError,
  PUBLICATION_FORMAT,
  parseDocumentationPublicationArguments,
  stampDocumentationPublication,
  verifyPublicDocumentation,
} from "../scripts/docs-publication.mjs";

const REVISION = "a".repeat(40);
const scriptPath = resolve("scripts/docs-publication.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    ),
  );
});

describe("documentation publication CLI", () => {
  it.each(["-h", "--help"])("supports %s", (helpFlag) => {
    const result = spawnSync(process.execPath, [scriptPath, helpFlag], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: docs-publication.mjs");
    expect(result.stderr).toBe("");
  });

  it("accepts equivalent option forms and interleaved positionals", () => {
    expect(parseDocumentationPublicationArguments([
      "-r" + REVISION,
      "stamp",
      "--output=artifact.json",
    ])).toMatchObject({
      command: "stamp",
      outputPath: resolve("artifact.json"),
      revision: REVISION,
    });
    expect(parseDocumentationPublicationArguments([
      "verify",
      "--revision",
      REVISION,
      "-a2",
      "-d",
      "10",
      "--url=http://127.0.0.1:8787",
    ])).toMatchObject({
      attempts: 2,
      command: "verify",
      delayMs: 10,
      origin: "http://127.0.0.1:8787",
      revision: REVISION,
    });
  });

  it("rejects unknown, missing, and misplaced values with usage status", () => {
    for (const args of [
      ["stamp"],
      ["stamp", "--revision", REVISION, "--attempts", "2"],
      ["verify", "--revision", REVISION, "--unknown"],
      ["verify", "--revision", REVISION, "--", "extra"],
    ]) {
      expect(() => parseDocumentationPublicationArguments(args))
        .toThrow(DocumentationPublicationUsageError);
    }

    const result = spawnSync(process.execPath, [scriptPath, "stamp"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Try --help for usage");
  });
});

describe("documentation publication artifact", () => {
  it("stamps the exact verified revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "stowplan-docs-publication-"));
    temporaryRoots.push(root);
    const outputPath = join(root, "publication.json");

    await stampDocumentationPublication({ outputPath, revision: REVISION });

    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      format: PUBLICATION_FORMAT,
      revision: REVISION,
    });
  });

  it("verifies the revision, nested clean URL, and custom 404", async () => {
    const requestedPaths: string[] = [];
    const result = await verifyPublicDocumentation({
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requestedPaths.push(url.pathname);
        if (url.pathname === "/publication.json") {
          return Response.json({
            format: PUBLICATION_FORMAT,
            revision: REVISION,
          });
        }
        if (url.pathname === "/guide/getting-started") {
          return new Response("<title>Getting started | Stowplan</title>");
        }
        return new Response("<title>404 | Stowplan</title>", { status: 404 });
      },
      origin: "https://docs.example.test",
      revision: REVISION,
    });

    expect(result).toEqual({
      attempt: 1,
      origin: "https://docs.example.test",
      revision: REVISION,
    });
    expect(requestedPaths).toEqual([
      "/publication.json",
      "/guide/getting-started",
      `/missing-publication-${REVISION}`,
    ]);
  });

  it("retries a stale public revision before succeeding", async () => {
    let publicationRequests = 0;
    const retries: string[] = [];
    const sleeps: number[] = [];

    const result = await verifyPublicDocumentation({
      attempts: 2,
      delayMs: 25,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/publication.json") {
          publicationRequests += 1;
          return Response.json({
            format: PUBLICATION_FORMAT,
            revision: publicationRequests === 1 ? "b".repeat(40) : REVISION,
          });
        }
        if (url.pathname === "/guide/getting-started") {
          return new Response("<title>Getting started | Stowplan</title>");
        }
        return new Response("<title>404 | Stowplan</title>", { status: 404 });
      },
      onRetry(error) {
        retries.push(error instanceof Error ? error.message : String(error));
      },
      origin: "https://docs.example.test",
      revision: REVISION,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    expect(result.attempt).toBe(2);
    expect(retries).toEqual([
      `Public documentation does not identify revision ${REVISION}`,
    ]);
    expect(sleeps).toEqual([25]);
  });
});
