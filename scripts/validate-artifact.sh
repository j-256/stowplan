#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

worker="${SITES_PROJECT_ROOT}/dist/server/index.js"
hosting="${SITES_PROJECT_ROOT}/dist/.openai/hosting.json"
source_hosting="${SITES_PROJECT_ROOT}/.openai/hosting.json"
source_migrations="${SITES_PROJECT_ROOT}/drizzle"

[[ -f "${worker}" ]] || {
  echo "Missing Sites Worker entry: dist/server/index.js" >&2
  exit 66
}
[[ -f "${hosting}" ]] || {
  echo "Missing packaged Sites manifest: dist/.openai/hosting.json" >&2
  exit 66
}

node --input-type=module - \
  "${worker}" \
  "${hosting}" \
  "${source_hosting}" \
  "${source_migrations}" <<'NODE'
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [
  workerPath,
  hostingPath,
  sourceHostingPath,
  sourceMigrationDirectory,
] = process.argv.slice(2);
const [hostingBytes, sourceHostingBytes] = await Promise.all([
  readFile(hostingPath),
  readFile(sourceHostingPath),
]);
if (!hostingBytes.equals(sourceHostingBytes)) {
  throw new Error("The packaged Sites manifest differs from its source");
}
const hosting = JSON.parse(hostingBytes.toString("utf8"));

async function filesBelow(directory, prefix = "", rejectFinderMetadata = false) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") {
      if (rejectFinderMetadata) {
        throw new Error(`Finder metadata was packaged at ${join(prefix, entry.name)}`);
      }
      continue;
    }
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...await filesBelow(
          join(directory, entry.name),
          relativePath,
          rejectFinderMetadata,
        ),
      );
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

if (hosting.d1) {
  const migrationDirectory = resolve(dirname(hostingPath), "drizzle");
  const [migrationFiles, sourceFiles] = await Promise.all([
    filesBelow(migrationDirectory, "", true),
    filesBelow(sourceMigrationDirectory),
  ]);
  if (!sourceFiles.some((name) => name.endsWith(".sql"))) {
    throw new Error("A Sites D1 binding requires at least one source SQL migration");
  }
  if (JSON.stringify(migrationFiles) !== JSON.stringify(sourceFiles)) {
    throw new Error("The packaged Sites migrations differ from the source file set");
  }
  for (const migrationFile of sourceFiles) {
    const [packaged, source] = await Promise.all([
      readFile(join(migrationDirectory, migrationFile)),
      readFile(join(sourceMigrationDirectory, migrationFile)),
    ]);
    if (!packaged.equals(source)) {
      throw new Error(`The packaged Sites migration differs from source: ${migrationFile}`);
    }
  }
  if (!migrationFiles.some((name) => name.endsWith(".sql"))) {
    throw new Error("A Sites D1 binding requires at least one packaged SQL migration");
  }
}

const workerUrl = pathToFileURL(workerPath);
workerUrl.searchParams.set("sites-validation", `${process.pid}-${Date.now()}`);
const worker = await import(workerUrl.href);
if (!worker.default || typeof worker.default.fetch !== "function") {
  throw new Error("dist/server/index.js must have an ESM default export with fetch(request, env, ctx)");
}
NODE

echo "Validated Sites artifact: Worker, manifest, and binding migrations exactly match their sources."
