// Bindings and vars (wrangler.jsonc, .dev.vars, `wrangler secret put`).
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  PUBLIC_URL?: string;
  // .dev.vars only: browser requests on localhost act as DEV_USER_EMAIL.
  DEV_NO_ACCESS?: string;
  DEV_USER_EMAIL?: string;
  // Deprecated: roles live in the users table (worker/users.ts). Comma-separated
  // emails that are admins while they have no saved role; set, humans without
  // one are deciders until an admin is saved.
  ADMIN_EMAILS?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  NTFY_TOPIC?: string;
  NTFY_SERVER?: string;
  NTFY_TOKEN?: string;
  NTFY_ACTION_SECRET?: string;
  // Web Push VAPID keys (base64url raw P-256 public point and private scalar).
  // Both or neither; unset, the Worker generates a pair on first use and keeps
  // it in D1 (vapid_keys). VAPID_SUBJECT is a mailto: or https: contact for
  // the push services, default PUBLIC_URL.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  // Extra Web Push service hosts to accept subscriptions on, comma-separated;
  // each also allows its subdomains. The browsers' own are built in
  // (worker/routes/push.ts, PUSH_HOSTS).
  PUSH_ENDPOINT_HOSTS?: string;
  // Days of change log to keep (default 30, min 7); see worker/prune.ts.
  CHANGES_RETENTION_DAYS?: string;
  // Days of review runs and events to keep (default 90, min 14); see worker/prune.ts.
  REVIEWS_RETENTION_DAYS?: string;
}
