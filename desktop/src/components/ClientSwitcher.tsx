import { onMount, Show } from "solid-js";

import { clientsStore, dialogs, nav } from "@/store";
import { openContextMenu, openContextMenuFromKeyboard, type ContextMenuItem } from "./ContextMenu";
import Icon from "./Icon";

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
    if (clientsStore.pinned()) return "pinned by environment";
    const state = clientsStore.state;
    const active = state.clients.find((c) => c.id === state.activeId);
    return active?.address ?? "local daemon";
  };

  return (
    <div class="client-switcher">
      <button
        class="client-switcher-button"
        disabled={clientsStore.state.busy || clientsStore.pinned()}
        title={
          clientsStore.pinned()
            ? `ARCHDUCTOR_ARCHCAR_REMOTE pins this app to ${clientsStore.state.envAddress}`
            : "Switch client"
        }
        onClick={(e) => openContextMenu(e, items())}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") openContextMenuFromKeyboard(e, items());
        }}
      >
        <Icon
          name={clientsStore.state.activeId === null ? "monitor" : "cloud"}
          class="client-switcher-icon"
        />
        <span class="client-switcher-text">
          <span class="client-switcher-label">{clientsStore.activeLabel()}</span>
          <span class="client-switcher-address">{subtitle()}</span>
        </span>
        <Show when={!clientsStore.pinned()}>
          <Icon name="chevron-down" class="client-switcher-chevron" />
        </Show>
      </button>
    </div>
  );
}
