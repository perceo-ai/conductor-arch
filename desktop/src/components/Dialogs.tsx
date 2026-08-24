import {   Show, Switch, Match } from "solid-js";
import {
  dialogs,
  type ConfirmSpec
} from "@/store";
import SyncSkillsDialog from "./SyncSkillsDialog";
import { AddProjectForm } from "./dialogs/AddProjectForm";
import { CreateWorkspaceForm } from "./dialogs/CreateWorkspaceForm";
import { WorkspaceActionsForm } from "./dialogs/WorkspaceActionsForm";
import { ConfirmForm } from "./dialogs/ConfirmForm";
import { BackgroundTaskForm } from "./dialogs/BackgroundTaskForm";
import { AddClientForm } from "./dialogs/AddClientForm";
import { Modal } from "./dialogs/DialogShared";

// Global modal host. Renders the form for the active dialog spec. Every form
// calls into `actions.*`, which logs the action, sends the archcar request, and
// re-pulls the inventory on success.

export default function Dialogs() {
  const spec = dialogs.current;
  const close = () => dialogs.close();
  return (
    <Show when={spec()}>
      {(s) => (
        <Switch>
          <Match when={s().kind === "add-project"}>
            <Modal title="Add project" onClose={close}>
              <AddProjectForm onDone={close} />
            </Modal>
          </Match>
          <Match when={s().kind === "sync-skills"}>
            <Modal title="Sync skills and MCP servers" onClose={close}>
              <SyncSkillsDialog onDone={close} />
            </Modal>
          </Match>
          <Match when={s().kind === "add-client"}>
            <Modal title="Add client" onClose={close}>
              <AddClientForm onDone={close} />
            </Modal>
          </Match>
          <Match when={s().kind === "create-workspace"}>
            <Modal title="New workspace" onClose={close}>
              <CreateWorkspaceForm repository={(s() as { repository: string }).repository} onDone={close} />
            </Modal>
          </Match>
          <Match when={s().kind === "workspace-actions"}>
            <Modal title={`Workspace: ${(s() as { workspace: string }).workspace}`} onClose={close}>
              <WorkspaceActionsForm workspace={(s() as { workspace: string }).workspace} onDone={close} />
            </Modal>
          </Match>
          <Match when={s().kind === "background-task"}>
            <Modal title="New background task" onClose={close}>
              <BackgroundTaskForm
                repository={(s() as { repository: string }).repository}
                onDone={close}
              />
            </Modal>
          </Match>
          <Match when={s().kind === "confirm"}>
            <Modal title={(s() as ConfirmSpec).title} onClose={close}>
              <ConfirmForm spec={s() as ConfirmSpec} onDone={close} />
            </Modal>
          </Match>
        </Switch>
      )}
    </Show>
  );
}
