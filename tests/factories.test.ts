import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../src/domain/factories";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("identifier generation", () => {
    it("creates a UUID when crypto.randomUUID is unavailable", () => {
        vi.stubGlobal("crypto", {
            getRandomValues(bytes: Uint8Array) {
                bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
                return bytes;
            },
        });

        expect(newId("item")).toBe("item_00010203-0405-4607-8809-0a0b0c0d0e0f");
    });
});
