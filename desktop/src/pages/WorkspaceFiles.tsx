import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { listWorkspaceFiles, send } from "@/bridge/client";
import { materialFileIcon, materialFolderIcon } from "@/lib/materialFileIcons";
import { openFileInCenter } from "./openFileBridge";

// Right-panel "Browse" file tree — port of ws_simple_file_list. Core returns a
// flat, capped file list (list_workspace_files); the tree is built client-side
// and directories collapse locally, exactly like the GTK helper.

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === name && c.dir === !isFile);
      if (!child) {
        child = { name, path, dir: !isFile, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  // dirs before files, then byte-wise name order to match the backend's Rust
  // BTreeMap/String ordering (localeCompare would diverge on case/locale).
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function collectDirPaths(nodes: TreeNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (!node.dir) continue;
    into.add(node.path);
    collectDirPaths(node.children, into);
  }
  return into;
}

function MaterialIcon(props: { icon: () => { src: string; title: string }; class: string }) {
  return (
    <img class={`ws-material-icon ${props.class}`} src={props.icon().src} title={props.icon().title} alt="" loading="lazy" />
  );
}

function Row(props: {
  node: TreeNode;
  depth: number;
  collapsed: () => Set<string>;
  toggle: (path: string) => void;
  openFile: (path: string) => void;
}) {
  const isCollapsed = () => props.collapsed().has(props.node.path);
  const indent = () => ({ "padding-left": `${8 + props.depth * 14}px` });
  return (
    <Show
      when={props.node.dir}
      fallback={
        <button class="ws-file-row" style={indent()} onClick={() => props.openFile(props.node.path)}>
          <MaterialIcon icon={() => materialFileIcon(props.node.path)} class="ws-file-kind-icon" />
          <span class="ws-file-name">{props.node.name}</span>
        </button>
      }
    >
      <button class="ws-dir-row" style={indent()} onClick={() => props.toggle(props.node.path)}>
        <MaterialIcon
          icon={() => materialFolderIcon(props.node.path, !isCollapsed())}
          class="ws-folder-kind-icon"
        />
        <span class="ws-folder-name">{props.node.name}</span>
      </button>
      <Show when={!isCollapsed()}>
        <For each={props.node.children}>
          {(child) => (
            <Row
              node={child}
              depth={props.depth + 1}
              collapsed={props.collapsed}
              toggle={props.toggle}
              openFile={props.openFile}
            />
          )}
        </For>
      </Show>
    </Show>
  );
}

export default function WorkspaceFiles(props: { workspace: string; rootPath?: string; openFile?: (path: string) => void }) {
  const openFile = (path: string) => (props.openFile ?? ((file) => openFileInCenter(props.workspace, file)))(path);
  const [files] = createResource(
    () => ({ workspace: props.workspace, rootPath: props.rootPath }),
    async ({ workspace, rootPath }) => {
      try {
        if (rootPath) {
          const local = await listWorkspaceFiles({ rootPath, cap: 400 });
          if (local.ok) return local.files;
        }
        const res = await send({ type: "list_workspace_files", workspace });
        return res.type === "workspace_files" ? res.files : [];
      } catch {
        // Daemon/socket unavailable — render an empty tree instead of throwing.
        return [];
      }
    },
  );
  const tree = createMemo(() => buildTree(files() ?? []));
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  let collapseSeed = "";
  createEffect(() => {
    const paths = files();
    if (!paths) return;
    const nextSeed = `${props.workspace}\0${paths.join("\0")}`;
    if (collapseSeed === nextSeed) return;
    collapseSeed = nextSeed;
    setCollapsed(collectDirPaths(tree()));
  });
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  return (
    <div class="ws-file-list">
      <Show
        when={(files() ?? []).length > 0}
        fallback={<div class="empty-state">{files.loading ? "Loading…" : "No files"}</div>}
      >
        <For each={tree()}>
          {(node) => (
            <Row
              node={node}
              depth={0}
              collapsed={collapsed}
              toggle={toggle}
              openFile={openFile}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
