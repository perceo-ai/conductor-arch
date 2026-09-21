import Foundation

/// A response the app understands, plus a catch-all.
///
/// P0 decodes only the responses P0 sends requests for. Everything else lands
/// in `.unknown`, which is deliberate: a phone on an older build must degrade
/// to "I don't render that" rather than failing to decode the line at all.
public enum ArchcarResponse: Sendable {
    case ack
    case workspaces([WorkspaceSummary])
    case repositories([RepositorySummary])
    case inventorySnapshot(
        repositories: [RepositorySummary],
        workspaces: [WorkspaceSummary],
        chatThreads: [String: [ChatThread]])
    case remoteAccess(listen: String?, token: String)
    case chatThreads(workspace: String, threads: [ChatThread])
    case chatThreadCreated(ChatThread)
    case chatProjection(threadID: Int64, items: [ProjectionItem])
    case queuedChatInput(QueuedChatInput)
    case queuedChatInputs(threadID: Int64, inputs: [QueuedChatInput])
    case chatPlan(threadID: Int64, planMode: Bool, planPath: String?, planMarkdown: String?)
    case sessionStatus(SessionStatus)
    case sessionSpawned(sessionID: Int64, threadID: Int64, workspace: String, kind: SessionKind)
    /// The spawn was accepted but has not happened yet, so there is no session
    /// id to report. The `session_started` event carries it when it lands.
    case sessionSpawnQueued(workspace: String, kind: SessionKind)
    case workspaceChanges(workspace: String, files: [DiffFileSummary])
    case workspaceDiff(workspace: String, diff: String)
    case todos(workspace: String, todos: [Todo])
    case todoAdded(Todo)
    case checksSummary(workspace: String, summary: ChecksSummary)
    case workflowRuns(workspace: String, summary: WorkflowRunSummary)
    case pullRequestReadiness(workspace: String, text: String)
    case pullRequestDraft(title: String, body: String)
    case pullRequestCreated(workspace: String, output: String)
    case workspaceCreated(name: String)
    case workspaceUpdated(name: String)
    case workspaceRemoved(name: String)
    case repositoryAdded(name: String)
    case agentProviders([AgentProvider])
    case providerInteraction(ProviderInteraction)
    case providerInteractions([ProviderInteraction])
    case error(String)
    case unknown(type: String)
}

extension ArchcarResponse: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, workspaces, repositories, message, listen, token
        case workspace, threads, items, inputs, thread, interaction, interactions, kind
        case threadID = "thread_id"
        case sessionID = "session_id"
        case planMode = "plan_mode"
        case planPath = "plan_path"
        case planMarkdown = "plan_markdown"
        case input, files, todos, todo, summary, diff, text, title, body, output, name
        case providers
        case chatThreads = "chat_threads"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "ack":
            self = .ack
        case "workspaces":
            self = .workspaces(try container.decode([WorkspaceSummary].self, forKey: .workspaces))
        case "repositories":
            self = .repositories(try container.decode([RepositorySummary].self, forKey: .repositories))
        case "inventory_snapshot":
            self = .inventorySnapshot(
                repositories: try container.decode([RepositorySummary].self, forKey: .repositories),
                workspaces: try container.decode([WorkspaceSummary].self, forKey: .workspaces),
                // Keyed by workspace name. This is what makes a cross-workspace
                // "which chats are live" view one request instead of N.
                chatThreads: try container.decodeIfPresent(
                    [String: [ChatThread]].self, forKey: .chatThreads) ?? [:]
            )
        case "remote_access":
            self = .remoteAccess(
                listen: try container.decodeIfPresent(String.self, forKey: .listen),
                token: try container.decode(String.self, forKey: .token)
            )
        case "chat_threads":
            self = .chatThreads(
                workspace: try container.decode(String.self, forKey: .workspace),
                threads: try container.decode([ChatThread].self, forKey: .threads))
        case "chat_thread_created":
            self = .chatThreadCreated(try container.decode(ChatThread.self, forKey: .thread))
        case "chat_projection":
            self = .chatProjection(
                threadID: try container.decode(Int64.self, forKey: .threadID),
                items: try container.decode([ProjectionItem].self, forKey: .items))
        case "queued_chat_input":
            self = .queuedChatInput(try container.decode(QueuedChatInput.self, forKey: .input))
        case "queued_chat_inputs":
            self = .queuedChatInputs(
                threadID: try container.decode(Int64.self, forKey: .threadID),
                inputs: try container.decode([QueuedChatInput].self, forKey: .inputs))
        case "chat_plan":
            self = .chatPlan(
                threadID: try container.decode(Int64.self, forKey: .threadID),
                planMode: try container.decode(Bool.self, forKey: .planMode),
                planPath: try container.decodeIfPresent(String.self, forKey: .planPath),
                planMarkdown: try container.decodeIfPresent(String.self, forKey: .planMarkdown))
        case "session_status":
            self = .sessionStatus(try SessionStatus(from: decoder))
        case "session_spawn_queued":
            self = .sessionSpawnQueued(
                workspace: try container.decode(String.self, forKey: .workspace),
                kind: try container.decode(SessionKind.self, forKey: .kind))
        case "session_spawned":
            self = .sessionSpawned(
                sessionID: try container.decode(Int64.self, forKey: .sessionID),
                threadID: try container.decode(Int64.self, forKey: .threadID),
                workspace: try container.decode(String.self, forKey: .workspace),
                kind: try container.decode(SessionKind.self, forKey: .kind))
        case "workspace_changes":
            self = .workspaceChanges(
                workspace: try container.decode(String.self, forKey: .workspace),
                files: try container.decode([DiffFileSummary].self, forKey: .files))
        case "workspace_diff":
            self = .workspaceDiff(
                workspace: try container.decode(String.self, forKey: .workspace),
                diff: try container.decode(String.self, forKey: .diff))
        case "todos":
            self = .todos(
                workspace: try container.decode(String.self, forKey: .workspace),
                todos: try container.decode([Todo].self, forKey: .todos))
        case "todo_added":
            self = .todoAdded(try container.decode(Todo.self, forKey: .todo))
        case "checks_summary":
            self = .checksSummary(
                workspace: try container.decode(String.self, forKey: .workspace),
                summary: try container.decode(ChecksSummary.self, forKey: .summary))
        case "workflow_runs":
            self = .workflowRuns(
                workspace: try container.decode(String.self, forKey: .workspace),
                summary: try container.decode(WorkflowRunSummary.self, forKey: .summary))
        case "pull_request_readiness":
            self = .pullRequestReadiness(
                workspace: try container.decode(String.self, forKey: .workspace),
                text: try container.decode(String.self, forKey: .text))
        case "pull_request_draft":
            self = .pullRequestDraft(
                title: try container.decode(String.self, forKey: .title),
                body: try container.decode(String.self, forKey: .body))
        case "pull_request_created":
            self = .pullRequestCreated(
                workspace: try container.decode(String.self, forKey: .workspace),
                output: try container.decode(String.self, forKey: .output))
        case "workspace_created":
            self = .workspaceCreated(name: try container.decode(String.self, forKey: .name))
        case "workspace_updated":
            self = .workspaceUpdated(name: try container.decode(String.self, forKey: .name))
        case "workspace_removed":
            self = .workspaceRemoved(name: try container.decode(String.self, forKey: .name))
        case "repository_added":
            self = .repositoryAdded(name: try container.decode(String.self, forKey: .name))
        case "agent_providers":
            self = .agentProviders(try container.decode([AgentProvider].self, forKey: .providers))
        case "provider_interaction":
            self = .providerInteraction(
                try container.decode(ProviderInteraction.self, forKey: .interaction))
        case "provider_interactions":
            self = .providerInteractions(
                try container.decode([ProviderInteraction].self, forKey: .interactions))
        case "error":
            self = .error(try container.decode(String.self, forKey: .message))
        default:
            self = .unknown(type: type)
        }
    }
}

public struct ResponseEnvelope: Decodable, Sendable {
    public let id: String
    public let payload: ArchcarResponse
}
