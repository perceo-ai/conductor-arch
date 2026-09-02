// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { panelDescriptor, registerPanel, registeredPanels, unregisterPanel, workspacePanels, type PanelDescriptor } from "./panelRegistry";

describe("panel registry", () => {
  it("registers and unregisters descriptors by stable id", () => {
    const descriptor: PanelDescriptor = {
      id: "test-panel",
      title: "Test panel",
      icon: "terminal",
      kind: "tab",
      component: () => null,
      requiresWorkspace: false,
    };
    registerPanel(descriptor);
    expect(panelDescriptor("test-panel")).toBe(descriptor);
    unregisterPanel("test-panel");
    expect(panelDescriptor("test-panel")).toBeUndefined();
  });

  it("exposes the complete built-in registry and filters workspace panels", () => {
    expect(registeredPanels().map((panel) => panel.id)).toEqual([
      "chat", "pr", "summary", "files", "changes", "checks", "terminal", "todos", "checkpoints", "processes", "timeline", "context",
    ]);
    expect(workspacePanels().every((panel) => panel.requiresWorkspace)).toBe(true);
  });
});
