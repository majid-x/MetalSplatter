// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "spz-swift",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
        .tvOS(.v17),
        .visionOS(.v1),
    ],
    products: [
        .library(
            name: "spz",
            targets: ["spz"]
        ),
    ],
    targets: [
        .target(
            name: "spz",
            dependencies: []
        ),
        .testTarget(
            name: "spzTests",
            dependencies: ["spz"]
        ),
    ]
)
