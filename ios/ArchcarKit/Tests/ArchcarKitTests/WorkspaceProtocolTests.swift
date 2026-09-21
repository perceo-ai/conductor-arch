import Foundation
import Testing

@testable import ArchcarKit

private func payloadObject<Body: ArchcarRequestBody>(_ body: Body) throws -> [String: Any] {
    let line = try RequestEnvelope(id: "1", body: body).encodedLine()
    let object = try #require(try JSONSerialization.jsonObject(with: line) as? [String: Any])
    return try #require(object["payload"] as? [String: Any])
}

private func decodeResponse(_ json: String) throws -> ArchcarResponse {
    try JSONDecoder().decode(ResponseEnvelope.self, from: Data(json.utf8)).payload
}

@Test func encodesWorkspaceLifecycleRequests() throws {
    let create = try payloadObject(
        CreateWorkspaceRequest(repository: "demo", name: "fix-auth", branch: "fix/auth"))
    #expect(create["type"] as? String == "create_workspace")
    #expect(create["branch"] as? String == "fix/auth")
    // base_ref is omitted rather than sent as null, so the daemon applies its
    // own default.
    #expect(create["base_ref"] == nil)

    let prompt = try payloadObject(
        CreateWorkspaceFromPromptRequest(repository: "demo", prompt: "make login work"))
    #expect(prompt["type"] as? String == "create_workspace_from_prompt")
    #expect(prompt["prompt"] as? String == "make login work")

    let issue = try payloadObject(
        CreateWorkspaceFromIssueRequest(repository: "demo", issueNumber: 42))
    #expect(issue["type"] as? String == "create_workspace_from_issue")
    #expect(issue["issue_number"] as? Int == 42)

    let archive = try payloadObject(ArchiveWorkspaceRequest(workspace: "w", removeWorktree: true))
    #expect(archive["type"] as? String == "archive_workspace")
    #expect(archive["remove_worktree"] as? Bool == true)

    let restore = try payloadObject(RestoreWorkspaceRequest(workspace: "w"))
    #expect(restore["type"] as? String == "restore_workspace")
}

@Test func encodesChangeScopesExternallyTagged() throws {
    // serde's default representation, not this protocol's usual {"type": …}:
    // unit cases are bare strings. Getting this wrong makes the daemon close
    // the connection with no answer at all.
    let all = try payloadObject(GetWorkspaceChangesRequest(workspace: "w"))
    #expect(all["scope"] as? String == "all")

    let uncommitted = try payloadObject(
        GetWorkspaceChangesRequest(workspace: "w", scope: .uncommitted))
    #expect(uncommitted["scope"] as? String == "uncommitted")

    let commit = try payloadObject(
        GetWorkspaceDiffRequest(workspace: "w", path: "src/main.rs", scope: .commit(sha: "abc1234")))
    #expect(commit["path"] as? String == "src/main.rs")
    let commitScope = try #require(commit["scope"] as? [String: Any])
    let inner = try #require(commitScope["commit"] as? [String: Any])
    #expect(inner["sha"] as? String == "abc1234")
}

@Test func encodesPullRequestActions() throws {
    #expect(try payloadObject(PushBranchRequest(workspace: "w"))["type"] as? String == "push_branch")
    let create = try payloadObject(CreatePullRequestRequest(workspace: "w", title: "t", draft: true))
    #expect(create["type"] as? String == "create_pull_request")
    #expect(create["draft"] as? Bool == true)
    let merge = try payloadObject(MergePullRequestRequest(workspace: "w", method: "squash"))
    #expect(merge["type"] as? String == "merge_pull_request")
    #expect(merge["method"] as? String == "squash")
}

@Test func decodesWorkspaceChanges() throws {
    let json = """
    {"id":"1","payload":{"type":"workspace_changes","workspace":"w","scope":{"type":"all"},
    "files":[{"path":"crates/core/src/main.rs","additions":12,"deletions":3,"staged":false,
    "unstaged":true,"untracked":false},
    {"path":"notes.md","staged":false,"unstaged":false,"untracked":true}]}}
    """
    guard case .workspaceChanges(_, let files) = try decodeResponse(json) else {
        Issue.record("expected workspace_changes")
        return
    }
    #expect(files.count == 2)
    #expect(files[0].fileName == "main.rs")
    #expect(files[0].directory == "crates/core/src")
    #expect(files[0].additions == 12)
    // An untracked file has no counts at all, which must not fail the decode.
    #expect(files[1].additions == nil)
    #expect(files[1].stateLabel == "U")
}

@Test func decodesChecksAndRuns() throws {
    let checks = """
    {"id":"1","payload":{"type":"checks_summary","workspace":"w","summary":{"workspace":"w",
    "changed_files":4,"check_status":"failed","check_exit_code":1,"active_sessions":1,
    "open_todos":2,"total_todos":5,"open_review_comments":0,"source_branch_ahead":0,
    "branch_ahead":3,"pull_request_number":121}}}
    """
    guard case .checksSummary(_, let summary) = try decodeResponse(checks) else {
        Issue.record("expected checks_summary")
        return
    }
    #expect(summary.checkStatus == "failed")
    #expect(summary.checkExitCode == 1)
    #expect(summary.pullRequestNumber == 121)

    let runs = """
    {"id":"1","payload":{"type":"workflow_runs","workspace":"w","summary":{"runs":[
    {"name":"CI","status":"completed","conclusion":"failure","branch":"b","url":"u",
    "started_at":"1","number":9}],"failing":1,"running":0,"succeeded":0}}}
    """
    guard case .workflowRuns(_, let summary) = try decodeResponse(runs) else {
        Issue.record("expected workflow_runs")
        return
    }
    #expect(summary.failing == 1)
    #expect(summary.runs.first?.isFailure == true)
    #expect(summary.unavailable == nil)
}

@Test func decodesGhUnavailableWithoutFailing() throws {
    // No gh auth on the daemon's machine is the normal case for a fresh setup,
    // and the phone should say so rather than show an empty checks panel.
    let json = """
    {"id":"1","payload":{"type":"workflow_runs","workspace":"w","summary":{"runs":[],
    "failing":0,"running":0,"succeeded":0,"unavailable":"gh is not authenticated"}}}
    """
    guard case .workflowRuns(_, let summary) = try decodeResponse(json) else {
        Issue.record("expected workflow_runs")
        return
    }
    #expect(summary.unavailable == "gh is not authenticated")
}

@Test func decodesLifecycleAcknowledgements() throws {
    guard case .workspaceCreated(let created) = try decodeResponse(
        #"{"id":"1","payload":{"type":"workspace_created","name":"fix-auth"}}"#) else {
        Issue.record("expected workspace_created")
        return
    }
    #expect(created == "fix-auth")

    guard case .repositoryAdded(let repo) = try decodeResponse(
        #"{"id":"1","payload":{"type":"repository_added","name":"demo"}}"#) else {
        Issue.record("expected repository_added")
        return
    }
    #expect(repo == "demo")

    guard case .pullRequestDraft(let title, _) = try decodeResponse(
        #"{"id":"1","payload":{"type":"pull_request_draft","workspace":"w","title":"Fix auth","body":"b"}}"#)
    else {
        Issue.record("expected pull_request_draft")
        return
    }
    #expect(title == "Fix auth")
}

@Test func decodesTodos() throws {
    let json = """
    {"id":"1","payload":{"type":"todos","workspace":"w","todos":[{"id":3,"workspace_id":1,
    "text":"write the migration","status":"open","source":"agent","created_at":"1",
    "updated_at":"1"}]}}
    """
    guard case .todos(_, let todos) = try decodeResponse(json) else {
        Issue.record("expected todos")
        return
    }
    #expect(todos.first?.text == "write the migration")
    #expect(todos.first?.isOpen == true)
}
