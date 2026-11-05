// Where the CLI points and with which token.
// Precedence: --url/--token flags > AGENT_INBOX_URL/AGENT_INBOX_TOKEN > config file.
// Config file: $AGENT_INBOX_CONFIG, else $XDG_CONFIG_HOME/agent-inbox/config.json,
// else ~/.config/agent-inbox/config.json, holding {"url": "...", "token": "..."}.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "http://localhost:8787/agent";

export function configPath(env, home = homedir()) {
  if (env.AGENT_INBOX_CONFIG) return env.AGENT_INBOX_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, "agent-inbox", "config.json");
}

function readConfigFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`can't read ${path}: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

// → {url, token, configFile}. `url` is the base including the /agent prefix
// for the deployed app; requests go to `${url}/api/...`. An AGENT_INBOX_TOKEN
// that is set but empty means no token (the local dev human on /api), not
// "use the config file's token".
export function resolveConfig(flags, env, home) {
  const file = configPath(env, home);
  const envToken = env.AGENT_INBOX_TOKEN;
  const needFile = !(flags.url ?? env.AGENT_INBOX_URL) || !(flags.token || envToken !== undefined);
  const fromFile = needFile ? readConfigFile(file) : {};
  const url = flags.url || env.AGENT_INBOX_URL || fromFile.url || DEFAULT_URL;
  const token = flags.token || (envToken !== undefined ? envToken : fromFile.token) || undefined;
  return { url: url.replace(/\/+$/, ""), token, configFile: file };
}
