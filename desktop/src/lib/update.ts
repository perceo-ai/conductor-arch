export interface UpdateStatus {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  releaseUrl?: string;
  error?: string;
}

function normalizeVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

export function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function updateStatusText(status: UpdateStatus): string {
  if (status.error) return `Update check failed: ${status.error}`;
  if (status.updateAvailable && status.latestVersion) return `Update available: ${status.latestVersion}`;
  if (status.latestVersion) return "Archductor is up to date.";
  return `Current version ${status.currentVersion}`;
}
