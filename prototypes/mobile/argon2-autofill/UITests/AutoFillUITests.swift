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

	/** The iPhone look (#82 step 2): the same screens through the tab bar, scrolled too. */
	func testNativeScreens() throws {
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
		XCTAssertTrue(web.links["Items"].waitForExistence(timeout: 60))
		sleep(3)
		shot("\(prefix)2-overview")
		web.swipeUp(velocity: .slow)
		sleep(2)
		shot("\(prefix)3-overview-scrolled")
		tap("Items")
		web.swipeDown(velocity: .fast)
		sleep(2)
		shot("\(prefix)4-items")
		web.swipeUp(velocity: .slow)
		sleep(2)
		shot("\(prefix)5-items-scrolled")
		web.swipeDown(velocity: .fast)
		sleep(1)
		let item = web.links.matching(NSPredicate(format: "label CONTAINS 'AWS root'")).firstMatch
		XCTAssertTrue(item.waitForExistence(timeout: 10))
		// A row slides left to show its actions; a tap on it closes them again.
		item.swipeLeft()
		sleep(1)
		shot("\(prefix)5b-swipe")
		item.tap()
		sleep(1)
		item.tap()
		sleep(3)
		shot("\(prefix)6-item")
		web.swipeUp(velocity: .slow)
		sleep(2)
		shot("\(prefix)6b-item-scrolled")
		tap("More actions")
		sleep(1)
		shot("\(prefix)6c-item-menu")
		web.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.6)).tap()
		sleep(1)
		tap("Settings")
		sleep(2)
		shot("\(prefix)7-settings")
		tap("Items")
		tap("New item")
		sleep(2)
		shot("\(prefix)8-new-item-sheet")
		web.buttons["Cancel"].firstMatch.tap()
		sleep(1)

		// Long titles: an item renamed for the shot and back, and a vault with a long name.
		func rename(to name: String) {
			tap("Edit")
			let field = shell.webViews.textFields["Name"].firstMatch
			XCTAssertTrue(field.waitForExistence(timeout: 10))
			// The caret goes where the tap lands: at the end, then delete back to empty.
			field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
			let old = (field.value as? String) ?? ""
			field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count + 2))
			// Return submits the form; Save sits under the keyboard.
			field.typeText(name + "\n")
			sleep(3)
		}
		let aws = web.links.matching(NSPredicate(format: "label CONTAINS 'AWS root'")).firstMatch
		XCTAssertTrue(aws.waitForExistence(timeout: 10))
		aws.tap()
		sleep(2)
		rename(to: "AWS root account for production billing")
		shot("\(prefix)9-item-long-name")
		rename(to: "AWS root")

		tap("Vaults")
		web.swipeDown(velocity: .fast)
		sleep(1)
		shot("\(prefix)10-vaults")
		web.swipeUp(velocity: .fast)
		sleep(1)
		let vaultName = "Customer support escalations"
		let existing = web.descendants(matching: .any)
			.matching(NSPredicate(format: "label == %@", "Open \(vaultName)")).firstMatch
		if existing.waitForExistence(timeout: 3) {
			existing.tap()
		} else {
			tap("New vault")
			let field = shell.webViews.textFields["Name"].firstMatch
			XCTAssertTrue(field.waitForExistence(timeout: 10))
			field.tap()
			field.typeText(vaultName + "\n")
		}
		sleep(3)
		shot("\(prefix)11-vault-long-name")
	}

	/** #78: apps/mobile, installed fresh, connects to a local vauly and signs in. */
	func testConnectsToAnyVauly() throws {
		let app = XCUIApplication(bundleIdentifier: "app.vauly")
		let env = ProcessInfo.processInfo.environment
		// Attached to a copy already running, its console stays with whoever started it.
		let attach = env["VAULY_PROTO_ATTACH"] != nil
		if attach { app.activate() } else { app.launch() }
		let web = app.webViews.firstMatch
		let address = env["VAULY_PROTO_ADDRESS"] ?? "http://127.0.0.1:3202"
		func tap(_ label: String) {
			let any = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label))
			let element = any.allElementsBoundByIndex.first(where: { $0.isHittable }) ?? any.firstMatch
			XCTAssertTrue(element.waitForExistence(timeout: 15), label)
			element.tap()
			sleep(2)
		}
		func fill(_ field: XCUIElement, _ text: String) {
			XCTAssertTrue(field.waitForExistence(timeout: 15))
			// The caret goes where the tap lands: at the end, then delete back to empty.
			field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
			let old = (field.value as? String) ?? ""
			if !old.isEmpty, old != field.placeholderValue {
				field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count + 2))
			}
			field.typeText(text)
		}
		let field = web.textFields["Address"]
		XCTAssertTrue(field.waitForExistence(timeout: 30))
		sleep(1)
		shot("c1-connect")
		fill(field, "gone.invalid")
		web.buttons["Connect"].tap()
		let unreachable = web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'reach gone.invalid'")).firstMatch
		XCTAssertTrue(unreachable.waitForExistence(timeout: 40))
		shot("c2-unreachable")
		fill(field, address)
		web.buttons["Connect"].tap()
		let email = web.textFields["Email"]
		XCTAssertTrue(email.waitForExistence(timeout: 30))
		sleep(1)
		shot("c3-sign-in")
		fill(email, "alex@acme.test")
		let password = web.secureTextFields["Master password"]
		password.tap()
		sleep(1)
		password.typeText("correct horse battery staple 42")
		web.buttons["Sign in"].tap()
		XCTAssertTrue(web.links["Items"].waitForExistence(timeout: 60))
		sleep(3)
		shot("c4-signed-in")
		tap("Settings")
		sleep(1)
		shot("c5-settings")
		let device = web.staticTexts["Your vauly"]
		for _ in 0..<6 where !device.isHittable { web.swipeUp(velocity: .slow) }
		sleep(2)
		shot("c5b-settings-this-device")
		tap("Items")
		tap("New item")
		let name = app.webViews.textFields["Name"].firstMatch
		XCTAssertTrue(name.waitForExistence(timeout: 10))
		if env["VAULY_PROTO_NOTES_FIRST"] == nil {
			name.tap()
			name.typeText("G")
			sleep(2)
			shot("c6-sheet-keyboard")
		}
		let notes = app.webViews.textViews.firstMatch
		if notes.waitForExistence(timeout: 5) {
			print("NOTES before: \(notes.frame) hittable \(notes.isHittable)")
			// Scrolled into view first, as a person would, then tapped.
			for _ in 0..<4 where !notes.isHittable { web.swipeUp(velocity: .slow) }
			sleep(1)
			print("NOTES scrolled: \(notes.frame) hittable \(notes.isHittable)")
			shot("c6a-sheet-scrolled")
			notes.tap()
			notes.typeText("n")
			sleep(2)
			print("NOTES typing: \(notes.frame) hittable \(notes.isHittable)")
			shot("c6b-sheet-keyboard-notes")
		}
		web.buttons["Cancel"].firstMatch.tap()
		sleep(1)
		if attach { return }
		// The session is in the Keychain: a new launch opens locked, not signed out.
		app.terminate()
		app.launch()
		XCTAssertTrue(web.secureTextFields.firstMatch.waitForExistence(timeout: 30))
		sleep(2)
		shot("c7-relaunched")
	}
}
