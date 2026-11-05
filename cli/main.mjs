// agent-inbox CLI entry point. main() never calls process.exit; it returns the
// exit code so tests can drive it with injected io.
// Exit codes: 0 ok · 1 error · 2 usage · 3 conflict (any 409) · 4 wait timed out ·
// 5 schedule --check off hours.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { UsageError } from "./args.mjs";
import { COMMANDS, GROUP_DEFAULTS } from "./commands.mjs";
import { resolveConfig } from "./config.mjs";
import { ApiError, NetworkError, createClient } from "./http.mjs";

export const EXIT = { ok: 0, error: 1, usage: 2, conflict: 3 };

const GLOBAL_OPTIONS = {
  url: { type: "string" },
  token: { type: "string" },
  // The lease session: sent as X-Lease-Session on writes, and the lease commands' session_id.
  session: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const VALUED_GLOBALS = new Set(["--url", "--token", "--session"]);
const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
const GROUPS = new Set(COMMANDS.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]));

function globalHelp() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    "agent-inbox: the orchestrator/manager CLI for the agent inbox (docs/api.md).",
    "",
    "Usage: agent-inbox <command> [args] [--json] [--url URL] [--token TOKEN] [--session ID]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Config: --url/--token > AGENT_INBOX_URL/AGENT_INBOX_TOKEN > ~/.config/agent-inbox/config.json {url, token}.",
    "URL is the base including /agent (default http://localhost:8787/agent).",
    "--session/AGENT_INBOX_SESSION: your lease session; writes then carry it (X-Lease-Session) and get",
    "exit 3 lease_held once that session no longer holds the lease.",
    "--json prints the raw API response. Exit: 0 ok, 1 error, 2 usage, 3 conflict (409; details on stderr),",
    "4 wait timed out, 5 schedule --check off hours.",
    "`agent-inbox <command> --help` shows a command's flags.",
  ].join("\n");
}

const commandHelp = (cmd) => `Usage: agent-inbox ${cmd.usage}\n\n${cmd.summary}.`;

// Finds the command words in argv (skipping leading global flags) and returns
// {cmd, rest} with those words removed.
function splitCommand(argv) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) i += VALUED_GLOBALS.has(argv[i]) ? 2 : 1;
  const word = argv[i];
  if (word === undefined || word === "help") {
    const target = word === "help" ? argv.slice(i + 1).join(" ") : "";
    return { help: true, target, rest: [] };
  }
  const rest = [...argv.slice(0, i), ...argv.slice(i + 1)];
  if (GROUPS.has(word)) {
    const sub = argv[i + 1];
    if (sub !== undefined && BY_NAME.has(`${word} ${sub}`)) {
      rest.splice(i, 1);
      return { cmd: BY_NAME.get(`${word} ${sub}`), rest };
    }
    if (GROUP_DEFAULTS[word]) return { cmd: BY_NAME.get(`${word} ${GROUP_DEFAULTS[word]}`), rest };
    const subs = COMMANDS.filter((c) => c.name.startsWith(`${word} `)).map((c) => c.name.split(" ")[1]);
    throw new UsageError(`${word} needs a subcommand: ${subs.join(", ")}`);
  }
  const cmd = BY_NAME.get(word);
  if (!cmd) throw new UsageError(`unknown command "${word}" (try agent-inbox help)`);
  return { cmd, rest };
}

// parseArgs rejects text that starts with "-" ("- bullet" markdown, "-3 items")
// as a positional or an option value. Anything starting with "-" that isn't
// shaped like a flag is swapped for a placeholder and restored after parsing.
const FLAG_SHAPE = /^(-[A-Za-z]|--[A-Za-z][\w-]*(=[\s\S]*)?)$/;
function parseWithDashText(args, options) {
  const held = [];
  const masked = args.map((a) => {
    if (a === "-" || a === "--" || !a.startsWith("-") || FLAG_SHAPE.test(a)) return a;
    held.push(a);
    return `\u0000${held.length - 1}`;
  });
  const restore = (v) => (typeof v === "string" && v.startsWith("\u0000") ? held[Number(v.slice(1))] : v);
  const { values, positionals } = parseArgs({ args: masked, options, allowPositionals: true, strict: true });
  for (const [k, v] of Object.entries(values)) values[k] = Array.isArray(v) ? v.map(restore) : restore(v);
  return { values, positionals: positionals.map(restore) };
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const readStdin = io.readStdin ?? readAllStdin;
  let cmd;
  let json = false;
  try {
    const split = splitCommand(argv);
    if (split.help) {
      const target = BY_NAME.get(split.target);
      const group = GROUPS.has(split.target) ? COMMANDS.filter((c) => c.name.startsWith(`${split.target} `)) : [];
      stdout((target ? commandHelp(target) : group.length ? group.map(commandHelp).join("\n\n") : globalHelp()) + "\n");
      return EXIT.ok;
    }
    cmd = split.cmd;
    const { values, positionals } = parseWithDashText(split.rest, { ...GLOBAL_OPTIONS, ...cmd.options });
    if (values.help) {
      stdout(commandHelp(cmd) + "\n");
      return EXIT.ok;
    }
    json = !!values.json;
    const expected = cmd.args ?? [];
    let args = positionals;
    // A trailing <text> takes the rest of the words, so quoting is optional.
    if (expected.at(-1) === "text" && args.length > expected.length) {
      args = [...args.slice(0, expected.length - 1), args.slice(expected.length - 1).join(" ")];
    }
    if (args.length > expected.length) throw new UsageError(`unexpected argument "${args[expected.length]}"`);

    const config = resolveConfig({ url: values.url, token: values.token }, env, io.home);
    if (!config.token && config.url.endsWith("/agent")) {
      throw new UsageError(`no token: set AGENT_INBOX_TOKEN, pass --token, or add "token" to ${config.configFile}`);
    }
    // Only an explicit --session or AGENT_INBOX_SESSION opts writes into the
    // lease check; never CLAUDE_SESSION_ID, which every Claude Code session
    // (orchestrators too) has and which needn't be the lease's session id.
    // Present but empty (`--session "$S"` with S unset) is a mistake: sending
    // nothing would let the write through unchecked.
    if (values.session !== undefined && !values.session.trim()) {
      throw new UsageError("--session is empty: pass your lease session id, or drop the flag");
    }
    if (values.session === undefined && env.AGENT_INBOX_SESSION !== undefined && !env.AGENT_INBOX_SESSION.trim()) {
      throw new UsageError("AGENT_INBOX_SESSION is set but empty: set it to your lease session id, or unset it");
    }
    const session = values.session ?? env.AGENT_INBOX_SESSION;
    const api = createClient({ url: config.url, token: config.token, session, fetch: io.fetch });
    const ctx = {
      values,
      args,
      env,
      home: io.home,
      json,
      api,
      now,
      sleep,
      log: (s) => stderr(s + "\n"),
      out: (s) => stdout(s + "\n"),
      print(data, text) {
        stdout((json || !text ? JSON.stringify(data, null, 2) : text(data)) + "\n");
      },
      async readText(arg, what) {
        if (arg === undefined) throw new UsageError(`missing <${what}>`);
        const text = arg === "-" ? await readStdin() : arg;
        if (!text.trim()) throw new UsageError(`<${what}> is empty`);
        return arg === "-" ? text.replace(/\n$/, "") : text;
      },
      async readJson(path) {
        const text = path === "-" ? await readStdin() : readFileSync(path, "utf8");
        try {
          return JSON.parse(text);
        } catch {
          throw new UsageError(`${path === "-" ? "stdin" : path} is not valid JSON`);
        }
      },
    };
    const code = await cmd.run(ctx);
    return typeof code === "number" ? code : EXIT.ok;
  } catch (err) {
    return reportError(err, { cmd, json, stderr });
  }
}

function reportError(err, { cmd, stderr }) {
  if (err instanceof UsageError || err?.code?.startsWith?.("ERR_PARSE_ARGS")) {
    stderr(`agent-inbox: ${err.message}\n${cmd ? `Usage: agent-inbox ${cmd.usage}\n` : ""}`);
    return EXIT.usage;
  }
  if (err instanceof ApiError) {
    const body = err.body ?? {};
    if (err.status === 409) {
      const out = { error: body.error ?? "conflict", message: body.message ?? "" };
      if (body.index !== undefined) out.index = body.index; // which op of a batch
      out.current = body.current ?? null;
      stderr(JSON.stringify(out, null, 2) + "\n");
      return EXIT.conflict;
    }
    let hint = "";
    if (err.status === 401) hint = " (check the token: AGENT_INBOX_TOKEN, --token or the config file)";
    if (err.status === 403) hint = " (this token's scope doesn't allow it)";
    const op = body.index !== undefined ? ` [batch op ${body.index}]` : "";
    stderr(`agent-inbox: ${err.message}${op}${hint}\n`);
    return EXIT.error;
  }
  if (err instanceof NetworkError) {
    stderr(`agent-inbox: can't reach the inbox: ${err.message}\n`);
    return EXIT.error;
  }
  stderr(`agent-inbox: ${err?.message ?? err}\n`);
  return EXIT.error;
}
