import Foundation

/// Splits a byte stream into newline-delimited frames.
///
/// archcar speaks one JSON object per line in both directions, so every read
/// off the socket goes through here before it reaches a decoder. Chunk
/// boundaries have nothing to do with line boundaries: a single read can carry
/// half an envelope, or nine of them.
public struct LineFramer: Sendable {
    private var buffer = Data()

    public init() {}

    /// Bytes held back because no newline has arrived for them yet.
    public var pendingByteCount: Int { buffer.count }

    /// Appends a chunk and returns every line it completed, newline stripped.
    public mutating func append(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[buffer.startIndex..<newline])
            buffer = Data(buffer[buffer.index(after: newline)...])
            // The daemon never sends blank lines; tolerating them keeps a
            // keepalive newline from being decoded as malformed JSON.
            if !line.isEmpty { lines.append(line) }
        }
        return lines
    }
}
