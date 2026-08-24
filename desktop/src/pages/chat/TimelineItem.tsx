import { Match, Show, Switch, createSignal } from "solid-js";
import type {
  ArchcarProjectionItem,
} from "@/bridge/protocol";
import Diff from "@/components/Diff";
import Icon from "@/components/Icon";
import type { IconName } from "@/components/Icon";
import { renderMarkdown, renderMarkdownWithInlineFileChips } from "@/lib/markdown";
import { ansiToHtml } from "@/lib/ansi";
import {
  formatReasoningText,
  inlineEventVerbChip,
  isDiffCard,
  isTerminalCard,
  stripArchductorMetadata,
} from "@/lib/chatFormat";

// One row of the chat timeline. The projection built in core decides which
// shape a row takes; this module owns how each shape renders.
function UserBubble(props: { body: string }) {
  return (
    <div class="chat-user-row">
      <div
        class="chat-user-bubble markdown-body"
        innerHTML={renderMarkdownWithInlineFileChips(stripArchductorMetadata(props.body))}
      />
    </div>
  );
}

export function eventIcon(renderClass: string): IconName {
  if (renderClass === "command_card" || renderClass === "process_card" || renderClass === "background_card")
    return "terminal";
  if (renderClass === "file_card") return "file-text";
  if (renderClass === "diff_card") return "git-compare";
  if (renderClass === "reasoning_card") return "brain";
  if (renderClass === "skill_card" || renderClass === "tool_card" || renderClass === "plugin_card") return "wrench";
  if (renderClass === "subagent_card" || renderClass === "nested_transcript_card") return "bolt";
  return "wrench";
}

// Inline "chip-card" event — GTK's inline_event_widget: a flat row of expander +
// verb (action label) + a small monospace content chip (the command/filename),
// with the body revealed only on expand. No category badge; the row carries no
// card chrome of its own. Bodies stay collapsed until the user asks for them.
function InlineCard(props: { item: ArchcarProjectionItem; agentIdle?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const parsed = () => inlineEventVerbChip(props.item.render_class, props.item.title);
  const verb = () => parsed().verb;
  const chip = () => parsed().chip;
  const hasBody = () => props.item.body.trim().length > 0;
  return (
    <div
      class="chat-inline-event"
      classList={{
        "chat-inline-event-failed": props.item.status === "failed",
        "chat-inline-event-loading": props.item.status === "running" && !props.agentIdle
      }}
    >
      <div class="chat-inline-event-header">
        <button
          class="chat-inline-event-expander"
          title={hasBody() ? "Show details" : undefined}
          disabled={!hasBody()}
          onClick={() => setOpen((o) => !o)}
        >
          <Show when={hasBody()} fallback={<span class="chat-inline-event-dot" />}>
            <span class="chat-inline-event-expander-glyph">{open() ? "−" : "+"}</span>
          </Show>
        </button>
        <Icon name={eventIcon(props.item.render_class)} class="chat-inline-event-icon" />
        <span class="chat-inline-event-action">{verb()}</span>
        <Show when={chip()}>
          <span class="chat-inline-event-chip">
            <span class="chat-inline-event-chip-label">{chip()}</span>
          </span>
        </Show>
      </div>
      <Show when={open() && hasBody()}>
        <Switch fallback={<div class="chat-inline-event-body">{props.item.body}</div>}>
          <Match when={isDiffCard(props.item)}>
            <Diff text={props.item.body} />
          </Match>
          <Match when={isTerminalCard(props.item)}>
            <pre class="chat-inline-event-terminal" innerHTML={ansiToHtml(props.item.body)} />
          </Match>
        </Switch>
      </Show>
    </div>
  );
}

function ReasoningBlock(props: { item: ArchcarProjectionItem }) {
  const body = () => formatReasoningText(props.item.body);
  return (
    <section
      class="chat-reasoning-block"
      classList={{ "chat-reasoning-block-streaming": props.item.stream_state === "streaming" }}
      aria-label="Agent reasoning"
    >
      <div class="chat-reasoning-text">{body()}</div>
    </section>
  );
}

export function TimelineItem(props: { item: ArchcarProjectionItem; agentIdle: boolean }) {
  const cls = () => props.item.render_class;
  return (
    <Switch fallback={<InlineCard item={props.item} agentIdle={props.agentIdle} />}>
      <Match when={cls() === "user_chat"}>
        <UserBubble body={props.item.body} />
      </Match>
      <Match when={cls() === "assistant_chat"}>
        {/* Reasoning already marked itself as streaming; agent prose did not,
            so a reply still arriving looked identical to a finished one and new
            text simply appeared. */}
        <div
          class="chat-agent-text markdown-body"
          classList={{ "chat-stream-active": props.item.stream_state === "streaming" }}
          innerHTML={renderMarkdown(stripArchductorMetadata(props.item.body))}
        />
      </Match>
      <Match when={cls() === "reasoning_card"}>
        <ReasoningBlock item={props.item} />
      </Match>
    </Switch>
  );
}

