import { For, Show, type JSX } from "solid-js";
import Icon from "@/components/Icon";
import type { QueuedArchcarInput } from "@/bridge/protocol";
import { configuredShortcut } from "@/lib/configuredShortcut";

// Presentational pieces of the composer. Each takes everything it needs as
// props and owns no state, so the composer's reactive graph stays in one place
// and these can be read (and changed) without holding that graph in your head.
//
// Props are read inside the JSX rather than destructured — Solid props are
// getters, and destructuring them at the top of a component reads each value
// once and freezes it.

/** Failed send or failed session start. Offers the only two useful next steps:
 *  restart the agent, or dismiss and carry on typing. */
export function ComposerErrorBanner(props: {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div class="chat-error-banner" role="alert">
      <Icon name="alert" class="chat-error-banner-icon" />
      <span class="chat-error-banner-text">{props.message}</span>
      <button class="chat-error-banner-btn" onClick={() => props.onRetry()}>
        Restart agent
      </button>
      <button
        class="chat-error-banner-btn chat-error-banner-dismiss"
        title="Dismiss"
        onClick={() => props.onDismiss()}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

/** Inputs typed while the agent was busy, in the order they will be delivered. */
export function ComposerQueue(props: {
  queue: QueuedArchcarInput[];
  /** False before a session exists — there is nothing to steer into yet. */
  canSteer: boolean;
  onMove: (id: number, up: boolean) => void;
  onSteer: (q: QueuedArchcarInput) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <div class="chat-queue-overlay">
      <div class="chat-queue-heading">Queued</div>
      <For each={props.queue}>
        {(q) => (
          <div class="chat-queued-composer-row">
            <span class="chat-queued-composer-body">{q.visible_input ?? q.input}</span>
            <div class="chat-queued-actions">
              <button
                class="chat-queued-action-btn"
                title="Move up"
                onClick={() => props.onMove(q.id, true)}
              >
                <Icon name="arrow-up" />
              </button>
              <button
                class="chat-queued-action-btn"
                title="Move down"
                onClick={() => props.onMove(q.id, false)}
              >
                <Icon name="arrow-down" />
              </button>
              <button
                class="chat-queued-action-btn"
                title="Send now"
                disabled={!props.canSteer}
                onClick={() => props.onSteer(q)}
              >
                <Icon name="bolt" />
              </button>
              <button
                class="chat-queued-action-btn"
                title="Remove queued message"
                onClick={() => props.onRemove(q.id)}
              >
                <Icon name="x" />
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

/** Autocomplete list for an @file or /skill mention.
 *
 *  Generic over the item type so the file and skill menus share one keyboard
 *  and selection model — they had identical markup and drifting behaviour when
 *  they were two copies. `renderItem` supplies the two label spans. */
export function MentionMenu<T>(props: {
  items: T[];
  cursor: number;
  onHover: (index: number) => void;
  onPick: (item: T) => void;
  renderItem: (item: T) => JSX.Element;
  class?: string;
}) {
  return (
    <div class={`chat-file-mention-menu ${props.class ?? ""}`} role="listbox">
      <For each={props.items}>
        {(item, i) => (
          <button
            class="chat-file-mention-item"
            classList={{ "chat-file-mention-item-active": i() === props.cursor }}
            role="option"
            aria-selected={i() === props.cursor}
            onMouseEnter={() => props.onHover(i())}
            // mousedown, not click: the textarea would blur first on click and
            // the menu would unmount before the selection landed.
            onMouseDown={(e) => {
              e.preventDefault();
              props.onPick(item);
            }}
          >
            {props.renderItem(item)}
          </button>
        )}
      </For>
    </div>
  );
}

/** The status chip on the right of the toolbar. Exactly one of the three
 *  states shows at a time; they are ordered by how much they need the user. */
export function ComposerStatus(props: {
  contextPercent: number | null;
  awaitingUser: boolean;
  busy: boolean;
  busyLabel: string;
  busyTitle: string;
}) {
  return (
    <>
      <Show when={props.contextPercent != null}>
        <span class="chat-context-usage" title="Context window used">
          <Icon name="panel-right" class="chat-context-usage-icon" />
          <span>{props.contextPercent}%</span>
        </span>
      </Show>
      <Show when={props.awaitingUser}>
        <span class="chat-context-usage" title="The agent is waiting on your answer">
          <Icon name="alert" class="chat-context-usage-icon" />
          <span>Waiting for you</span>
        </span>
      </Show>
      <Show when={!props.awaitingUser && props.busy}>
        <span class="chat-context-usage" title={props.busyTitle}>
          <Icon name="bolt" class="chat-context-usage-icon" />
          <span>{props.busyLabel}</span>
        </span>
      </Show>
    </>
  );
}

/** Send, or interrupt a turn in flight. One control in two modes rather than
 *  two controls, so the primary action is always in the same place. */
export function ComposerSendButton(props: {
  interrupting: boolean;
  hasText: boolean;
  onActivate: () => void;
}) {
  return (
    <Show
      when={props.interrupting}
      fallback={
        <button
          class="chat-send-btn"
          classList={{ "chat-send-btn-active": props.hasText }}
          data-shortcut={configuredShortcut("send-immediate")}
          onClick={() => props.onActivate()}
          title="Send"
          disabled={!props.hasText}
        >
          <Icon name="arrow-up" />
        </button>
      }
    >
      <button class="chat-send-btn chat-stop-btn" onClick={() => props.onActivate()} title="Interrupt">
        <Icon name="square" />
      </button>
    </Show>
  );
}

/** A toolbar toggle (Fast, Plan). */
export function ComposerToggle(props: {
  on: boolean;
  title: string;
  icon: "bolt" | "file-text";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      class="chat-plan-toggle"
      classList={{ "chat-plan-toggle-on": props.on }}
      title={props.title}
      data-shortcut={props.label === "Plan" ? configuredShortcut("toggle-plan-mode") : undefined}
      onClick={() => props.onClick()}
    >
      <Icon name={props.icon} />
      <span>{props.label}</span>
    </button>
  );
}
