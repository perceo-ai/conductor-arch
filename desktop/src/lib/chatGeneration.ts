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

  // Not ready. The daemon's runtime vocabulary has three states that all mean
  // "the agent is actively working the turn" — matching only `running` left
  // the chip stuck on "Still starting" through whole streamed replies and
  // tool runs (AgentSessionState::as_str in core/src/session_state.rs).
  if (isGeneratingRuntimeState(session.runtime_state)) return "generating";

  // A not-ready session in a parked or terminal state is not about to produce
  // output — saying "starting" there is the stuck-chip bug in another shape.
  // Anything else (including states this file has never heard of) is treated
  // as still coming up, matching the old behaviour for unknowns.
  if (PARKED_OR_TERMINAL.has(session.runtime_state)) return "idle";
  return "starting";
}

const PARKED_OR_TERMINAL = new Set([
  "waiting_for_input",
  "interrupted",
  "failed",
  "exited",
  "archived",
]);

/** The daemon runtime states in which the agent is actively producing work. */
export function isGeneratingRuntimeState(runtimeState: string): boolean {
  return (
    runtimeState === "running" ||
    runtimeState === "streaming" ||
    runtimeState === "tool_running"
  );
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
