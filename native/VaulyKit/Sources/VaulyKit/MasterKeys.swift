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

	/// The salt and settings, as prelogin would give them.
	public var kdfSettings: KdfSettings {
		KdfSettings(
			kdfSalt: kdfSalt, kdf: kdf, kdfIterations: kdfIterations, kdfPasses: kdfPasses,
			kdfMemory: kdfMemory)
	}

	public var settings: Kdf { kdfSettings.settings }
}

/// What the server says to derive with: the account's salt and settings, as prelogin
/// returns them. Accounts from before Argon2id have no `kdf`, and are PBKDF2. An
/// algorithm vauly doesn't know fails to decode.
public struct KdfSettings: Codable, Equatable, Sendable {
	public var kdfSalt: String
	public var kdf: Kdf.Algorithm?
	public var kdfIterations: Int
	public var kdfPasses: Int?
	public var kdfMemory: Int?

	public init(
		kdfSalt: String, kdf: Kdf.Algorithm?, kdfIterations: Int, kdfPasses: Int? = nil,
		kdfMemory: Int? = nil
	) {
		self.kdfSalt = kdfSalt
		self.kdf = kdf
		self.kdfIterations = kdfIterations
		self.kdfPasses = kdfPasses
		self.kdfMemory = kdfMemory
	}

	public init(kdfSalt: String, _ kdf: Kdf) {
		self.init(
			kdfSalt: kdfSalt, kdf: kdf.kdf, kdfIterations: kdf.kdfIterations, kdfPasses: kdf.kdfPasses,
			kdfMemory: kdf.kdfMemory)
	}

	public var settings: Kdf {
		Kdf(kdf: kdf ?? .pbkdf2, kdfIterations: kdfIterations, kdfPasses: kdfPasses, kdfMemory: kdfMemory)
	}
}

/// The most memory Argon2id may take, in KiB, by where it runs. iOS gives an AutoFill
/// extension about 120 MiB in all and ends it, rather than failing an allocation, when it
/// goes over, so the extension stops well short and leaves heavier accounts to the app.
/// At 64 MiB, today's default, the extension prototype peaked at 88 MiB (#8).
public enum Argon2Memory {
	/// The app itself: all of vauly's range, up to 1 GiB.
	public static let app = 1024 * 1024
	/// The AutoFill extension.
	public static let autoFill = 64 * 1024
}

/// vauly's limits, the same as packages/crypto's and the server's: PBKDF2 needs at least
/// 600,000 rounds; Argon2id 19 MiB to 1 GiB and two to ten passes; the salt is 16 bytes.
/// A server that lowered the work could test guesses against the auth key it gets back;
/// one that raised it could make a phone run out of memory.
public func kdfAllowed(_ settings: KdfSettings) -> Bool {
	let kdf = settings.settings
	guard Data(base64Encoded: settings.kdfSalt)?.count == 16 else { return false }
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
func refuseDowngrade(_ kdf: Kdf, argon2idSeen: Bool) throws {
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
		// The server's numbers, refused rather than trapping on a negative or an overflow.
		guard let passes = kdf.kdfPasses.flatMap({ UInt64(exactly: $0) }), passes > 0,
			let kib = kdf.kdfMemory, kib > 0
		else { throw VaulyKitError.kdfNotAllowed(notAllowed) }
		let (memory, overflow) = kib.multipliedReportingOverflow(by: 1024)
		guard !overflow else { throw VaulyKitError.kdfNotAllowed(notAllowed) }
		// libsodium wants a pointer even for an empty password, which an empty array lacks.
		let chars = bytes.isEmpty ? [CChar(0)] : bytes.map { CChar(bitPattern: $0) }
		let status = salt.withUnsafeBytes { saltBytes in
			chars.withUnsafeBufferPointer { password in
				crypto_pwhash(
					&out, 32, password.baseAddress!, UInt64(bytes.count),
					saltBytes.bindMemory(to: UInt8.self).baseAddress!,
					passes, memory, crypto_pwhash_ALG_ARGON2ID13)
			}
		}
		guard status == 0 else { throw VaulyKitError.argon2 }
	case .pbkdf2:
		guard let rounds = UInt32(exactly: kdf.kdfIterations), rounds > 0 else {
			throw VaulyKitError.kdfNotAllowed(notAllowed)
		}
		let status = salt.withUnsafeBytes { saltBytes in
			bytes.withUnsafeBufferPointer { passwordBytes in
				passwordBytes.withMemoryRebound(to: CChar.self) { password in
					CCKeyDerivationPBKDF(
						CCPBKDFAlgorithm(kCCPBKDF2), password.baseAddress, bytes.count,
						saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count,
						CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds, &out, 32)
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
/// settings, so only the checked functions below and the tests reach it.
func deriveMasterKeys(password: String, salt: String, kdf: Kdf = .argon2id) throws
	-> MasterKeys
{
	let master = try masterBits(password: password, salt: Data(base64: salt, "salt"), kdf: kdf)
	return MasterKeys(
		authKey: hkdf(master, "vauly/auth").withUnsafeBytes { Data($0).hex },
		wrapKey: hkdf(master, "vauly/wrap"))
}

private let notAllowed =
	"This server asks for different key derivation than vauly allows, so your master password wasn't used."

/// Checks what the server sent before the password goes into it: vauly's limits, which
/// decide how hard the auth key the server gets back is to attack; what this device has
/// seen the account use; and the memory this process can spare (`Argon2Memory`).
public func checkKdf(_ settings: KdfSettings, argon2idSeen: Bool, memoryLimit: Int) throws {
	guard kdfAllowed(settings) else { throw VaulyKitError.kdfNotAllowed(notAllowed) }
	try refuseDowngrade(settings.settings, argon2idSeen: argon2idSeen)
	if settings.settings.kdf == .argon2id, let memory = settings.kdfMemory, memory > memoryLimit {
		throw VaulyKitError.overMemoryLimit
	}
}

/// The master keys for the settings the server sent, prelogin's or an account's, once
/// `checkKdf` passes them. Signing in needs these before the account's keys come back.
public func checkedMasterKeys(
	password: String, settings: KdfSettings, argon2idSeen: Bool, memoryLimit: Int
) throws -> MasterKeys {
	try checkKdf(settings, argon2idSeen: argon2idSeen, memoryLimit: memoryLimit)
	return try deriveMasterKeys(password: password, salt: settings.kdfSalt, kdf: settings.settings)
}
