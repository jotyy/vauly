import CryptoKit
import Foundation

// Each person has an ECDH P-256 key pair: vault keys reach them wrapped to their public key
// (SPKI, base64), and their private key (PKCS#8) is sealed with their wrap key.

public typealias PrivateKey = P256.KeyAgreement.PrivateKey

public func importPrivateKey(pkcs8: Data) throws -> PrivateKey {
	try PrivateKey(derRepresentation: pkcs8)
}

/// The public key, as SPKI in base64: the form the server keeps and the vectors use.
public func publicKeyOf(_ privateKey: PrivateKey) -> String {
	privateKey.publicKey.derRepresentation.base64EncodedString()
}

private func importPublicKey(_ spki: String) throws -> P256.KeyAgreement.PublicKey {
	try P256.KeyAgreement.PublicKey(derRepresentation: Data(base64: spki, "public key"))
}

/// ECDH, then HKDF-SHA256 with 32 zero bytes of salt and `context` as the info.
private func sharedKey(_ privateKey: PrivateKey, _ publicKey: P256.KeyAgreement.PublicKey, context: String)
	throws -> SymmetricKey
{
	try privateKey.sharedSecretFromKeyAgreement(with: publicKey).hkdfDerivedSymmetricKey(
		using: SHA256.self, salt: Data(count: 32), sharedInfo: Data(context.utf8), outputByteCount: 32)
}

/// Wraps a data key so only the holder of `recipientPublicKey` can open it (ECIES):
/// `base64(ephemeral SPKI):sealed`.
public func wrapKey(for recipientPublicKey: String, _ key: SymmetricKey) throws -> String {
	try wrapKey(for: recipientPublicKey, key, ephemeral: PrivateKey(), nonce: AES.GCM.Nonce())
}

func wrapKey(for recipientPublicKey: String, _ key: SymmetricKey, ephemeral: PrivateKey, nonce: AES.GCM.Nonce)
	throws -> String
{
	let aes = try sharedKey(
		ephemeral, importPublicKey(recipientPublicKey), context: "vauly/share:\(recipientPublicKey)")
	let sealed = try seal(aes, key.withUnsafeBytes { Data($0) }, additionalData: nil, nonce: nonce)
	return "\(publicKeyOf(ephemeral)):\(sealed)"
}

/// Opens a data key wrapped to this person: their private key, and their own public key,
/// which the wrapping named.
public func unwrapKey(from wrapped: String, privateKey: PrivateKey, ownPublicKey: String) throws
	-> SymmetricKey
{
	let parts = wrapped.split(separator: ":", omittingEmptySubsequences: false)
	guard parts.count == 2 else { throw VaulyKitError.malformed("wrapped key") }
	let aes = try sharedKey(
		privateKey, importPublicKey(String(parts[0])), context: "vauly/share:\(ownPublicKey)")
	return try unwrapKey(aes, String(parts[1]))
}

/// Opens the account's private key with an already derived wrap key. Fails on a wrong
/// password, as CryptoKit's authentication failure.
public func openPrivateKey(wrapKey: SymmetricKey, encryptedPrivateKey: Sealed) throws -> PrivateKey {
	try importPrivateKey(pkcs8: open(wrapKey, encryptedPrivateKey))
}

public struct UnlockedAccount: Sendable {
	public let authKey: String
	public let privateKey: PrivateKey
}

/// Derives with the account's own settings and opens its private key. The apps check the
/// settings first, with `checkedMasterKeys`.
public func unlockAccount(password: String, keys: AccountKeys) throws -> UnlockedAccount {
	let master = try deriveMasterKeys(password: password, salt: keys.kdfSalt, kdf: keys.settings)
	return UnlockedAccount(
		authKey: master.authKey,
		privateKey: try openPrivateKey(
			wrapKey: master.wrapKey, encryptedPrivateKey: keys.encryptedPrivateKey))
}
