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
	struct SnapshotVector: Decodable {
		struct Meta: Decodable, Equatable {
			let name: String
			let description: String
		}
		struct Fields: Decodable, Equatable {
			let kind: String
			let name: String
			let username: String
		}
		let privateKey: String
		let snapshot: Snapshot
		let vaultMeta: Meta
		let item: Fields
	}
	let deviceKey: [DeviceKey]
	let snapshot: [SnapshotVector]
	let passkeyKey: [PasskeyKey]
	let totp: [Totp]
	let parseTotp: [ParseTotp]
}

private let vectorsURL = URL(fileURLWithPath: #filePath)
	.deletingLastPathComponent()  // VaulyKitTests
	.deletingLastPathComponent()  // Tests
	.deletingLastPathComponent()  // VaulyKit
	.deletingLastPathComponent()  // native
	.deletingLastPathComponent()  // the repository
	.appendingPathComponent("packages/crypto/test-vectors.json")

/// packages/crypto/test-vectors.json, found from this file's place in the repository.
private let vectors = try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: vectorsURL))

/// The same file as plain JSON, for what Vectors can't decode up front.
let vectorsJson =
	try! JSONSerialization.jsonObject(with: Data(contentsOf: vectorsURL)) as! [String: Any]

private func key(_ base64: String) -> SymmetricKey { SymmetricKey(data: Data(base64Encoded: base64)!) }
private func raw(_ key: SymmetricKey) -> String { key.withUnsafeBytes { Data($0).base64EncodedString() } }
private func nonce(_ base64: String) -> AES.GCM.Nonce { try! AES.GCM.Nonce(data: Data(base64Encoded: base64)!) }
private func data(_ base64: String) -> Data { Data(base64Encoded: base64)! }

/// What an old account's vectors need: they're below vauly's limits, so the checked
/// functions refuse them.
private func uncheckedUnlock(password: String, keys: AccountKeys) throws -> UnlockedAccount {
	let master = try deriveMasterKeys(password: password, salt: keys.kdfSalt, kdf: keys.settings)
	return UnlockedAccount(
		authKey: master.authKey, privateKey: try openPrivateKey(wrapKey: master.wrapKey, keys: keys))
}

private func unlock(password: String, keys: AccountKeys) throws -> UnlockedAccount {
	try unlockAccount(password: password, keys: keys, argon2idSeen: false, memoryLimit: Argon2Memory.app)
}

final class VectorTests: XCTestCase {
	/// A list left empty would pass every loop below without checking anything.
	func testEveryListHasVectors() {
		for (name, value) in vectorsJson {
			if let list = value as? [Any] { XCTAssertFalse(list.isEmpty, name) }
		}
	}

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
			// What VaulyKit seals, it opens to the same. (Only a round trip in Swift: JSONEncoder
			// and JSON.stringify differ for nil fields and dates, as sealJson says.)
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
			let unlocked = try unlock(password: vector.password, keys: vector.keys)
			XCTAssertEqual(unlocked.authKey, vector.authKey)
			XCTAssertEqual(publicKeyOf(unlocked.privateKey), vector.keys.publicKey)
			// The private key sealed the way createAccount seals it.
			let master = try deriveMasterKeys(
				password: vector.password, salt: vector.keys.kdfSalt, kdf: vector.keys.settings)
			let sealed = try seal(
				master.wrapKey, data(vector.privateKey), additionalData: nil, nonce: nonce(vector.iv))
			XCTAssertEqual(sealed, vector.keys.encryptedPrivateKey)
			// Signing in derives from prelogin's settings, before the keys come back.
			let signIn = try checkedMasterKeys(
				password: vector.password, settings: vector.keys.kdfSettings, argon2idSeen: true,
				memoryLimit: Argon2Memory.app)
			XCTAssertEqual(signIn.authKey, vector.authKey)
			XCTAssertEqual(
				publicKeyOf(try openPrivateKey(wrapKey: signIn.wrapKey, keys: vector.keys)), vector.keys.publicKey)
		}
		for vector in vectors.changeMasterPassword {
			XCTAssertEqual(try unlock(password: vector.current, keys: vector.keys).authKey, vector.currentAuthKey)
			let next = try unlock(password: vector.next, keys: vector.nextKeys)
			XCTAssertEqual(next.authKey, vector.authKey)
			XCTAssertEqual(publicKeyOf(next.privateKey), vector.keys.publicKey)
			XCTAssertThrowsError(try unlock(password: vector.current, keys: vector.nextKeys))
		}
		for vector in vectors.upgradeKdf {
			XCTAssertEqual(
				try uncheckedUnlock(password: vector.password, keys: vector.keys).authKey, vector.currentAuthKey)
			XCTAssertEqual(try unlock(password: vector.password, keys: vector.nextKeys).authKey, vector.authKey)
			// The account from before the move derives too little to pass vauly's limits.
			XCTAssertThrowsError(try unlock(password: vector.password, keys: vector.keys)) {
				guard case .kdfNotAllowed = $0 as? VaulyKitError else { return XCTFail("\($0)") }
			}
		}
	}

	func testDeviceCopies() throws {
		for vector in vectors.deviceKey {
			let device = try deviceKey(secret: data(vector.prfOutput), pepper: data(vector.pepper))
			XCTAssertEqual(device.withUnsafeBytes { Data($0).hex }, vector.deviceKey)
			let context = DeviceCopyContext(
				accountId: vector.accountId, credentialId: vector.credentialId, publicKey: vector.publicKey)
			let made = try seal(
				device, data(vector.privateKey), additionalData: context.additionalData, nonce: nonce(vector.iv))
			XCTAssertEqual(made, vector.sealed)
			XCTAssertEqual(publicKeyOf(try openDeviceCopy(device, vector.sealed, context: context)), vector.publicKey)
			// Another session's pepper, or another context, doesn't open it.
			let otherPepper = try deviceKey(secret: data(vector.prfOutput), pepper: Data(count: 32))
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

	/// The limits table, which packages/crypto is checked against too. Only an algorithm
	/// Swift doesn't know may fail to decode, which refuses it as well.
	func testKdfLimits() throws {
		let cases = try XCTUnwrap(vectorsJson["kdfLimits"] as? [[String: Any]])
		for limit in cases {
			let why = limit["why"] as! String
			let fields = limit["settings"] as! [String: Any]
			let allowed = limit["allowed"] as! Bool
			let json = try JSONSerialization.data(withJSONObject: fields)
			guard let settings = try? JSONDecoder().decode(KdfSettings.self, from: json) else {
				XCTAssertEqual(fields["kdf"] as? String, "scrypt", "\(why) fails to decode")
				XCTAssertFalse(allowed, why)
				continue
			}
			XCTAssertEqual(kdfAllowed(settings), allowed, why)
		}
	}

	/// The offline copy the app keeps for its AutoFill extension opens as the web app sealed it,
	/// down to an item, and for nobody else.
	func testSnapshot() throws {
		XCTAssertFalse(vectors.snapshot.isEmpty)
		let other = try importPrivateKey(pkcs8: Data(
			base64Encoded: ((vectorsJson["wrapKeyFor"] as! [[String: Any]])[0]["recipientPrivateKey"] as! String))!)
		for vector in vectors.snapshot {
			let privateKey = try importPrivateKey(pkcs8: Data(base64Encoded: vector.privateKey)!)
			let contents = try openSnapshot(vector.snapshot, privateKey: privateKey)
			let expected = (vectorsJson["snapshot"] as! [[String: Any]])[0]["contents"] as! [String: Any]
			XCTAssertEqual(contents.profile.id, (expected["profile"] as! [String: Any])["id"] as? String)
			XCTAssertEqual(contents.vaults.map(\.id), (expected["vaults"] as! [[String: Any]]).map { $0["id"] as! String })
			XCTAssertEqual(contents.items.map(\.id), (expected["items"] as! [[String: Any]]).map { $0["id"] as! String })

			let vault = try XCTUnwrap(contents.vaults.first)
			let key = try vaultKey(vault, privateKey: privateKey)
			XCTAssertEqual(try openJson(Vectors.SnapshotVector.Meta.self, key, vault.encryptedMeta), vector.vaultMeta)
			let item = try XCTUnwrap(contents.items.first { $0.vaultId == vault.id })
			XCTAssertEqual(try openItem(Vectors.SnapshotVector.Fields.self, item, vaultKey: key), vector.item)

			// As stored: it reads back the same, and another account's key doesn't open it.
			XCTAssertEqual(try decodeSnapshot(JSONEncoder().encode(vector.snapshot)), vector.snapshot)
			XCTAssertThrowsError(try openSnapshot(vector.snapshot, privateKey: other))
			var changed = vector.snapshot
			changed.sealed = String(changed.sealed.dropLast(4)) + "AAA="
			XCTAssertThrowsError(try openSnapshot(changed, privateKey: privateKey))

			// Used for 30 days after its sync, and not when it says it's from the future.
			let synced = Date(timeIntervalSince1970: vector.snapshot.syncedAt / 1000)
			XCTAssertTrue(isFresh(vector.snapshot, now: synced.addingTimeInterval(29 * 86_400)))
			XCTAssertFalse(isFresh(vector.snapshot, now: synced.addingTimeInterval(30 * 86_400)))
			XCTAssertFalse(isFresh(vector.snapshot, now: synced.addingTimeInterval(-120)))
		}
	}
}
