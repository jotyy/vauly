import Foundation
import Security

/// vauly's items in the Keychain.
enum Keychain {
    /// The access group the app shares with its AutoFill extension, from Info.plist, where
    /// the build fills in the team. A build without a team, as for the simulator, has no
    /// group to share, and the items stay in the app's own. Only items that name it go there:
    /// the app's own group comes first in App.entitlements, so it's the default, and the
    /// session, which names none, stays the app's alone.
    static let sharedGroup: String? = {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "VaulyKeychainGroup") as? String,
              group.contains("."), !group.hasPrefix("app.vauly")
        else { return nil }
        return group
    }()

    private static let installedKey = "app.vauly.installed"

    /// The Keychain outlives the app, so deleting vauly and installing it again would come
    /// back signed in, with Face ID unlock still on. UserDefaults goes with the app: no
    /// mark means a fresh install, and every item vauly left behind goes.
    static func forgetAfterReinstall() {
        guard !UserDefaults.standard.bool(forKey: installedKey) else { return }
        SecItemDelete([kSecClass as String: kSecClassGenericPassword] as CFDictionary)
        UserDefaults.standard.set(true, forKey: installedKey)
    }

    /// The query for one item, in the shared group when there is one.
    static func item(service: String, account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        if let group = sharedGroup { query[kSecAttrAccessGroup as String] = group }
        return query
    }
}
