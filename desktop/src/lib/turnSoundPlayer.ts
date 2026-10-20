// Bundled by Vite into dist/ (or inlined); played from the app's own origin,
// never fetched from the network.
import turnCompleteUrl from "@/assets/sounds/turn-complete.wav?url";

let audio: HTMLAudioElement | null = null;

/** Play the short "chat finished" chime. Silent no-op where audio is unavailable. */
export function playTurnSound(): void {
  if (typeof Audio === "undefined") return;
  try {
    audio ??= new Audio(turnCompleteUrl);
    audio.volume = 0.6;
    audio.currentTime = 0;
    // Rejects with no audio device or a blocked autoplay policy; neither is
    // worth surfacing over a chime.
    void audio.play().catch(() => {});
  } catch {
    // same: best-effort
  }
}
