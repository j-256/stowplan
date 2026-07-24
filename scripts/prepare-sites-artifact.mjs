import {
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(process.argv[2] ?? ".");
const artifactRoot = join(projectRoot, "dist");
const removableNames = new Set([
  ".DS_Store",
  ".dev.vars",
]);

function isEnvironmentFile(name) {
  return name === ".env" || name.startsWith(".env.");
}

async function prepare(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (removableNames.has(entry.name) || isEnvironmentFile(entry.name)) {
      await rm(path, { force: true, recursive: entry.isDirectory() });
      continue;
    }
    if (entry.isDirectory()) {
      await prepare(path);
      continue;
    }
    if (!entry.isFile() || entry.name !== "wrangler.json") continue;
    const config = JSON.parse(await readFile(path, "utf8"));
    delete config.configPath;
    delete config.userConfigPath;
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  }
}

await prepare(artifactRoot);
console.log("Removed local environment data and machine metadata from the Sites artifact");
