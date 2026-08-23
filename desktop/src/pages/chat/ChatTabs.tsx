import { Show } from "solid-js";
import {
  chatStore,
} from "@/store";
import type {
  ArchcarChatThread,
} from "@/bridge/protocol";
import Icon from "@/components/Icon";

// Tab strips above the chat surface: one row of chat threads, one row of open
// files. Both are pure presentation driven by props.
export function ThreadTab(props: {
  thread: ArchcarChatThread;
  label: string;
  active: boolean;
  queued: number;
  pendingInteraction: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const generating = () => props.thread.status === "running" || props.thread.status === "generating";
  const showFinishedDot = () =>
    !props.active &&
    !generating() &&
    !props.pendingInteraction &&
    chatStore.slice(props.thread.id).completedTurnAttention;
  const showAttentionDot = () => !props.active && props.pendingInteraction;
  return (
    <div
      class="ws-chat-tab-shell ws-tab-shell"
      classList={{ "ws-tab-active": props.active }}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onClick();
        }
      }}
      role="button"
      tabIndex={0}
      title={`${props.thread.provider} · ${props.thread.status || "ready"}`}
    >
      <Show when={showFinishedDot() || showAttentionDot()}>
        <span
          class="ws-chat-tab-dot"
          classList={{ "ws-chat-tab-needs-input": showAttentionDot() }}
        />
      </Show>
      <span class="ws-chat-tab-text">
        <span class="ws-tab-label">{props.label}</span>
      </span>
      <Show when={props.queued > 0}>
        <span class="ws-chat-tab-count">{props.queued}</span>
      </Show>
      <button
        class="ws-tab-close-button"
        title="Close chat"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function FileTab(props: { path: string; active: boolean; onClick: () => void; onClose: () => void }) {
  return (
    <div
      class="ws-chat-tab-shell ws-tab-shell ws-file-tab"
      classList={{ "ws-tab-active": props.active }}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onClick();
        }
      }}
      role="button"
      tabIndex={0}
      title={props.path}
    >
      <Icon name="file" class="ws-file-tab-icon" />
      <span class="ws-tab-label">File</span>
      <button
        class="ws-tab-close-button"
        title="Close file"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

