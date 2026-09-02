import { For, Show, createSignal } from "solid-js";
import {
  actions,
} from "@/store";
import type {
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
  const [other, setOther] = createSignal<Record<string, string>>({});
  const questions = () => props.rec.questions ?? [];
  const isQuestion = () => props.rec.kind === "user_question" && questions().length > 0;

  const answer = (questionId: string, value: string) => {
    if (!value.trim()) return;
    resolve({ type: "answer", answers: [{ question_id: questionId, values: [value] }] });
  };

  return (
    <div class="chat-interaction">
      <div class="chat-interaction-head">
        <span class="chat-interaction-kind">{props.rec.kind.replace(/_/g, " ")}</span>
        <span class="chat-interaction-title">{props.rec.title}</span>
      </div>
      <Show when={isQuestion()} fallback={<PermissionActions rec={props.rec} resolve={resolve} />}>
        <For each={questions()}>
          {(question) => (
            <div class="chat-interaction-question">
              <div class="chat-interaction-detail">{question.question}</div>
              <div class="chat-interaction-actions">
                <For each={question.options}>
                  {(option) => (
                    <button
                      class="ui-button-sm"
                      title={option.description}
                      onClick={() => answer(question.id, option.label)}
                    >
                      {option.label}
                    </button>
                  )}
                </For>
              </div>
              {/* Providers mark a question as accepting free text; without it,
                  answering means picking one of the offered labels. */}
              <Show when={question.allow_other}>
                <div class="chat-interaction-other">
                  <input
                    class="chat-interaction-other-input"
                    placeholder="Answer in your own words…"
                    value={other()[question.id] ?? ""}
                    onInput={(e) =>
                      setOther((prev) => ({ ...prev, [question.id]: e.currentTarget.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      answer(question.id, other()[question.id] ?? "");
                    }}
                  />
                  <button
                    class="ui-button-sm"
                    onClick={() => answer(question.id, other()[question.id] ?? "")}
                  >
                    Send
                  </button>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
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

