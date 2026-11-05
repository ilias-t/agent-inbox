-- Web Push (worker/hooks/webpush.ts). Additive: nothing reads these tables
-- until someone enables notifications on a device in Settings.

-- One row per browser/device that turned notifications on. `endpoint` is the
-- push service URL the browser handed out (a capability: whoever holds it can
-- push to that device, so it never leaves the Worker); p256dh and auth are the
-- device's keys for RFC 8291 encryption. A push service 404/410 deletes the
-- row; any other failure bumps fail_count, and a success resets it.
CREATE TABLE push_subscriptions (
  id          INTEGER PRIMARY KEY,
  email       TEXT    NOT NULL,              -- lowercased, like item assignees and meta/people keys
  endpoint    TEXT    NOT NULL UNIQUE,
  p256dh      TEXT    NOT NULL,              -- base64url
  auth        TEXT    NOT NULL,              -- base64url
  created_at  TEXT    NOT NULL,
  last_ok_at  TEXT,
  fail_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_email ON push_subscriptions (email);

-- The VAPID key pair generated on first use when the VAPID_PUBLIC_KEY /
-- VAPID_PRIVATE_KEY secrets aren't set. One row, never exposed by any API
-- (GET /api/push/key returns only the public half). base64url, like the secrets.
CREATE TABLE vapid_keys (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  public_key   TEXT NOT NULL,
  private_key  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
