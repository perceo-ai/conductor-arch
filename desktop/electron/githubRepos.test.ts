import { describe, expect, it } from "vitest";
import { parseGithubRepos } from "./githubRepos";

describe("parseGithubRepos", () => {
  const repo = (name: string, pushedAt: string, avatarUrl = "https://avatars.githubusercontent.com/u/1?v=4") => ({
    full_name: `perceo-ai/${name}`,
    name,
    ssh_url: `git@github.com:perceo-ai/${name}.git`,
    html_url: `https://github.com/perceo-ai/${name}`,
    pushed_at: pushedAt,
    owner: { login: "perceo-ai", avatar_url: avatarUrl },
  });

  it("flattens gh api --slurp pages", () => {
    const repos = parseGithubRepos(
      JSON.stringify([[repo("older", "2026-01-01T00:00:00Z")], [repo("newer", "2026-02-01T00:00:00Z")]]),
    );

    expect(repos.map((item) => item.nameWithOwner)).toEqual(["perceo-ai/newer", "perceo-ai/older"]);
    expect(repos[0]).toMatchObject({
      name: "newer",
      owner: "perceo-ai",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4&s=64",
    });
  });

  it("also accepts a flat repo array for compatibility", () => {
    expect(parseGithubRepos(JSON.stringify([repo("archductor", "2026-01-01T00:00:00Z")]))).toMatchObject([
      {
        nameWithOwner: "perceo-ai/archductor",
        sshUrl: "git@github.com:perceo-ai/archductor.git",
      },
    ]);
  });
});
