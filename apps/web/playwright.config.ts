import { defineConfig } from "@playwright/test";

/**
 * Real-browser coverage for the input provenance model (§7.5).
 *
 * jsdom cannot test the signal that matters most here: `isTrusted`. Every
 * event it dispatches is synthetic, so "genuine typing is trusted" is
 * unverifiable there by construction — and that distinction is exactly what
 * separates an author writing from a script driving the page.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    headless: true,
    /**
     * Use the Chromium already on the machine rather than downloading a
     * pinned build. Keeps CI from fetching ~150MB per run for four tests.
     */
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  reporter: [["list"]],
});
