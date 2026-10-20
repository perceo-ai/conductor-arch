import { describe, expect, it } from "vitest";
import { doNotDisturbActive, gnomeShowBannersMeansDnd } from "./doNotDisturb";

describe("do-not-disturb", () => {
  it("reads GNOME's show-banners=false as do-not-disturb", () => {
    expect(gnomeShowBannersMeansDnd("false\n")).toBe(true);
    expect(gnomeShowBannersMeansDnd("true\n")).toBe(false);
    expect(gnomeShowBannersMeansDnd("")).toBe(false);
  });

  it("reports false on platforms without a public do-not-disturb API", async () => {
    expect(await doNotDisturbActive("darwin")).toBe(false);
    expect(await doNotDisturbActive("win32")).toBe(false);
  });
});
