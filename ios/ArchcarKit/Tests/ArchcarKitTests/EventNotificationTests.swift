import Foundation
import Testing

@testable import ArchcarKit

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
        .providerInteractionRequested(interaction))

    #expect(descriptor == EventNotificationDescriptor(
        id: "interaction-ask-1",
        title: "Input required",
        body: "Approve command? - cargo test",
        threadID: 9))
}

@Test func notificationDescriptorForCompletedTurnEvent() {
    let descriptor = EventNotificationDescriptor.from(
        .turnCompleted(sessionID: 11, threadID: 9, status: "completed"))

    #expect(descriptor == EventNotificationDescriptor(
        id: "turn-11-9-completed",
        title: "Chat finished",
        body: "Thread 9 completed.",
        threadID: 9))
}

@Test func notificationDescriptorForSessionErrorEvent() {
    let descriptor = EventNotificationDescriptor.from(
        .sessionError(sessionID: 11, threadID: 9, message: "codex exited before it was ready"))

    #expect(descriptor == EventNotificationDescriptor(
        id: "session-error-11-9",
        title: "Chat failed",
        body: "codex exited before it was ready",
        threadID: 9))
}

@Test func notificationDescriptorForReadyBackgroundTaskEvent() throws {
    let event = try JSONDecoder().decode(ArchcarEvent.self, from: Data("""
    {"type":"background_task_updated","task":{"id":4,"title":"Open PR","status":"ready",\
    "detail":"Ready for review","workspace_name":"checkout"}}
    """.utf8))

    let descriptor = EventNotificationDescriptor.from(event)

    #expect(descriptor == EventNotificationDescriptor(
        id: "background-task-4-ready",
        title: "Background task ready",
        body: "#4 Open PR (checkout): Ready for review",
        threadID: nil))
}

@Test func notificationDescriptorIgnoresUnrelatedEvents() {
    #expect(EventNotificationDescriptor.from(.sessionMessagesUpdated(threadID: 9)) == nil)
}
