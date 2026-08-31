#!/usr/bin/env node

import { stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DOCUMENTATION_ORIGIN = "https://docs.stowplan.lasers.app";
export const PUBLICATION_FORMAT = "stowplan.documentation.v1";
export const PUBLICATION_FILE_NAME = "publication.json";

const DEFAULT_PUBLICATION_PATH = fileURLToPath(
  new URL(`../docs/.vitepress/dist/${PUBLICATION_FILE_NAME}`, import.meta.url),
);
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const MAXIMUM_ATTEMPTS = 12;
const MAXIMUM_DELAY_MS = 10_000;

export class DocumentationPublicationUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentationPublicationUsageError";
  }
}

export function documentationPublicationUsage() {
  return [
    "Usage: docs-publication.mjs COMMAND [options]",
    "",
    "Commands:",
    "  stamp    Add the verified source revision to the built docs artifact",
    "  verify   Require the canonical site to serve that exact revision",
    "",
    "Options:",
    "  -r, --revision REVISION   Required lowercase Git object ID",
    `  -o, --output FILE         Stamp output (default: docs/.vitepress/dist/${PUBLICATION_FILE_NAME})`,
    `  -u, --url URL             Verification origin (default: ${DOCUMENTATION_ORIGIN})`,
    "  -a, --attempts N          Verification attempts from 1 through 12 (default: 1)",
    "  -d, --delay-ms N          Delay up to 10000 milliseconds between attempts (default: 0)",
    "  -h, --help                Show this help",
    "",
    "Exit status: 0 for success, 1 for runtime failure, and 2 for invalid usage.",
  ].join("\n");
}

function usageError(message) {
  throw new DocumentationPublicationUsageError(message);
}

function requireRevision(value) {
  if (!value || !REVISION_PATTERN.test(value)) {
    usageError("--revision requires a lowercase Git object ID");
  }
  return value;
}

function parseBoundedInteger(value, label, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value ?? "")) {
    usageError(`${label} requires an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    usageError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    usageError("--url requires an HTTP or HTTPS origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    usageError("--url requires an HTTP or HTTPS origin");
  }
  return url.origin;
}

export function parseDocumentationPublicationArguments(args) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args,
      options: {
        attempts: { short: "a", type: "string" },
        "delay-ms": { short: "d", type: "string" },
        help: { short: "h", type: "boolean" },
        output: { short: "o", type: "string" },
        revision: { short: "r", type: "string" },
        url: { short: "u", type: "string" },
      },
      strict: true,
    });
  } catch (error) {
    usageError(error instanceof Error ? error.message : "arguments are invalid");
  }

  if (parsed.values.help) {
    return { command: null, help: true };
  }

  const [command, ...extraPositionals] = parsed.positionals;
  if (command !== "stamp" && command !== "verify") {
    usageError("COMMAND must be stamp or verify");
  }
  if (extraPositionals.length > 0) {
    usageError(`unexpected argument: ${extraPositionals[0]}`);
  }

  const revision = requireRevision(parsed.values.revision);
  if (command === "stamp") {
    if (
      parsed.values.attempts !== undefined ||
      parsed.values["delay-ms"] !== undefined ||
      parsed.values.url !== undefined
    ) {
      usageError("stamp accepts only --revision and --output");
    }
    return {
      command,
      help: false,
      outputPath: resolve(parsed.values.output ?? DEFAULT_PUBLICATION_PATH),
      revision,
    };
  }

  if (parsed.values.output !== undefined) {
    usageError("verify does not accept --output");
  }
  return {
    attempts: parseBoundedInteger(
      parsed.values.attempts ?? "1",
      "--attempts",
      1,
      MAXIMUM_ATTEMPTS,
    ),
    command,
    delayMs: parseBoundedInteger(
      parsed.values["delay-ms"] ?? "0",
      "--delay-ms",
      0,
      MAXIMUM_DELAY_MS,
    ),
    help: false,
    origin: normalizeOrigin(parsed.values.url ?? DOCUMENTATION_ORIGIN),
    revision,
  };
}

export function documentationPublication(revision) {
  return {
    format: PUBLICATION_FORMAT,
    revision: requireRevision(revision),
  };
}

export function validateDocumentationPublication(value, revision) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["format", "revision"]) ||
    value.format !== PUBLICATION_FORMAT ||
    value.revision !== revision
  ) {
    throw new Error(`Public documentation does not identify revision ${revision}`);
  }
  return value;
}

export async function stampDocumentationPublication({
  outputPath = DEFAULT_PUBLICATION_PATH,
  revision,
}) {
  const parent = dirname(outputPath);
  const metadata = await stat(parent).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new Error(`Documentation output directory is missing: ${parent}`);
  }
  const publication = documentationPublication(revision);
  await writeFile(outputPath, `${JSON.stringify(publication, null, 2)}\n`);
  return { outputPath, publication };
}

async function fetchWithTimeout(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function verificationUrl(origin, path, revision, attempt) {
  const url = new URL(path, `${origin}/`);
  url.searchParams.set("stowplan-revision", revision);
  url.searchParams.set("attempt", String(attempt));
  return url;
}

async function verifyAttempt({ attempt, fetchImpl, origin, revision }) {
  const publicationResponse = await fetchWithTimeout(
    fetchImpl,
    verificationUrl(origin, PUBLICATION_FILE_NAME, revision, attempt),
  );
  if (publicationResponse.status !== 200) {
    throw new Error(`Publication marker returned ${publicationResponse.status}`);
  }
  let publication;
  try {
    publication = await publicationResponse.json();
  } catch {
    throw new Error("Publication marker is not JSON");
  }
  validateDocumentationPublication(publication, revision);

  const guideResponse = await fetchWithTimeout(
    fetchImpl,
    verificationUrl(origin, "guide/getting-started", revision, attempt),
  );
  if (guideResponse.status !== 200) {
    throw new Error(`Nested documentation route returned ${guideResponse.status}`);
  }
  if (!(await guideResponse.text()).includes("<title>Getting started | Stowplan</title>")) {
    throw new Error("Nested documentation route returned unexpected content");
  }

  const missingResponse = await fetchWithTimeout(
    fetchImpl,
    verificationUrl(
      origin,
      `missing-publication-${revision}`,
      revision,
      attempt,
    ),
  );
  if (missingResponse.status !== 404) {
    throw new Error(`Missing documentation route returned ${missingResponse.status}`);
  }
  if (!(await missingResponse.text()).includes("<title>404 | Stowplan</title>")) {
    throw new Error("Missing documentation route did not use the documentation 404 page");
  }
}

/**
 * @param {{
 *   attempts?: number,
 *   delayMs?: number,
 *   fetchImpl?: typeof fetch,
 *   onRetry?: (error: unknown, attempt: number, attempts: number) => void,
 *   origin?: string,
 *   revision: string,
 *   sleep?: (milliseconds: number) => Promise<void>,
 * }} options
 */
export async function verifyPublicDocumentation({
  attempts = 1,
  delayMs = 0,
  fetchImpl = fetch,
  onRetry = () => undefined,
  origin = DOCUMENTATION_ORIGIN,
  revision,
  sleep = (milliseconds) => new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }),
}) {
  requireRevision(revision);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await verifyAttempt({ attempt, fetchImpl, origin, revision });
      return { attempt, origin, revision };
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      onRetry(error, attempt, attempts);
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error("Public documentation verification failed");
}

async function main() {
  const options = parseDocumentationPublicationArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${documentationPublicationUsage()}\n`);
    return;
  }
  if (options.command === "stamp") {
    const result = await stampDocumentationPublication(options);
    process.stdout.write(
      `Stamped documentation revision ${result.publication.revision} at ${result.outputPath}\n`,
    );
    return;
  }
  const result = await verifyPublicDocumentation({
    ...options,
    onRetry(error, attempt, attempts) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Documentation is not current after attempt ${attempt} of ${attempts}: ${message}\n`,
      );
    },
  });
  process.stdout.write(
    `Verified documentation revision ${result.revision} at ${result.origin}\n`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    if (error instanceof DocumentationPublicationUsageError) {
      process.stderr.write(`docs-publication: ${error.message}\n`);
      process.stderr.write("Try --help for usage.\n");
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `docs-publication: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
