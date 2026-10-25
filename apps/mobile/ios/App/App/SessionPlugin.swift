import Capacitor
import Foundation
import Security

/// Which vauly the app is connected to, and its session there: the address the person
/// typed, its API's address as it was when they connected, and the session token the API
/// gave the app when they signed in, which the web app sends as a bearer token. They're
/// kept in the Keychain, readable only while the iPhone is unlocked, and never restored
/// to another device or synced.
@objc(SessionPlugin)
public class SessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SessionPlugin"
    public let jsName = "VaulySession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    // Gone after the app is deleted and installed again: Keychain.forgetAfterReinstall.
    private let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.vauly.session",
        kSecAttrAccount as String: "session"
    ]

    /// Resolves with `address`, `server` and `token`, each only if it's there. Rejects with
    /// LOCKED when the Keychain can't be read just now, as before the iPhone is unlocked.
    @objc func get(_ call: CAPPluginCall) {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return call.resolve([:]) }
        guard status == errSecSuccess, let data = result as? Data,
              let saved = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        else { return call.reject("The Keychain can't be read now (\(status))", "LOCKED") }
        call.resolve(saved)
    }

    /// Keeps `address` and `server`, and `token` when it's given; a set without a token
    /// drops the old one.
    @objc func set(_ call: CAPPluginCall) {
        guard let address = call.getString("address"), let server = call.getString("server") else {
            return call.reject("The vauly's address is missing")
        }
        var saved = ["address": address, "server": server]
        if let token = call.getString("token") { saved["token"] = token }
        guard let data = try? JSONSerialization.data(withJSONObject: saved) else {
            return call.reject("Couldn't keep the session")
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var status = SecItemUpdate(item as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(item.merging(attributes) { $1 } as CFDictionary, nil)
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
