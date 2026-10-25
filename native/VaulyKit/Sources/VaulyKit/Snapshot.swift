import CryptoKit
import Foundation

// --- The offline copy ------------------------------------------------------------------

/// The offline copy, as the web app makes it (apps/web/src/lib/snapshot.ts) and the app
/// keeps it for its AutoFill extension: what the API last returned for the account, sealed
/// whole with a key wrapped to the account's own public key. Only what unlocking needs is
/// readable without the private key.
public struct Snapshot: Codable, Equatable, Sendable {
	public var accountId: String
	/// The session it was made in; the app deletes the copy once that session ends.
	public var sessionId: String
	/// When it was synced, in milliseconds since 1970, as JavaScript counts.
	public var syncedAt: Double
	public var keys: AccountKeys
	/// The copy's key, wrapped to the account's public key.
	public var cacheKey: String
	public var sealed: Sealed
}

/// What's sealed inside: the vaults with their wrapped keys and sealed names, and the items'
/// ciphertext. Rows carry more than this; only what opening an item takes is read.
public struct SnapshotContents: Decodable, Equatable, Sendable {
	public struct Profile: Decodable, Equatable, Sendable {
		public var id: String
		public var name: String?
		public var email: String?
	}

	public struct Vault: Decodable, Equatable, Sendable {
		public var id: String
		/// The vault's key, wrapped to the account's public key.
		public var wrappedKey: String
		public var encryptedMeta: Sealed
	}

	public struct Item: Decodable, Equatable, Sendable {
		public var id: String
		public var vaultId: String
		/// The item's fields, sealed with its key.
		public var data: Sealed
		/// The item's key, wrapped with its vault's.
		public var wrappedKey: Sealed
	}

	public var profile: Profile
	public var vaults: [Vault]
	public var items: [Item]
}

/// How long a copy is used after its last sync, as on the web: its rules are the app's,
/// since a device offline has no trusted clock.
public let offlineDays = 30

/// Whether the copy is within `offlineDays` of its last sync, and not from the future.
public func isFresh(_ snapshot: Snapshot, now: Date = Date()) -> Bool {
	let nowMs = now.timeIntervalSince1970 * 1000
	return nowMs - snapshot.syncedAt < Double(offlineDays) * 86_400_000
		&& snapshot.syncedAt <= nowMs + 60_000
}

/// Reads a stored copy. JSON with a key twice is refused, as openJson refuses it.
public func decodeSnapshot(_ json: Data) throws -> Snapshot {
	try refuseDuplicateKeys(json)
	return try JSONDecoder().decode(Snapshot.self, from: json)
}

/// Opens the copy with the account's private key: another account's key, or a copy that's
/// been changed, doesn't open it.
public func openSnapshot(_ snapshot: Snapshot, privateKey: PrivateKey) throws -> SnapshotContents {
	guard publicKeyOf(privateKey) == snapshot.keys.publicKey else { throw VaulyKitError.anotherKey }
	let key = try unwrapKey(
		from: snapshot.cacheKey, privateKey: privateKey, ownPublicKey: snapshot.keys.publicKey)
	return try openJson(SnapshotContents.self, key, snapshot.sealed)
}

/// A vault's key, from its row in the copy.
public func vaultKey(_ vault: SnapshotContents.Vault, privateKey: PrivateKey) throws -> SymmetricKey {
	try unwrapKey(from: vault.wrappedKey, privateKey: privateKey, ownPublicKey: publicKeyOf(privateKey))
}

/// An item's fields, opened with its vault's key into `type`. Nothing opened is stored.
public func openItem<T: Decodable>(_ type: T.Type, _ item: SnapshotContents.Item, vaultKey: SymmetricKey)
	throws -> T
{
	try openJson(type, unwrapKey(vaultKey, item.wrappedKey), item.data)
}
