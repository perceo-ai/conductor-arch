import { describe, expect, it } from "vitest";
import {
  rankSkills,
  skillMentionAt,
  skillsForProvider,
  type SkillOption,
} from "./skillMention";

const SKILLS: SkillOption[] = [
  { name: "review", description: "Review a pull request", providers: ["claude"] },
  { name: "commit", description: "Write a commit message", providers: ["claude", "codex"] },
  { name: "abcdef", description: "Nothing to do with reviewing", providers: ["codex"] },
];

describe("skillMentionAt", () => {
  it("opens at the start of the input", () => {
    expect(skillMentionAt("/rev", 4)).toEqual({ start: 0, end: 4, query: "rev" });
  });

  it("opens after whitespace", () => {
    expect(skillMentionAt("please /rev", 11)).toEqual({ start: 7, end: 11, query: "rev" });
  });

  it("opens on a bare slash so typing / lists everything", () => {
    expect(skillMentionAt("/", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("ignores slashes inside a path, which would otherwise fire constantly", () => {
    expect(skillMentionAt("src/lib", 7)).toBeNull();
    expect(skillMentionAt("https://example.com", 19)).toBeNull();
    expect(skillMentionAt("a/b/c", 5)).toBeNull();
  });

  it("closes once the token can no longer be a command name", () => {
    expect(skillMentionAt("/rev iew", 8)).toBeNull();
  });

  it("reads at the cursor, not at the end of the text", () => {
    expect(skillMentionAt("/rev trailing", 4)).toEqual({ start: 0, end: 4, query: "rev" });
  });
});

describe("rankSkills", () => {
  it("lists everything for an empty query", () => {
    expect(rankSkills(SKILLS, "").map((s) => s.name)).toEqual(["review", "commit", "abcdef"]);
  });

  it("puts a name match above a description match", () => {
    // "abcdef" only matches through its description; "review" matches by name.
    const ranked = rankSkills(SKILLS, "review").map((s) => s.name);
    expect(ranked[0]).toBe("review");
    expect(ranked).toContain("abcdef");
    expect(ranked.indexOf("review")).toBeLessThan(ranked.indexOf("abcdef"));
  });

  it("fuzzy matches rather than requiring a prefix", () => {
    expect(rankSkills(SKILLS, "cmt").map((s) => s.name)).toContain("commit");
  });

  it("drops skills that match neither name nor description", () => {
    expect(rankSkills(SKILLS, "zzzzz")).toEqual([]);
  });

  it("does not treat a long description as a fuzzy haystack", () => {
    // A subsequence match against prose succeeds for nearly any short query,
    // which made every skill appear for "/comm". Descriptions must match as a
    // substring so narrowing actually narrows.
    const wordy: SkillOption[] = [
      {
        name: "zzz",
        description: "Create Object Modeling Machinery for complicated meshes",
        providers: ["claude"],
      },
    ];
    expect(rankSkills(wordy, "comm")).toEqual([]);
    expect(rankSkills(wordy, "modeling").map((s) => s.name)).toEqual(["zzz"]);
  });

  it("ignores one- and two-character queries for description matching", () => {
    const wordy: SkillOption[] = [
      { name: "zzz", description: "a commit helper", providers: ["claude"] },
    ];
    expect(rankSkills(wordy, "co")).toEqual([]);
    expect(rankSkills(wordy, "com").map((s) => s.name)).toEqual(["zzz"]);
  });

  it("honours the limit", () => {
    expect(rankSkills(SKILLS, "", 2)).toHaveLength(2);
  });
});

describe("skillsForProvider", () => {
  it("only offers what the session's agent can run", () => {
    expect(skillsForProvider(SKILLS, "codex").map((s) => s.name)).toEqual(["commit", "abcdef"]);
    expect(skillsForProvider(SKILLS, "claude").map((s) => s.name)).toEqual(["review", "commit"]);
  });

  it("falls back to everything when the provider is unknown", () => {
    expect(skillsForProvider(SKILLS, null)).toHaveLength(3);
  });
});
