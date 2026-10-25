import CryptoKit
import Foundation

// --- Unlocking without the master password ------------------------------------------

/// What a device's copy of the private key belongs to; it opens for nothing else.
public struct DeviceCopyContext: Equatable, Sendable {
	public var accountId: String
	public var credentialId: String
	public var publicKey: String

	public init(accountId: String, credentialId: String, publicKey: String) {
		self.accountId = accountId
		self.credentialId = credentialId
		self.publicKey = publicKey
	}

	var additionalData: Data { Data("vauly/device\n\(accountId)\n\(credentialId)\n\(publicKey)".utf8) }
}

/// The key that seals a device's copy of the private key: HKDF-SHA256 of the device's
/// secret (a passkey's PRF output on the web), with the server's pepper for the session as
/// salt. Neither alone opens the copy, and the pepper ends with the session. The secret is
/// 32 bytes and the pepper at least 16; anything shorter is refused rather than stretched.
public func deviceKey(secret: Data, pepper: Data) throws -> SymmetricKey {
	guard secret.count == 32 else { throw VaulyKitError.malformed("device secret") }
	guard pepper.count >= 16 else { throw VaulyKitError.malformed("pepper") }
	return HKDF<SHA256>.deriveKey(
		inputKeyMaterial: SymmetricKey(data: secret), salt: pepper, info: Data("vauly/device".utf8),
		outputByteCount: 32)
}

public func sealDeviceCopy(_ key: SymmetricKey, privateKeyPkcs8: Data, context: DeviceCopyContext)
	throws -> Sealed
{
	try seal(key, privateKeyPkcs8, additionalData: context.additionalData)
}

/// Opens a device copy, and checks that the key inside is the account's.
public func openDeviceCopy(_ key: SymmetricKey, _ sealed: Sealed, context: DeviceCopyContext) throws
	-> PrivateKey
{
	let privateKey = try importPrivateKey(
		pkcs8: open(key, sealed, additionalData: context.additionalData))
	guard publicKeyOf(privateKey) == context.publicKey else { throw VaulyKitError.anotherKey }
	return privateKey
}

// --- Passkeys ------------------------------------------------------------------------

private func passkeyData(_ credentialId: String) -> Data { Data("vauly/passkey\n\(credentialId)".utf8) }

/// Seals a passkey's private key (PKCS#8) with its vault's key, bound to the passkey.
public func sealPasskeyKey(_ vaultKey: SymmetricKey, privateKeyPkcs8: Data, credentialId: String) throws
	-> Sealed
{
	try seal(vaultKey, privateKeyPkcs8, additionalData: passkeyData(credentialId))
}

public func openPasskeyKey(_ vaultKey: SymmetricKey, _ sealed: Sealed, credentialId: String) throws
	-> Data
{
	try open(vaultKey, sealed, additionalData: passkeyData(credentialId))
}
