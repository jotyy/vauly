import XCTest

// Opens the AutoFill extension the way a person would: turn vauly proto on as a provider,
// tap a username field, pick it from the keyboard's passwords button. Simulator UI changes
// between iOS versions, so this records what it sees as it goes.
final class AutoFillUITests: XCTestCase {
	/** Where screenshots go: TEST_RUNNER_VAULY_PROTO_SHOTS, or the runner's temporary folder. */
	let shots = ProcessInfo.processInfo.environment["VAULY_PROTO_SHOTS"] ?? NSTemporaryDirectory()
	let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

	func shot(_ name: String) {
		try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(shots)/\(name).png"))
	}

	func testOpensTheExtension() throws {
		let app = XCUIApplication()
		app.launch()
		app.buttons["Turn on AutoFill"].tap()
		let turnOn = springboard.alerts.buttons["Turn On"]
		if turnOn.waitForExistence(timeout: 5) { turnOn.tap() }
		sleep(1)
		app.textFields["username"].tap()
		shot("2-field")
		app.buttons["Passwords"].firstMatch.tap()
		let provider = app.buttons["vauly proto"]
		XCTAssertTrue(provider.waitForExistence(timeout: 5))
		provider.tap()
		sleep(8)
		shot("3-extension")
	}

	/** The Capacitor shell (../capacitor-shell), installed separately, signs in to the demo. */
	func testShellSignsInToTheDemo() throws {
		let shell = XCUIApplication(bundleIdentifier: "app.vauly.proto.shell")
		shell.activate()
		let signIn = shell.webViews.buttons["Sign in"]
		XCTAssertTrue(signIn.waitForExistence(timeout: 30))
		shot("shell-1-sign-in")
		let start = Date()
		signIn.tap()
		// At phone width the sidebar sits behind Menu, so look for the item search.
		let vault = shell.webViews.textFields["Find an item"]
		let signedIn = vault.waitForExistence(timeout: 60)
		print("SHELL signed in: \(signedIn), after \(String(format: "%.1f", Date().timeIntervalSince(start))) s")
		shot("shell-2-after-sign-in")
		if !signedIn { print("SHELL TREE:\n\(shell.debugDescription)") }
		XCTAssertTrue(signedIn)
	}

	/** The shell's main screens, for #82: sign-in, Overview, the menu, All items, an item, Settings. */
	func testShellScreens() throws {
		let shell = XCUIApplication(bundleIdentifier: "app.vauly.proto.shell")
		shell.activate()
		let web = shell.webViews.firstMatch
		let prefix = ProcessInfo.processInfo.environment["VAULY_PROTO_PREFIX"] ?? ""
		func tap(_ label: String) {
			let any = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label))
			let element = any.allElementsBoundByIndex.first(where: { $0.isHittable }) ?? any.firstMatch
			XCTAssertTrue(element.waitForExistence(timeout: 15), label)
			element.tap()
			sleep(2)
		}
		let signIn = web.buttons["Sign in"]
		if signIn.waitForExistence(timeout: 20) {
			sleep(1)
			shot("\(prefix)1-sign-in")
			signIn.tap()
		}
		XCTAssertTrue(web.textFields["Find an item"].waitForExistence(timeout: 60))
		sleep(3)
		shot("\(prefix)2-overview")
		tap("Menu")
		shot("\(prefix)3-menu")
		tap("All items")
		sleep(2)
		shot("\(prefix)4-all-items")
		let item = web.links.matching(NSPredicate(format: "label CONTAINS 'GitHub' OR label CONTAINS 'AWS' OR label CONTAINS 'Wi'")).firstMatch
		if item.waitForExistence(timeout: 10) { item.tap() } else { web.links.element(boundBy: 8).tap() }
		sleep(3)
		shot("\(prefix)5-item")
		tap("Menu")
		let me = web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Alex Kim'"))
			.allElementsBoundByIndex.last(where: { $0.isHittable })
		XCTAssertNotNil(me)
		me?.tap()
		sleep(1)
		tap("Settings")
		sleep(2)
		shot("\(prefix)6-settings")
		// A link out of vauly opens in Safari, not inside the app.
		tap("Menu")
		tap("Overview")
		tap("Get your own")
		sleep(3)
		let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
		print("SHELL external link opened Safari: \(safari.state == .runningForeground)")
		shot("\(prefix)7-after-link")
		shell.activate()
	}
}
