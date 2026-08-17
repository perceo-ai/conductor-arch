export type ComposerPrimaryAction = "send" | "interrupt";

export function composerPrimaryAction(running: boolean): ComposerPrimaryAction {
  return running ? "interrupt" : "send";
}
