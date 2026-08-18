import type { JSX } from "solid-js";

export type IconName =
  | "alert"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "arrow-down"
  | "bolt"
  | "brain"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
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
  | "panel-left"
  | "panel-right"
  | "paperclip"
  | "play"
  | "plus"
  | "circle-check"
  | "send"
  | "sidebar"
  | "settings"
  | "square"
  | "terminal"
  | "wrench"
  | "x";

// Each entry is a factory: Solid JSX evaluates to real DOM nodes, so a shared
// node would be *moved* into the last <Icon> that rendered it, blanking every
// earlier one (icon lists render the same name many times).
const PATHS: Record<IconName, () => JSX.Element> = {
  alert: () => <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  "arrow-left": () => <path d="M19 12H5m6-6-6 6 6 6" />,
  "arrow-right": () => <path d="M5 12h14m-6-6 6 6-6 6" />,
  "arrow-up": () => <path d="M12 19V5m-6 6 6-6 6 6" />,
  "arrow-down": () => <path d="M12 5v14m6-6-6 6-6-6" />,
  bolt: () => <path d="m13 2-8 13h7l-1 7 8-13h-7l1-7z" />,
  brain: () => <><path d="M9.5 2A3.5 3.5 0 0 0 6 5.5v.2A3.5 3.5 0 0 0 4 9a3.5 3.5 0 0 0 1.2 2.6A3.5 3.5 0 0 0 8.5 16H10V5.5A3.5 3.5 0 0 0 9.5 2Z" /><path d="M14.5 2A3.5 3.5 0 0 1 18 5.5v.2A3.5 3.5 0 0 1 20 9a3.5 3.5 0 0 1-1.2 2.6A3.5 3.5 0 0 1 15.5 16H14V5.5A3.5 3.5 0 0 1 14.5 2Z" /><path d="M10 16v2a4 4 0 0 0 4 4v-6" /></>,
  "chevron-down": () => <path d="m6 9 6 6 6-6" />,
  "chevron-left": () => <path d="m15 18-6-6 6-6" />,
  "chevron-right": () => <path d="m9 18 6-6-6-6" />,
  "chevron-up": () => <path d="m18 15-6-6-6 6" />,
  external: () => <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
  file: () => <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
  "file-code": () => <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="m10 13-2 2 2 2" /><path d="m14 17 2-2-2-2" /></>,
  "file-text": () => <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h5" /></>,
  folder: () => <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>,
  "git-merge": () => <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 9v6a3 3 0 0 0 3 3h6" /><path d="M6 9a9 9 0 0 0 9 9" /></>,
  "git-compare": () => <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M6 9v7a2 2 0 0 0 2 2h3" /></>,
  "git-pull-request": () => <><circle cx="6" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v6" /><path d="M18 15v-2a4 4 0 0 0-4-4h-3" /><path d="m14 6-3 3 3 3" /></>,
  history: () => <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></>,
  "layout-dashboard": () => <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>,
  "panel-left": () => <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  "panel-right": () => <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  paperclip: () => <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />,
  play: () => <path d="m6 3 15 9-15 9V3z" />,
  plus: () => <path d="M12 5v14m-7-7h14" />,
  "circle-check": () => <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.6 2.6L16 9" /></>,
  send: () => <path d="m22 2-7 20-4-9-9-4 20-7z" />,
  sidebar: () => <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16" /></>,
  settings: () => <><path d="M12.2 2h-.4l-.8 3.1a7 7 0 0 0-1.8.7L6.4 4.1l-.3.3-2 3.5.3.2 2.3.7a7 7 0 0 0 0 2.4l-2.3.7-.3.2 2 3.5.3.3 2.8-1.7a7 7 0 0 0 1.8.7l.8 3.1h.4l.8-3.1a7 7 0 0 0 1.8-.7l2.8 1.7.3-.3 2-3.5-.3-.2-2.3-.7a7 7 0 0 0 0-2.4l2.3-.7.3-.2-2-3.5-.3-.3-2.8 1.7a7 7 0 0 0-1.8-.7L12.2 2Z" /><circle cx="12" cy="12" r="2.5" /></>,
  square: () => <rect x="6" y="6" width="12" height="12" rx="2" />,
  terminal: () => <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  wrench: () => <><path d="M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-2.8-2.8 2.2-2.6Z" /></>,
  x: () => <path d="M18 6 6 18M6 6l12 12" />,
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
