// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ArchcarKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ArchcarKit", targets: ["ArchcarKit"])
    ],
    targets: [
        .target(name: "ArchcarKit"),
        .testTarget(name: "ArchcarKitTests", dependencies: ["ArchcarKit"])
    ]
)
