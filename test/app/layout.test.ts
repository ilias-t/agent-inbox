import { describe, expect, it } from "vitest";
import { DESK_MIN, DESK_QUERY, MID_MIN, MID_QUERY, isSplit, layoutFor, layoutOf } from "../../src/lib/layout.ts";

describe("layoutFor: the layout for a viewport width", () => {
  it("is phone below 700px", () => {
    expect(layoutFor(0)).toBe("phone");
    expect(layoutFor(390)).toBe("phone");
    expect(layoutFor(699)).toBe("phone");
    expect(layoutFor(699.98)).toBe("phone");
  });
  it("is mid from 700px up to 1099px", () => {
    expect(layoutFor(MID_MIN)).toBe("mid");
    expect(layoutFor(700)).toBe("mid");
    expect(layoutFor(1024)).toBe("mid");
    expect(layoutFor(1099)).toBe("mid");
    expect(layoutFor(1099.98)).toBe("mid");
  });
  it("is desk from 1100px", () => {
    expect(layoutFor(DESK_MIN)).toBe("desk");
    expect(layoutFor(1100)).toBe("desk");
    expect(layoutFor(1280)).toBe("desk");
  });
});

describe("layoutOf: the layout two media queries describe", () => {
  it("agrees with layoutFor at the edges", () => {
    for (const w of [390, 699, 700, 1099, 1100, 1280]) expect(layoutOf(w >= MID_MIN, w >= DESK_MIN)).toBe(layoutFor(w));
  });
  it("watches the CSS edges", () => {
    expect(MID_QUERY).toBe("(min-width: 700px)");
    expect(DESK_QUERY).toBe("(min-width: 1100px)");
  });
});

describe("isSplit", () => {
  it("is false on a phone only", () => {
    expect(isSplit("phone")).toBe(false);
    expect(isSplit("mid")).toBe(true);
    expect(isSplit("desk")).toBe(true);
  });
});
