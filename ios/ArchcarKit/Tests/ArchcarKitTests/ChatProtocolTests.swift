import Foundation
import Testing

@testable import ArchcarKit

private func decodeResponse(_ json: String) throws -> ArchcarResponse {
    try JSONDecoder().decode(ResponseEnvelope.self, from: Data(json.utf8)).payload
}

private func payloadObject<Body: ArchcarRequestBody>(_ body: Body) throws -> [String: Any] {
    let line = try RequestEnvelope(id: "1", body: body).encodedLine()
    let object = try #require(try JSONSerialization.jsonObject(with: line) as? [String: Any])
    return try #require(object["payload"] as? [String: Any])
}

@Test func encodesChatRequests() throws {
    let threads = try payloadObject(ListChatThreadsRequest(workspace: "columbia"))
    #expect(threads["type"] as? String == "list_chat_threads")
    #expect(threads["workspace"] as? String == "columbia")

    let projection = try payloadObject(GetChatProjectionRequest(threadID: 7))
    #expect(projection["type"] as? String == "get_chat_projection")
    #expect(projection["thread_id"] as? Int == 7)

    let queue = try payloadObject(
        QueueChatInputRequest(threadID: 7, input: "ship it", sessionKind: .codex))
    #expect(queue["type"] as? String == "queue_chat_input")
    #expect(queue["input"] as? String == "ship it")
    // The daemon distinguishes a human turn from a staged review prompt.
    #expect(queue["kind"] as? String == "user")
    #expect(queue["session_kind"] as? String == "codex")

    let interrupt = try payloadObject(InterruptTurnRequest(sessionID: 3))
    #expect(interrupt["type"] as? String == "interrupt_turn")
    #expect(interrupt["session_id"] as? Int == 3)

    let ensure = try payloadObject(
        EnsureChatThreadSessionRequest(workspace: "columbia", threadID: 7, kind: .claude))
    #expect(ensure["type"] as? String == "ensure_chat_thread_session")
    #expect(ensure["kind"] as? String == "claude")

    let create = try payloadObject(
        CreateChatThreadRequest(workspace: "columbia", provider: "codex", title: "From phone"))
    #expect(create["type"] as? String == "create_chat_thread")
    #expect(create["provider"] as? String == "codex")

    let planMode = try payloadObject(SetChatPlanModeRequest(threadID: 7, planMode: true))
    #expect(planMode["type"] as? String == "set_chat_plan_mode")
    #expect(planMode["plan_mode"] as? Bool == true)

    let pending = try payloadObject(ListProviderInteractionsRequest(threadID: 7, pendingOnly: true))
    #expect(pending["type"] as? String == "list_provider_interactions")
    #expect(pending["pending_only"] as? Bool == true)
    #expect(pending["thread_id"] as? Int == 7)
}

@Test func encodesInteractionResolutions() throws {
    let approve = try payloadObject(
        ResolveProviderInteractionRequest(interactionID: "abc", resolution: .approve))
    #expect(approve["type"] as? String == "resolve_provider_interaction")
    let resolution = try #require(approve["resolution"] as? [String: Any])
    #expect(resolution["type"] as? String == "approve")

    let denied = try payloadObject(
        ResolveProviderInteractionRequest(interactionID: "abc", resolution: .deny(reason: "not now")))
    let denyBody = try #require(denied["resolution"] as? [String: Any])
    #expect(denyBody["type"] as? String == "deny")
    #expect(denyBody["reason"] as? String == "not now")

    let answered = try payloadObject(
        ResolveProviderInteractionRequest(
            interactionID: "abc",
            resolution: .answer(answers: [InteractionAnswer(questionID: "q1", values: ["Yes"])])))
    let answerBody = try #require(answered["resolution"] as? [String: Any])
    #expect(answerBody["type"] as? String == "answer")
    let answers = try #require(answerBody["answers"] as? [[String: Any]])
    #expect(answers.first?["question_id"] as? String == "q1")
    #expect(answers.first?["values"] as? [String] == ["Yes"])
}

@Test func decodesChatThreads() throws {
    let json = """
    {"id":"1","payload":{"type":"chat_threads","workspace":"columbia","threads":[\
    {"id":7,"provider":"codex","title":"Fix auth","status":"open","model":"gpt-5",\
    "effort_mode":"high","fast_mode":false,"updated_at":"1758326400"}]}}
    """
    guard case .chatThreads(let workspace, let threads) = try decodeResponse(json) else {
        Issue.record("expected chat_threads")
        return
    }
    #expect(workspace == "columbia")
    let thread = try #require(threads.first)
    #expect(thread.id == 7)
    #expect(thread.provider == "codex")
    #expect(thread.model == "gpt-5")
    #expect(thread.isArchived == false)
}

@Test func decodesChatProjection() throws {
    let json = """
    {"id":"1","payload":{"type":"chat_projection","thread_id":7,"items":[\
    {"id":"a","sequence":1,"render_class":"user_chat","role_label":"user","title":"",\
    "body":"do the thing","status":"complete","stream_state":"final","timeline_seq":4},\
    {"id":"b","sequence":2,"render_class":"assistant_chat","role_label":"assistant",\
    "title":"","body":"on it","status":"running","stream_state":"streaming"}]}}
    """
    guard case .chatProjection(let threadID, let items) = try decodeResponse(json) else {
        Issue.record("expected chat_projection")
        return
    }
    #expect(threadID == 7)
    #expect(items.count == 2)
    #expect(items[0].renderClass == "user_chat")
    #expect(items[0].timelineSeq == 4)
    #expect(items[1].isStreaming)
    #expect(items[0].isStreaming == false)
}

@Test func decodesQueuedInputsAndSessionStatus() throws {
    let queued = """
    {"id":"1","payload":{"type":"queued_chat_inputs","thread_id":7,"inputs":[\
    {"id":3,"thread_id":7,"input":"next task","kind":"user","session_kind":"codex",\
    "created_at":"1758326400","updated_at":"1758326400"}]}}
    """
    guard case .queuedChatInputs(let threadID, let inputs) = try decodeResponse(queued) else {
        Issue.record("expected queued_chat_inputs")
        return
    }
    #expect(threadID == 7)
    #expect(inputs.first?.input == "next task")

    let status = """
    {"id":"1","payload":{"type":"session_status","session_id":3,"status":"running",\
    "runtime_state":"waiting_for_input","ready":true,"pending_interactions":2}}
    """
    guard case .sessionStatus(let sessionStatus) = try decodeResponse(status) else {
        Issue.record("expected session_status")
        return
    }
    #expect(sessionStatus.sessionID == 3)
    #expect(sessionStatus.runtimeState == .waitingForInput)
    #expect(sessionStatus.pendingInteractions == 2)
}

@Test func decodesProviderInteraction() throws {
    let json = """
    {"id":"1","payload":{"type":"provider_interactions","interactions":[\
    {"id":"i1","provider_key":"claude","workspace":"columbia","thread_id":7,"session_id":3,\
    "native_id":"n1","kind":"permission","title":"Run tests?","detail":"cargo test",\
    "questions":[],"native_request":{},"request_fingerprint":"f","status":"pending",\
    "created_at":"1758326400"}]}}
    """
    guard case .providerInteractions(let interactions) = try decodeResponse(json) else {
        Issue.record("expected provider_interactions")
        return
    }
    let interaction = try #require(interactions.first)
    #expect(interaction.id == "i1")
    #expect(interaction.kind == .permission)
    #expect(interaction.isPending)
    #expect(interaction.threadID == 7)
}

@Test func decodesInteractionQuestions() throws {
    let json = """
    {"id":"1","payload":{"type":"provider_interaction","interaction":\
    {"id":"i2","provider_key":"claude","workspace":"w","thread_id":7,"session_id":3,\
    "native_id":"n","kind":"user_question","title":"Pick one","detail":"",\
    "questions":[{"id":"q1","header":"Scope","question":"How far?","options":[\
    {"label":"Small","description":"one file"},{"label":"Big","description":"everything"}],\
    "allow_other":true,"multi_select":false}],"native_request":{},\
    "request_fingerprint":"f","status":"pending","created_at":"1"}}}
    """
    guard case .providerInteraction(let interaction) = try decodeResponse(json) else {
        Issue.record("expected provider_interaction")
        return
    }
    #expect(interaction.kind == .userQuestion)
    let question = try #require(interaction.questions.first)
    #expect(question.header == "Scope")
    #expect(question.options.map(\.label) == ["Small", "Big"])
    #expect(question.allowOther)
    #expect(question.multiSelect == false)
}
