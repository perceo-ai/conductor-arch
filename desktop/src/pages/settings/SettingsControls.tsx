import {  Show,  type JSX } from "solid-js";
import Icon, { type IconName } from "@/components/Icon";
import PeekCard, { type PeekTriggerProps } from "@/components/PeekCard";

export type SettingsSection = "general" | "clients" | "agents" | "repository" | "advanced";

// Shared settings chrome: the section list, the nav button, and the row/section\n// wrappers every settings pane is built from.
export const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  group: string;
  icon: IconName;
}> = [
  { id: "general", label: "General", group: "Personal", icon: "settings" },
  { id: "clients", label: "Clients", group: "Archcars", icon: "panel-right" },
  { id: "agents", label: "Agents", group: "Agents & environment", icon: "brain" },
  { id: "repository", label: "Repository behavior", group: "Repositories", icon: "folder" },
  { id: "advanced", label: "Advanced", group: "More", icon: "wrench" },
];
export function SettingsNavButton(props: {
  active: boolean;
  icon: IconName;
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button class="settings-nav-button" classList={{ active: props.active }} onClick={props.onClick}>
      <Icon name={props.icon} class="settings-nav-icon" />
      <span class="settings-nav-text">
        <span class="settings-nav-label">{props.label}</span>
        <Show when={props.detail}>
          <span class="settings-nav-detail">{props.detail}</span>
        </Show>
      </span>
    </button>
  );
}

export function SettingsSectionBlock(props: { title: string; children: JSX.Element }) {
  return (
    <section class="settings-section-block">
      <h2>{props.title}</h2>
      <div class="settings-section-list">{props.children}</div>
    </section>
  );
}

export function SettingsRow(props: {
  title: string;
  description?: JSX.Element;
  meta?: JSX.Element;
  control?: JSX.Element;
  accent?: boolean;
}) {
  const renderRow = (peek?: PeekTriggerProps) => (
    <div
      class="settings-row"
      classList={{ "settings-row-accent": props.accent }}
      onPointerEnter={peek?.onPointerEnter}
      onPointerLeave={peek?.onPointerLeave}
    >
      <div class="settings-row-copy">
        <div class="settings-row-title-line">
          <div class="settings-row-title">{props.title}</div>
          {peek ? (
            <span
              ref={peek.ref}
              aria-describedby={peek["aria-describedby"]}
              onFocus={peek.onFocus}
              onBlur={peek.onBlur}
              onKeyDown={peek.onKeyDown}
              class="settings-row-peek-trigger"
              tabIndex={0}
              aria-label={`About ${props.title}`}
            >
              <Icon name="circle-help" />
            </span>
          ) : null}
        </div>
        <Show when={props.description}>
          <div class="settings-row-description">{props.description}</div>
        </Show>
        <Show when={props.meta}>
          <div class="settings-row-meta">{props.meta}</div>
        </Show>
      </div>
      <Show when={props.control}>
        <div class="settings-row-control">{props.control}</div>
      </Show>
    </div>
  );
  return (
    <Show when={props.description || props.meta} fallback={renderRow()}>
      <PeekCard
        content={
          <div class="peek-content settings-help-content">
            <div class="peek-eyebrow">Setting</div>
            <div class="peek-title-row"><strong>{props.title}</strong></div>
            <Show when={props.description}>
              <div class="peek-description">{props.description}</div>
            </Show>
            <Show when={props.meta}>
              <div class="peek-meta">{props.meta}</div>
            </Show>
          </div>
        }
      >
        {(peek) => renderRow(peek)}
      </PeekCard>
    </Show>
  );
}
export function SettingsTextInput(props: {
  value: string;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  return (
    <input
      class="settings-control"
      value={props.value}
      placeholder={props.placeholder}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
}

export function SettingsBoolSelect(props: { value: string; onInput: (value: string) => void }) {
  return (
    <select class="settings-control settings-boolean-control" value={props.value} onChange={(e) => props.onInput(e.currentTarget.value)}>
      <option value="">Inherit</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  );
}
