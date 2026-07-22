import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        coverage: {
            include: ["src/domain/**/*.ts", "src/server/**/*.ts", "src/adapters/**/*.ts"],
            reporter: ["text", "html", "lcov"],
        },
        environment: "node",
        include: ["tests/**/*.test.ts"],
        reporters: ["default"],
    },
});
