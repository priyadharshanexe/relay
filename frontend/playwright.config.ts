import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive a real browser against the whole stack. Start it first:
 *
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build --wait
 *
 * The e2e override shortens the retry schedule, so a failing delivery reaches
 * the dead-letter queue in seconds.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.RELAY_DASHBOARD_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
