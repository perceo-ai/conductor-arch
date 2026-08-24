import { onMount, Show } from "solid-js";

import { clientsStore, dialogs, nav } from "@/store";
import { openContextMenu, openContextMenuFromKeyboard, type ContextMenuItem } from "./ContextMenu";
import Icon from "./Icon";
import PeekCard from "./PeekCard";

// Which machine you are working on, above the nav. Archductor can hold any
// number of saved daemons; this is how you move between them without going
// through Settings. The selection is machine-wide (it writes the same profile
// the CLI reads), so switching here also moves `archductor archcar …`.

export default function ClientSwitcher() {
  onMount(() => void clientsStore.refresh());

  const items = (): ContextMenuItem[] => {
    const state = clientsStore.state;
    const rows: ContextMenuItem[] = [
      {
        label: state.activeId === null ? "✓ This machine" : "This machine",
        icon: "monitor",
        run: () => void clientsStore.activate(null),
      },
      ...state.clients.map((client) => ({
        label: `${client.id === state.activeId ? "✓ " : ""}${client.label}`,
        icon: "cloud" as const,
        run: () => void clientsStore.activate(client.id),
      })),
      {
        label: "Add client…",
        icon: "plus",
        run: () => dialogs.open({ kind: "add-client" }),
      },
      {
        label: "Manage clients…",
        icon: "settings",
        run: () => nav.goToPage("settings"),
      },
    ];
    return rows;
  };

  const subtitle = () => {
    if (clientsStore.pinned()) return clientsStore.state.envAddress ?? "pinned by environment";
    const state = clientsStore.state;
    const active = state.clients.find((c) => c.id === state.activeId);
    return active?.address ?? "local daemon";
  };

  return (
    <div class="client-switcher">
      <PeekCard
        content={
          <div class="peek-content client-switcher-peek">
            <div class="peek-eyebrow">Current client</div>
            <div class="peek-title-row"><strong>{clientsStore.activeLabel()}</strong></div>
            <dl class="peek-facts">
              <div>
                <dt>Connection</dt>
                <dd>{subtitle()}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{clientsStore.state.activeId === null ? "This device" : "Remote machine"}</dd>
              </div>
            </dl>
            <Show when={clientsStore.pinned()}>
              <div class="peek-meta">Pinned by ARCHDUCTOR_ARCHCAR_REMOTE</div>
            </Show>
          </div>
        }
      >
        {(peek) => (
          <button
            {...peek}
            class="client-switcher-button"
            disabled={clientsStore.state.busy}
            aria-disabled={clientsStore.pinned() ? "true" : undefined}
            aria-label={
              clientsStore.pinned()
                ? `ARCHDUCTOR_ARCHCAR_REMOTE pins this app to ${clientsStore.state.envAddress}`
                : `Switch client; current client is ${clientsStore.activeLabel()}`
            }
            onClick={(e) => {
              if (!clientsStore.pinned()) openContextMenu(e, items());
            }}
            onKeyDown={(e) => {
              if (typeof peek.onKeyDown === "function") peek.onKeyDown(e);
              if (!clientsStore.pinned() && (e.key === "Enter" || e.key === " ")) {
                openContextMenuFromKeyboard(e, items());
              }
            }}
          >
        {/* The glyph sits in its own tile so the control reads as "an identity
            you can change" rather than as a labelled icon in a box. The tile
            is tinted by kind, which is the fastest way to tell at a glance
            that you are pointed at a remote machine rather than this one. */}
        <span
          class="client-switcher-badge"
          classList={{ "client-switcher-badge-remote": clientsStore.state.activeId !== null }}
        >
          <Icon
            name={clientsStore.state.activeId === null ? "monitor" : "cloud"}
            class="client-switcher-icon"
          />
        </span>
            <span class="client-switcher-text">
              <span class="client-switcher-label">{clientsStore.activeLabel()}</span>
            </span>
        {/* A pinned client cannot be switched, so it gets a lock-ish cue
            instead of the chevron that implies a menu. */}
        <Show when={clientsStore.pinned()}>
          <span class="client-switcher-pinned" title="Pinned by environment" />
        </Show>
        <Show when={!clientsStore.pinned()}>
          <Icon name="chevron-down" class="client-switcher-chevron" />
        </Show>
          </button>
        )}
      </PeekCard>
    </div>
  );
}
