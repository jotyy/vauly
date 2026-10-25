import CryptoKit
import Foundation

// One-time codes (RFC 6238), as packages/crypto/src/totp.ts makes them.

public struct TotpConfig: Codable, Equatable, Sendable {
	public enum Algorithm: String, Codable, Sendable {
		case sha1 = "SHA-1"
		case sha256 = "SHA-256"
		case sha512 = "SHA-512"
	}

	public var secret: String
	public var digits: Int
	public var period: Int
	public var algorithm: Algorithm

	public init(secret: String, digits: Int = 6, period: Int = 30, algorithm: Algorithm = .sha1) {
		self.secret = secret
		self.digits = digits
		self.period = period
		self.algorithm = algorithm
	}
}

/// Reads a base32 setup key or an otpauth:// link; nil when there's nothing to read, or
/// the link asks for what vauly doesn't make: 6 to 10 digits, a period of 1 to 300 seconds,
/// and SHA-1, SHA-256 or SHA-512.
public func parseTotp(_ input: String) -> TotpConfig? {
	let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
	if text.isEmpty { return nil }
	guard text.hasPrefix("otpauth://") else { return TotpConfig(secret: text) }
	guard let items = URLComponents(string: text)?.queryItems,
		let secret = items.first(where: { $0.name == "secret" })?.value, !secret.isEmpty
	else { return nil }
	let value = { (name: String) in items.first(where: { $0.name == name })?.value }
	guard let digits = Int(value("digits") ?? "6"), (6...10).contains(digits),
		let period = Int(value("period") ?? "30"), (1...300).contains(period)
	else { return nil }
	let algorithm: TotpConfig.Algorithm
	switch (value("algorithm") ?? "SHA1").uppercased() {
	case "SHA1": algorithm = .sha1
	case "SHA256": algorithm = .sha256
	case "SHA512": algorithm = .sha512
	default: return nil
	}
	return TotpConfig(secret: secret, digits: digits, period: period, algorithm: algorithm)
}

private let base32Alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

func base32(_ text: String) throws -> Data {
	var bits = 0
	var value = 0
	var out = Data()
	for char in text.uppercased() where !(char.isWhitespace || char == "=" || char == "-") {
		guard let index = base32Alphabet.firstIndex(of: char) else {
			throw VaulyKitError.malformed("base32 secret")
		}
		value = ((value << 5) | index) & 0xffff
		bits += 5
		if bits >= 8 {
			out.append(UInt8((value >> (bits - 8)) & 0xff))
			bits -= 8
		}
	}
	return out
}

private func hmac(_ algorithm: TotpConfig.Algorithm, key: SymmetricKey, message: Data) -> Data {
	switch algorithm {
	case .sha1: Data(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: key))
	case .sha256: Data(HMAC<SHA256>.authenticationCode(for: message, using: key))
	case .sha512: Data(HMAC<SHA512>.authenticationCode(for: message, using: key))
	}
}

/// The code at `now`. A stored item's settings may not have come through `parseTotp`, so
/// they're checked again here.
public func totpCode(_ config: TotpConfig, now: Date = Date()) throws -> String {
	guard config.period > 0, (1...10).contains(config.digits),
		let counter = UInt64(exactly: max(0, (now.timeIntervalSince1970 / Double(config.period)).rounded(.down)))
	else { throw VaulyKitError.malformed("one-time code settings") }
	let secret = try base32(config.secret)
	guard !secret.isEmpty else { throw VaulyKitError.malformed("base32 secret") }
	let message = withUnsafeBytes(of: counter.bigEndian) { Data($0) }
	let mac = hmac(config.algorithm, key: SymmetricKey(data: secret), message: message)
	let offset = Int(mac[mac.count - 1] & 0x0f)
	let binary =
		(UInt64(mac[offset] & 0x7f) << 24) | (UInt64(mac[offset + 1]) << 16)
		| (UInt64(mac[offset + 2]) << 8) | UInt64(mac[offset + 3])
	var modulus: UInt64 = 1
	for _ in 0..<config.digits { modulus *= 10 }
	let code = String(binary % modulus)
	return String(repeating: "0", count: config.digits - code.count) + code
}

/// Seconds until the current code changes; 0 for settings `totpCode` refuses.
public func totpSecondsLeft(_ config: TotpConfig, now: Date = Date()) -> Int {
	guard config.period > 0, let seconds = Int(exactly: now.timeIntervalSince1970.rounded(.down))
	else { return 0 }
	return config.period - (seconds % config.period + config.period) % config.period
}
