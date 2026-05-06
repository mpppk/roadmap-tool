import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    ...devices["Desktop Chrome"],
  },
});
