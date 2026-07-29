import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";

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
  // dirs before files, alphabetical (mirrors BTreeMap ordering)
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
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
          <span class="ws-file-icon">·</span>
          <span class="ws-file-name">{props.node.name}</span>
        </button>
      }
    >
      <button class="ws-dir-row" style={indent()} onClick={() => props.toggle(props.node.path)}>
        <span class="ws-folder-toggle">{isCollapsed() ? "▸" : "▾"}</span>
        <span class="ws-folder-icon">▪</span>
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

export default function WorkspaceFiles(props: { workspace: string; openFile?: (path: string) => void }) {
  const [files] = createResource(
    () => props.workspace,
    async (ws) => {
      const res = await send({ type: "list_workspace_files", workspace: ws });
      return res.type === "workspace_files" ? res.files : [];
    },
  );
  const tree = createMemo(() => buildTree(files() ?? []));
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
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
              openFile={props.openFile ?? (() => {})}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
