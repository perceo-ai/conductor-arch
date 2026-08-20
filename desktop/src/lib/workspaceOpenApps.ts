import cursorLogo from "material-icon-theme/icons/cursor.svg?url";
import linuxFolderLogo from "material-icon-theme/icons/folder-linux-open.svg?url";
import macosFolderLogo from "material-icon-theme/icons/folder-macos-open.svg?url";
import windowsFolderLogo from "material-icon-theme/icons/folder-windows-open.svg?url";
import vscodeLogo from "material-icon-theme/icons/vscode.svg?url";

export type WorkspaceOpenAppId = "cursor" | "vscode";

export interface WorkspaceOpenApp {
  id: WorkspaceOpenAppId;
  label: string;
  logoSrc: string;
}

export interface WorkspaceDefaultOpener {
  label: string;
  logoSrc: string;
}

export function workspaceDefaultOpener(platform = globalThis.navigator?.userAgent ?? ""): WorkspaceDefaultOpener {
  const value = platform.toLowerCase();
  if (value.includes("mac")) return { label: "Finder", logoSrc: macosFolderLogo };
  if (value.includes("win")) return { label: "File Explorer", logoSrc: windowsFolderLogo };
  return { label: "File manager", logoSrc: linuxFolderLogo };
}

export const WORKSPACE_OPEN_APPS: WorkspaceOpenApp[] = [
  { id: "cursor", label: "Cursor", logoSrc: cursorLogo },
  { id: "vscode", label: "VS Code", logoSrc: vscodeLogo },
];
