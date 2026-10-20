import Foundation

/// True if `task` finishes within `limit`.
///
/// On a timeout the task is cancelled, which ends any `for await` it is
/// parked in, so a stream that never finishes fails the test instead of
/// hanging the suite.
func finishes<T: Sendable>(_ task: Task<T, Never>, within limit: Duration = .seconds(2)) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
        group.addTask {
            _ = await task.value
            return true
        }
        group.addTask {
            try? await Task.sleep(for: limit)
            return false
        }
        let first = await group.next() ?? false
        task.cancel()
        group.cancelAll()
        return first
    }
}

/// Polls `condition` until it holds or `limit` passes, and reports which.
func eventually(
    within limit: Duration = .seconds(3), _ condition: @Sendable () async -> Bool
) async -> Bool {
    let deadline = ContinuousClock.now + limit
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return await condition()
}
