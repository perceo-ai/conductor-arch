import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Do-not-disturb, where the platform actually exposes it.
//
// - Linux (GNOME and derivatives): `org.gnome.desktop.notifications
//   show-banners` is the toggle behind the shell's "Do Not Disturb" switch.
// - macOS: Focus has no public API since Monterey (the old `doNotDisturb`
//   user default is gone), so this reports false.
// - Windows: Focus Assist has no public API either; reports false.
//
// Every failure answers false: no gsettings, a non-GNOME desktop, a timeout.
// Missing a silence is a smaller harm than swallowing the one signal that a
// chat needs the operator.

/** `gsettings get … show-banners` prints `false` exactly when DND is on. */
export function gnomeShowBannersMeansDnd(stdout: string): boolean {
  return stdout.trim() === "false";
}

export async function doNotDisturbActive(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "linux") return false;
  try {
    const { stdout } = await execFileP(
      "gsettings",
      ["get", "org.gnome.desktop.notifications", "show-banners"],
      { timeout: 1000 },
    );
    return gnomeShowBannersMeansDnd(stdout);
  } catch {
    return false;
  }
}
