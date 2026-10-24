import CryptoKit
import Foundation

/// `base64(iv).base64(ciphertext and tag)`: the only ciphertext format vauly stores.
public typealias Sealed = String

/// AES-256-GCM with a fresh 12-byte IV, and additional data when the format has it.
public func seal(_ key: SymmetricKey, _ plaintext: Data, additionalData: Data? = nil) throws
	-> Sealed
{
	try seal(key, plaintext, additionalData: additionalData, nonce: AES.GCM.Nonce())
}

/// With a given IV, which only the test vectors need.
func seal(_ key: SymmetricKey, _ plaintext: Data, additionalData: Data?, nonce: AES.GCM.Nonce)
	throws -> Sealed
{
	let box =
		try additionalData.map { try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: $0) }
		?? AES.GCM.seal(plaintext, using: key, nonce: nonce)
	return "\(Data(nonce).base64EncodedString()).\((box.ciphertext + box.tag).base64EncodedString())"
}

public func open(_ key: SymmetricKey, _ sealed: Sealed, additionalData: Data? = nil) throws -> Data {
	let parts = sealed.split(separator: ".", omittingEmptySubsequences: false)
	guard parts.count == 2 else { throw VaulyKitError.malformed("ciphertext") }
	let iv = try Data(base64: String(parts[0]), "ciphertext")
	let body = try Data(base64: String(parts[1]), "ciphertext")
	guard body.count >= 16 else { throw VaulyKitError.malformed("ciphertext") }
	let box = try AES.GCM.SealedBox(
		nonce: AES.GCM.Nonce(data: iv), ciphertext: body.dropLast(16), tag: body.suffix(16))
	return try additionalData.map { try AES.GCM.open(box, using: key, authenticating: $0) }
		?? AES.GCM.open(box, using: key)
}

/// JSON as the web app writes it: no escaped slashes.
public func sealJson<T: Encodable>(_ key: SymmetricKey, _ value: T) throws -> Sealed {
	let encoder = JSONEncoder()
	encoder.outputFormatting = .withoutEscapingSlashes
	return try seal(key, encoder.encode(value))
}

public func openJson<T: Decodable>(_ type: T.Type, _ key: SymmetricKey, _ sealed: Sealed) throws -> T {
	try JSONDecoder().decode(type, from: open(key, sealed))
}

// --- Data keys (vault keys and item keys) ------------------------------------------

public func newDataKey() -> SymmetricKey {
	SymmetricKey(size: .bits256)
}

/// Encrypts a data key with another symmetric key (vault key → item key).
public func wrapKey(_ wrapping: SymmetricKey, _ key: SymmetricKey) throws -> Sealed {
	try seal(wrapping, key.withUnsafeBytes { Data($0) })
}

public func unwrapKey(_ wrapping: SymmetricKey, _ sealed: Sealed) throws -> SymmetricKey {
	let raw = try open(wrapping, sealed)
	guard raw.count == 32 else { throw VaulyKitError.malformed("key") }
	return SymmetricKey(data: raw)
}
