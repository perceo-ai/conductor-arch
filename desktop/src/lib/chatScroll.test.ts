// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isNearScrollBottom, scrollBottomTop } from "./chatScroll";

describe("chat scroll anchoring", () => {
  it("treats positions within the bottom threshold as sticky", () => {
    expect(
      isNearScrollBottom({
        scrollTop: 530,
        clientHeight: 400,
        scrollHeight: 1000,
      }),
    ).toBe(true);
  });

  it("does not stick when the user has scrolled away from the bottom", () => {
    expect(
      isNearScrollBottom({
        scrollTop: 480,
        clientHeight: 400,
        scrollHeight: 1000,
      }),
    ).toBe(false);
  });

  it("clamps the bottom scroll target when content is shorter than the viewport", () => {
    expect(
      scrollBottomTop({
        scrollTop: 0,
        clientHeight: 700,
        scrollHeight: 320,
      }),
    ).toBe(0);
  });
});
