import SwiftUI

@main
struct ArchductorApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Before any bar exists. The UIKit appearance proxies are read when a
        // bar is created, so applying them from a view's `onAppear` leaves the
        // first tab bar on its system colours.
        Appearance.apply()
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environment(model)
                .task { await model.load() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await model.handleForeground() }
        }
    }
}
