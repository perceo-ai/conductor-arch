import { toastsStore } from "@/store/toasts";

// `openExternal`/`openWorkspaceApp` report failure by resolving `{ok:false}`
// rather than rejecting, so a plain `.catch()` swallows them — that is why
// "Open" against a remote workspace looked like a dead button. Check the
// payload, not just the promise.

export interface ShellResult {
  ok: boolean;
  error?: string;
}

/** The message to show for a shell result, or null when it succeeded. */
export function shellFailureMessage(label: string, res: ShellResult | undefined): string | null {
  if (res?.ok) return null;
  const detail = res?.error?.trim();
  return detail ? `${label} failed: ${detail}` : `${label} failed.`;
}

/** Run a shell-style IPC call and toast both rejections and `{ok:false}`. */
export function runShellAction(label: string, p: Promise<ShellResult>): void {
  void p
    .then((res) => {
      const message = shellFailureMessage(label, res);
      if (message) toastsStore.error(message);
    })
    .catch((err) => toastsStore.error(`${label} failed: ${(err as Error).message}`));
}
