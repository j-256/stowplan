import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea"]);
const SOURCE_DIRECTORIES = ["app", "src"];
const SOURCE_EXTENSION = ".tsx";
const IDENTITY_ATTRIBUTES = new Set(["id", "name"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(SOURCE_EXTENSION) ? [path] : [];
  });
}

describe("browser form controls", () => {
  it("gives every rendered control a stable browser identity", () => {
    const unidentified: string[] = [];
    const files = SOURCE_DIRECTORIES.flatMap(sourceFiles);

    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node): void => {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          FORM_CONTROL_TAGS.has(node.tagName.getText(source))
        ) {
          const identified = node.attributes.properties.some((property) =>
            ts.isJsxAttribute(property) &&
            IDENTITY_ATTRIBUTES.has(property.name.getText(source))
          );
          if (!identified) {
            const position = source.getLineAndCharacterOfPosition(
              node.getStart(source),
            );
            unidentified.push(
              `${relative(process.cwd(), file)}:${position.line + 1}:${position.character + 1}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(unidentified).toEqual([]);
  });
});
