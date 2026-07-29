// Small presentation helpers ported from the GTK app so labels match exactly.

/** Port of gtk-app main.rs::title_case_workspace. */
export function titleCaseWorkspace(name: string): string {
  return name
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
