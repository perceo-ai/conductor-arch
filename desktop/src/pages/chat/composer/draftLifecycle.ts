import { createEffect, on, onCleanup, untrack } from "solid-js";
import { nav } from "@/store/nav";
import { composerDrafts, draftKey } from "@/lib/composerDrafts";
import type { ComposerNode } from "@/lib/composerDocument";

/**
 * Which `composerDrafts` key a mounted composer reads and writes. The key is
 * cached rather than derived at park time, twice over: the parent's `threadId`
 * getter dereferences the active thread, which is already gone by the time the
 * composer is torn down (a throw there aborts the whole update that unmounted
 * it), and on a daemon switch the realm has already moved on while this draft
 * still belongs to the old realm's thread.
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
  let currentDraftKey = draftKey(untrack(nav.tabRealm), untrack(opts.threadId));
  // Each chat keeps its own unsent draft: park this one, bring the next back.
  createEffect(
    on(
      opts.threadId,
      (threadId) => {
        const next = draftKey(untrack(nav.tabRealm), threadId);
        if (next === currentDraftKey) return;
        composerDrafts.save(currentDraftKey, opts.currentNodes());
        currentDraftKey = next;
        opts.restore(composerDrafts.get(next));
      },
      { defer: true },
    ),
  );
  // Startup correcting the provisional realm to the daemon's real identity —
  // nav.tabRealm() changes while tabRealmSession keeps its object identity —
  // retargets this composer's key and every parked draft: same daemon, the
  // key was just provisional. A genuine daemon switch replaces the session
  // object instead, and nothing is retargeted: the draft stays under the old
  // realm's key, where only that daemon's chats can find it again.
  // Tracked by hand: with { defer: true }, on()'s prev argument is undefined
  // on the first triggered run, and the correction IS that first run.
  let lastSession = untrack(nav.tabRealmSession);
  let lastRealm = untrack(nav.tabRealm);
  createEffect(
    on(
      nav.tabRealm,
      (realm) => {
        const prevRealm = lastRealm;
        lastRealm = realm;
        const session = untrack(nav.tabRealmSession);
        const wasCorrection = session === lastSession;
        lastSession = session;
        if (!wasCorrection) return;
        composerDrafts.retargetRealm(prevRealm, realm);
        currentDraftKey = draftKey(realm, untrack(opts.threadId));
      },
      { defer: true },
    ),
  );
  onCleanup(() => composerDrafts.save(currentDraftKey, opts.currentNodes()));
  return { initialNodes: composerDrafts.get(currentDraftKey) };
}
