import type { JSX } from "solid-js";

type IconName =
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "arrow-down"
  | "bolt"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "external"
  | "file"
  | "folder"
  | "history"
  | "layout-dashboard"
  | "panel-left"
  | "panel-right"
  | "paperclip"
  | "play"
  | "plus"
  | "send"
  | "sidebar"
  | "settings"
  | "square"
  | "terminal"
  | "x";

const PATHS: Record<IconName, JSX.Element> = {
  "arrow-left": <path d="M19 12H5m6-6-6 6 6 6" />,
  "arrow-right": <path d="M5 12h14m-6-6 6 6-6 6" />,
  "arrow-up": <path d="M12 19V5m-6 6 6-6 6 6" />,
  "arrow-down": <path d="M12 5v14m6-6-6 6-6-6" />,
  bolt: <path d="m13 2-8 13h7l-1 7 8-13h-7l1-7z" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "chevron-up": <path d="m18 15-6-6-6 6" />,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></>,
  "layout-dashboard": <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>,
  "panel-left": <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  "panel-right": <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  paperclip: <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />,
  play: <path d="m6 3 15 9-15 9V3z" />,
  plus: <path d="M12 5v14m-7-7h14" />,
  send: <path d="m22 2-7 20-4-9-9-4 20-7z" />,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16" /></>,
  settings: <><path d="M12.2 2h-.4l-.8 3.1a7 7 0 0 0-1.8.7L6.4 4.1l-.3.3-2 3.5.3.2 2.3.7a7 7 0 0 0 0 2.4l-2.3.7-.3.2 2 3.5.3.3 2.8-1.7a7 7 0 0 0 1.8.7l.8 3.1h.4l.8-3.1a7 7 0 0 0 1.8-.7l2.8 1.7.3-.3 2-3.5-.3-.2-2.3-.7a7 7 0 0 0 0-2.4l2.3-.7.3-.2-2-3.5-.3-.3-2.8 1.7a7 7 0 0 0-1.8-.7L12.2 2Z" /><circle cx="12" cy="12" r="2.5" /></>,
  square: <rect x="6" y="6" width="12" height="12" rx="2" />,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  x: <path d="M18 6 6 18M6 6l12 12" />,
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
      {PATHS[props.name]}
    </svg>
  );
}
