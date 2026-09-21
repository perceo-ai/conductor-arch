import Testing

@testable import ArchcarKit

@Test func backoffDoublesAndCaps() {
    var backoff = Backoff(base: .milliseconds(500), cap: .seconds(4))
    #expect(backoff.next() == .milliseconds(500))
    #expect(backoff.next() == .seconds(1))
    #expect(backoff.next() == .seconds(2))
    #expect(backoff.next() == .seconds(4))
    #expect(backoff.next() == .seconds(4))
}

@Test func backoffResetsAfterSuccess() {
    var backoff = Backoff(base: .milliseconds(500), cap: .seconds(4))
    _ = backoff.next()
    _ = backoff.next()
    backoff.reset()
    #expect(backoff.next() == .milliseconds(500))
}
