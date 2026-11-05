// Roles in the UI: what to show whom. The API enforces them (worker/auth.ts);
// this only hides or disables what a role can't do, so nobody hits a 403.

import type { Principal, Role, UserInfo } from "../../shared/types.ts";

// The signed-in human's role; null for a token (or before /api/state loads).
// A server from before roles sends only is_admin: not an admin meant everything but tokens and the schedule.
export function roleOf(me: Principal | null): Role | null {
  if (!me || me.kind !== "human") return null;
  return me.role ?? (me.is_admin === false ? "decider" : "admin");
}

// Decide, ask, reassign, Run tick now. Viewers only read.
export const canAct = (role: Role | null) => role !== "viewer";
// Tokens, the schedule and People.
export const isAdminRole = (role: Role | null) => role === null || role === "admin";

// "Admins …", "Deciders …", "Viewers …".
export const ROLE_HELP: Record<Role, string> = {
  admin: "Admins do everything, including agent tokens, the schedule and people.",
  decider: "Deciders read everything, decide, ask questions, request ticks and reassign.",
  viewer: "Viewers read everything and set up only their own notifications.",
};

// The API refuses to demote or remove the last saved admin (409 last_admin); the list disables those controls.
export function isLastAdmin(users: UserInfo[], email: string): boolean {
  const saved = users.filter((u) => u.role_set && u.role === "admin");
  return saved.length === 1 && saved[0].email === email;
}

const plural = (n: number, one: string) => n + " " + one + (n === 1 ? "" : "s");

// The small print under a People row. `has_row: false` is someone listed only
// because they turned on Web Push (anyone Access lets in can); Remove deletes those devices.
export function personNotes(u: UserInfo, lastAdmin: boolean): string[] {
  const devices = u.devices ? plural(u.devices, "Web Push device") : "";
  if (u.has_row === false) return ["not added here: only Web Push devices", devices].filter(Boolean);
  return [u.role_set ? "" : "default role: no role saved", devices, u.has_topic ? "ntfy topic set" : "", lastAdmin ? "the only admin: make someone else an admin first" : ""].filter(Boolean);
}

export function removePrompt(u: UserInfo): string {
  if (u.has_row === false) {
    return "Remove " + u.email + "'s " + plural(u.devices ?? 0, "Web Push device") + "? They stop getting pushes. If Access still lets them in, they can turn notifications on again.";
  }
  return "Remove " + u.email + "? Their role, name and ntfy topic are deleted, and their devices stop getting pushes. If Access still lets them in, they can only read.";
}

const ORDER: Record<Role, number> ={ admin: 0, decider: 1, viewer: 2 };
export function sortUsers(users: UserInfo[]): UserInfo[] {
  return users.slice().sort((a, b) => ORDER[a.role] - ORDER[b.role] || a.email.localeCompare(b.email));
}
