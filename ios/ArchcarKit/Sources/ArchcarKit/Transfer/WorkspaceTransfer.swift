import Foundation

/// Move a workspace from one paired daemon to another, chat and all.
///
/// A port of `actions.transferWorkspace` in desktop/src/store/actions.ts, which
/// itself mirrors `remote transfer` in crates/cli/src/main.rs. Keep the three
/// in step: every refusal below exists because a looser version once lost or
/// duplicated work. The phone owns the orchestration; the daemons never talk to
/// each other.
///
/// Steps: stop the source's sessions, commit and push its branch, create (or
/// adopt) the workspace on the target, hand the conversation to a session
/// there, and only then archive the source — reversibly; the worktree stays.
public enum WorkspaceTransfer {
    /// One request to one daemon: `type` plus fields in, raw payload out.
    public typealias Send = @Sendable (String, [String: JSONValue]) async throws -> JSONValue

    public struct Endpoint: Sendable {
        public let label: String
        public let send: Send

        public init(label: String, send: @escaping Send) {
            self.label = label
            self.send = send
        }

        /// An endpoint backed by a real session.
        public init(label: String, session: DaemonSession) {
            self.init(label: label) { type, fields in
                try await session.requestRaw(type, fields)
            }
        }
    }

    public enum Failure: Error, LocalizedError, Equatable {
        /// The source still has a running agent. Offer "stop it and transfer".
        case liveSession(String)
        /// The target has no clone of the repository; retry with `cloneInto`.
        case missingRepository(url: String, name: String)
        case refused(String)

        public var errorDescription: String? {
            switch self {
            case .liveSession(let message), .refused(let message): message
            case .missingRepository(let url, _):
                "The target has no clone of \(url). Clone it there first, then transfer again."
            }
        }
    }

    public struct Timing: Sendable {
        public var pollInterval: Duration
        public var pollTimeout: Duration
        public init(pollInterval: Duration = .milliseconds(250), pollTimeout: Duration = .seconds(60)) {
            self.pollInterval = pollInterval
            self.pollTimeout = pollTimeout
        }
    }

    /// Opens the resume message, so it doubles as the "already handed over" marker.
    static let preamblePrefix = "This conversation moved from daemon "
    /// `FORKED_MESSAGE_SOURCE`: the source a seeded transcript row carries.
    static let seededSource = "fork"
    static let terminalStates: Set<String> = ["interrupted", "failed", "exited", "archived"]

    /// Returns the workspace's name on the target.
    @discardableResult
    public static func run(
        workspace: String,
        from source: Endpoint,
        to target: Endpoint,
        force: Bool = false,
        cloneInto: String? = nil,
        timing: Timing = Timing()
    ) async throws -> String {
        // Two daemons, proven by what each says it is — a saved address can
        // point back at the source, and a self-transfer would archive the
        // workspace it had just resumed.
        if let a = await identity(source), let b = await identity(target), a == b {
            throw Failure.refused(
                "\(source.label) and \(target.label) are the same daemon reached two ways; a transfer needs two.")
        }

        let listed = try ok(await source.send("list_workspaces", [:]))
        guard let row = listed["workspaces"]?.array.first(where: { $0["name"]?.string == workspace }) else {
            throw Failure.refused("\(workspace) is not a workspace on \(source.label)")
        }
        let repositoryName = row["repository_name"]?.string ?? ""
        let branch = row["branch"]?.string ?? ""
        let repos = try ok(await source.send("list_repositories", [:]))
        guard let repositoryURL = repos["repositories"]?.array
            .first(where: { $0["name"]?.string == repositoryName })?["remote_url"]?.string,
            !repositoryURL.isEmpty
        else {
            throw Failure.refused(
                "\(repositoryName) has no remote URL on \(source.label), so there is nothing for \(target.label) to match a clone against")
        }

        // Step 1: stop. Before the push: the branch about to be published is
        // the one an agent there may still be writing.
        let threadsReply = try ok(await source.send("list_chat_threads", ["workspace": .string(workspace)]))
        let threads = threadsReply["threads"]?.array.filter { $0["archived_at"]?.string == nil } ?? []
        var live: [(session: Int64, provider: String, title: String)] = []
        for thread in threads {
            guard let id = thread["id"]?.int else { continue }
            let snapshot = try await source.send("get_chat_snapshot", snapshotFields(id))
            guard snapshot.type == "chat_snapshot",
                  let session = snapshot["snapshot"]?["live_session"], !session.isNull,
                  let sessionID = session["session_id"]?.int
            else { continue }
            if session["status"]?.string == "running",
               !terminalStates.contains(session["runtime_state"]?.string ?? "")
            {
                live.append((sessionID, thread["provider"]?.string ?? "", thread["title"]?.string ?? ""))
            }
        }
        if !live.isEmpty && !force {
            let named = live.map { "session \($0.session) (\($0.provider), \"\($0.title)\")" }
                .joined(separator: ", ")
            let count = live.count == 1 ? "a session" : "\(live.count) sessions"
            throw Failure.liveSession(
                "\(workspace) still has \(count) running: \(named). Nothing has been pushed and nothing has changed.")
        }
        for entry in live {
            _ = try ok(await source.send("kill_session", ["session_id": .number(Double(entry.session))]))
        }
        for entry in live {
            try await waitForSessionGone(source, entry.session, timing)
        }

        // The chat that moves: the most recently touched live one.
        let moving = threads.max { updatedAt($0) < updatedAt($1) }
        var transcript: [JSONValue] = []
        var chatTitle: String?
        if let moving, let id = moving["id"]?.int {
            let chat = try ok(await source.send("get_chat_transcript", ["thread_id": .number(Double(id))]))
            if chat.type == "chat_transcript" {
                transcript = chat["messages"]?.array ?? []
                chatTitle = chat["title"]?.string
            }
        }
        let provider = moving?["provider"]?.string

        // Step 2: publish — commit what is uncommitted so the push carries it.
        try await commitIfNeeded(source, workspace)
        _ = try ok(await source.send("push_branch", ["workspace": .string(workspace)]))
        let head = try await source.send(
            "get_recent_commits", ["workspace": .string(workspace), "limit": 1])
        let sourceCommit = head.type == "recent_commits"
            ? head["log"]?.string?.split(whereSeparator: \.isWhitespace).first.map(String.init) : nil

        // Step 3: create on the target, or adopt what an earlier attempt left.
        let targetRepos = try ok(await target.send("list_repositories", [:]))["repositories"]?.array ?? []
        let targetRepository = (targetRepos.first { $0["remote_url"]?.string == repositoryURL }
            ?? targetRepos.first {
                guard let url = $0["remote_url"]?.string, !url.isEmpty else { return false }
                return repositoryURLTail(url) == repositoryURLTail(repositoryURL)
            })?["name"]?.string

        func inRepository() async throws -> (all: [JSONValue], mine: [JSONValue]) {
            let all = try ok(await target.send("list_workspaces", [:]))["workspaces"]?.array ?? []
            let mine = all.filter {
                targetRepository != nil && $0["repository_name"]?.string == targetRepository
            }
            return (all, mine)
        }
        var onTarget = try await inRepository()
        func archivedOnBranch() -> JSONValue? {
            onTarget.mine.first { $0["branch"]?.string == branch && $0["status"]?.string == "archived" }
        }
        // Coming back to a daemon it was moved off: its old self is there,
        // archived, holding this branch. Restore it and look again.
        var restored = false
        if let archived = archivedOnBranch(), let name = archived["name"]?.string {
            _ = try ok(await target.send("restore_workspace", ["workspace": .string(name)]))
            onTarget = try await inRepository()
            restored = true
        }
        if let archived = archivedOnBranch() {
            throw Failure.refused(
                "\(archived["name"]?.string ?? "A workspace") on \(target.label) is archived but still holds branch \(branch), and restoring it did not take. Nothing else has been changed; restore or delete it there and try again.")
        }
        let candidates = onTarget.mine.filter { $0["status"]?.string != "archived" }
        var existing: JSONValue?
        if let sourceCommit {
            for candidate in candidates {
                guard let name = candidate["name"]?.string else { continue }
                let theirs = try await target.send(
                    "get_recent_commits", ["workspace": .string(name), "limit": 1])
                let headOf = theirs["log"]?.string?.split(whereSeparator: \.isWhitespace).first.map(String.init)
                if commitsMatch(headOf, sourceCommit) {
                    existing = candidate
                    break
                }
            }
        }
        let onBranch = candidates.first { $0["branch"]?.string == branch }
        if existing == nil && sourceCommit == nil {
            existing = onBranch
        } else if existing == nil, let onBranch {
            throw Failure.refused(
                "\(onBranch["name"]?.string ?? "A workspace") on \(target.label) is on branch \(branch) but not at the \(sourceCommit ?? "commit") this transfer pushed — that copy has its own commits, so nothing has been changed. Pull \(branch) into it there, or move it aside, and try again.")
        } else if existing == nil {
            let taken = onTarget.all.first { $0["name"]?.string == workspace }
                ?? onTarget.mine.first { $0["branch"]?.string == branch }
            if let taken {
                throw Failure.refused(
                    "\(target.label) already uses the workspace name \(workspace) for \(taken["name"]?.string ?? "another workspace"), so importing would rename this one to a -v2 form a retry could not recognise. Nothing has been changed; clear that name there first.")
            }
        }

        var targetWorkspace: String
        var targetThread: Int64?
        if let existing, let name = existing["name"]?.string, restored, moving != nil {
            // A restored workspace's chats are the conversation as it was when
            // it left: adopting one would drop everything said since, and its
            // old handover would read as this leg's. Close them and seed the
            // current conversation. Mirrors `reseed_restored_workspace` (CLI).
            targetWorkspace = name
            let stale = try ok(await target.send("list_chat_threads", ["workspace": .string(name)]))
            for thread in stale["threads"]?.array ?? [] where thread["archived_at"]?.string == nil {
                if let id = thread["id"]?.int {
                    _ = try ok(await target.send("close_chat_thread", ["thread_id": .number(Double(id))]))
                }
            }
            var seedFields: [String: JSONValue] = [
                "workspace": .string(name),
                "transcript": .array(transcript.map(transcriptRow)),
            ]
            if let chatTitle { seedFields["chat_title"] = .string(chatTitle) }
            if let provider { seedFields["provider"] = .string(provider) }
            let seeded = try ok(await target.send("seed_chat_thread", seedFields))
            guard seeded.type == "chat_thread_created", let id = seeded["thread"]?["id"]?.int else {
                throw Failure.refused("could not carry the conversation into \(name) on \(target.label)")
            }
            targetThread = id
        } else if let existing, let name = existing["name"]?.string {
            targetWorkspace = name
            targetThread = try await importedThread(in: name, on: target)
        } else {
            if let cloneInto {
                _ = try ok(await target.send(
                    "clone_repository", ["url": .string(repositoryURL), "dest": .string(cloneInto)]))
            }
            let afterClone = try await target.send("list_repositories", [:])
            let resolved = afterClone["repositories"]?.array.contains {
                guard let url = $0["remote_url"]?.string else { return false }
                return url == repositoryURL || (!url.isEmpty && repositoryURLTail(url) == repositoryURLTail(repositoryURL))
            } ?? false
            var fields: [String: JSONValue] = [
                "repository_url": .string(repositoryURL),
                "branch": .string(branch),
                "source_branch": .string(branch),
                "name": .string(workspace),
                "transcript": .array(transcript.map(transcriptRow)),
            ]
            if let sourceCommit { fields["source_commit"] = .string(sourceCommit) }
            if let base = row["base_ref"]?.string { fields["base_ref"] = .string(base) }
            if let chatTitle { fields["chat_title"] = .string(chatTitle) }
            if let provider { fields["provider"] = .string(provider) }
            let imported = try await target.send("import_workspace_from_remote", fields)
            if imported.type == "error",
               imported["message"]?.string?.hasPrefix("no repository here has remote") == true
            {
                throw Failure.missingRepository(url: repositoryURL, name: repositoryName)
            }
            _ = try ok(imported)
            guard imported.type == "workspace_imported", let name = imported["workspace"]?.string else {
                throw Failure.refused("the transfer returned no workspace")
            }
            if !resolved, let landed = imported["branch"]?.string, landed != branch {
                throw Failure.refused(
                    "\(target.label) already has branch \(branch), so it created \(name) on \(landed) instead. The transfer stopped: nothing was resumed and the source was not archived. Remove \(name) there and try again.")
            }
            targetWorkspace = name
            targetThread = imported["thread_id"]?.int
        }

        // Step 4: resume. Nothing is archived until the message has landed.
        if moving != nil, targetThread == nil {
            if transcript.isEmpty {
                let opened = try ok(await target.send("create_chat_thread", [
                    "workspace": .string(targetWorkspace),
                    "provider": .string(provider ?? "codex"),
                    "title": .string(chatTitle ?? "Transferred chat"),
                ]))
                guard opened.type == "chat_thread_created", let id = opened["thread"]?["id"]?.int else {
                    throw Failure.refused("could not open a chat for \(targetWorkspace) on \(target.label)")
                }
                targetThread = id
            } else {
                throw Failure.refused(
                    "\(targetWorkspace) is on \(target.label) but has none of the conversation. Remove that workspace there and transfer again; \(workspace) has been left alone.")
            }
        }
        if let targetThread, moving != nil {
            try await resume(
                on: target, workspace: targetWorkspace, threadID: targetThread,
                provider: provider ?? "", transcript: transcript, commit: sourceCommit,
                fromLabel: source.label, timing: timing)
        }

        // Step 5: retire. Archive, never delete.
        _ = try ok(await source.send("archive_workspace", ["workspace": .string(workspace)]))
        return targetWorkspace
    }

    // MARK: - Helpers (each mirrors the desktop function of the same purpose)

    /// One transcript line as the import and seed requests take it.
    static func transcriptRow(_ message: JSONValue) -> JSONValue {
        .object([
            "role": message["role"] ?? "",
            "content": message["content"] ?? "",
            "created_at": message["created_at"] ?? "",
        ])
    }

    static func ok(_ response: JSONValue) throws -> JSONValue {
        if response.type == "error" {
            throw Failure.refused(response["message"]?.string ?? "the daemon refused")
        }
        return response
    }

    static func snapshotFields(_ threadID: Int64) -> [String: JSONValue] {
        ["thread_id": .number(Double(threadID)), "include_provider_events": false]
    }

    static func updatedAt(_ thread: JSONValue) -> Double {
        Double(thread["updated_at"]?.string ?? "") ?? 0
    }

    /// What a daemon says it is. Compared, never shown: it holds the token.
    static func identity(_ endpoint: Endpoint) async -> String? {
        guard let res = try? await endpoint.send("get_remote_access", [:]),
              res.type == "remote_access"
        else { return nil }
        return "\(res["token_path"]?.string ?? "")\n\(res["token"]?.string ?? "")"
    }

    static func commitIfNeeded(_ source: Endpoint, _ workspace: String) async throws {
        let changes = try ok(await source.send(
            "get_workspace_changes", ["workspace": .string(workspace), "scope": "uncommitted"]))
        let visible = changes["files"]?.array.count ?? 0
        let committed = try await source.send("commit_workspace_changes", [
            "workspace": .string(workspace),
            "message": .string("Transfer \(workspace) before moving workspace"),
            "stage_all": true,
        ])
        if visible == 0, committed.type == "error",
           committed["message"]?.string == "stage at least one file before committing"
        {
            return
        }
        _ = try ok(committed)
    }

    static func waitForSessionGone(_ source: Endpoint, _ sessionID: Int64, _ timing: Timing) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now + timing.pollTimeout
        while true {
            let status = try await source.send("get_session_status", ["session_id": .number(Double(sessionID))])
            if status.type == "error" { return }
            if status.type == "session_status",
               status["status"]?.string != "running"
                || terminalStates.contains(status["runtime_state"]?.string ?? "")
            {
                return
            }
            if clock.now >= deadline {
                throw Failure.refused("session \(sessionID) did not stop in time; nothing has been pushed")
            }
            try await Task.sleep(for: timing.pollInterval)
        }
    }

    static func hasDeliveredTransferMessage(_ messages: [JSONValue]) -> Bool {
        messages.contains {
            $0["role"]?.string == "user" && $0["source"]?.string != seededSource
                && ($0["content"]?.string?.hasPrefix(preamblePrefix) ?? false)
        }
    }

    /// The chat in an adopted workspace that holds the moved conversation:
    /// one already handed over, else one with seeded history, else the newest.
    static func importedThread(in workspace: String, on target: Endpoint) async throws -> Int64? {
        let listed = try await target.send("list_chat_threads", ["workspace": .string(workspace)])
        guard listed.type == "chat_threads" else { return nil }
        let live = (listed["threads"]?.array ?? [])
            .filter { $0["archived_at"]?.string == nil }
            .sorted { updatedAt($0) > updatedAt($1) }
        var seeded: Int64?
        for thread in live {
            guard let id = thread["id"]?.int else { continue }
            let snapshot = try await target.send("get_chat_snapshot", snapshotFields(id))
            guard snapshot.type == "chat_snapshot" else { continue }
            let messages = snapshot["snapshot"]?["messages"]?.array ?? []
            if hasDeliveredTransferMessage(messages) { return id }
            if seeded == nil, messages.contains(where: { $0["source"]?.string == seededSource }) {
                seeded = id
            }
        }
        return seeded ?? live.first?["id"]?.int
    }

    /// `owner/repo`, lowercased, without `.git`, from any remote URL form.
    public static func repositoryURLTail(_ url: String) -> String {
        var path = url.trimmingCharacters(in: .whitespaces)
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix(".git") { path.removeLast(4) }
        if let scheme = path.range(of: "://") { path = String(path[scheme.upperBound...]) }
        if let colon = path.firstIndex(of: ":") { path = String(path[path.index(after: colon)...]) }
        let segments = path.split(separator: "/").map(String.init)
        return segments.suffix(2).joined(separator: "/").lowercased()
    }

    /// Two abbreviated shas naming one commit.
    public static func commitsMatch(_ left: String?, _ right: String?) -> Bool {
        let a = (left ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let b = (right ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let shared = min(a.count, b.count)
        guard shared >= 7 else { return false }
        let hex = CharacterSet(charactersIn: "0123456789abcdef")
        guard a.unicodeScalars.allSatisfy(hex.contains), b.unicodeScalars.allSatisfy(hex.contains)
        else { return false }
        return a.prefix(shared) == b.prefix(shared)
    }

    public static func resumeMessage(
        transcript: [JSONValue], fromLabel: String, toLabel: String, commit: String?
    ) -> String {
        let trimmed = commit?.trimmingCharacters(in: .whitespaces) ?? ""
        let branchState = trimmed.isEmpty ? "the branch has been pushed" : "the branch is at \(trimmed.prefix(12))"
        let preamble = "\(preamblePrefix)\(fromLabel) to \(toLabel); \(branchState)."
        if let last = transcript.last, last["role"]?.string == "user" {
            let content = (last["content"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(preamble) Continue from where the transcript leaves off \u{2014} do not redo completed work.\n\n\(content)"
        }
        return "\(preamble) Pick up where you left off and continue the work \u{2014} do not redo anything already done."
    }

    static func resume(
        on target: Endpoint, workspace: String, threadID: Int64, provider: String,
        transcript: [JSONValue], commit: String?, fromLabel: String, timing: Timing
    ) async throws {
        let snapshot = try await target.send("get_chat_snapshot", snapshotFields(threadID))
        if snapshot.type == "chat_snapshot",
           hasDeliveredTransferMessage(snapshot["snapshot"]?["messages"]?.array ?? [])
        {
            return  // Already handed over by an earlier attempt.
        }
        if provider == "shell" {
            throw Failure.refused(
                "the chat moved with \(workspace) runs under shell, which has no turns to resume; the workspace is on \(target.label) and its branch is pushed, but start a session there yourself")
        }
        _ = try ok(await target.send("ensure_chat_thread_session", [
            "workspace": .string(workspace), "thread_id": .number(Double(threadID)), "kind": .string(provider),
        ]))
        let message = resumeMessage(
            transcript: transcript, fromLabel: fromLabel, toLabel: target.label, commit: commit)
        _ = try ok(await target.send("queue_chat_input", [
            "thread_id": .number(Double(threadID)),
            "input": .string(message),
            "visible_input": .string(message),
            "kind": "user",
            "session_kind": .string(provider),
            "verbatim": true,
        ]))
        // Delivery is confirmed from the thread's own messages, never from an
        // empty queue: a claimed row is not a delivered one.
        let clock = ContinuousClock()
        let deadline = clock.now + timing.pollTimeout
        while true {
            let current = try ok(await target.send("get_chat_snapshot", snapshotFields(threadID)))
            if hasDeliveredTransferMessage(current["snapshot"]?["messages"]?.array ?? []) { return }
            if clock.now >= deadline {
                throw Failure.refused(
                    "the conversation was queued for \(workspace) on \(target.label) but no session there had taken it in time; the source workspace has been left alone")
            }
            try await Task.sleep(for: timing.pollInterval)
        }
    }
}
