import Capacitor
import CryptoKit
import Foundation
import VaulyKit

/// The offline copy, kept where the AutoFill extension can read it: in the App Group
/// container the app shares with it, a file per account. It's the web app's sealed
/// snapshot as it is (VaulyKit's Snapshot): nothing in it is decrypted here. The web app
/// keeps and deletes it whenever it keeps or deletes its own copy (lib/offline.ts).
@objc(CopyPlugin)
public class CopyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CopyPlugin"
    public let jsName = "VaulyCopy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise)
    ]

    /// The App Group's folder for copies, from Info.plist (VaulyAppGroup). A build without a
    /// team has no group to share, as for the simulator: then the app's own folder.
    private static var folder: URL? {
        let files = FileManager.default
        let group = (Bundle.main.object(forInfoDictionaryKey: "VaulyAppGroup") as? String)
            .flatMap { files.containerURL(forSecurityApplicationGroupIdentifier: $0) }
        guard let base = group ?? files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        return base.appendingPathComponent("vauly/copies", isDirectory: true)
    }

    /// A file per account, named by a hash of its ID, so no ID can name a path.
    private static func file(for accountId: String) -> URL? {
        let name = SHA256.hash(data: Data(accountId.utf8)).map { String(format: "%02x", $0) }.joined()
        return folder?.appendingPathComponent("\(name).json")
    }

    /// Keeps `snapshot`, the web app's copy as JSON, in place of the account's last one.
    @objc func keep(_ call: CAPPluginCall) {
        guard let json = call.getString("snapshot").map({ Data($0.utf8) }),
              let snapshot = try? decodeSnapshot(json),
              let folder = Self.folder, var file = Self.file(for: snapshot.accountId)
        else { return call.reject("That isn't a copy to keep") }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            // Readable only while the iPhone is unlocked, and never in a backup.
            try json.write(to: file, options: [.atomic, .completeFileProtection])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try file.setResourceValues(values)
            call.resolve()
        } catch {
            call.reject("Couldn't keep the copy")
        }
    }

    /// Resolves with `copies`: each one's `accountId`, `sessionId` and `syncedAt`.
    @objc func list(_ call: CAPPluginCall) {
        call.resolve(["copies": Self.copies().map {
            ["accountId": $0.accountId, "sessionId": $0.sessionId, "syncedAt": $0.syncedAt]
        }])
    }

    /// Deletes the copy for `accountId`, or every copy when it's left out.
    @objc func forget(_ call: CAPPluginCall) {
        if let accountId = call.getString("accountId") {
            if let file = Self.file(for: accountId) { try? FileManager.default.removeItem(at: file) }
        } else if let folder = Self.folder {
            try? FileManager.default.removeItem(at: folder)
        }
        call.resolve()
    }

    private static func copies() -> [Snapshot] {
        guard let folder,
              let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        else { return [] }
        return files.compactMap { try? decodeSnapshot(Data(contentsOf: $0)) }
    }
}
