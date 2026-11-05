// docs/api.md decide: a routine's ask (an item with review_pr) also takes "github", Done on GitHub: its human handled
// it there themselves. Other items don't.
import { describe, expect, it } from "vitest";
import { createItem, human, uid } from "./helpers.ts";

describe("decide github", () => {
  it("is accepted on an item with review_pr and recorded as the choice", async () => {
    const id = uid("gh");
    await createItem(id, { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], review_pr: { routine: "review-bot", number: 4736 } } as never);
    const r = await human.post(`/api/items/${id}/decide`, { choice: "github" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: "decided", decision: { choice: "github" } });
  });

  it("is refused on any other item", async () => {
    const id = uid("gh");
    await createItem(id, { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    const r = await human.post(`/api/items/${id}/decide`, { choice: "github" });
    expect(r.status).toBe(400);
  });
});
