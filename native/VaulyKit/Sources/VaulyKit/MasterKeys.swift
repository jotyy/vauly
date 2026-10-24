import Clibsodium
import CommonCrypto
import CryptoKit
import Foundation

// The master password, as packages/crypto derives it:
//
//   master password ─Argon2id─▶ master key ─HKDF─┬─▶ auth key  (sent to the server as the login password)
//                                                └─▶ wrap key  (encrypts the account private key)
//
// Accounts made before Argon2id use PBKDF2-SHA256 until the web app moves them.

/// PBKDF2-SHA256's rounds: what accounts used before Argon2id, and the least vauly accepts.
public let kdfIterations = 600_000

/// How the master password becomes the master key. The server keeps it with the salt.
public struct Kdf: Codable, Equatable, Sendable {
	public enum Algorithm: String, Codable, Sendable {
		case pbkdf2
		case argon2id
	}

	public var kdf: Algorithm
	/// PBKDF2's rounds; Argon2id accounts keep 600,000 here too.
	public var kdfIterations: Int
	/// Argon2's passes; nil for PBKDF2.
	public var kdfPasses: Int?
	/// Argon2's memory in KiB; nil for PBKDF2. Argon2 runs one lane.
	public var kdfMemory: Int?

	public init(kdf: Algorithm, kdfIterations: Int, kdfPasses: Int? = nil, kdfMemory: Int? = nil) {
		self.kdf = kdf
		self.kdfIterations = kdfIterations
		self.kdfPasses = kdfPasses
		self.kdfMemory = kdfMemory
	}

	/// What new accounts use: 64 MiB, three passes, one lane.
	public static let argon2id = Kdf(
		kdf: .argon2id, kdfIterations: VaulyKit.kdfIterations, kdfPasses: 3, kdfMemory: 64 * 1024)
}

/// What the server stores per person: it can hand it back, but cannot open it. Copies
/// saved before Argon2id have no `kdf`, `kdfPasses` or `kdfMemory`, and are PBKDF2.
public struct AccountKeys: Codable, Equatable, Sendable {
	public var kdfSalt: String
	public var kdf: Kdf.Algorithm?
	public var kdfIterations: Int
	public var kdfPasses: Int?
	public var kdfMemory: Int?
	public var publicKey: String
	public var encryptedPrivateKey: Sealed

	public init(
		kdfSalt: String, kdf: Kdf.Algorithm?, kdfIterations: Int, kdfPasses: Int?, kdfMemory: Int?,
		publicKey: String, encryptedPrivateKey: Sealed
	) {
		self.kdfSalt = kdfSalt
		self.kdf = kdf
		self.kdfIterations = kdfIterations
		self.kdfPasses = kdfPasses
		self.kdfMemory = kdfMemory
		self.publicKey = publicKey
		self.encryptedPrivateKey = encryptedPrivateKey
	}

	public var settings: Kdf {
		Kdf(kdf: kdf ?? .pbkdf2, kdfIterations: kdfIterations, kdfPasses: kdfPasses, kdfMemory: kdfMemory)
	}
}

/// vauly's limits, the same as packages/crypto's and the server's: PBKDF2 needs at least
/// 600,000 rounds; Argon2id 19 MiB to 1 GiB and two to ten passes; the salt is 16 bytes.
/// A server that lowered the work could test guesses against the auth key it gets back;
/// one that raised it could make a phone run out of memory.
public func kdfAllowed(_ kdf: Kdf, salt: String) -> Bool {
	guard Data(base64Encoded: salt)?.count == 16 else { return false }
	guard kdf.kdfIterations >= kdfIterations, kdf.kdfIterations <= 10_000_000 else { return false }
	switch kdf.kdf {
	case .pbkdf2:
		return kdf.kdfPasses == nil && kdf.kdfMemory == nil
	case .argon2id:
		guard let memory = kdf.kdfMemory, let passes = kdf.kdfPasses else { return false }
		return (19 * 1024...1024 * 1024).contains(memory) && (2...10).contains(passes)
	}
}

/// Refuses PBKDF2 for an account this device has seen use Argon2id: a server that asked
/// for it again could be lowering the work to attack the auth key.
public func refuseDowngrade(_ kdf: Kdf, argon2idSeen: Bool) throws {
	if argon2idSeen && kdf.kdf != .argon2id {
		throw VaulyKitError.kdfNotAllowed(
			"This account uses Argon2id on this device, but the server now asks for older key derivation, so your master password wasn't used."
		)
	}
}

public struct MasterKeys: Sendable {
	/// Sent to the server instead of the password, in hex; the server hashes it again.
	public let authKey: String
	/// Never leaves the device. Encrypts the account's private key.
	public let wrapKey: SymmetricKey
}

func masterBits(password: String, salt: Data, kdf: Kdf) throws -> SymmetricKey {
	let bytes = Array(password.precomposedStringWithCompatibilityMapping.utf8)
	var out = [UInt8](repeating: 0, count: 32)
	defer { out.withUnsafeMutableBytes { sodium_memzero($0.baseAddress, $0.count) } }
	switch kdf.kdf {
	case .argon2id:
		guard sodium_init() >= 0, salt.count == Int(crypto_pwhash_saltbytes()) else {
			throw VaulyKitError.argon2
		}
		// libsodium wants a pointer even for an empty password, which an empty array lacks.
		let chars = bytes.isEmpty ? [CChar(0)] : bytes.map { CChar(bitPattern: $0) }
		let status = salt.withUnsafeBytes { saltBytes in
			chars.withUnsafeBufferPointer { password in
				crypto_pwhash(
					&out, 32, password.baseAddress!, UInt64(bytes.count),
					saltBytes.bindMemory(to: UInt8.self).baseAddress!,
					UInt64(kdf.kdfPasses ?? 0), (kdf.kdfMemory ?? 0) * 1024,
					crypto_pwhash_ALG_ARGON2ID13)
			}
		}
		guard status == 0 else { throw VaulyKitError.argon2 }
	case .pbkdf2:
		let status = salt.withUnsafeBytes { saltBytes in
			bytes.withUnsafeBufferPointer { passwordBytes in
				passwordBytes.withMemoryRebound(to: CChar.self) { password in
					CCKeyDerivationPBKDF(
						CCPBKDFAlgorithm(kCCPBKDF2), password.baseAddress, bytes.count,
						saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count,
						CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(kdf.kdfIterations), &out, 32)
				}
			}
		}
		guard status == kCCSuccess else { throw VaulyKitError.pbkdf2 }
	}
	return SymmetricKey(data: out)
}

private func hkdf(_ master: SymmetricKey, _ info: String) -> SymmetricKey {
	HKDF<SHA256>.deriveKey(
		inputKeyMaterial: master, salt: Data(count: 32), info: Data(info.utf8), outputByteCount: 32)
}

/// The auth key and wrap key for a password, salt and settings. It doesn't check the
/// settings: the apps use `checkedMasterKeys`.
public func deriveMasterKeys(password: String, salt: String, kdf: Kdf = .argon2id) throws
	-> MasterKeys
{
	let master = try masterBits(password: password, salt: Data(base64: salt, "salt"), kdf: kdf)
	return MasterKeys(
		authKey: hkdf(master, "vauly/auth").withUnsafeBytes { Data($0).hex },
		wrapKey: hkdf(master, "vauly/wrap"))
}

/// The master keys for an account's settings, once they're checked against vauly's
/// limits: the settings decide how hard the auth key the server gets back is to attack.
public func checkedMasterKeys(password: String, keys: AccountKeys) throws -> MasterKeys {
	guard kdfAllowed(keys.settings, salt: keys.kdfSalt) else {
		throw VaulyKitError.kdfNotAllowed(
			"This server asks for different key derivation than vauly allows, so your master password wasn't used."
		)
	}
	return try deriveMasterKeys(password: password, salt: keys.kdfSalt, kdf: keys.settings)
}
