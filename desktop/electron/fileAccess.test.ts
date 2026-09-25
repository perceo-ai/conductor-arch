import { describe, expect, it } from "vitest";

import { FULL_DISK_ACCESS_URL, restartArgs } from "./fileAccess";

// The deep link and the launchctl invocation are the whole contract here: both
// are strings macOS either accepts or silently ignores, so they are pinned.
describe("fileAccess", () => {
  it("deep-links the Full Disk Access pane", () => {
    expect(FULL_DISK_ACCESS_URL).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    );
  });

  it("kickstarts the agent in the user's gui domain", () => {
    expect(restartArgs(501)).toEqual([
      "kickstart",
      "-k",
      "gui/501/ai.perceo.archductor.archcar",
    ]);
  });
});
