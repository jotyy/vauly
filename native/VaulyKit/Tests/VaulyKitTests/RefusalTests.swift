import CryptoKit
import Foundation
import XCTest

@testable import VaulyKit

// What VaulyKit refuses: tampered and malformed input, settings outside vauly's limits,
// and numbers that would otherwise trap. Each refusal is an error, never a crash.

private func data(_ base64: String) -> Data { Data(base64Encoded: base64)! }
private func vector(_ name: String) -> [String: Any] {
	(vectorsJson[name] as! [[String: Any]])[0]
}
private func string(_ name: String, _ field: String) -> String { vector(name)[field] as! String }

private let salt = "AAECAwQFBgcICQoLDA0ODw=="

/// The parts of a sealed value, with one byte of one part flipped.
private func flip(_ sealed: Sealed, part: Int, at index: (Int) -> Int) -> Sealed {
	var parts = sealed.split(separator: ".").map { data(String($0)) }
	parts[part][index(parts[part].count)] ^= 1
	return parts.map { $0.base64EncodedString() }.joined(separator: ".")
}

private func assertMalformed(_ body: @autoclosure () throws -> some Any, file: StaticString = #filePath, line: UInt = #line) {
	XCTAssertThrowsError(try body(), file: file, line: line) {
		guard case .malformed = $0 as? VaulyKitError else {
			return XCTFail("\($0) isn't malformed", file: file, line: line)
		}
	}
}

final class RefusalTests: XCTestCase {
	// --- Sealing ---------------------------------------------------------------------

	func testOpenRefusesTamperingAndTheWrongKey() throws {
		let key = SymmetricKey(data: data(string("seal", "key")))
		let sealed = string("seal", "sealed")
		XCTAssertNoThrow(try open(key, sealed))
		XCTAssertThrowsError(try open(key, flip(sealed, part: 1, at: { _ in 0 })))
		XCTAssertThrowsError(try open(key, flip(sealed, part: 1, at: { $0 - 1 })))
		XCTAssertThrowsError(try open(key, flip(sealed, part: 0, at: { _ in 0 })))
		XCTAssertThrowsError(try open(SymmetricKey(size: .bits256), sealed))
		// Additional data where there was none, and none where there was some.
		XCTAssertThrowsError(try open(key, sealed, additionalData: Data("x".utf8)))
		let bound = try seal(key, Data("x".utf8), additionalData: Data("vauly/test".utf8))
		XCTAssertThrowsError(try open(key, bound))
		XCTAssertThrowsError(try open(key, bound, additionalData: Data("vauly/other".utf8)))
	}

	func testOpenRefusesMalformedInput() throws {
		let key = SymmetricKey(data: data(string("seal", "key")))
		let sealed = string("seal", "sealed")
		let parts = sealed.split(separator: ".").map(String.init)
		assertMalformed(try open(key, sealed + ".AAAA"))
		assertMalformed(try open(key, parts[1]))
		assertMalformed(try open(key, "AAAAAAAAAAA=.\(parts[1])"))
		assertMalformed(try open(key, "AAAAAAAAAAAAAAAAAAAAAA==.\(parts[1])"))
		assertMalformed(try open(key, "\(parts[0]).AAAA"))
		assertMalformed(try open(key, "\(parts[0]).not base64!"))
		assertMalformed(try open(key, ""))
	}

	func testEachSealHasAFreshIv() throws {
		let key = SymmetricKey(size: .bits256)
		let ivs = try (0..<8).map { _ in
			try seal(key, Data("same".utf8)).split(separator: ".").first.map { data(String($0)) }!
		}
		XCTAssertEqual(Set(ivs).count, ivs.count)
		XCTAssertTrue(ivs.allSatisfy { $0.count == 12 })
	}

	func testUnwrapKeyRefusesWhatIsNotADataKey() throws {
		let wrapping = SymmetricKey(size: .bits256)
		for length in [16, 24, 31, 33] {
			assertMalformed(try unwrapKey(wrapping, seal(wrapping, Data(count: length))))
		}
	}

	// --- Wrapping for a person -------------------------------------------------------

	func testWrapKeyForUsesAFreshEphemeralKey() throws {
		let recipient = string("wrapKeyFor", "recipientPublicKey")
		let key = SymmetricKey(size: .bits256)
		let wrapped = try (0..<4).map { _ in try wrapKey(for: recipient, key) }
		let ephemerals = wrapped.map { $0.split(separator: ":")[0] }
		XCTAssertEqual(Set(ephemerals).count, wrapped.count)
		XCTAssertEqual(Set(wrapped.map { $0.split(separator: ":")[1].split(separator: ".")[0] }).count, 4)
	}

	func testUnwrapKeyFromRefusesTheWrongPersonAndBadKeys() throws {
		let privateKey = try importPrivateKey(pkcs8: data(string("wrapKeyFor", "recipientPrivateKey")))
		let publicKey = string("wrapKeyFor", "recipientPublicKey")
		let wrapped = string("wrapKeyFor", "wrapped")
		XCTAssertNoThrow(try unwrapKey(from: wrapped, privateKey: privateKey, ownPublicKey: publicKey))
		let someoneElse = PrivateKey()
		// Another person's own public key in the context, or another person's private key.
		XCTAssertThrowsError(
			try unwrapKey(from: wrapped, privateKey: privateKey, ownPublicKey: publicKeyOf(someoneElse)))
		XCTAssertThrowsError(try unwrapKey(from: wrapped, privateKey: someoneElse, ownPublicKey: publicKey))
		// An ephemeral key that isn't on the curve.
		let parts = wrapped.split(separator: ":").map(String.init)
		var spki = data(parts[0])
		spki[spki.count - 1] ^= 1
		XCTAssertThrowsError(
			try unwrapKey(
				from: "\(spki.base64EncodedString()):\(parts[1])", privateKey: privateKey, ownPublicKey: publicKey))
		assertMalformed(try unwrapKey(from: wrapped + ":x", privateKey: privateKey, ownPublicKey: publicKey))
		assertMalformed(try unwrapKey(from: parts[1], privateKey: privateKey, ownPublicKey: publicKey))
	}

	// --- Key derivation --------------------------------------------------------------

	private func argon(_ memory: Int?, passes: Int? = 3) -> KdfSettings {
		KdfSettings(kdfSalt: salt, kdf: .argon2id, kdfIterations: 600_000, kdfPasses: passes, kdfMemory: memory)
	}

	func testCheckKdfKeepsToTheMemoryThisProcessHas() throws {
		XCTAssertNoThrow(try checkKdf(argon(19_456), argon2idSeen: true, memoryLimit: Argon2Memory.autoFill))
		XCTAssertNoThrow(try checkKdf(argon(64 * 1024), argon2idSeen: true, memoryLimit: Argon2Memory.autoFill))
		XCTAssertThrowsError(try checkKdf(argon(64 * 1024 + 1), argon2idSeen: true, memoryLimit: Argon2Memory.autoFill)) {
			XCTAssertEqual($0 as? VaulyKitError, .overMemoryLimit)
		}
		XCTAssertNoThrow(try checkKdf(argon(1024 * 1024), argon2idSeen: true, memoryLimit: Argon2Memory.app))
		// The extension doesn't derive at all: it sends the person to the app.
		XCTAssertThrowsError(
			try checkedMasterKeys(
				password: "pw", settings: argon(256 * 1024), argon2idSeen: true, memoryLimit: Argon2Memory.autoFill)
		) { XCTAssertEqual($0 as? VaulyKitError, .overMemoryLimit) }
	}

	func testCheckedMasterKeysRefusesBadArgon2idWithoutDeriving() {
		for settings in [argon(64 * 1024, passes: 1), argon(64 * 1024, passes: nil), argon(19_455), argon(nil)] {
			XCTAssertThrowsError(
				try checkedMasterKeys(password: "pw", settings: settings, argon2idSeen: false, memoryLimit: Argon2Memory.app)
			) {
				guard case .kdfNotAllowed = $0 as? VaulyKitError else { return XCTFail("\($0)") }
			}
		}
	}

	func testRefuseDowngrade() throws {
		let pbkdf2 = KdfSettings(kdfSalt: salt, kdf: .pbkdf2, kdfIterations: 600_000)
		let old = KdfSettings(kdfSalt: salt, kdf: nil, kdfIterations: 600_000)
		XCTAssertNoThrow(try checkKdf(pbkdf2, argon2idSeen: false, memoryLimit: Argon2Memory.app))
		XCTAssertNoThrow(try checkKdf(old, argon2idSeen: false, memoryLimit: Argon2Memory.app))
		XCTAssertNoThrow(try checkKdf(argon(64 * 1024), argon2idSeen: true, memoryLimit: Argon2Memory.app))
		XCTAssertNoThrow(try checkKdf(argon(64 * 1024), argon2idSeen: false, memoryLimit: Argon2Memory.app))
		for settings in [pbkdf2, old] {
			XCTAssertThrowsError(try checkKdf(settings, argon2idSeen: true, memoryLimit: Argon2Memory.app)) {
				guard case .kdfNotAllowed = $0 as? VaulyKitError else { return XCTFail("\($0)") }
			}
		}
	}

	func testPreloginDecodesAsKdfSettings() throws {
		let prelogin = Data(
			#"{"kdfSalt":"\#(salt)","kdf":"argon2id","kdfIterations":600000,"kdfPasses":3,"kdfMemory":65536}"#.utf8)
		XCTAssertEqual(try JSONDecoder().decode(KdfSettings.self, from: prelogin), argon(64 * 1024))
		let old = Data(#"{"kdfSalt":"\#(salt)","kdf":null,"kdfIterations":600000,"kdfPasses":null,"kdfMemory":null}"#.utf8)
		XCTAssertEqual(try JSONDecoder().decode(KdfSettings.self, from: old).settings.kdf, .pbkdf2)
		let unknown = Data(#"{"kdfSalt":"\#(salt)","kdf":"scrypt","kdfIterations":600000}"#.utf8)
		XCTAssertThrowsError(try JSONDecoder().decode(KdfSettings.self, from: unknown))
	}

	/// Numbers a server could send that would trap a conversion if nothing checked them.
	func testServerNumbersThrowInsteadOfTrapping() {
		for kdf in [
			Kdf(kdf: .pbkdf2, kdfIterations: -1),
			Kdf(kdf: .pbkdf2, kdfIterations: 0),
			Kdf(kdf: .pbkdf2, kdfIterations: 5_000_000_000),
			Kdf(kdf: .argon2id, kdfIterations: 600_000, kdfPasses: -1, kdfMemory: 65_536),
			Kdf(kdf: .argon2id, kdfIterations: 600_000, kdfPasses: 0, kdfMemory: 65_536),
			Kdf(kdf: .argon2id, kdfIterations: 600_000, kdfPasses: 3, kdfMemory: -1),
			Kdf(kdf: .argon2id, kdfIterations: 600_000, kdfPasses: 3, kdfMemory: Int.max / 512),
			Kdf(kdf: .argon2id, kdfIterations: 600_000, kdfPasses: 3, kdfMemory: nil),
		] {
			XCTAssertThrowsError(try deriveMasterKeys(password: "pw", salt: salt, kdf: kdf), "\(kdf)")
		}
	}

	// --- Accounts --------------------------------------------------------------------

	func testUnlockRefusesAPrivateKeyThatIsNotTheAccounts() throws {
		let account = vector("createAccount")
		let password = account["password"] as! String
		let json = try JSONSerialization.data(withJSONObject: account["keys"]!)
		var keys = try JSONDecoder().decode(AccountKeys.self, from: json)
		XCTAssertNoThrow(
			try unlockAccount(password: password, keys: keys, argon2idSeen: true, memoryLimit: Argon2Memory.app))
		keys.publicKey = publicKeyOf(PrivateKey())
		XCTAssertThrowsError(
			try unlockAccount(password: password, keys: keys, argon2idSeen: true, memoryLimit: Argon2Memory.app)
		) { XCTAssertEqual($0 as? VaulyKitError, .anotherKey) }
	}

	// --- JSON --------------------------------------------------------------------------

	private struct Login: Codable, Equatable {
		let name: String
		let url: String?
	}

	private func sealed(_ json: String, _ key: SymmetricKey) throws -> Sealed {
		try seal(key, Data(json.utf8))
	}

	func testOpenJsonRefusesAKeyTwice() throws {
		let key = SymmetricKey(size: .bits256)
		XCTAssertEqual(
			try openJson(Login.self, key, sealed(#"{"name":"a","url":"https://one.example"}"#, key)),
			Login(name: "a", url: "https://one.example"))
		for json in [
			#"{"name":"a","url":"https://one.example","url":"https://two.example"}"#,
			// The same key once escaped: JSON.parse reads each pair as one key.
			#"{"name":"a","url":"https://one.example","\u0075\u0072\u006c":"https://two.example"}"#,
			#"{"name":"a","a/b":1,"a\/b":2}"#,
			#"{"name":"a","😀":1,"\ud83d\ude00":2}"#,
			#"{"name":"a","nested":{"x":1,"x":2}}"#,
			#"{"name":"a","list":[{"x":1},{"y":1,"y":2}]}"#,
		] {
			assertMalformed(try openJson(Login.self, key, sealed(json, key)))
		}
		// Keys must be in NFC, or JSONDecoder could read a field JSON.parse doesn't see: the
		// Kelvin sign for K, a decomposed é, a lone surrogate.
		for json in [
			"{\"name\":\"a\",\"\u{212A}ey\":1}",
			"{\"name\":\"a\",\"e\u{0301}\":1}",
			#"{"name":"a","\#u{5C}ud83d":1}"#,
			#"{"name":"a","\#u{5C}u+041":1}"#,
		] {
			assertMalformed(try openJson(Login.self, key, sealed(json, key)))
		}
		for json in [
			#"{"name":"a","é":1,"名前":2,"😀":3,"\#u{5C}u00e9t\#u{5C}u00e9":4}"#,
			"{\"name\":\"a\",\"\u{00E9}\":1}",
		] {
			XCTAssertNoThrow(try openJson(Login.self, key, sealed(json, key)), json)
		}
		// The same name in different objects is fine.
		XCTAssertNoThrow(try openJson(Login.self, key, sealed(#"{"name":"a","list":[{"x":1},{"x":2}]}"#, key)))
		// Nesting deeper than any item, refused rather than recursed into.
		let deep = String(repeating: "[", count: 10_000) + String(repeating: "]", count: 10_000)
		assertMalformed(try refuseDuplicateKeys(Data(deep.utf8)))
	}

	// --- Device copies and passkeys --------------------------------------------------

	func testDeviceKeyRefusesShortSecrets() {
		assertMalformed(try deviceKey(secret: Data(), pepper: Data()))
		assertMalformed(try deviceKey(secret: Data(count: 16), pepper: Data(count: 32)))
		assertMalformed(try deviceKey(secret: Data(count: 32), pepper: Data(count: 15)))
		XCTAssertNoThrow(try deviceKey(secret: Data(count: 32), pepper: Data(count: 16)))
	}

	func testDeviceCopiesRefuseTamperingAndOtherContexts() throws {
		let device = try deviceKey(
			secret: data(string("deviceKey", "prfOutput")), pepper: data(string("deviceKey", "pepper")))
		let context = DeviceCopyContext(
			accountId: string("deviceKey", "accountId"), credentialId: string("deviceKey", "credentialId"),
			publicKey: string("deviceKey", "publicKey"))
		let sealed = string("deviceKey", "sealed")
		XCTAssertNoThrow(try openDeviceCopy(device, sealed, context: context))
		XCTAssertThrowsError(try openDeviceCopy(device, flip(sealed, part: 1, at: { $0 / 2 }), context: context))
		var other = context
		other.credentialId = "another-credential"
		XCTAssertThrowsError(try openDeviceCopy(device, sealed, context: other))
		other = context
		other.publicKey = publicKeyOf(PrivateKey())
		XCTAssertThrowsError(try openDeviceCopy(device, sealed, context: other))
	}

	func testPasskeyKeysRefuseTampering() throws {
		let vaultKey = SymmetricKey(data: data(string("passkeyKey", "vaultKey")))
		let credentialId = string("passkeyKey", "credentialId")
		let sealed = string("passkeyKey", "sealed")
		XCTAssertNoThrow(try openPasskeyKey(vaultKey, sealed, credentialId: credentialId))
		XCTAssertThrowsError(
			try openPasskeyKey(vaultKey, flip(sealed, part: 1, at: { _ in 0 }), credentialId: credentialId))
	}

	// --- One-time codes ----------------------------------------------------------------

	func testParseTotpRefusesWhatVaulyDoesNotMake() {
		let base = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP"
		for query in ["&period=0", "&period=-30", "&period=301", "&digits=5", "&digits=11", "&digits=x", "&algorithm=MD5", "&algorithm=SHA-256"] {
			XCTAssertNil(parseTotp(base + query), query)
		}
		XCTAssertEqual(parseTotp(base + "&period=300&digits=10")?.period, 300)
		XCTAssertEqual(parseTotp(base + "&algorithm=sha512")?.algorithm, .sha512)
		XCTAssertNil(parseTotp("otpauth://totp/x?issuer=Example"))
		XCTAssertNil(parseTotp("   "))
	}

	func testOneTimeCodesNeverTrap() {
		let config = TotpConfig(secret: "JBSWY3DPEHPK3PXP")
		// Stored items may hold settings parseTotp would refuse.
		XCTAssertEqual(totpSecondsLeft(TotpConfig(secret: "A", period: 0)), 0)
		XCTAssertEqual(totpSecondsLeft(TotpConfig(secret: "A", period: -30)), 0)
		XCTAssertThrowsError(try totpCode(TotpConfig(secret: "A", period: 0)))
		XCTAssertThrowsError(try totpCode(TotpConfig(secret: "JBSWY3DP", digits: 11)))
		XCTAssertThrowsError(try totpCode(TotpConfig(secret: "====")))
		XCTAssertThrowsError(try totpCode(TotpConfig(secret: "18")))
		XCTAssertThrowsError(try totpCode(config, now: Date(timeIntervalSince1970: 1e300)))
		XCTAssertNoThrow(try totpCode(config, now: .distantFuture))
		XCTAssertNoThrow(try totpCode(config, now: Date(timeIntervalSince1970: -100)))
		XCTAssertTrue((1...30).contains(totpSecondsLeft(config, now: Date(timeIntervalSince1970: -100))))
		XCTAssertEqual(totpSecondsLeft(config, now: Date(timeIntervalSince1970: 1e300)), 0)
		// A period no link would give, but a stored item could hold.
		let longest = TotpConfig(secret: "JBSWY3DPEHPK3PXP", period: .max)
		XCTAssertTrue((1...Int.max).contains(totpSecondsLeft(longest, now: Date(timeIntervalSince1970: -100))))
		XCTAssertTrue((1...Int.max).contains(totpSecondsLeft(longest)))
		XCTAssertNoThrow(try totpCode(longest))
	}
}
