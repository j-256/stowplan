import { describe, expect, it } from "vitest";
import { suggestLocationCode } from "../src/domain";

describe("location code suggestions", () => {
    it("builds short editable codes from familiar names", () => {
        expect(suggestLocationCode("Kitchen", "room", [])).toBe("KIT");
        expect(suggestLocationCode("Hall closet", "cabinet", [])).toBe("HC");
        expect(suggestLocationCode("Shelf 1 - daily food", "shelf", [])).toBe("S1DF");
    });

    it("normalizes punctuation and creates a case-insensitive unique suffix", () => {
        expect(
            suggestLocationCode(
                "Prep-side upper cabinet",
                "cabinet",
                ["psuc", "PSUC-2"],
            ),
        ).toBe("PSUC-3");
        expect(suggestLocationCode("Caf\u00e9 supplies", "cabinet", [])).toBe("CS");
    });

    it("falls back to the location type when the name has no usable characters", () => {
        expect(suggestLocationCode("---", "drawer", [])).toBe("DRA");
    });
});
