// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatTomlValue, readTomlValue, tomlSectionBounds, writeTomlValue } from "./toml";

describe("tomlSectionBounds", () => {
  it("ends a section at the next header, not at the end of the file", () => {
    const lines = ["[a]", "x = 1", "[b]", "y = 2"];
    expect(tomlSectionBounds(lines, "a")).toEqual([0, 2]);
    expect(tomlSectionBounds(lines, "b")).toEqual([2, 4]);
  });

  it("returns null for a section that is not present", () => {
    expect(tomlSectionBounds(["[a]"], "missing")).toBeNull();
  });
});

describe("readTomlValue", () => {
  it("unquotes string values", () => {
    expect(readTomlValue('[net]\nhost = "example.com"\n', "net", "host")).toBe("example.com");
  });

  it("decodes escapes in quoted strings", () => {
    expect(readTomlValue('[p]\nk = "a\\\\b"\n', "p", "k")).toBe("a\\b");
  });

  it("returns numbers and bools as their raw text", () => {
    expect(readTomlValue("[net]\nport = 8080\n", "net", "port")).toBe("8080");
    expect(readTomlValue("[net]\ntls = true\n", "net", "tls")).toBe("true");
  });

  it("returns empty string for a missing section or key", () => {
    expect(readTomlValue("[net]\nport = 1\n", "other", "port")).toBe("");
    expect(readTomlValue("[net]\nport = 1\n", "net", "host")).toBe("");
  });

  it("does not read a key belonging to a later section", () => {
    // The bug this guards: scanning past the section end would return 9000.
    expect(readTomlValue("[a]\nx = 1\n[b]\nport = 9000\n", "a", "port")).toBe("");
  });
});

describe("formatTomlValue", () => {
  it("quotes and escapes strings", () => {
    expect(formatTomlValue('a"b', "string")).toBe('"a\\"b"');
  });

  it("accepts only well-formed numbers and bools", () => {
    expect(formatTomlValue("42", "number")).toBe("42");
    expect(formatTomlValue("-7", "number")).toBe("-7");
    expect(formatTomlValue("4.2", "number")).toBeNull();
    expect(formatTomlValue("abc", "number")).toBeNull();
    expect(formatTomlValue("true", "bool")).toBe("true");
    expect(formatTomlValue("yes", "bool")).toBeNull();
  });

  it("treats blank input as absent, whatever the kind", () => {
    expect(formatTomlValue("   ", "string")).toBeNull();
    expect(formatTomlValue("", "number")).toBeNull();
  });
});

describe("writeTomlValue", () => {
  it("updates an existing key in place", () => {
    const out = writeTomlValue('[net]\nhost = "old"\nport = 1\n', "net", "host", "new", "string");
    expect(out).toBe('[net]\nhost = "new"\nport = 1\n');
  });

  it("appends a key to an existing section", () => {
    expect(writeTomlValue("[net]\nport = 1\n", "net", "host", "h", "string")).toBe(
      '[net]\nport = 1\nhost = "h"\n',
    );
  });

  it("creates the section when it does not exist", () => {
    expect(writeTomlValue("[a]\nx = 1\n", "net", "port", "80", "number")).toBe(
      "[a]\nx = 1\n\n[net]\nport = 80\n",
    );
  });

  it("writes into an empty document", () => {
    expect(writeTomlValue("", "net", "port", "80", "number")).toBe("[net]\nport = 80\n");
  });

  it("removes the key when the value clears", () => {
    expect(writeTomlValue('[net]\nhost = "h"\nport = 1\n', "net", "host", "", "string")).toBe(
      "[net]\nport = 1\n",
    );
  });

  it("leaves the document untouched when clearing a key in a missing section", () => {
    const src = "[a]\nx = 1\n";
    expect(writeTomlValue(src, "net", "host", "", "string")).toBe(src);
  });

  it("preserves comments and the order of untouched keys", () => {
    const src = '# top comment\n[net]\n# why this port\nport = 1\nhost = "h"\n';
    expect(writeTomlValue(src, "net", "port", "2", "number")).toBe(
      '# top comment\n[net]\n# why this port\nport = 2\nhost = "h"\n',
    );
  });

  it("does not write into a later section that happens to share the key", () => {
    expect(writeTomlValue("[a]\nport = 1\n[b]\nport = 2\n", "b", "port", "3", "number")).toBe(
      "[a]\nport = 1\n[b]\nport = 3\n",
    );
  });

  it("rejects a malformed value rather than writing garbage", () => {
    // Invalid input formats to null, which is the same signal as "clear it".
    expect(writeTomlValue("[net]\nport = 1\n", "net", "port", "abc", "number")).toBe("[net]\n");
  });

  it("always terminates with exactly one newline", () => {
    const out = writeTomlValue("[net]\nport = 1\n\n\n", "net", "port", "2", "number");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});
