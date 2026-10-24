import Foundation

/// Why VaulyKit refused or failed. A wrong key or tampered ciphertext surfaces as
/// CryptoKit's own `CryptoKitError.authenticationFailure` instead.
public enum VaulyKitError: Error, Equatable {
	/// The server asked for key derivation outside vauly's limits.
	case kdfNotAllowed(String)
	/// Argon2id failed, usually for want of memory.
	case argon2
	case pbkdf2
	/// Not in a format vauly writes.
	case malformed(String)
	/// A device copy opened, but holds another key than the account's.
	case anotherKey
}

extension VaulyKitError: LocalizedError {
	public var errorDescription: String? {
		switch self {
		case .kdfNotAllowed(let message): message
		case .argon2: "Your master password couldn't be checked: this device ran out of memory."
		case .pbkdf2: "Your master password couldn't be checked."
		case .malformed(let what): "Malformed \(what)"
		case .anotherKey: "This copy holds another key"
		}
	}
}

extension Data {
	init(base64 text: String, _ what: String) throws {
		guard let data = Data(base64Encoded: text) else { throw VaulyKitError.malformed(what) }
		self = data
	}

	var hex: String { map { String(format: "%02x", $0) }.joined() }
}
