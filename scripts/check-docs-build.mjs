import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const output = path.resolve("docs/.vitepress/dist");
const rawBase = process.env.DOCS_BASE ?? "/";
const base = rawBase === "/" ? "/" : `/${rawBase.replace(/^\/+|\/+$/g, "")}/`;
const applicationUrl = (
  process.env.DOCS_APPLICATION_URL ||
  "https://stowplan.jklein.dev"
).replace(/\/+$/u, "");
const demoUrl = `${applicationUrl}/demo`;

async function filesBelow(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry);
    if ((await stat(target)).isDirectory()) files.push(...await filesBelow(target));
    else files.push(target);
  }
  return files;
}

const files = await filesBelow(output);
for (const required of ["index.html", "404.html", "favicon.svg"]) {
  if (!files.some((file) => path.relative(output, file) === required)) {
    throw new Error(`Documentation build is missing ${required}`);
  }
}

const bad = [];
for (const file of files.filter((candidate) => candidate.endsWith(".html"))) {
  const html = await readFile(file, "utf8");
  if (!html.includes(`\\\"base\\\":\\\"${base}\\\"`) && !html.includes(`"base":"${base}"`)) {
    bad.push(`${path.relative(output, file)}: embedded base does not match ${base}`);
  }
  for (const match of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
    const url = match[1];
    if (base !== "/" && !url.startsWith(base)) {
      bad.push(`${path.relative(output, file)}: ${url}`);
    }
  }
}

for (const relative of [
  "index.html",
  "guide/getting-started.html",
]) {
  const html = await readFile(path.join(output, relative), "utf8");
  if (!html.includes(`href="${demoUrl}"`)) {
    bad.push(`${relative}: direct demo link does not match ${demoUrl}`);
  }
}

if (bad.length) {
  throw new Error(`Documentation validation failed:\n${bad.slice(0, 20).join("\n")}`);
}

console.log(`Validated ${files.filter((file) => file.endsWith(".html")).length} documentation pages at ${base}.`);
