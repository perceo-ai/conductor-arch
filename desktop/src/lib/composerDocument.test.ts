// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type ComposerNode, fromVisible, nodeText, normalize, toInput, toVisible } from "./composerDocument";

const FILE: ComposerNode = { kind: "file", path: "src/lib/markdown.ts", label: "markdown.ts" };
const CMD: ComposerNode = { kind: "command", name: "review" };

describe("toVisible", () => {
  it("writes a file node as its brace marker", () => {
    expect(toVisible([{ kind: "text", text: "read " }, FILE])).toBe("read {markdown.ts}");
  });

  it("writes a command node as a slash name", () => {
    expect(toVisible([CMD, { kind: "text", text: " please" }])).toBe("/review please");
  });
});

describe("toInput", () => {
  it("expands a file node to its full path so the agent can open it", () => {
    expect(toInput([{ kind: "text", text: "read " }, FILE])).toBe("read @src/lib/markdown.ts");
  });

  it("leaves a command node as the agent CLI's own slash command", () => {
    expect(toInput([CMD])).toBe("/review");
  });
});

describe("fromVisible", () => {
  it("round-trips a document through its visible form", () => {
    const nodes: ComposerNode[] = [{ kind: "text", text: "see " }, FILE, { kind: "text", text: " now" }];
    expect(toVisible(fromVisible(toVisible(nodes)))).toBe(toVisible(nodes));
  });

  it("leaves braces that are not file markers as plain text", () => {
    expect(fromVisible("use {} and {not a file}")).toEqual([
      { kind: "text", text: "use {} and {not a file}" },
    ]);
  });

  it("recovers a file node without its original path", () => {
    expect(fromVisible("{markdown.ts}")).toEqual([
      { kind: "file", path: "markdown.ts", label: "markdown.ts" },
    ]);
  });

  it("returns nothing for an empty document rather than an empty text node", () => {
    expect(fromVisible("")).toEqual([]);
  });
});

describe("nodeText", () => {
  it("measures a chip by the visible token it stands for", () => {
    expect(nodeText(FILE)).toBe("{markdown.ts}");
    expect(nodeText(CMD)).toBe("/review");
  });
});

describe("normalize", () => {
  it("merges adjacent text so a document has one spelling", () => {
    expect(normalize([{ kind: "text", text: "a" }, { kind: "text", text: "b" }])).toEqual([
      { kind: "text", text: "ab" },
    ]);
  });

  it("drops empty text nodes left behind by editing", () => {
    expect(normalize([{ kind: "text", text: "" }, CMD, { kind: "text", text: "" }])).toEqual([CMD]);
  });
});
