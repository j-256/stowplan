import type { LocationKind } from "./types";

const MAX_INITIAL_CODE_LENGTH = 6;
const SINGLE_WORD_CODE_LENGTH = 3;

function codeTokens(value: string): string[] {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .match(/[A-Z0-9]+/g) ?? [];
}

function baseLocationCode(name: string, kind: LocationKind): string {
    const nameTokens = codeTokens(name);
    if (nameTokens.length === 1) {
        return (nameTokens[0] as string).slice(0, SINGLE_WORD_CODE_LENGTH);
    }
    if (nameTokens.length > 1) {
        return nameTokens
            .map((token) => token.slice(0, 1))
            .join("")
            .slice(0, MAX_INITIAL_CODE_LENGTH);
    }
    return codeTokens(kind).join("").slice(0, SINGLE_WORD_CODE_LENGTH) || "LOC";
}

export function suggestLocationCode(
    name: string,
    kind: LocationKind,
    existingCodes: readonly string[],
): string {
    const base = baseLocationCode(name, kind);
    const used = new Set(
        existingCodes.map((code) => code.trim().toLocaleUpperCase()),
    );
    if (!used.has(base)) return base;

    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
}
