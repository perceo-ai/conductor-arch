export function preferArchcarWorkspaceFileList(input: {
  remoteAddress?: string | null;
  rootPath?: string | null;
}): boolean {
  return !!input.remoteAddress?.trim();
}
