// A tiny method + path router for the /api routes. Patterns use `:name`
// segments; every captured segment is URL-decoded and checked as an id (an
// `:email` segment as an email, lowercased).

import type { Caller } from "./auth.ts";
import type { Env } from "./env.ts";
import { checkEmail, checkId, readJson } from "./http.ts";

export interface Ctx {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  caller: Caller;
  params: Record<string, string>;
  now: string; // one timestamp per request, used for every write it makes
  body(): Promise<Record<string, unknown>>;
}

export type Handler = (c: Ctx) => Promise<Response>;
export type Route = [method: string, pattern: string, handler: Handler];

interface Compiled {
  method: string;
  re: RegExp;
  names: string[];
  handler: Handler;
}

export class Router {
  private compiled: Compiled[] = [];

  constructor(routes: Route[]) {
    for (const [method, pattern, handler] of routes) {
      const names: string[] = [];
      const src = pattern.replace(/:(\w+)/g, (_, name: string) => {
        names.push(name);
        return "([^/]+)";
      });
      this.compiled.push({ method, re: new RegExp(`^${src}$`), names, handler });
    }
  }

  // The handler and params for a path, or "method" when only the method is wrong.
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const r of this.compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.names.forEach((name, i) => {
        const v = safeDecode(m[i + 1]);
        params[name] = name === "email" ? checkEmail(v, "email") : checkId(v);
      });
      return { handler: r.handler, params };
    }
    return pathMatched ? "method" : null;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // checkId rejects the leftover "%"
  }
}

export function makeCtx(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  caller: Caller,
  params: Record<string, string>,
): Ctx {
  let body: Promise<Record<string, unknown>> | undefined;
  return {
    request,
    env,
    ctx,
    url,
    caller,
    params,
    now: new Date().toISOString(),
    body: () => (body ??= readJson(request)),
  };
}
