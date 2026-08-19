// @vitest-environment node
import { describe, expect, it } from "vitest";
import { externalNavigationUrl, isExternalOpenTarget } from "./externalNavigation";

describe("isExternalOpenTarget", () => {
  it("accepts the schemes the OS browser/mail client should handle", () => {
    expect(isExternalOpenTarget("https://example.com")).toBe(true);
    expect(isExternalOpenTarget("http://example.com")).toBe(true);
    expect(isExternalOpenTarget("mailto:a@example.com")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isExternalOpenTarget("file:///etc/passwd")).toBe(false);
    expect(isExternalOpenTarget("javascript:alert(1)")).toBe(false);
    expect(isExternalOpenTarget("about:blank")).toBe(false);
    expect(isExternalOpenTarget("/Users/me/repo")).toBe(false);
    expect(isExternalOpenTarget("")).toBe(false);
  });
});

describe("externalNavigationUrl", () => {
  it("flags web navigations away from the app as external", () => {
    expect(externalNavigationUrl("https://example.com/x", null)).toBe("https://example.com/x");
    expect(externalNavigationUrl("mailto:a@example.com", null)).toBe("mailto:a@example.com");
  });

  it("treats the packaged app's own file:// document as internal", () => {
    expect(externalNavigationUrl("file:///Applications/App.app/dist/index.html", null)).toBeNull();
  });

  it("treats dev-server navigations as internal", () => {
    expect(externalNavigationUrl("http://localhost:5173/", "http://localhost:5173")).toBeNull();
    expect(externalNavigationUrl("http://localhost:5173/index.html", "http://localhost:5173/")).toBeNull();
    expect(externalNavigationUrl("http://localhost:9999/", "http://localhost:5173")).toBe("http://localhost:9999/");
  });

  it("returns null for schemes we refuse to hand to the OS", () => {
    expect(externalNavigationUrl("javascript:alert(1)", null)).toBeNull();
    expect(externalNavigationUrl("about:blank", null)).toBeNull();
  });
});
