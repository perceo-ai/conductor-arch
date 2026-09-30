// Which workspaces the left sidebar lists under one project.
//
// Archive means "hide from the sidebar": an archived workspace keeps its record,
// chats, branch, and worktree, and lives on in History and the dashboard's
// Archived column until it is restored or deleted. So the sidebar drops archived
// rows here, whatever the filter says.

export interface SidebarRowFields {
  repository?: string;
  status?: string;
}

export function sidebarWorkspaceNames(
  order: readonly string[],
  row: (name: string) => SidebarRowFields | undefined,
  repository: string,
  matches: (name: string) => boolean,
  isPinned: (name: string) => boolean,
): string[] {
  const listed = order.filter((name) => {
    const fields = row(name);
    return fields?.repository === repository && fields.status !== "archived" && matches(name);
  });
  // Pinned first, otherwise the daemon's order. Stable so the list does not
  // reshuffle while an agent updates a row.
  return [...listed.filter(isPinned), ...listed.filter((name) => !isPinned(name))];
}
