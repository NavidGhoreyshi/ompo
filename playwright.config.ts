import { defineConfig, devices } from "@playwright/test";

// The webServer readiness probe must reach loopback directly; a proxy in the
// environment turns it into a 502 and the server never looks ready.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4319",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun tests/e2e/serve.ts --port 4319",
    url: "http://127.0.0.1:4319/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
