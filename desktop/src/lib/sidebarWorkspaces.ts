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

/**
 * The sidebar's workspaces, top to bottom, flattened across project groups.
 *
 * This is what `mod+1`..`mod+9` and next/prev workspace count through: the
 * numbers have to read down the list the eye sees, not the order the daemon
 * happened to create the rows in. So it walks the repositories in sidebar
 * order, and within each the same pinned-first order the group renders, then
 * appends any workspace whose repository has no group (a stale or unlisted
 * repo) so it still keeps a keyboard path.
 *
 * The sidebar's text filter is deliberately ignored: a slot that moved while
 * someone typed in the filter box would be a slot nobody could aim at.
 */
export function sidebarWorkspaceOrder(
  repositories: readonly string[],
  order: readonly string[],
  row: (name: string) => SidebarRowFields | undefined,
  isPinned: (name: string) => boolean,
): string[] {
  const flat: string[] = [];
  for (const repository of repositories) {
    flat.push(...sidebarWorkspaceNames(order, row, repository, () => true, isPinned));
  }
  const grouped = new Set(flat);
  for (const name of order) {
    const fields = row(name);
    if (!fields || fields.status === "archived" || grouped.has(name)) continue;
    flat.push(name);
  }
  return flat;
}
