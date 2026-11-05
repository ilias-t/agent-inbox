// Every push an item write triggers, on every channel: ntfy topics
// (hooks/ntfy.ts) and Web Push devices (hooks/webpush.ts). Each channel routes
// the same way and runs in its own waitUntil, so one failing never stops the
// other or the request.

import type { Doc, Item, QaMessage } from "../shared/types.ts";
import { notifyAnswer as ntfyAnswer, notifyItemCreated as ntfyCreated, notifyReassigned as ntfyReassigned } from "./hooks/ntfy.ts";
import { webPushAnswer, webPushItemCreated, webPushReassigned } from "./hooks/webpush.ts";
import type { Ctx } from "./router.ts";

export function notifyItemCreated(c: Ctx, doc: Doc<Item>): void {
  ntfyCreated(c, doc);
  webPushItemCreated(c, doc);
}

export function notifyReassigned(c: Ctx, doc: Doc<Item>, prevAssignee: string | undefined): void {
  ntfyReassigned(c, doc, prevAssignee);
  webPushReassigned(c, doc, prevAssignee);
}

export function notifyAnswer(c: Ctx, item: Doc<Item>, msg: Doc<QaMessage>): void {
  ntfyAnswer(c, item, msg);
  webPushAnswer(c, item, msg);
}
