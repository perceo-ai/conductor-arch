import Foundation
import Testing

@testable import ArchcarKit

@Test func framerSplitsCompleteLines() {
    var framer = LineFramer()
    let lines = framer.append(Data(#"{"a":1}"#.utf8) + Data("\n".utf8))
    #expect(lines.count == 1)
    #expect(String(decoding: lines[0], as: UTF8.self) == #"{"a":1}"#)
}

@Test func framerHoldsPartialLineUntilTerminated() {
    var framer = LineFramer()
    #expect(framer.append(Data(#"{"a":"#.utf8)).isEmpty)
    #expect(framer.pendingByteCount == 5)
    let lines = framer.append(Data("1}\n".utf8))
    #expect(lines.map { String(decoding: $0, as: UTF8.self) } == [#"{"a":1}"#])
    #expect(framer.pendingByteCount == 0)
}

@Test func framerSplitsMultipleLinesInOneChunk() {
    var framer = LineFramer()
    let lines = framer.append(Data("one\ntwo\nthr".utf8))
    #expect(lines.map { String(decoding: $0, as: UTF8.self) } == ["one", "two"])
    #expect(framer.pendingByteCount == 3)
}

@Test func framerSkipsEmptyLines() {
    var framer = LineFramer()
    let lines = framer.append(Data("\n\nx\n".utf8))
    #expect(lines.map { String(decoding: $0, as: UTF8.self) } == ["x"])
}
