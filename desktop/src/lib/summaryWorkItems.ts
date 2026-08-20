import type { Task, TaskStatus, Todo } from "@/bridge/protocol";
import type { PrCheckRow } from "@/lib/prReadiness";

// Native tasks and todos are the same thing to a human reading the Summary
// tab: a line of outstanding work. They differ only in how much structure the
// record carries, which is not a reason to render them as two panels. Merge
// them into one flat, ordered row list and let the panel stay dumb.

/** Tone vocabulary shared with the Checks tab's `ws-check-glyph`. */
export type WorkItemTone = PrCheckRow["tone"];

export interface SummaryWorkItem {
  /** Stable `<For>` key; task and todo id spaces overlap, so it is prefixed. */
  key: string;
  kind: "task" | "todo";
  id: number;
  title: string;
  status: TaskStatus;
  tone: WorkItemTone;
  /** Muted tail after the title; empty when there is nothing worth saying. */
  detail: string;
  blockedReason: string;
}

// Unfinished work first, finished work last — the panel is read to answer
// "what is outstanding", so `done` sinking to the bottom is the point.
const STATUS_ORDER: Record<TaskStatus, number> = {
  blocked: 0,
  in_progress: 1,
  review: 2,
  todo: 3,
  done: 4,
};

const STATUS_TONE: Record<TaskStatus, WorkItemTone> = {
  blocked: "failed",
  in_progress: "running",
  review: "running",
  todo: "unknown",
  done: "passed",
};

export function workItemTone(status: TaskStatus): WorkItemTone {
  return STATUS_TONE[status] ?? "unknown";
}

/** Todos only ever carry `open` / `done` (see `add_todo` in workspace.rs). */
function todoStatus(status: string): TaskStatus {
  return status === "done" ? "done" : "todo";
}

function taskDetail(task: Task): string {
  return [task.owner?.trim(), task.intended_areas.join(", ")].filter(Boolean).join(" · ");
}

export function mergeWorkItems(tasks: Task[], todos: Todo[]): SummaryWorkItem[] {
  const items: SummaryWorkItem[] = [
    ...tasks.map((task) => ({
      key: `task:${task.id}`,
      kind: "task" as const,
      id: task.id,
      title: task.title,
      status: task.status,
      tone: workItemTone(task.status),
      detail: taskDetail(task),
      blockedReason: task.blocked_reason?.trim() ?? "",
    })),
    ...todos.map((todo) => {
      const status = todoStatus(todo.status);
      return {
        key: `todo:${todo.id}`,
        kind: "todo" as const,
        id: todo.id,
        title: todo.text,
        status,
        tone: workItemTone(status),
        // A context todo was written by an agent reading the chat, not typed
        // by the human; nothing else on the row distinguishes the two.
        detail: todo.source === "context" ? "from chat" : "",
        blockedReason: "",
      };
    }),
  ];

  return items.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      // Tasks carry more context than todos, so they lead within a status.
      (a.kind === b.kind ? 0 : a.kind === "task" ? -1 : 1) ||
      a.id - b.id,
  );
}
