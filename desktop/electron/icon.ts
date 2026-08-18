import fs from "node:fs";
import path from "node:path";

type Platform = NodeJS.Platform;

export type WindowIconOptions = {
  moduleDir: string;
  resourcesPath: string;
  platform: Platform;
  exists?: (candidate: string) => boolean;
};

function runtimeIconName(platform: Platform): string {
  return platform === "win32" ? "icon.ico" : "icon.png";
}

export function resolveWindowIconPath(options: WindowIconOptions): string | undefined {
  const exists = options.exists ?? fs.existsSync;
  const fileName = runtimeIconName(options.platform);
  const candidates = [
    path.join(options.resourcesPath, fileName),
    path.resolve(options.moduleDir, "../build", fileName),
  ];

  return candidates.find((candidate) => exists(candidate));
}
