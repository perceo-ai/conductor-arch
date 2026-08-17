import cursorLogo from "material-icon-theme/icons/cursor.svg?url";
import vscodeLogo from "material-icon-theme/icons/vscode.svg?url";

export type WorkspaceOpenAppId = "cursor" | "vscode";

export interface WorkspaceOpenApp {
  id: WorkspaceOpenAppId;
  label: string;
  logoSrc: string;
}

export const WORKSPACE_OPEN_APPS: WorkspaceOpenApp[] = [
  { id: "cursor", label: "Cursor", logoSrc: cursorLogo },
  { id: "vscode", label: "VS Code", logoSrc: vscodeLogo },
];
