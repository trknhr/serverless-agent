import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      all: true,
      include: [
        "src/agentcore/contracts.ts",
        "src/aws/secretsProvider.ts",
        "src/calendar/googleCalendarClient.ts",
        "src/calendar/googleOAuth.ts",
        "src/calendar/userGoogleCalendar.ts",
        "src/chat/contracts.ts",
        "src/config/env.ts",
        "src/conversations/**/*.ts",
        "src/documents/contentBlocks.ts",
        "src/imports/contracts.ts",
        "src/repo/**/*.ts",
        "src/shared/**/*.ts",
        "src/slack/**/*.ts",
        "src/tasks/**/*.ts",
      ],
      exclude: [
        "src/repo/documentClient.ts",
        "src/**/*.d.ts",
        "src/**/types.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
