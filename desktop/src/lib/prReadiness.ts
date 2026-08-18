export type PrGateTone = "passed" | "failed" | "running" | "unknown";

export interface PrCheckRow {
  name: string;
  status: string;
  detail?: string;
  tone: PrGateTone;
}

export interface PrReadinessView {
  state?: string;
  reviewDecision?: string;
  mergeState?: string;
  checks: PrCheckRow[];
  attention: string[];
}

function sectionLines(text: string, title: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${title}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z][A-Za-z ]+:$/.test(line.trim())) break;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) out.push(trimmed.slice(2));
  }
  return out;
}

function field(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

export function checkTone(status: string): PrGateTone {
  const value = status.toLowerCase();
  if (/(success|passed|pass|approved|completed)$/.test(value) || value === "success") return "passed";
  if (/(fail|failure|error|cancel|timed_out|action_required)/.test(value)) return "failed";
  if (/(pending|queued|running|in_progress|waiting|requested)/.test(value)) return "running";
  return "unknown";
}

export function parsePrReadiness(text: string): PrReadinessView {
  const checks = sectionLines(text, "Checks")
    .filter((line) => line !== "none")
    .map((line) => {
      const [left, detail] = line.split(/\s+-\s+/, 2);
      const [name, ...statusParts] = left.split(": ");
      const status = statusParts.join(": ").trim() || "unknown";
      return {
        name: name.trim(),
        status,
        detail: detail?.trim(),
        tone: checkTone(status),
      };
    });

  return {
    state: field(text, "State"),
    reviewDecision: field(text, "Review decision"),
    mergeState: field(text, "Merge state"),
    checks,
    attention: sectionLines(text, "Attention needed").filter((line) => line !== "none"),
  };
}
