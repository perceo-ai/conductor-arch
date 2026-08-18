export interface GithubRepo {
  nameWithOwner: string;
  name: string;
  sshUrl: string;
  url: string;
  pushedAt: string;
  owner: string;
  avatarUrl: string;
}

interface GithubRepoApiRow {
  full_name?: string;
  name?: string;
  ssh_url?: string;
  html_url?: string;
  pushed_at?: string;
  owner?: {
    login?: string;
    avatar_url?: string;
  };
}

function repoRowsFromJson(value: unknown): GithubRepoApiRow[] {
  if (!Array.isArray(value)) return [];
  if (value.every((page) => Array.isArray(page))) {
    return value.flat() as GithubRepoApiRow[];
  }
  return value as GithubRepoApiRow[];
}

function avatarWithSize(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  return `${trimmed}${trimmed.includes("?") ? "&" : "?"}s=64`;
}

export function parseGithubRepos(stdout: string, limit = 300): GithubRepo[] {
  const rows = repoRowsFromJson(JSON.parse(stdout));
  return rows
    .filter((row) => row.full_name && row.name)
    .sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""))
    .slice(0, limit)
    .map((row) => ({
      nameWithOwner: row.full_name ?? "",
      name: row.name ?? "",
      sshUrl: row.ssh_url ?? "",
      url: row.html_url ?? "",
      pushedAt: row.pushed_at ?? "",
      owner: row.owner?.login ?? row.full_name?.split("/", 1)[0] ?? "",
      avatarUrl: avatarWithSize(row.owner?.avatar_url ?? ""),
    }));
}
