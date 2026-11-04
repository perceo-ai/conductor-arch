import { createEffect, on, onCleanup, untrack } from "solid-js";
import { nav } from "@/store/nav";
import { composerDrafts, draftKey } from "@/lib/composerDrafts";
import type { ComposerNode } from "@/lib/composerDocument";

/**
 * Which `composerDrafts` key a mounted composer reads and writes.
 *
 * Park keys derive from the tab-realm session captured at mount (re-captured
 * on each thread switch), not from a cached realm string: startup correcting
 * the provisional realm mutates the session's `realm` in place, so a draft
 * still on screen parks under the corrected key — nav's assignTabRealm only
 * migrates entries already parked. A genuine daemon switch replaces the
 * session object instead; this composer keeps the old one until its thread
 * changes, so the park still targets the realm the draft was typed under.
 *
 * The thread id is cached because the parent's `threadId` getter dereferences
 * the active thread, which is already gone by the time the composer is torn
 * down (a throw there aborts the whole update that unmounted it).
 *
 * Runs under the composer's reactive owner: call it during component setup.
 */
export function createComposerDraftLifecycle(opts: {
  threadId: () => number;
  /** The document on screen right now, read at park time. */
  currentNodes: () => ComposerNode[];
  /** Bring a parked draft on screen. Must not steal focus. */
  restore: (nodes: ComposerNode[]) => void;
}): { initialNodes: ComposerNode[] } {
  let session = untrack(nav.tabRealmSession);
  let draftThreadId = untrack(opts.threadId);
  // Each chat keeps its own unsent draft: park this one, bring the next back.
  createEffect(
    on(
      opts.threadId,
      (threadId) => {
        if (threadId === draftThreadId) return;
        composerDrafts.save(draftKey(session.realm, draftThreadId), opts.currentNodes());
        session = untrack(nav.tabRealmSession);
        draftThreadId = threadId;
        opts.restore(composerDrafts.get(draftKey(session.realm, threadId)));
      },
      { defer: true },
    ),
  );
  onCleanup(() => composerDrafts.save(draftKey(session.realm, draftThreadId), opts.currentNodes()));
  return { initialNodes: composerDrafts.get(draftKey(session.realm, draftThreadId)) };
}
