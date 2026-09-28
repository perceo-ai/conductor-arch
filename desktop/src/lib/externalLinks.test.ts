// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { externalHref, installExternalLinkHandler, workspaceFilePath } from "./externalLinks";

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

describe("workspaceFilePath", () => {
  const root = "/Users/me/ws";

  it("keeps a workspace-relative link as-is", () => {
    expect(workspaceFilePath("src/main.ts", root)).toBe("src/main.ts");
    expect(workspaceFilePath("./src/main.ts", root)).toBe("src/main.ts");
  });

  it("relativizes absolute and file:// links inside the workspace", () => {
    expect(workspaceFilePath("/Users/me/ws/src/main.ts", root)).toBe("src/main.ts");
    expect(workspaceFilePath("file:///Users/me/ws/src/main.ts", root)).toBe("src/main.ts");
    expect(workspaceFilePath("/Users/me/ws/src/main.ts", "/Users/me/ws/")).toBe("src/main.ts");
  });

  it("drops line anchors and decodes escapes", () => {
    expect(workspaceFilePath("src/main.ts#L12", root)).toBe("src/main.ts");
    expect(workspaceFilePath("src/main.ts:12", root)).toBe("src/main.ts");
    expect(workspaceFilePath("src/main.ts:12:4", root)).toBe("src/main.ts");
    expect(workspaceFilePath("docs/my%20notes.md", root)).toBe("docs/my notes.md");
  });

  it("handles Windows roots", () => {
    expect(workspaceFilePath("C:\\code\\ws\\src\\a.ts", "C:\\code\\ws")).toBe("src/a.ts");
    expect(workspaceFilePath("file:///C:/code/ws/src/a.ts", "C:\\code\\ws")).toBe("src/a.ts");
  });

  it("refuses paths outside the workspace", () => {
    expect(workspaceFilePath("/etc/passwd", root)).toBeNull();
    expect(workspaceFilePath("/Users/me/ws-other/a.ts", root)).toBeNull();
    expect(workspaceFilePath("../outside.ts", root)).toBeNull();
    expect(workspaceFilePath("/Users/me/ws/src/main.ts", null)).toBeNull();
  });

  it("ignores fragments, web links and the workspace root itself", () => {
    expect(workspaceFilePath("#section", root)).toBeNull();
    expect(workspaceFilePath("https://example.com/a.ts", root)).toBeNull();
    expect(workspaceFilePath("/Users/me/ws", root)).toBeNull();
    expect(workspaceFilePath("", root)).toBeNull();
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

  it("routes local path links to the in-app opener instead of navigating", () => {
    const open = vi.fn();
    const openLocal = vi.fn();
    const dispose = installExternalLinkHandler(document, open, openLocal);
    document.body.innerHTML = `<a id="rel" href="src/main.ts">main</a><a id="abs" href="file:///Users/me/ws/a.ts">a</a>`;

    const rel = clickOn(document.getElementById("rel")!);
    const abs = clickOn(document.getElementById("abs")!);

    expect(rel.defaultPrevented).toBe(true);
    expect(abs.defaultPrevented).toBe(true);
    expect(openLocal).toHaveBeenNthCalledWith(1, "src/main.ts");
    expect(openLocal).toHaveBeenNthCalledWith(2, "file:///Users/me/ws/a.ts");
    expect(open).not.toHaveBeenCalled();
    dispose();
  });

  it("never lets a local link navigate the renderer, even with no opener", () => {
    const dispose = installExternalLinkHandler(document, vi.fn());
    document.body.innerHTML = `<a id="link" href="src/main.ts">main</a>`;

    expect(clickOn(document.getElementById("link")!).defaultPrevented).toBe(true);
    dispose();
  });

  it("refuses script-ish schemes without handing them to either opener", () => {
    const open = vi.fn();
    const openLocal = vi.fn();
    const dispose = installExternalLinkHandler(document, open, openLocal);
    document.body.innerHTML = `<a id="link" href="javascript:alert(1)">x</a>`;

    expect(clickOn(document.getElementById("link")!).defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(openLocal).not.toHaveBeenCalled();
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
