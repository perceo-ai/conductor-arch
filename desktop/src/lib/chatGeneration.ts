/** Whether a chat thread is currently producing output, and why.
 *
 * The composer used to answer this with four ad-hoc signals read straight off
 * the store (`busy`, `starting`, `slowStart`, `running`), which meant the
 * toolbar status and anything else that wanted the same answer could disagree.
 * The rules live here instead: one function, one vocabulary, testable without a
 * store or a DOM.
 *
 * The distinction that matters is between "no output is coming" and "output is
 * coming but hasn't started" — a session that is still launching its agent CLI
 * looks identical to an idle one in the raw fields, and reporting it as idle is
 * what makes a slow start feel like a hang.
 */

export type ChatGenerationState = "idle" | "starting" | "generating";

export interface ChatGenerationInput {
  session: { runtime_state: string; ready: boolean } | null;
  phase: { kind: string };
  /**
   * The agent has asked the user something and is parked until it is answered.
   * The session reports `ready: false` throughout, because from its side a turn
   * really is in flight — but nothing is being produced, and showing a loader
   * for a wait that only the user can end is how a blocked agent sits unnoticed.
   */
  blockedOnUser: boolean;
}

export function chatGenerationState(input: ChatGenerationInput): ChatGenerationState {
  // Checked first: it outranks every "busy" signal below by design.
  if (input.blockedOnUser) return "idle";

  const session = input.session;

  // No session yet, but one is being created or launched — output is coming.
  if (session == null) {
    const kind = input.phase.kind;
    return kind === "creating" || kind === "starting" ? "starting" : "idle";
  }

  // A ready session is parked waiting for input.
  if (session.ready) return "idle";

  // Not ready. `running` means the agent is actively working the turn;
  // anything else at this point is the session still coming up.
  return session.runtime_state === "running" ? "generating" : "starting";
}

/** Should the generation loader be on screen? */
export function showsGenerationLoader(state: ChatGenerationState): boolean {
  return state !== "idle";
}

/** Status text for the loader and the composer's toolbar chip.
 *  `slowStart` only changes wording, never whether the loader shows — a start
 *  that has gone on long enough to notice should say so. */
export function generationLabel(state: ChatGenerationState, slowStart = false): string {
  if (state === "generating") return "Generating";
  if (state === "starting") return slowStart ? "Still starting" : "Starting";
  return "";
}
