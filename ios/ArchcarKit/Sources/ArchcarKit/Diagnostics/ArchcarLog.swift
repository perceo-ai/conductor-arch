import os

/// Where the client says what it is doing.
///
/// A phone gives you no console, so a connection that fails on a bus is only
/// diagnosable afterwards — `log collect --device` off a cable, or Console.app
/// while it happens. Nothing here logs the token, or any argument that could
/// carry one.
public enum ArchcarLog {
    public static let subsystem = "ai.perceo.archductor"

    public static let transport = Logger(subsystem: subsystem, category: "transport")
    public static let session = Logger(subsystem: subsystem, category: "session")
    public static let store = Logger(subsystem: subsystem, category: "store")
}
