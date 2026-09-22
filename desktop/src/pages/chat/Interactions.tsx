import { For, Show, createSignal } from "solid-js";
import {
  actions,
} from "@/store";
import type {
  InteractionQuestion,
  ProviderInteractionRecord,
  ProviderInteractionResolution,
} from "@/bridge/protocol";
import Icon from "@/components/Icon";
import { renderMarkdown } from "@/lib/markdown";
import { configuredShortcut } from "@/lib/configuredShortcut";
import { openFileInCenter } from "@/pages/openFileBridge";

// Agent-initiated interactions: permission prompts, questions, and plan
// approvals. Rendered above the composer, because resolving one is the next
// thing the user has to do before the turn can continue.
// Agent asked for something mid-turn (permission / question / plan approval).
// Rendered above the composer with actionable buttons; resolving it unblocks the
// turn (else tools that require approval silently stall).
export function InteractionBanner(props: { rec: ProviderInteractionRecord }) {
  const resolve = (resolution: ProviderInteractionResolution) =>
    void actions.resolveInteraction(props.rec.id, resolution).catch(() => {});
  const questions = () => props.rec.questions ?? [];
  const isQuestion = () => props.rec.kind === "user_question" && questions().length > 0;

  return (
    <div class="chat-interaction">
      <div class="chat-interaction-head">
        <span class="chat-interaction-kind">{props.rec.kind.replace(/_/g, " ")}</span>
        <span class="chat-interaction-title">{props.rec.title}</span>
      </div>
      <Show when={isQuestion()} fallback={<PermissionActions rec={props.rec} resolve={resolve} />}>
        <QuestionWizard questions={questions()} resolve={resolve} />
      </Show>
    </div>
  );
}

// A multi-question ask is a wizard, not a wall: one question at a time, its
// options numbered, arrows to move between them, and a single resolve at the
// end carrying every answer. Answering each question the moment it was clicked
// resolved the whole interaction on the first click and threw the rest away.
function QuestionWizard(props: {
  questions: InteractionQuestion[];
  resolve: (resolution: ProviderInteractionResolution) => void;
}) {
  const [index, setIndex] = createSignal(0);
  const [picked, setPicked] = createSignal<Record<string, string[]>>({});
  const [other, setOther] = createSignal<Record<string, string>>({});

  const current = () => props.questions[Math.min(index(), props.questions.length - 1)];
  const isLast = () => index() >= props.questions.length - 1;
  const valuesFor = (question: InteractionQuestion) => {
    const typed = (other()[question.id] ?? "").trim();
    const chosen = picked()[question.id] ?? [];
    return typed ? [...chosen, typed] : chosen;
  };
  const isPicked = (question: InteractionQuestion, label: string) =>
    (picked()[question.id] ?? []).includes(label);

  const toggle = (question: InteractionQuestion, label: string) =>
    setPicked((prev) => {
      const chosen = prev[question.id] ?? [];
      if (!question.multi_select) {
        return { ...prev, [question.id]: chosen.includes(label) ? [] : [label] };
      }
      return {
        ...prev,
        [question.id]: chosen.includes(label)
          ? chosen.filter((it) => it !== label)
          : [...chosen, label],
      };
    });

  const go = (delta: number) =>
    setIndex((prev) => Math.min(props.questions.length - 1, Math.max(0, prev + delta)));

  const submit = () => {
    const answers = props.questions
      .map((question) => ({ question_id: question.id, values: valuesFor(question) }))
      .filter((answer) => answer.values.length > 0);
    if (answers.length === 0) return;
    props.resolve({ type: "answer", answers });
  };

  const advance = () => (isLast() ? submit() : go(1));

  // Arrows page between questions and digits pick an option, but only when the
  // user is not typing their own answer — there the same keys are text.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    } else if (/^[1-9]$/.test(event.key)) {
      const option = current().options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      toggle(current(), option.label);
    }
  };

  return (
    <div class="chat-interaction-question" onKeyDown={onKeyDown}>
      <div class="chat-interaction-question-head">
        <span class="chat-interaction-question-text">{current().question}</span>
        <Show when={props.questions.length > 1}>
          <div class="chat-interaction-question-nav">
            <button
              class="ui-button-sm chat-interaction-nav-button"
              aria-label="Previous question"
              disabled={index() === 0}
              onClick={() => go(-1)}
            >
              <Icon name="chevron-left" />
            </button>
            <span class="chat-interaction-question-count">
              {index() + 1}/{props.questions.length}
            </span>
            <button
              class="ui-button-sm chat-interaction-nav-button"
              aria-label="Next question"
              disabled={isLast()}
              onClick={() => go(1)}
            >
              <Icon name="chevron-right" />
            </button>
          </div>
        </Show>
      </div>
      <div class="chat-interaction-options">
        <For each={current().options}>
          {(option, i) => (
            <button
              class="chat-interaction-option"
              classList={{ "is-picked": isPicked(current(), option.label) }}
              aria-pressed={isPicked(current(), option.label)}
              title={option.description}
              onClick={() => toggle(current(), option.label)}
            >
              <span class="chat-interaction-option-index">{i() + 1})</span>
              <span class="chat-interaction-option-label">{option.label}</span>
              <Show when={option.description}>
                <span class="chat-interaction-option-desc">{option.description}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <div class="chat-interaction-question-foot">
        {/* Providers mark a question as accepting free text; without it,
            answering means picking one of the offered labels. */}
        <Show
          when={current().allow_other}
          fallback={<span class="chat-interaction-question-hint">Pick an option</span>}
        >
          <input
            class="chat-interaction-other-input"
            placeholder="Type your own…"
            value={other()[current().id] ?? ""}
            onInput={(e) =>
              setOther((prev) => ({ ...prev, [current().id]: e.currentTarget.value }))
            }
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              advance();
            }}
          />
        </Show>
        <button
          class="ui-button-primary chat-interaction-advance"
          disabled={valuesFor(current()).length === 0}
          onClick={advance}
        >
          {isLast() ? "Submit" : "Next"}
        </button>
      </div>
    </div>
  );
}

function PermissionActions(props: {
  rec: ProviderInteractionRecord;
  resolve: (resolution: ProviderInteractionResolution) => void;
}) {
  return (
    <>
      <Show when={props.rec.detail.trim()}>
        <div class="chat-interaction-detail">{props.rec.detail}</div>
      </Show>
      <div class="chat-interaction-actions">
        <button class="ui-button-primary" onClick={() => props.resolve({ type: "approve" })}>
          Allow
        </button>
        <button
          class="ui-button-sm"
          title="Allow this and anything like it for the rest of the session"
          onClick={() => props.resolve({ type: "approve_for_session" })}
        >
          Allow for session
        </button>
        <button class="ui-button-destructive" onClick={() => props.resolve({ type: "deny" })}>
          Deny
        </button>
      </div>
    </>
  );
}

// The plan the agent proposed, rendered inline in the timeline as the message
// it is, with its own actions. It used to be pinned above the composer with
// approve living in the composer's chrome — which split one object across two
// surfaces and put the plan somewhere the scrollback could not reach.
export function PlanCard(props: { rec: ProviderInteractionRecord; workspace: string }) {
  return (
    <div class="chat-plan-card">
      <div class="chat-plan-card-head">
        <Icon name="file-text" class="chat-plan-card-icon" />
        <span class="chat-plan-card-title">Proposed plan</span>
        <Show when={props.rec.plan_path}>
          {(path) => <span class="chat-plan-card-path">{path()}</span>}
        </Show>
      </div>
      <div
        class="chat-plan-card-body markdown-body"
        innerHTML={renderMarkdown(props.rec.detail)}
      />
      <div class="chat-plan-card-actions">
        <Show when={props.rec.plan_path}>
          {(path) => (
            <button
              class="ui-button-sm chat-plan-card-open"
              onClick={() => openFileInCenter(props.workspace, path())}
            >
              <Icon name="external" />
              Open plan
            </button>
          )}
        </Show>
        <span class="chat-plan-card-hint">or say what to change</span>
        <button
          class="ui-button-primary chat-plan-approve"
          data-shortcut={configuredShortcut("approve-plan")}
          onClick={() =>
            void actions.resolveInteraction(props.rec.id, { type: "approve" }).catch(() => {})
          }
        >
          Approve &amp; build
        </button>
      </div>
    </div>
  );
}

