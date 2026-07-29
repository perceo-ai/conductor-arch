import { windowControls } from "@/bridge/client";

// Custom window chrome for the frameless window (Linux/Windows). On macOS the
// native traffic lights are used and this can be hidden via CSS if desired.
export default function WindowControls() {
  const wc = windowControls();
  return (
    <div class="window-controls">
      <button class="chrome-button" onClick={() => wc.minimize()} title="Minimize">
        ─
      </button>
      <button class="chrome-button" onClick={() => wc.toggleMaximize()} title="Maximize">
        ▢
      </button>
      <button class="chrome-button close" onClick={() => wc.close()} title="Close">
        ✕
      </button>
    </div>
  );
}
