import iconTheme from "material-icon-theme/dist/material-icons.json";

interface IconDefinition {
  iconPath?: string;
}

interface MaterialIconTheme {
  iconDefinitions: Record<string, IconDefinition>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}

export interface MaterialFileIcon {
  src: string;
  title: string;
}

const theme = iconTheme as MaterialIconTheme;
const iconUrls = import.meta.glob("/node_modules/material-icon-theme/icons/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function iconUrl(iconId: string): string {
  const iconPath = theme.iconDefinitions[iconId]?.iconPath;
  const file = iconPath ? basename(iconPath) : "file.svg";
  return iconUrls[`/node_modules/material-icon-theme/icons/${file}`] ?? iconUrls["/node_modules/material-icon-theme/icons/file.svg"] ?? "";
}

function extensionIconId(name: string): string | undefined {
  const parts = name.split(".");
  for (let index = 1; index < parts.length; index++) {
    const extension = parts.slice(index).join(".");
    const icon = theme.fileExtensions[extension];
    if (icon) return icon;
  }
  return undefined;
}

export function materialFileIcon(path: string): MaterialFileIcon {
  const name = basename(path).toLowerCase();
  const iconId = theme.fileNames[name] ?? extensionIconId(name) ?? theme.file;
  return { src: iconUrl(iconId), title: iconId };
}

export function materialFolderIcon(path: string, expanded: boolean): MaterialFileIcon {
  const name = basename(path).toLowerCase();
  const iconId = expanded
    ? theme.folderNamesExpanded[name] ?? theme.folderExpanded
    : theme.folderNames[name] ?? theme.folder;
  return { src: iconUrl(iconId), title: iconId };
}
