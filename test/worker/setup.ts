import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Each test file starts from an empty, fully migrated D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
