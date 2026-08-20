// The daemon returns recent commits as preformatted log text (get_recent_commits
// hands back one "<sha> <subject>" line per commit). Parsing lives here so the
// scope selector and any other consumer agree on the shape.

export interface CommitLogEntry {
  sha: string;
  /** Ref names git printed with --decorate, e.g. "HEAD -> main". */
  refs: string;
  subject: string;
}

const SHORT_SHA_LENGTH = 7;

/**
 * The daemon logs with `--decorate`, so a line reads
 * `<sha> (HEAD -> branch) <subject>`. Split the decoration out rather than
 * leaving it glued to the message.
 *
 * A commit message that genuinely starts with a parenthesised group is
 * indistinguishable from a decoration, so only strip one when a subject
 * remains — that way such a message is kept whole instead of vanishing.
 */
const DECORATED = /^\((?<refs>[^)]*)\)\s+(?<subject>.+)$/;

export function parseCommitLog(log: string): CommitLogEntry[] {
  return log
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      if (space < 0) return { sha: line, refs: "", subject: "" };
      const sha = line.slice(0, space);
      const rest = line.slice(space + 1).trim();
      const decorated = DECORATED.exec(rest);
      if (decorated?.groups) {
        return {
          sha,
          refs: decorated.groups.refs.trim(),
          subject: decorated.groups.subject.trim(),
        };
      }
      return { sha, refs: "", subject: rest };
    });
}

export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}
