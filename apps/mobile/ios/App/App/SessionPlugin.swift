import Capacitor
import Foundation
import Security

/// Which vauly the app is connected to, and its session there: the address the person
/// typed, and the session token the API gave the app when they signed in, which the web
/// app sends as a bearer token. Both are kept in the Keychain, readable only while the
/// iPhone is unlocked, and never copied to a backup or another device.
@objc(SessionPlugin)
public class SessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SessionPlugin"
    public let jsName = "VaulySession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    private static let installedKey = "app.vauly.installed"
    private let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.vauly.session",
        kSecAttrAccount as String: "session"
    ]

    public override func load() {
        // The Keychain outlives the app, so deleting vauly and installing it again would
        // come back signed in. UserDefaults goes with the app: no mark, a fresh install.
        if !UserDefaults.standard.bool(forKey: Self.installedKey) {
            SecItemDelete(item as CFDictionary)
            UserDefaults.standard.set(true, forKey: Self.installedKey)
        }
    }

    /// Resolves with `address` and `token`, each only if it's there.
    @objc func get(_ call: CAPPluginCall) {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let saved = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        else { return call.resolve([:]) }
        call.resolve(saved)
    }

    /// Keeps `address`, and `token` when it's given; a set without a token drops the old one.
    @objc func set(_ call: CAPPluginCall) {
        guard let address = call.getString("address") else {
            return call.reject("The vauly's address is missing")
        }
        var saved = ["address": address]
        if let token = call.getString("token") { saved["token"] = token }
        guard let data = try? JSONSerialization.data(withJSONObject: saved) else {
            return call.reject("Couldn't keep the session")
        }
        var status = SecItemUpdate(item as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var added = item
            added[kSecValueData as String] = data
            added[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(added as CFDictionary, nil)
        }
        status == errSecSuccess ? call.resolve() : call.reject("Couldn't keep the session (\(status))")
    }

    @objc func clear(_ call: CAPPluginCall) {
        let status = SecItemDelete(item as CFDictionary)
        status == errSecSuccess || status == errSecItemNotFound
            ? call.resolve()
            : call.reject("Couldn't forget the session (\(status))")
    }
}
