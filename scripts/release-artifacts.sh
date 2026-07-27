#!/bin/bash
# Produces the artifacts attached to a GitHub release.
#
# The SBOM lists production dependencies only, so it describes what actually
# ships rather than the build and test toolchain. The release step uploads this
# exact path, so keep the name in sync with the workflow.
set -euo pipefail

SBOM_PATH="stowplan-sbom.cdx.json"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"

echo "::group::cyclonedx sbom"
npm sbom --omit=dev --sbom-format cyclonedx > "${SBOM_PATH}"
# npm exits 0 while writing a diagnostic instead of a document when a dependency
# tree is unresolved, which would attach an unusable artifact to the release
node --input-type=module - "${SBOM_PATH}" <<'NODE'
import { readFile } from "node:fs/promises";

const path = process.argv[2];
const document = JSON.parse(await readFile(path, "utf8"));
if (document.bomFormat !== "CycloneDX") {
  throw new Error(`${path} is not a CycloneDX document`);
}
if (!Array.isArray(document.components) || document.components.length === 0) {
  throw new Error(`${path} contains no components`);
}
console.log(
  `[release-artifacts] ${path}: ${document.components.length} components`,
);
NODE
echo "::endgroup::"

echo "[release-artifacts] all artifacts written"
