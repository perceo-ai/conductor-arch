import Testing

@testable import ArchcarKit

@Test func aFailedFetchOnALiveConnectionShowsItsCauseNotADisconnect() {
    let text = StaleBannerCopy.text(isDisconnected: false, cause: "gh is not authenticated")
    #expect(!text.contains("not connected"))
    #expect(text.contains("gh is not authenticated"))
}

@Test func aRealDisconnectStillSaysNotConnectedWhateverTheCause() {
    #expect(StaleBannerCopy.text(isDisconnected: true, cause: "irrelevant") == StaleBannerCopy.disconnected)
    #expect(StaleBannerCopy.text(isDisconnected: true, cause: nil) == StaleBannerCopy.disconnected)
}

@Test func aFailedFetchWithNoCauseStillDoesNotClaimADisconnect() {
    #expect(!StaleBannerCopy.text(isDisconnected: false, cause: nil).contains("not connected"))
    #expect(!StaleBannerCopy.text(isDisconnected: false, cause: "  \n").contains("not connected"))
}
