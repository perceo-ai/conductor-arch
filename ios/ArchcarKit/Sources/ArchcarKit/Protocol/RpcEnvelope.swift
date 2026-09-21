import Foundation

/// A request the daemon understands.
///
/// The Rust side is one 190-variant enum. Mirroring that enum in Swift would
/// mean maintaining 190 cases the app mostly never sends, so each request the
/// app actually uses is its own small struct instead, carrying the `type`
/// discriminator the enum would have supplied.
public protocol ArchcarRequestBody: Encodable, Sendable {
    /// The `type` tag, matching serde's `rename_all = "snake_case"`.
    static var typeName: String { get }
}

/// `{"id": …, "payload": {"type": …, …}}` — the shape every archcar message
/// travels in.
public struct RequestEnvelope<Body: ArchcarRequestBody>: Encodable {
    public let id: String
    public let body: Body

    public init(id: String = UUID().uuidString, body: Body) {
        self.id = id
        self.body = body
    }

    private enum CodingKeys: String, CodingKey { case id, payload }
    private struct TypeKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        // The tag is injected into the body's own container rather than
        // wrapping it, because serde's internal tagging puts `type` alongside
        // the variant's fields, not above them.
        let payload = container.superEncoder(forKey: .payload)
        try body.encode(to: payload)
        var tagged = payload.container(keyedBy: TypeKey.self)
        try tagged.encode(Body.typeName, forKey: TypeKey(stringValue: "type"))
    }

    /// The bytes to write to the socket, including the terminating newline.
    public func encodedLine() throws -> Data {
        var data = try JSONEncoder().encode(self)
        data.append(0x0A)
        return data
    }
}
