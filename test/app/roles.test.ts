import { describe, expect, it } from "vitest";
import type { Principal, UserInfo } from "../../shared/types.ts";
import { canAct, isAdminRole, isLastAdmin, personNotes, removePrompt, roleOf, sortUsers } from "../../src/lib/roles.ts";

const human = (role?: string, is_admin?: boolean) => ({ kind: "human", email: "a@b", role, is_admin }) as unknown as Principal;

describe("roleOf", () => {
  it("is the human's role; null for tokens and before sign-in", () => {
    expect(roleOf(human("viewer", false))).toBe("viewer");
    expect(roleOf(human("decider", false))).toBe("decider");
    expect(roleOf({ kind: "token", name: "m", scope: "manager" })).toBeNull();
    expect(roleOf(null)).toBeNull();
  });
  it("falls back to is_admin from a server before roles", () => {
    expect(roleOf(human(undefined, true))).toBe("admin");
    expect(roleOf(human(undefined, false))).toBe("decider");
  });
});

describe("what a role may do in the UI", () => {
  it("viewers can't act; deciders, admins and tokens can (the API has the last word)", () => {
    expect(canAct("viewer")).toBe(false);
    expect(canAct("decider")).toBe(true);
    expect(canAct("admin")).toBe(true);
    expect(canAct(null)).toBe(true);
  });
  it("admin controls show for admins (and tokens, which the API answers for)", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole(null)).toBe(true);
    expect(isAdminRole("decider")).toBe(false);
    expect(isAdminRole("viewer")).toBe(false);
  });
});

describe("the People list", () => {
  const u = (email: string, role: UserInfo["role"], role_set = true): UserInfo => ({ email, role, role_set });
  it("the only saved admin is the last admin; a default admin doesn't count", () => {
    const list = [u("a@x", "admin"), u("b@x", "decider"), u("c@x", "admin", false)];
    expect(isLastAdmin(list, "a@x")).toBe(true);
    expect(isLastAdmin(list, "b@x")).toBe(false);
    expect(isLastAdmin(list, "c@x")).toBe(false);
    expect(isLastAdmin([...list, u("d@x", "admin")], "a@x")).toBe(false);
  });
  it("sorts admins first, then deciders, then viewers, each by email", () => {
    const list = [u("z@x", "viewer"), u("b@x", "decider"), u("y@x", "admin"), u("a@x", "decider")];
    expect(sortUsers(list).map((x) => x.email)).toEqual(["y@x", "a@x", "b@x", "z@x"]);
  });
});

describe("a People row's notes and Remove prompt", () => {
  const saved: UserInfo = { email: "a@x", role: "decider", role_set: true, has_row: true, devices: 0, has_topic: false };
  const ghost: UserInfo = { email: "g@x", role: "viewer", role_set: false, has_row: false, devices: 2, has_topic: false };

  it("someone with only Web Push devices (no row) says so, with how many", () => {
    expect(personNotes(ghost, false)).toEqual(["not added here: only Web Push devices", "2 Web Push devices"]);
  });
  it("a saved person lists a default role, their devices, topic and the last-admin lock", () => {
    expect(personNotes(saved, false)).toEqual([]);
    expect(personNotes({ ...saved, devices: 1, has_topic: true }, false)).toEqual(["1 Web Push device", "ntfy topic set"]);
    expect(personNotes({ ...saved, role: "admin", role_set: false }, false)).toEqual(["default role: no role saved"]);
    expect(personNotes({ ...saved, role: "admin" }, true)).toEqual(["the only admin: make someone else an admin first"]);
  });
  it("removing someone with only devices says only their devices go", () => {
    expect(removePrompt(ghost)).toBe(
      "Remove g@x's 2 Web Push devices? They stop getting pushes. If Access still lets them in, they can turn notifications on again.",
    );
    expect(removePrompt(saved)).toBe(
      "Remove a@x? Their role, name and ntfy topic are deleted, and their devices stop getting pushes. If Access still lets them in, they can only read.",
    );
  });
});
