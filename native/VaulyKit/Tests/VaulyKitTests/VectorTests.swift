import CryptoKit
import Foundation
import XCTest

@testable import VaulyKit

// Checks VaulyKit against packages/crypto/test-vectors.json, the same file packages/crypto
// is checked against. If this fails, the iPhone app no longer reads what the web app
// writes: fix VaulyKit, or, for a deliberate format change, regenerate the vectors.

private struct Vectors: Decodable {
	struct MasterKeys: Decodable {
		struct Check: Decodable {
			let iv: String
			let plaintext: String
			let sealed: String
		}
		let password: String
		let passwordNfkc: String
		let salt: String
		let kdf: Kdf
		let masterKey: String
		let authKey: String
		let wrapKey: String
		let wrapKeyCheck: Check
	}
	struct Seal: Decodable {
		let key: String
		let iv: String
		let plaintext: String
		let sealed: String
	}
	struct SealJson: Decodable {
		let key: String
		let iv: String
		let json: String
		let sealed: String
	}
	struct WrapKey: Decodable {
		let wrappingKey: String
		let key: String
		let iv: String
		let wrapped: String
	}
	struct WrapKeyFor: Decodable {
		let recipientPrivateKey: String
		let recipientPublicKey: String
		let ephemeralPrivateKey: String
		let ephemeralPublicKey: String
		let key: String
		let iv: String
		let wrapped: String
	}
	struct CreateAccount: Decodable {
		let password: String
		let privateKey: String
		let publicKey: String
		let iv: String
		let authKey: String
		let keys: AccountKeys
	}
	struct ChangeMasterPassword: Decodable {
		let current: String
		let next: String
		let keys: AccountKeys
		let currentAuthKey: String
		let authKey: String
		let nextKeys: AccountKeys
	}
	struct UpgradeKdf: Decodable {
		let password: String
		let keys: AccountKeys
		let currentAuthKey: String
		let authKey: String
		let nextKeys: AccountKeys
	}
	struct DeviceKey: Decodable {
		let prfOutput: String
		let pepper: String
		let deviceKey: String
		let accountId: String
		let credentialId: String
		let publicKey: String
		let privateKey: String
		let iv: String
		let sealed: String
	}
	struct PasskeyKey: Decodable {
		let vaultKey: String
		let credentialId: String
		let privateKey: String
		let iv: String
		let sealed: String
	}
	struct Totp: Decodable {
		let secret: String
		let algorithm: TotpConfig.Algorithm
		let digits: Int
		let period: Int
		let time: Double
		let code: String
	}
	struct ParseTotp: Decodable {
		let input: String
		let config: TotpConfig
	}

	let masterKeys: [MasterKeys]
	let seal: [Seal]
	let sealJson: [SealJson]
	let wrapKey: [WrapKey]
	let wrapKeyFor: [WrapKeyFor]
	let createAccount: [CreateAccount]
	let changeMasterPassword: [ChangeMasterPassword]
	let upgradeKdf: [UpgradeKdf]
	let deviceKey: [DeviceKey]
	let passkeyKey: [PasskeyKey]
	let totp: [Totp]
	let parseTotp: [ParseTotp]
}

/// packages/crypto/test-vectors.json, found from this file's place in the repository.
private let vectors: Vectors = {
	let url = URL(fileURLWithPath: #filePath)
		.deletingLastPathComponent()  // VaulyKitTests
		.deletingLastPathComponent()  // Tests
		.deletingLastPathComponent()  // VaulyKit
		.deletingLastPathComponent()  // native
		.deletingLastPathComponent()  // the repository
		.appendingPathComponent("packages/crypto/test-vectors.json")
	return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
}()

private func key(_ base64: String) -> SymmetricKey { SymmetricKey(data: Data(base64Encoded: base64)!) }
private func raw(_ key: SymmetricKey) -> String { key.withUnsafeBytes { Data($0).base64EncodedString() } }
private func nonce(_ base64: String) -> AES.GCM.Nonce { try! AES.GCM.Nonce(data: Data(base64Encoded: base64)!) }
private func data(_ base64: String) -> Data { Data(base64Encoded: base64)! }

final class VectorTests: XCTestCase {
	func testMasterKeys() throws {
		for vector in vectors.masterKeys {
			let keys = try deriveMasterKeys(password: vector.password, salt: vector.salt, kdf: vector.kdf)
			XCTAssertEqual(keys.authKey, vector.authKey, vector.password)
			XCTAssertEqual(keys.wrapKey.withUnsafeBytes { Data($0).hex }, vector.wrapKey)
			XCTAssertEqual(vector.password.precomposedStringWithCompatibilityMapping, vector.passwordNfkc)
			let check = vector.wrapKeyCheck
			let made = try seal(
				keys.wrapKey, Data(check.plaintext.utf8), additionalData: nil, nonce: nonce(check.iv))
			XCTAssertEqual(made, check.sealed)
		}
	}

	func testSealAndOpen() throws {
		for vector in vectors.seal {
			let made = try seal(
				key(vector.key), Data(vector.plaintext.utf8), additionalData: nil, nonce: nonce(vector.iv))
			XCTAssertEqual(made, vector.sealed)
			XCTAssertEqual(String(decoding: try open(key(vector.key), vector.sealed), as: UTF8.self), vector.plaintext)
		}
	}

	func testSealJsonAndOpenJson() throws {
		struct Item: Codable, Equatable {
			let kind: String
			let name: String
			let username: String
		}
		for vector in vectors.sealJson {
			let made = try seal(
				key(vector.key), Data(vector.json.utf8), additionalData: nil, nonce: nonce(vector.iv))
			XCTAssertEqual(made, vector.sealed)
			let item = try openJson(Item.self, key(vector.key), vector.sealed)
			XCTAssertEqual(item, try JSONDecoder().decode(Item.self, from: Data(vector.json.utf8)))
			// What VaulyKit seals, the web app reads back the same.
			let again = try openJson(Item.self, key(vector.key), sealJson(key(vector.key), item))
			XCTAssertEqual(again, item)
		}
	}

	func testWrapKey() throws {
		for vector in vectors.wrapKey {
			let made = try seal(
				key(vector.wrappingKey), data(vector.key), additionalData: nil, nonce: nonce(vector.iv))
			XCTAssertEqual(made, vector.wrapped)
			XCTAssertEqual(raw(try unwrapKey(key(vector.wrappingKey), vector.wrapped)), vector.key)
		}
	}

	func testWrapKeyFor() throws {
		for vector in vectors.wrapKeyFor {
			let ephemeral = try importPrivateKey(pkcs8: data(vector.ephemeralPrivateKey))
			XCTAssertEqual(publicKeyOf(ephemeral), vector.ephemeralPublicKey)
			let made = try wrapKey(
				for: vector.recipientPublicKey, key(vector.key), ephemeral: ephemeral, nonce: nonce(vector.iv))
			XCTAssertEqual(made, vector.wrapped)
			let recipient = try importPrivateKey(pkcs8: data(vector.recipientPrivateKey))
			XCTAssertEqual(publicKeyOf(recipient), vector.recipientPublicKey)
			let opened = try unwrapKey(
				from: vector.wrapped, privateKey: recipient, ownPublicKey: vector.recipientPublicKey)
			XCTAssertEqual(raw(opened), vector.key)
		}
	}

	func testAccountsUnlock() throws {
		for vector in vectors.createAccount {
			let unlocked = try unlockAccount(password: vector.password, keys: vector.keys)
			XCTAssertEqual(unlocked.authKey, vector.authKey)
			XCTAssertEqual(publicKeyOf(unlocked.privateKey), vector.keys.publicKey)
			// The private key sealed the way createAccount seals it.
			let master = try deriveMasterKeys(
				password: vector.password, salt: vector.keys.kdfSalt, kdf: vector.keys.settings)
			let sealed = try seal(
				master.wrapKey, data(vector.privateKey), additionalData: nil, nonce: nonce(vector.iv))
			XCTAssertEqual(sealed, vector.keys.encryptedPrivateKey)
			XCTAssertNoThrow(try checkedMasterKeys(password: vector.password, keys: vector.keys))
		}
		for vector in vectors.changeMasterPassword {
			XCTAssertEqual(try unlockAccount(password: vector.current, keys: vector.keys).authKey, vector.currentAuthKey)
			let next = try unlockAccount(password: vector.next, keys: vector.nextKeys)
			XCTAssertEqual(next.authKey, vector.authKey)
			XCTAssertEqual(publicKeyOf(next.privateKey), vector.keys.publicKey)
			XCTAssertThrowsError(try unlockAccount(password: vector.current, keys: vector.nextKeys))
		}
		for vector in vectors.upgradeKdf {
			XCTAssertEqual(try unlockAccount(password: vector.password, keys: vector.keys).authKey, vector.currentAuthKey)
			XCTAssertEqual(try unlockAccount(password: vector.password, keys: vector.nextKeys).authKey, vector.authKey)
			// The account from before the move derives too little to pass vauly's limits.
			XCTAssertThrowsError(try checkedMasterKeys(password: vector.password, keys: vector.keys))
		}
	}

	func testDeviceCopies() throws {
		for vector in vectors.deviceKey {
			let device = deviceKey(secret: data(vector.prfOutput), pepper: data(vector.pepper))
			XCTAssertEqual(device.withUnsafeBytes { Data($0).hex }, vector.deviceKey)
			let context = DeviceCopyContext(
				accountId: vector.accountId, credentialId: vector.credentialId, publicKey: vector.publicKey)
			let made = try seal(
				device, data(vector.privateKey), additionalData: context.additionalData, nonce: nonce(vector.iv))
			XCTAssertEqual(made, vector.sealed)
			XCTAssertEqual(publicKeyOf(try openDeviceCopy(device, vector.sealed, context: context)), vector.publicKey)
			// Another session's pepper, or another context, doesn't open it.
			let otherPepper = deviceKey(secret: data(vector.prfOutput), pepper: Data(count: 32))
			XCTAssertThrowsError(try openDeviceCopy(otherPepper, vector.sealed, context: context))
			var other = context
			other.accountId = "user_someone_else"
			XCTAssertThrowsError(try openDeviceCopy(device, vector.sealed, context: other))
			// A copy holding someone else's key is refused.
			let stranger = try sealDeviceCopy(
				device, privateKeyPkcs8: data(vectors.wrapKeyFor[0].recipientPrivateKey), context: context)
			XCTAssertThrowsError(try openDeviceCopy(device, stranger, context: context)) {
				XCTAssertEqual($0 as? VaulyKitError, .anotherKey)
			}
		}
	}

	func testPasskeyKeys() throws {
		for vector in vectors.passkeyKey {
			let vaultKey = key(vector.vaultKey)
			let made = try seal(
				vaultKey, data(vector.privateKey),
				additionalData: Data("vauly/passkey\n\(vector.credentialId)".utf8), nonce: nonce(vector.iv))
			XCTAssertEqual(made, vector.sealed)
			let opened = try openPasskeyKey(vaultKey, vector.sealed, credentialId: vector.credentialId)
			XCTAssertEqual(opened.base64EncodedString(), vector.privateKey)
			XCTAssertThrowsError(try openPasskeyKey(vaultKey, vector.sealed, credentialId: "another-passkey"))
			XCTAssertThrowsError(try open(vaultKey, vector.sealed))
		}
	}

	func testOneTimeCodes() throws {
		for vector in vectors.totp {
			let config = TotpConfig(
				secret: vector.secret, digits: vector.digits, period: vector.period, algorithm: vector.algorithm)
			XCTAssertEqual(try totpCode(config, now: Date(timeIntervalSince1970: vector.time)), vector.code)
		}
		for vector in vectors.parseTotp {
			XCTAssertEqual(parseTotp(vector.input), vector.config)
		}
	}

	func testKdfLimits() {
		let salt = "AAECAwQFBgcICQoLDA0ODw=="
		XCTAssertTrue(kdfAllowed(.argon2id, salt: salt))
		XCTAssertTrue(kdfAllowed(Kdf(kdf: .pbkdf2, kdfIterations: 600_000), salt: salt))
		XCTAssertFalse(kdfAllowed(Kdf(kdf: .pbkdf2, kdfIterations: 1_000), salt: salt))
		XCTAssertFalse(
			kdfAllowed(Kdf(kdf: .argon2id, kdfIterations: 600_000, kdfPasses: 3, kdfMemory: 2 * 1024 * 1024), salt: salt))
		XCTAssertFalse(kdfAllowed(.argon2id, salt: "AAEC"))
		XCTAssertThrowsError(try refuseDowngrade(Kdf(kdf: .pbkdf2, kdfIterations: 600_000), argon2idSeen: true))
		XCTAssertNoThrow(try refuseDowngrade(.argon2id, argon2idSeen: true))
	}
}
