import Testing

@testable import ArchcarKit

@Test func clearingNeedsBothARefetchAndAConnectedStream() {
    #expect(StaleClearing.mayClear(afterRefetchSucceeded: true, connected: true))
    // A one-shot request answered while the stream is down proves nothing
    // about the live updates the screen is missing.
    #expect(!StaleClearing.mayClear(afterRefetchSucceeded: true, connected: false))
    // A stream that is back says nothing about data that failed to refetch.
    #expect(!StaleClearing.mayClear(afterRefetchSucceeded: false, connected: true))
    #expect(!StaleClearing.mayClear(afterRefetchSucceeded: false, connected: false))
}
