import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type {
  ArchcarProjectionItem,
} from "@/bridge/protocol";
import Diff from "@/components/Diff";
import Icon from "@/components/Icon";
import type { IconName } from "@/components/Icon";
import { renderMarkdown, renderMarkdownWithInlineFileChips } from "@/lib/markdown";
import { ansiToHtml } from "@/lib/ansi";
import { openableChipPath } from "@/lib/fileChip";
import { openFileInCenter } from "@/pages/openFileBridge";
import { TurnForkAction } from "./MessageActions";
import {
  formatReasoningText,
  inlineEventVerbChip,
  isDiffCard,
  isTerminalCard,
  stripArchductorMetadata,
} from "@/lib/chatFormat";
import { showsRunning } from "@/lib/timeline";

// One row of the chat timeline. The projection built in core decides which
// shape a row takes; this module owns how each shape renders.
function UserBubble(props: {
  body: string;
  threadId: number;
  workspace: string;
  files: readonly string[];
}) {
  return (
    <div class="chat-user-row">
      <div
        class="chat-user-bubble markdown-body"
        // A chip in a sent message opens the file it stands for, the same way
        // the composer's chips do — the message is the only record of what was
        // attached, so it has to be the way back to it.
        onClick={(e) => {
          const path = openableChipPath(e.target);
          if (path) openFileInCenter(props.workspace, path);
        }}
        innerHTML={renderMarkdownWithInlineFileChips(stripArchductorMetadata(props.body), {
          threadId: props.threadId,
          files: props.files,
        })}
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
//
// A card that spawned a subagent carries the subagent's own rows. They expand
// with the card, above its report; while it runs, the header shows the latest
// thing the subagent did so the work is visible without opening it.
function InlineCard(props: {
  item: ArchcarProjectionItem;
  running: boolean;
  nested: ArchcarProjectionItem[];
  renderNested: (item: ArchcarProjectionItem) => JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const parsed = () => inlineEventVerbChip(props.item.render_class, props.item.title);
  const verb = () => parsed().verb;
  const chip = () => parsed().chip;
  const hasNested = () => props.nested.length > 0;
  const hasBody = () => props.item.body.trim().length > 0 || hasNested();
  const latest = () => {
    if (!props.running || open()) return null;
    const last = props.nested[props.nested.length - 1];
    if (!last || last.render_class === "nested_transcript_card") return null;
    const step = inlineEventVerbChip(last.render_class, last.title);
    return `${step.verb} ${step.chip}`.trim();
  };
  return (
    <div
      class="chat-inline-event"
      classList={{
        "chat-inline-event-failed": props.item.status === "failed",
        "chat-inline-event-running": props.running
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
        <Show when={latest()}>
          {(step) => <span class="chat-inline-event-latest">{step()}</span>}
        </Show>
      </div>
      <Show when={open() && hasNested()}>
        <div class="chat-inline-event-nested">
          <For each={props.nested}>{(child) => props.renderNested(child)}</For>
        </div>
      </Show>
      <Show when={open() && props.item.body.trim().length > 0}>
        <Switch fallback={<div class="chat-inline-event-body">{props.item.body}</div>}>
          <Match when={hasNested()}>
            {/* A subagent's report is prose, written for the parent agent. */}
            <div
              class="chat-nested-text markdown-body"
              innerHTML={renderMarkdown(stripArchductorMetadata(props.item.body))}
            />
          </Match>
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

export function TimelineItem(props: {
  item: ArchcarProjectionItem;
  agentIdle: boolean;
  sessionAlive: boolean;
  threadId: number;
  workspace: string;
  files: readonly string[];
  forkable: boolean;
  /** Rows nested under each card, keyed by the card's id. */
  childrenOf?: ReadonlyMap<string, ArchcarProjectionItem[]>;
}) {
  const cls = () => props.item.render_class;
  const nested = () => props.childrenOf?.get(props.item.id) ?? [];
  const renderNested = (child: ArchcarProjectionItem) => (
    <TimelineItem {...props} item={child} forkable={false} />
  );
  return (
    <Switch
      fallback={
        <InlineCard
          item={props.item}
          running={showsRunning(props.item, { idle: props.agentIdle, sessionAlive: props.sessionAlive })}
          nested={nested()}
          renderNested={renderNested}
        />
      }
    >
      <Match when={cls() === "user_chat"}>
        <UserBubble
          body={props.item.body}
          threadId={props.threadId}
          workspace={props.workspace}
          files={props.files}
        />
      </Match>
      <Match when={cls() === "assistant_chat"}>
        {/* Reasoning already marked itself as streaming; agent prose did not,
            so a reply still arriving looked identical to a finished one and new
            text simply appeared. */}
        <div class="chat-agent-turn">
          <div class="chat-agent-row">
            <div
              class="chat-agent-text markdown-body"
              classList={{ "chat-stream-active": props.item.stream_state === "streaming" }}
              innerHTML={renderMarkdown(stripArchductorMetadata(props.item.body))}
            />
          </div>
          <Show when={props.forkable && props.item.timeline_seq != null}>
            <TurnForkAction threadId={props.threadId} timelineSeq={props.item.timeline_seq!} />
          </Show>
        </div>
      </Match>
      <Match when={cls() === "reasoning_card"}>
        <ReasoningBlock item={props.item} />
      </Match>
      <Match when={cls() === "nested_transcript_card"}>
        {/* What a subagent said, inside its Agent card. */}
        <div
          class="chat-nested-text markdown-body"
          innerHTML={renderMarkdown(stripArchductorMetadata(props.item.body))}
        />
      </Match>
    </Switch>
  );
}
