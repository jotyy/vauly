// swift-tools-version: 5.9

import PackageDescription

// vauly's cryptography for the iPhone app and its AutoFill extension: the same formats as
// packages/crypto, checked against packages/crypto/test-vectors.json.
let package = Package(
	name: "VaulyKit",
	platforms: [.iOS(.v15), .macOS(.v12)],
	products: [
		.library(name: "VaulyKit", targets: ["VaulyKit"])
	],
	dependencies: [
		// Argon2id from libsodium, as the web app's libsodium.js. Pinned to one version.
		.package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.9.1")
	],
	targets: [
		.target(
			name: "VaulyKit",
			dependencies: [.product(name: "Clibsodium", package: "swift-sodium")]
		),
		.testTarget(name: "VaulyKitTests", dependencies: ["VaulyKit"]),
	]
)
