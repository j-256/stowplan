import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        coverage: {
            include: ["src/domain/**/*.ts", "src/server/**/*.ts", "src/adapters/**/*.ts"],
            reporter: ["text", "html", "lcov"],
            thresholds: {
                branches: 55,
                functions: 75,
                lines: 70,
                statements: 60,
            },
        },
        environment: "node",
        include: ["test/**/*.test.ts"],
        reporters: ["default"],
    },
});
