import { openExternal, openWorkspaceApp } from "@/bridge/client";
import type { ContextMenuItem } from "@/components/ContextMenu";
import { materialFileIcon } from "@/lib/materialFileIcons";
import { runShellAction } from "@/lib/shellAction";
import { WORKSPACE_OPEN_APPS, workspaceDefaultOpener } from "@/lib/workspaceOpenApps";

// "Open in …" entries for a path on this machine — the workspace worktree in
// the top bar, a single file in the Browse tree. The OS default handler goes
// first, then the editors we can launch by command; both reach the same shell
// IPC, so a remote workspace fails the same way in either place.

/** Absolute path for a worktree-relative file, or null when the root is unknown. */
export function workspaceFilePath(root: string | undefined | null, relative: string): string | null {
  if (!root || !relative) return null;
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

/** `kind` only picks the first entry's wording: a directory lands in the file
 *  manager, a file in whatever app the OS has registered for its type. */
/** Where "Open in …" for a workspace should land: its worktree, falling back to
 *  the project checkout only while the workspace row has no path yet. Opening
 *  the base repo instead shows another workspace's files (or plain `main`). */
export function workspaceOpenRoot(
  worktreePath: string | undefined | null,
  repoRootPath: string | undefined | null,
): string | undefined {
  return worktreePath || repoRootPath || undefined;
}

export function openWithItems(path: string, kind: "folder" | "file" = "folder"): ContextMenuItem[] {
  if (!path) return [];
  const defaultOpener = workspaceDefaultOpener();
  const isFile = kind === "file";
  const defaultLabel = isFile ? "Open in default app" : `Open in ${defaultOpener.label}`;
  const items: ContextMenuItem[] = [
    {
      label: defaultLabel,
      iconSrc: isFile ? materialFileIcon(path).src : defaultOpener.logoSrc,
      iconAlt: isFile ? "Default app" : defaultOpener.label,
      run: () => runShellAction(defaultLabel, openExternal(path)),
    },
  ];
  for (const app of WORKSPACE_OPEN_APPS) {
    items.push({
      label: `Open in ${app.label}`,
      iconSrc: app.logoSrc,
      iconAlt: app.label,
      run: () => runShellAction(`Open in ${app.label}`, openWorkspaceApp({ rootPath: path, appId: app.id })),
    });
  }
  return items;
}
