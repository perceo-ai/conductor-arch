// Subsequence fuzzy match: every query char appears in order in the text.
// Returns a rough score (lower is better) favouring earlier and more contiguous
// matches, or null when the query is not a subsequence. Used by the command
// palette to rank commands, workspaces, and pages.
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let lastHit = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += found - ti; // gap penalty
    if (lastHit !== -1 && found !== lastHit + 1) score += 1; // non-contiguous
    lastHit = found;
    ti = found + 1;
  }
  return score + (t.length - q.length) * 0.01;
}
