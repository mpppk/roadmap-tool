import { existsSync } from "node:fs";
import { defineConfig, devices } from "playwright/test";

const linuxChromiumPath = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const chromiumExecutable =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync(linuxChromiumPath) ? linuxChromiumPath : undefined);

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    ...devices["Desktop Chrome"],
    channel: undefined,
    ...(chromiumExecutable
      ? { launchOptions: { executablePath: chromiumExecutable } }
      : {}),
  },
});
