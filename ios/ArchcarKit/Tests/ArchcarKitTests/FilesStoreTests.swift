import Foundation
import Testing

@testable import ArchcarKit

private func replyID(_ line: String) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    else { return nil }
    return object["id"] as? String
}

private let filesResponder: @Sendable (String) -> String? = { line in
    guard let id = replyID(line) else { return nil }
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let payload = object["payload"] as? [String: Any],
          let type = payload["type"] as? String else { return nil }
    switch type {
    case "list_workspace_files":
        // One line: the framer splits on newlines, so a fixture with real
        // line breaks in it arrives as broken JSON fragments.
        return """
        {"id":"\(id)","payload":{"type":"workspace_files","workspace":"w","files":\
        ["README.md","src/main.rs","src/lib/parse.rs","Cargo.toml"]}}
        """
    case "read_workspace_file":
        return ##"{"id":"\##(id)","payload":{"type":"workspace_file_content","workspace":"w","path":"README.md","content":"# demo\n"}}"##
    case "write_workspace_file":
        return #"{"id":"\#(id)","payload":{"type":"workspace_file_written","workspace":"w","path":"README.md"}}"#
    case "list_repositories":
        return #"{"id":"\#(id)","payload":{"type":"repositories","repositories":[]}}"#
    default:
        return nil
    }
}

@MainActor
@Test func buildsATreeFromTheFlatFileList() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: filesResponder)
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let files = FilesStore(session: session, workspace: "w")
    await files.refresh()

    let root = files.entries(under: "")
    #expect(root.directories == ["src"])
    #expect(root.files == ["Cargo.toml", "README.md"])

    // One flat list from the daemon, levels derived here: a phone on a slow
    // link pays for one round trip, not one per tap.
    let src = files.entries(under: "src")
    #expect(src.directories == ["lib"])
    #expect(src.files == ["main.rs"])
    #expect(files.entries(under: "src/lib").files == ["parse.rs"])

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func readsAndWritesAFile() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: filesResponder)
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let files = FilesStore(session: session, workspace: "w")

    #expect(await files.read("README.md") == "# demo\n")
    #expect(await files.write("README.md", content: "# demo\n\nmore\n"))

    await session.disconnect()
    await daemon.stop()
}
