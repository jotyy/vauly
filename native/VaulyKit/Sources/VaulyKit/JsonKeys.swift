import Foundation

// JSONDecoder keeps the first of two equal keys in an object, and the web app's JSON.parse
// the last, so one sealed JSON text could read one way on the web and another on iOS: a
// website shown in one and filled in the other. openJson refuses such JSON instead.

private let malformed = VaulyKitError.malformed("JSON")

/// Throws if an object anywhere in `json` has a key twice, with keys compared the way
/// JavaScript compares them: as UTF-16 code units, once escapes are read. JSON this can't
/// read is refused as well; JSONDecoder checks the rest (numbers and literals).
func refuseDuplicateKeys(_ json: Data) throws {
	var reader = KeyReader(bytes: [UInt8](json))
	try reader.value(depth: 0)
	reader.skipSpace()
	guard reader.at == reader.bytes.count else { throw malformed }
}

private struct KeyReader {
	let bytes: [UInt8]
	var at = 0

	/// Deeper than any item vauly writes, and shallow enough for the stack.
	static let maxDepth = 256

	mutating func skipSpace() {
		while at < bytes.count, [0x20, 0x09, 0x0a, 0x0d].contains(bytes[at]) { at += 1 }
	}

	/// The byte at the reading position, past any space, without taking it.
	mutating func next() throws -> UInt8 {
		skipSpace()
		guard at < bytes.count else { throw malformed }
		return bytes[at]
	}

	mutating func value(depth: Int) throws {
		guard depth < Self.maxDepth else { throw malformed }
		switch try next() {
		case UInt8(ascii: "{"): try object(depth: depth)
		case UInt8(ascii: "["): try array(depth: depth)
		case UInt8(ascii: "\""): _ = try string()
		default:
			// A number, true, false or null.
			let start = at
			while at < bytes.count, !Array(",]} \t\n\r".utf8).contains(bytes[at]) { at += 1 }
			guard at > start else { throw malformed }
		}
	}

	mutating func object(depth: Int) throws {
		at += 1
		var keys = Set<[UInt16]>()
		if try next() == UInt8(ascii: "}") {
			at += 1
			return
		}
		while true {
			guard try next() == UInt8(ascii: "\"") else { throw malformed }
			guard keys.insert(try string()).inserted else {
				throw VaulyKitError.malformed("JSON with a key twice")
			}
			guard try next() == UInt8(ascii: ":") else { throw malformed }
			at += 1
			try value(depth: depth + 1)
			let after = try next()
			at += 1
			if after == UInt8(ascii: "}") { return }
			guard after == UInt8(ascii: ",") else { throw malformed }
		}
	}

	mutating func array(depth: Int) throws {
		at += 1
		if try next() == UInt8(ascii: "]") {
			at += 1
			return
		}
		while true {
			try value(depth: depth + 1)
			let after = try next()
			at += 1
			if after == UInt8(ascii: "]") { return }
			guard after == UInt8(ascii: ",") else { throw malformed }
		}
	}

	/// A string, as the UTF-16 code units JavaScript would hold.
	mutating func string() throws -> [UInt16] {
		at += 1
		var units: [UInt16] = []
		var run: [UInt8] = []
		func flush() throws {
			guard let text = String(bytes: run, encoding: .utf8) else { throw malformed }
			units += text.utf16
			run.removeAll()
		}
		while at < bytes.count {
			let byte = bytes[at]
			at += 1
			switch byte {
			case UInt8(ascii: "\""):
				try flush()
				return units
			case UInt8(ascii: "\\"):
				try flush()
				guard at < bytes.count else { throw malformed }
				let escape = bytes[at]
				at += 1
				switch escape {
				case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"): units.append(UInt16(escape))
				case UInt8(ascii: "b"): units.append(0x08)
				case UInt8(ascii: "f"): units.append(0x0c)
				case UInt8(ascii: "n"): units.append(0x0a)
				case UInt8(ascii: "r"): units.append(0x0d)
				case UInt8(ascii: "t"): units.append(0x09)
				case UInt8(ascii: "u"):
					guard at + 4 <= bytes.count,
						let unit = UInt16(String(decoding: bytes[at..<at + 4], as: UTF8.self), radix: 16)
					else { throw malformed }
					units.append(unit)
					at += 4
				default: throw malformed
				}
			default:
				// Control characters only appear escaped.
				guard byte >= 0x20 else { throw malformed }
				run.append(byte)
			}
		}
		throw malformed
	}
}
