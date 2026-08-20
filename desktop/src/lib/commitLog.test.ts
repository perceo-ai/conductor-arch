// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseCommitLog, shortSha } from "./commitLog";

const LOG = [
  "a1b2c3d4e5f6 Make desktop actions keyboard-first (#101)",
  "308310e Context management: summaries and plan mode",
].join("\n");

describe("parseCommitLog", () => {
  it("splits each line into its sha and subject", () => {
    expect(parseCommitLog(LOG)).toEqual([
      { sha: "a1b2c3d4e5f6", refs: "", subject: "Make desktop actions keyboard-first (#101)" },
      { sha: "308310e", refs: "", subject: "Context management: summaries and plan mode" },
    ]);
  });

  it("lifts git's ref decoration out of the subject", () => {
    // The daemon logs with --decorate, so the branch names would otherwise be
    // read as part of the commit message.
    expect(parseCommitLog("f00923d (HEAD -> scope-demo) commit on branch")).toEqual([
      { sha: "f00923d", refs: "HEAD -> scope-demo", subject: "commit on branch" },
    ]);
  });

  it("handles a decoration listing several refs", () => {
    const [entry] = parseCommitLog("aeefd92 (tag: v1, origin/main, main) baseline");
    expect(entry.refs).toBe("tag: v1, origin/main, main");
    expect(entry.subject).toBe("baseline");
  });

  it("keeps a parenthesised subject when there is nothing after it", () => {
    // Only strip a leading group when a real subject remains, so a message that
    // simply starts with a parenthesis is not swallowed.
    expect(parseCommitLog("a1b2c3d (just a parenthesised message)")[0]).toEqual({
      sha: "a1b2c3d",
      refs: "",
      subject: "(just a parenthesised message)",
    });
  });

  it("keeps a commit whose subject is missing", () => {
    expect(parseCommitLog("a1b2c3d")).toEqual([{ sha: "a1b2c3d", refs: "", subject: "" }]);
  });

  it("skips blank lines", () => {
    expect(parseCommitLog("\n\na1b2c3d subject\n\n")).toHaveLength(1);
  });

  it("returns nothing for an empty log", () => {
    expect(parseCommitLog("")).toEqual([]);
    expect(parseCommitLog("   ")).toEqual([]);
  });

  it("does not split a subject containing extra whitespace", () => {
    expect(parseCommitLog("a1b2c3d  fix   spacing  ")[0].subject).toBe("fix   spacing");
  });
});

describe("shortSha", () => {
  it("truncates a full sha for display", () => {
    expect(shortSha("a1b2c3d4e5f6a7b8")).toBe("a1b2c3d");
  });

  it("leaves an already-short sha alone", () => {
    expect(shortSha("a1b2c3d")).toBe("a1b2c3d");
  });
});
