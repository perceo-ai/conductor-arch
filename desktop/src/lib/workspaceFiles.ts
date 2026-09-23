import { send } from "@/bridge/client";

/**
 * The workspace's file list, fetched once per workspace.
 *
 * Two surfaces want it now — the composer, to rank `@` mentions, and the
 * timeline, to work out where a sent message's file chip points — and they
 * mount together. The in-flight promise is shared so that is one round trip
 * rather than two, and the result is kept because the list only feeds
 * name-matching: a file added since the fetch just leaves its chip inert, which
 * is the same outcome as a name the capped list never contained.
 */
const inFlight = new Map<string, Promise<string[]>>();

export function loadWorkspaceFiles(workspace: string): Promise<string[]> {
  const cached = inFlight.get(workspace);
  if (cached) return cached;
  const fail = () => {
    // Don't cache a failure: the next caller should get to retry.
    inFlight.delete(workspace);
    return [] as string[];
  };
  let pending: Promise<string[]>;
  try {
    // `send` throws rather than rejecting when the bridge isn't up yet, which
    // is the normal state under test and during early mount — so the throw has
    // to be caught here as well as the rejection.
    pending = send({ type: "list_workspace_files", workspace })
      .then((res) => (res.type === "workspace_files" ? res.files : []))
      .catch(fail);
  } catch {
    return Promise.resolve(fail());
  }
  inFlight.set(workspace, pending);
  return pending;
}

/** Drop the cache for a workspace, so the next read refetches. */
export function forgetWorkspaceFiles(workspace: string): void {
  inFlight.delete(workspace);
}
