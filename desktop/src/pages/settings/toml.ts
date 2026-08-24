/** Minimal TOML read/write for the settings editor.
 *
 * The settings source panes edit raw TOML by hand, and these four functions do
 * the string surgery behind the form controls: find a `[section]`, read one
 * key out of it, and write one key back without disturbing the rest of the
 * file (including comments and key order, which a parse/serialise round-trip
 * would discard).
 *
 * Deliberately not a general TOML implementation — it handles the flat
 * `section.key = scalar` shape the settings files use and nothing else. It
 * lives in its own module because it is pure, is the part most likely to
 * corrupt a user's config, and was previously buried in a 1,254-line component
 * with no tests.
 */

export type TomlValueKind = "string" | "number" | "bool";

export function tomlSectionBounds(lines: string[], section: string): [number, number] | null {
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return [start, end];
}

export function readTomlValue(toml: string, section: string, key: string): string {
  const lines = toml.split("\n");
  const bounds = tomlSectionBounds(lines, section);
  if (!bounds) return "";
  const [, end] = bounds;
  for (let index = bounds[0] + 1; index < end; index += 1) {
    const match = lines[index].match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (!match) continue;
    const raw = match[1].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw.slice(1, -1);
      }
    }
    return raw;
  }
  return "";
}

export function formatTomlValue(value: string, kind: TomlValueKind): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (kind === "bool") return trimmed === "true" ? "true" : trimmed === "false" ? "false" : null;
  if (kind === "number") return /^-?\d+$/.test(trimmed) ? trimmed : null;
  return JSON.stringify(value);
}

export function writeTomlValue(toml: string, section: string, key: string, value: string, kind: TomlValueKind): string {
  const formatted = formatTomlValue(value, kind);
  const lines = toml.trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") lines.length = 0;
  let bounds = tomlSectionBounds(lines, section);
  if (!bounds && formatted == null) return toml;
  if (!bounds) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`[${section}]`);
    bounds = [lines.length - 1, lines.length];
  }
  const [start, end] = bounds;
  const existing = lines.findIndex((line, index) => index > start && index < end && new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (formatted == null) {
    if (existing >= 0) lines.splice(existing, 1);
    return `${lines.join("\n").trimEnd()}\n`;
  }
  const next = `${key} = ${formatted}`;
  if (existing >= 0) {
    lines[existing] = next;
  } else {
    lines.splice(end, 0, next);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
