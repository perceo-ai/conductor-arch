// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";

const SAMPLE = [
  "diff --git a/f.ts b/f.ts",
  "index 1111111..2222222 100644",
  "--- a/f.ts",
  "+++ b/f.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+two-changed",
  "+added",
  " three",
].join("\n");

const onlyFile = (text: string) => parseUnifiedDiff(text).files[0];

describe("parseUnifiedDiff line numbering", () => {
  it("assigns old/new line numbers from the hunk header", () => {
    const rows = onlyFile(SAMPLE).hunks[0].rows;
    expect(rows[0]).toMatchObject({ kind: "context", oldNo: 1, newNo: 1 }); // one
    expect(rows[1]).toMatchObject({ kind: "removed", oldNo: 2, newNo: null }); // two
    expect(rows[2]).toMatchObject({ kind: "added", oldNo: null, newNo: 2 }); // two-changed
    expect(rows[3]).toMatchObject({ kind: "added", oldNo: null, newNo: 3 }); // added
    expect(rows[4]).toMatchObject({ kind: "context", oldNo: 3, newNo: 4 }); // three
  });

  it("restarts numbering at each hunk header", () => {
    const text = ["@@ -10,2 +20,2 @@", " a", "+b", "@@ -50,1 +80,1 @@", " c"].join("\n");
    const hunks = onlyFile(text).hunks;
    expect(hunks[0].rows[0]).toMatchObject({ oldNo: 10, newNo: 20 }); // a
    expect(hunks[0].rows[1]).toMatchObject({ oldNo: null, newNo: 21 }); // b
    expect(hunks[1].rows[0]).toMatchObject({ oldNo: 50, newNo: 80 }); // c
  });

  it("keeps the section label trailing the hunk header", () => {
    const text = ["@@ -1,1 +1,1 @@ fn render(props: Props) {", " body"].join("\n");
    expect(onlyFile(text).hunks[0]).toMatchObject({
      header: "@@ -1,1 +1,1 @@",
      section: "fn render(props: Props) {",
    });
  });
});

describe("parseUnifiedDiff file metadata", () => {
  it("groups rows under the file they belong to", () => {
    const file = onlyFile(SAMPLE);
    expect(file.path).toBe("f.ts");
    expect(file.status).toBe("modified");
    expect(file.hunks).toHaveLength(1);
  });

  it("drops index and mode noise instead of rendering it as code", () => {
    const rows = onlyFile(SAMPLE).hunks.flatMap((h) => h.rows);
    expect(rows.some((r) => r.text.startsWith("index "))).toBe(false);
  });

  it("counts additions and deletions per file", () => {
    expect(onlyFile(SAMPLE)).toMatchObject({ additions: 2, deletions: 1 });
  });

  it("separates multiple files in one diff", () => {
    const text = [SAMPLE, "diff --git a/g.py b/g.py", "--- a/g.py", "+++ b/g.py", "@@ -1 +1 @@", "+x"].join(
      "\n",
    );
    const files = parseUnifiedDiff(text).files;
    expect(files.map((f) => f.path)).toEqual(["f.ts", "g.py"]);
  });

  it("reports a new file as added", () => {
    const text = [
      "diff --git a/n.ts b/n.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/n.ts",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n");
    expect(onlyFile(text)).toMatchObject({ path: "n.ts", status: "added" });
  });

  it("reports a removed file as deleted", () => {
    const text = [
      "diff --git a/d.ts b/d.ts",
      "deleted file mode 100644",
      "--- a/d.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(onlyFile(text)).toMatchObject({ path: "d.ts", status: "deleted" });
  });

  it("records both paths for a rename", () => {
    const text = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 96%",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");
    expect(onlyFile(text)).toMatchObject({
      status: "renamed",
      oldPath: "old.ts",
      path: "new.ts",
    });
  });

  it("marks a binary file and gives it no rows", () => {
    const text = [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    expect(onlyFile(text)).toMatchObject({ path: "img.png", status: "binary", hunks: [] });
  });

  it("ignores the no-newline marker", () => {
    const text = ["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n");
    const rows = onlyFile(text).hunks[0].rows;
    expect(rows).toHaveLength(2);
  });

  it("accepts a bare hunk with no file header", () => {
    const doc = parseUnifiedDiff(["@@ -1 +1 @@", " a"].join("\n"));
    expect(doc.files[0]).toMatchObject({ path: "", hunks: expect.any(Array) });
  });
});

describe("parseUnifiedDiff gutter sizing", () => {
  it("uses a two-digit gutter for small files", () => {
    expect(onlyFile(SAMPLE).gutterDigits).toBe(2);
  });

  it("widens the gutter to the largest line number in the file", () => {
    const text = ["@@ -998,3 +998,3 @@", " a", " b", " c", " d"].join("\n");
    expect(onlyFile(text).gutterDigits).toBe(4); // reaches line 1001
  });
});

describe("parseUnifiedDiff prose around the diff", () => {
  // `git show` leads with a commit header and a --stat block. None of it is
  // code, and the last stat line sits directly above the first `diff --git`.
  const SHOW = [
    "commit a1b2c3d4",
    "Author: Someone <someone@example.com>",
    "Date:   Mon Aug 19 12:00:00 2026 +0000",
    "",
    "    the subject line",
    "",
    " f.ts | 3 ++-",
    " 1 file changed, 2 insertions(+), 1 deletion(-)",
    "",
    SAMPLE,
  ].join("\n");

  it("keeps the commit header out of the diff rows", () => {
    const rows = parseUnifiedDiff(SHOW).files[0].hunks.flatMap((h) => h.rows);
    expect(rows.some((r) => r.text.includes("Author:"))).toBe(false);
  });

  it("collects leading prose as the preamble", () => {
    expect(parseUnifiedDiff(SHOW).preamble).toContain("commit a1b2c3d4");
  });

  it("keeps the last stat line, which sits directly above the first file", () => {
    expect(parseUnifiedDiff(SHOW).preamble).toContain(
      "1 file changed, 2 insertions(+), 1 deletion(-)",
    );
  });

  it("still finds the file after the prose", () => {
    expect(parseUnifiedDiff(SHOW).files.map((f) => f.path)).toEqual(["f.ts"]);
  });

  it("collects trailing prose as notes rather than preamble", () => {
    const truncated = [SAMPLE, "[Diff truncated after 200000 bytes.]"].join("\n");
    const doc = parseUnifiedDiff(truncated);
    expect(doc.notes).toEqual(["[Diff truncated after 200000 bytes.]"]);
    expect(doc.preamble).toEqual([]);
  });

  it("gives a bare diff no prose at all", () => {
    const doc = parseUnifiedDiff(SAMPLE);
    expect(doc.preamble).toEqual([]);
    expect(doc.notes).toEqual([]);
  });
});

describe("parseUnifiedDiff word-level highlighting", () => {
  it("wraps the changed words of a paired removed/added line", () => {
    const text = ["@@ -1,1 +1,1 @@", "-const a = 1", "+const b = 1"].join("\n");
    const rows = onlyFile(text).hunks[0].rows;
    expect(rows.find((r) => r.kind === "removed")!.html).toContain('class="diff-word"');
    expect(rows.find((r) => r.kind === "added")!.html).toContain('class="diff-word"');
  });

  it("leaves context rows unmarked", () => {
    const rows = onlyFile(SAMPLE).hunks[0].rows;
    expect(rows.filter((r) => r.kind === "context").every((r) => !r.html.includes("diff-word"))).toBe(
      true,
    );
  });

  it("leaves an unpairable run unmarked", () => {
    // One line removed, two added: no honest pairing, so no word highlight.
    const text = ["@@ -1,1 +1,2 @@", "-alpha", "+alpha one", "+alpha two"].join("\n");
    const rows = onlyFile(text).hunks[0].rows;
    expect(rows.every((r) => !r.html.includes("diff-word"))).toBe(true);
  });
});
