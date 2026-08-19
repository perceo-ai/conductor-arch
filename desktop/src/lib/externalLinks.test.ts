// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { externalHref, installExternalLinkHandler } from "./externalLinks";

describe("externalHref", () => {
  it("accepts http, https and mailto links", () => {
    expect(externalHref("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(externalHref("http://example.com")).toBe("http://example.com");
    expect(externalHref("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(externalHref("  https://example.com  ")).toBe("https://example.com");
  });

  it("ignores in-app and relative targets", () => {
    expect(externalHref("#section")).toBeNull();
    expect(externalHref("./notes.md")).toBeNull();
    expect(externalHref("/workspaces/foo")).toBeNull();
    expect(externalHref("")).toBeNull();
    expect(externalHref(null)).toBeNull();
  });

  it("ignores schemes the OS handler should never receive from agent output", () => {
    expect(externalHref("javascript:alert(1)")).toBeNull();
    expect(externalHref("file:///etc/passwd")).toBeNull();
    expect(externalHref("data:text/html,<script>x</script>")).toBeNull();
  });
});

function clickOn(el: Element, init: MouseEventInit = {}): MouseEvent {
  const evt = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(evt);
  return evt;
}

describe("installExternalLinkHandler", () => {
  it("opens external anchors in the OS browser instead of navigating the renderer", () => {
    const open = vi.fn();
    const dispose = installExternalLinkHandler(document, open);
    document.body.innerHTML = `<a id="link" href="https://example.com/docs">docs</a>`;

    const evt = clickOn(document.getElementById("link")!);

    expect(evt.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/docs");
    dispose();
  });

  it("resolves the anchor from a nested click target", () => {
    const open = vi.fn();
    const dispose = installExternalLinkHandler(document, open);
    document.body.innerHTML = `<a href="https://example.com"><code id="inner">x</code></a>`;

    clickOn(document.getElementById("inner")!);

    expect(open).toHaveBeenCalledWith("https://example.com");
    dispose();
  });

  it("leaves non-external anchors alone", () => {
    const open = vi.fn();
    const dispose = installExternalLinkHandler(document, open);
    document.body.innerHTML = `<a id="link" href="#section">section</a>`;

    const evt = clickOn(document.getElementById("link")!);

    expect(evt.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores clicks that are not a plain primary click", () => {
    const open = vi.fn();
    const dispose = installExternalLinkHandler(document, open);
    document.body.innerHTML = `<a id="link" href="https://example.com">x</a>`;

    clickOn(document.getElementById("link")!, { button: 1 });

    expect(open).not.toHaveBeenCalled();
    dispose();
  });

  it("stops intercepting once disposed", () => {
    const open = vi.fn();
    const dispose = installExternalLinkHandler(document, open);
    document.body.innerHTML = `<a id="link" href="https://example.com">x</a>`;
    dispose();

    const evt = clickOn(document.getElementById("link")!);

    expect(evt.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
