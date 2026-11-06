import Foundation
import Testing

@testable import ArchcarKit

private let chatContext = NotificationContext(
    workspace: "antix",
    chatTitle: "fix the parser",
    model: "claude-opus-5",
    provider: "claude")

@Test func notificationDescriptorForInputRequiredEvent() async throws {
    let interaction = try JSONDecoder().decode(
        ProviderInteraction.self,
        from: Data("""
        {"id":"ask-1","provider_key":"claude","workspace":"checkout","thread_id":9,"session_id":3,\
        "native_id":"n","kind":"permission","title":"Approve command?","detail":"cargo test",\
        "questions":[],"native_request":{},"request_fingerprint":"f","status":"pending",\
        "created_at":"1"}
        """.utf8))

    let descriptor = EventNotificationDescriptor.from(
        .providerInteractionRequested(interaction), context: chatContext)

    #expect(descriptor == EventNotificationDescriptor(
        id: "interaction-ask-1",
        // The interaction's own workspace wins over the looked-up one.
        title: "checkout \u{b7} fix the parser",
        body: "Needs you: Approve command? \u{2014} cargo test",
        threadID: 9))
}

@Test func completedTurnSaysWhereWhatHowLongAndWhoRanIt() {
    func turn(_ status: String, _ durationMS: UInt64?) -> EventNotificationDescriptor? {
        EventNotificationDescriptor.from(
            .turnCompleted(sessionID: 11, threadID: 9, status: status, durationMS: durationMS),
            context: chatContext)
    }

    #expect(turn("success", 252_000) == EventNotificationDescriptor(
        // Keyed on the status, so a retried turn replaces its own banner.
        id: "turn-11-9-success",
        title: "antix \u{b7} fix the parser",
        body: "Done in 4m 12s \u{b7} Claude Opus 5",
        threadID: 9))
    #expect(turn("failed", 2_000)?.body == "Failed after 2.0s \u{b7} Claude Opus 5")
    #expect(turn("interrupted", 18_300)?.body == "Stopped after 18.3s \u{b7} Claude Opus 5")
    // An older daemon sends no duration; the outcome still reads.
    #expect(turn("success", nil)?.body == "Done \u{b7} Claude Opus 5")
    // An unknown status is shown, not flattened into "stopped" — which is what
    // made every successful claude turn ("success") read as a failure.
    #expect(turn("rate_limited", 900)?.body == "Rate_limited after 900ms \u{b7} Claude Opus 5")
}

@Test func turnNotificationFallsBackThroughTheContextItHas() {
    let event = ArchcarEvent.turnCompleted(
        sessionID: 11, threadID: 9, status: "success", durationMS: 1_500)

    // No model recorded: the provider names who ran the turn.
    #expect(EventNotificationDescriptor.from(
        event,
        context: NotificationContext(workspace: "antix", chatTitle: "fix the parser", provider: "claude")
    )?.body == "Done in 1.5s \u{b7} Claude")
    // Nothing loaded: the thread number is the last resort, as before.
    #expect(EventNotificationDescriptor.from(event)?.title == "Thread 9")
    #expect(EventNotificationDescriptor.from(
        event, context: NotificationContext(workspace: "  "))?.title == "Thread 9")
}

@Test func longTitlesAreCutAtAWordBoundaryAndErrorsCollapseToOneLine() {
    #expect(EventNotificationDescriptor.from(
        .turnCompleted(sessionID: 1, threadID: 2, status: "success", durationMS: 1_000),
        context: NotificationContext(
            workspace: "antix",
            chatTitle: "refactor the provider projection so every surface agrees on turn ids")
    )?.title == "antix \u{b7} refactor the provider projection so every\u{2026}")

    #expect(EventNotificationDescriptor.from(
        .sessionError(sessionID: 11, threadID: 9, message: "codex exited\n\n  before it was ready"),
        context: chatContext
    ) == EventNotificationDescriptor(
        id: "session-error-11-9",
        title: "antix \u{b7} fix the parser",
        body: "Failed: codex exited before it was ready",
        threadID: 9))
}

@Test func notificationThreadIDComesFromTheEvent() {
    #expect(EventNotificationDescriptor.threadID(
        of: .turnCompleted(sessionID: 11, threadID: 9, status: nil, durationMS: nil)) == 9)
    #expect(EventNotificationDescriptor.threadID(
        of: .sessionError(sessionID: nil, threadID: nil, message: "x")) == nil)
    #expect(EventNotificationDescriptor.threadID(of: .sessionMessagesUpdated(threadID: 9)) == nil)
}

@Test func notificationDescriptorForReadyBackgroundTaskEvent() throws {
    let event = try JSONDecoder().decode(ArchcarEvent.self, from: Data("""
    {"type":"background_task_updated","task":{"id":4,"title":"Open PR","status":"ready",\
    "detail":"Ready for review","workspace_name":"checkout"}}
    """.utf8))

    let descriptor = EventNotificationDescriptor.from(event)

    #expect(descriptor == EventNotificationDescriptor(
        id: "background-task-4-ready",
        title: "checkout \u{b7} Open PR",
        body: "Task ready: Ready for review",
        threadID: nil))
}

@Test func notificationContextComesFromTheChatList() {
    let thread = try! JSONDecoder().decode(ChatThread.self, from: Data("""
    {"id":9,"provider":"claude","title":"fix the parser","status":"idle",\
    "model":"claude-opus-5","fast_mode":false,"updated_at":"1"}
    """.utf8))
    let chatThreads = ["antix": [thread]]

    let found = ChatThreadLookup.chat(forThread: 9, in: chatThreads)
    #expect(found?.workspace == "antix")
    #expect(found?.thread.title == "fix the parser")
    #expect(ChatThreadLookup.chat(forThread: 404, in: chatThreads) == nil)

    #expect(NotificationContext(workspace: "antix", thread: thread) == chatContext)
}

@Test func modelLabelsReadLikeTheRestOfTheApp() {
    #expect(EventNotificationDescriptor.modelLabel("claude-opus-5") == "Claude Opus 5")
    #expect(EventNotificationDescriptor.modelLabel("gpt-5.6-sol") == "GPT 5.6 Sol")
    #expect(EventNotificationDescriptor.modelLabel("claude-sonnet-4-6[1m]") == "Claude Sonnet 4 6 1M")
}

@Test func turnDurationsReadTheSameAsTheChatTurnRow() {
    #expect(EventNotificationDescriptor.formatTurnDuration(840) == "840ms")
    #expect(EventNotificationDescriptor.formatTurnDuration(18_300) == "18.3s")
    #expect(EventNotificationDescriptor.formatTurnDuration(252_000) == "4m 12s")
}

@Test func notificationDescriptorIgnoresUnrelatedEvents() {
    #expect(EventNotificationDescriptor.from(.sessionMessagesUpdated(threadID: 9)) == nil)
}

@Test func remotePushIsSuppressedOnlyWhileTheSocketIsDelivering() {
    // Connected: the socket already scheduled the local copy of this event.
    #expect(!NotificationPresentationPolicy.shouldPresent(
        isRemotePush: true, hasLiveDaemonSession: true))
    // Disconnected foreground (e.g. reconnect in flight): the push is the only copy.
    #expect(NotificationPresentationPolicy.shouldPresent(
        isRemotePush: true, hasLiveDaemonSession: false))
    // Local notifications always present; they exist only while connected.
    #expect(NotificationPresentationPolicy.shouldPresent(
        isRemotePush: false, hasLiveDaemonSession: true))
    #expect(NotificationPresentationPolicy.shouldPresent(
        isRemotePush: false, hasLiveDaemonSession: false))
}
