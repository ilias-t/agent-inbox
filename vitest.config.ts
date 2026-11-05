import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects: `worker` runs test/worker/** inside workerd with a fresh D1
// (migrations applied in test/worker/setup.ts); `node` runs the UI, shared
// and CLI unit tests in plain Node.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            // The committed test config, never a deployment's wrangler.jsonc.
            wrangler: { configPath: "./wrangler.test.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                // Humans in tests use http://localhost (DEV_NO_ACCESS); other
                // hosts exercise the real Access JWT path with a local key.
                DEV_NO_ACCESS: "1",
                DEV_USER_EMAIL: "you@test",
                ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.test",
                ACCESS_AUD: "test-aud",
                PUBLIC_URL: "https://inbox.test",
                GITHUB_WEBHOOK_SECRET: "gh-secret",
                NTFY_ACTION_SECRET: "ntfy-secret",
                // NTFY_TOPIC stays unset: publishing would fetch the network.
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["./test/worker/setup.ts"],
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/app/**/*.test.ts", "test/cli/**/*.test.ts", "test/shared/**/*.test.ts"],
        },
      },
    ],
  },
});
