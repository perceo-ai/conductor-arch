import type { JSX } from "solid-js";

export type IconName =
  | "alert"
  | "alert-circle"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "arrow-up-circle"
  | "arrow-down"
  | "arrow-down-circle"
  | "bolt"
  | "brain"
  | "circle-dashed"
  | "circle-dot"
  | "circle-help"
  | "circle-slash"
  | "circle-x"
  | "git-branch"
  | "loader-circle"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "cloud"
  | "external"
  | "file"
  | "file-code"
  | "file-text"
  | "folder"
  | "git-merge"
  | "git-compare"
  | "git-pull-request"
  | "history"
  | "layout-dashboard"
  | "monitor"
  | "panel-left"
  | "panel-right"
  | "paperclip"
  | "pencil"
  | "play"
  | "plus"
  | "refresh"
  | "search"
  | "circle-check"
  | "send"
  | "sidebar"
  | "settings"
  | "square"
  | "terminal"
  | "wrench"
  | "x";

// Geometry is Lucide's (https://lucide.dev, ISC licence), transcribed verbatim
// from `lucide-static@1.34.0`. Verbatim matters: Lucide draws every glyph on a
// 24×24 grid with a shared vocabulary — one ring radius, one frame corner, one
// stroke weight, consistent optical bounds. Icons redrawn freehand each satisfy
// their own name but disagree with each other, and a toolbar of them reads as
// wobbly even though no single icon looks obviously wrong.
//
// So: when adding an icon, copy the path out of Lucide rather than drawing one.
// `Icon.test.tsx` asserts the shared vocabulary holds.
//
// Each entry is a factory: Solid JSX evaluates to real DOM nodes, so a shared
// node would be *moved* into the last <Icon> that rendered it, blanking every
// earlier one (icon lists render the same name many times).
const PATHS: Record<IconName, () => JSX.Element> = {
  alert: () => <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  "alert-circle": () => <><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></>,
  "arrow-left": () => <><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>,
  "arrow-right": () => <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
  "arrow-up": () => <><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></>,
  "arrow-up-circle": () => <><circle cx="12" cy="12" r="10" /><path d="m16 12-4-4-4 4" /><path d="M12 16V8" /></>,
  "arrow-down": () => <><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>,
  "arrow-down-circle": () => <><circle cx="12" cy="12" r="10" /><path d="M12 8v8" /><path d="m8 12 4 4 4-4" /></>,
  // Dashed ring: "nothing here yet", visually lighter than any solid ring so an
  // untouched workspace recedes in a long list.
  "circle-dashed": () => <><path d="M10.1 2.182a10 10 0 0 1 3.8 0" /><path d="M13.9 21.818a10 10 0 0 1-3.8 0" /><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /><path d="M2.182 13.9a10 10 0 0 1 0-3.8" /><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /><path d="M21.818 10.1a10 10 0 0 1 0 3.8" /><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" /></>,
  // The inner dot is a stroked r=1 circle rather than a filled disc: at 2px it
  // reads as solid anyway, and it keeps every mark in the set the same weight.
  "circle-dot": () => <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1" /></>,
  "circle-help": () => <><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>,
  "circle-slash": () => <><circle cx="12" cy="12" r="10" /><line x1="9" x2="15" y1="15" y2="9" /></>,
  "circle-x": () => <><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></>,
  "git-branch": () => <><path d="M15 6a9 9 0 0 0-9 9V3" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /></>,
  // Broken ring — the gap is what makes rotation legible; a full circle spinning
  // looks static.
  "loader-circle": () => <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  bolt: () => <path d="M15.914 4a1.5 1.5 0 0 0-2.474-1.561l-9 9A1.5 1.5 0 0 0 5.5 14h4.002a.5.5 0 0 1 .471.666L8.086 20a1.5 1.5 0 0 0 2.475 1.56l9-9A1.5 1.5 0 0 0 18.5 10h-3.997a.5.5 0 0 1-.472-.667z" />,
  brain: () => <><path d="M12 18V5" /><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" /><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" /><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" /><path d="M18 18a4 4 0 0 0 2-7.464" /><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" /><path d="M6 18a4 4 0 0 1-2-7.464" /><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" /></>,
  "chevron-down": () => <path d="m6 9 6 6 6-6" />,
  "chevron-left": () => <path d="m15 18-6-6 6-6" />,
  "chevron-right": () => <path d="m9 18 6-6-6-6" />,
  "chevron-up": () => <path d="m18 15-6-6-6 6" />,
  cloud: () => <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  external: () => <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  file: () => <><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /></>,
  "file-code": () => <><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 12.5 8 15l2 2.5" /><path d="m14 12.5 2 2.5-2 2.5" /></>,
  "file-text": () => <><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>,
  folder: () => <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  "git-merge": () => <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></>,
  "git-compare": () => <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M11 18H8a2 2 0 0 1-2-2V9" /></>,
  "git-pull-request": () => <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" x2="6" y1="9" y2="21" /></>,
  history: () => <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>,
  "layout-dashboard": () => <><rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" /></>,
  monitor: () => <><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></>,
  "panel-left": () => <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></>,
  "panel-right": () => <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /></>,
  paperclip: () => <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />,
  pencil: () => <><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></>,
  play: () => <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />,
  plus: () => <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  refresh: () => <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
  "circle-check": () => <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  search: () => <><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>,
  send: () => <><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /><path d="m21.854 2.147-10.94 10.939" /></>,
  // Lucide's `sidebar` is an alias of `panel-left`; both names are in use here.
  sidebar: () => <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></>,
  settings: () => <><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></>,
  square: () => <rect width="18" height="18" x="3" y="3" rx="2" />,
  terminal: () => <><path d="M12 19h8" /><path d="m4 17 6-6-6-6" /></>,
  wrench: () => <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />,
  x: () => <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
};

export default function Icon(props: { name: IconName; class?: string; title?: string }) {
  return (
    <svg
      class={props.class ?? "ui-icon"}
      viewBox="0 0 24 24"
      aria-hidden={props.title ? undefined : "true"}
      role={props.title ? "img" : undefined}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.title ? <title>{props.title}</title> : null}
      {PATHS[props.name]()}
    </svg>
  );
}
