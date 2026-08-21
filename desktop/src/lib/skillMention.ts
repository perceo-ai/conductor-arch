import { fuzzyScore } from "./fuzzy";

// `/skill` discovery in the composer, mirroring the `@` file mention.
//
// Selecting a skill only inserts `/name ` — the agent CLIs own slash-command
// execution, and expanding one ourselves would fork behaviour per provider.
// This is discovery and insertion, nothing more.

export interface SkillMention {
  start: number;
  end: number;
  query: string;
}

export interface SkillOption {
  name: string;
  description: string;
  providers: string[];
}

/**
 * A slash command is only a slash command at the start of a line or after
 * whitespace — otherwise every path like `src/lib` would open the menu.
 */
export function skillMentionAt(value: string, cursor: number): SkillMention | null {
  const before = value.slice(0, cursor);
  const match = /(^|\s)\/([A-Za-z0-9_-]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: cursor - query.length - 1, end: cursor, query };
}

/**
 * Rank skills for a query. An empty query lists everything (typing bare `/`
 * should show what is available), and the name is weighted over the
 * description so `/rev` puts `review` above a skill that merely mentions
 * reviewing.
 */
export function rankSkills(
  skills: SkillOption[],
  query: string,
  limit = 8,
): SkillOption[] {
  const trimmed = query.trim();
  if (!trimmed) return skills.slice(0, limit);
  const needle = trimmed.toLowerCase();
  const scored: { skill: SkillOption; score: number }[] = [];
  for (const skill of skills) {
    const nameScore = fuzzyScore(trimmed, skill.name);
    // Descriptions are matched as a substring, not fuzzily. A subsequence
    // match against several hundred words of prose succeeds for almost any
    // short query — "/comm" matched every skill installed — which turns the
    // menu into noise exactly when it should be narrowing.
    const inDescription = needle.length >= 3 && skill.description.toLowerCase().includes(needle);
    if (nameScore == null && !inDescription) continue;
    // A description hit never outranks a name hit; the offset is larger than
    // any realistic name score.
    const score = nameScore ?? 10_000;
    scored.push({ skill, score });
  }
  scored.sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name));
  return scored.slice(0, limit).map((item) => item.skill);
}

/** Replace the typed `/query` with the chosen skill, leaving a trailing space. */
export function insertSkillMention(
  value: string,
  mention: SkillMention,
  name: string,
): { value: string; cursor: number } {
  const before = value.slice(0, mention.start);
  const after = value.slice(mention.end);
  // Only add the separating space when there isn't one already, so completing
  // mid-sentence doesn't leave a double space behind the command.
  const insert = /^\s/.test(after) ? `/${name}` : `/${name} `;
  return { value: before + insert + after, cursor: before.length + insert.length };
}

/** Only offer skills the session's own agent can actually run. */
export function skillsForProvider(skills: SkillOption[], provider: string | null): SkillOption[] {
  if (!provider) return skills;
  return skills.filter((skill) => skill.providers.includes(provider));
}
