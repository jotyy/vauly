import Capacitor
import Foundation
import LocalAuthentication
import Security
import VaulyKit

/// Unlocking with Face ID or Touch ID instead of the master password, as the web app does
/// with a passkey (docs/security.md). A random 32-byte secret in the Keychain, which iOS
/// releases only to a face or finger enrolled when it was made, and the server's pepper for
/// this session make the key (VaulyKit's deviceKey) that seals a copy of the account's
/// private key. The sealed copy is kept in the Keychain too, where the AutoFill extension
/// can reach it.
@objc(UnlockPlugin)
public class UnlockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "UnlockPlugin"
    public let jsName = "VaulyUnlock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "biometry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "turnOn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise)
    ]

    private static let secretService = "app.vauly.unlock.secret"
    private static let copyService = "app.vauly.unlock.copy"

    /// What the device's copy keeps besides the secret. Only `sealed` is secret, and sealed.
    private struct Copy: Codable {
        var accountId: String
        var credentialId: String
        var publicKey: String
        var sessionId: String
        var issuedAt: Double
        var sealed: Sealed

        var summary: [String: Any] {
            ["accountId": accountId, "credentialId": credentialId, "publicKey": publicKey,
             "sessionId": sessionId, "issuedAt": issuedAt]
        }
    }

    /// Resolves with `kind`: "faceID", "touchID" or "opticID" when one is set up, else "none".
    @objc func biometry(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return call.resolve(["kind": "none"])
        }
        switch context.biometryType {
        case .faceID: call.resolve(["kind": "faceID"])
        case .touchID: call.resolve(["kind": "touchID"])
        case .opticID: call.resolve(["kind": "opticID"])
        default: call.resolve(["kind": "none"])
        }
    }

    /// Each account's copy on this device, without the sealed key.
    @objc func copies(_ call: CAPPluginCall) {
        call.resolve(["copies": allCopies().map(\.summary)])
    }

    /**
     Seals the private key for this device. Takes `accountId`, `publicKey`, `sessionId`,
     `issuedAt`, `pepper` (base64) and `privateKey` (PKCS#8, base64). Face ID is asked once
     first, so nobody turns this on who can't pass it.
     */
    @objc func turnOn(_ call: CAPPluginCall) {
        guard let accountId = call.getString("accountId"), let publicKey = call.getString("publicKey"),
              let sessionId = call.getString("sessionId"), let issuedAt = call.getDouble("issuedAt"),
              let pepper = call.getString("pepper").flatMap({ Data(base64Encoded: $0) }),
              var privateKey = call.getString("privateKey").flatMap({ Data(base64Encoded: $0) })
        else { return call.reject("Something is missing", "BROKEN") }
        let context = LAContext()
        context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics, localizedReason: "Turn on unlocking vauly this way"
        ) { passed, error in
            defer { privateKey.resetBytes(in: 0..<privateKey.count) }
            guard passed else { return self.reject(call, error) }
            var secret = Data(count: 32)
            defer { secret.resetBytes(in: 0..<secret.count) }
            let generated = secret.withUnsafeMutableBytes {
                SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
            }
            var credential = Data(count: 16)
            let named = credential.withUnsafeMutableBytes {
                SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!)
            }
            guard generated == errSecSuccess, named == errSecSuccess else {
                return call.reject("No randomness", "BROKEN")
            }
            let copyContext = DeviceCopyContext(
                accountId: accountId, credentialId: "keychain:" + credential.base64EncodedString(),
                publicKey: publicKey)
            do {
                let key = try deviceKey(secret: secret, pepper: pepper)
                let sealed = try sealDeviceCopy(key, privateKeyPkcs8: privateKey, context: copyContext)
                // It must open, with the account's key inside, before it's kept.
                _ = try openDeviceCopy(key, sealed, context: copyContext)
                self.forgetCopy(accountId)
                try self.keepSecret(secret, for: accountId)
                try self.keep(Copy(
                    accountId: accountId, credentialId: copyContext.credentialId, publicKey: publicKey,
                    sessionId: sessionId, issuedAt: issuedAt, sealed: sealed))
                call.resolve()
            } catch {
                self.forgetCopy(accountId)
                call.reject("Couldn't keep the copy", "BROKEN")
            }
        }
    }

    /**
     Asks for Face ID and opens the copy. Takes `accountId` and `publicKey`, the server's,
     and `pepper` (base64); resolves with `privateKey`, PKCS#8 in base64. Rejects with
     CANCELLED, or INVALIDATED when the face or finger set changed since: the copy is gone.
     */
    @objc func unlock(_ call: CAPPluginCall) {
        guard let accountId = call.getString("accountId"), let publicKey = call.getString("publicKey"),
              let pepper = call.getString("pepper").flatMap({ Data(base64Encoded: $0) })
        else { return call.reject("Something is missing", "BROKEN") }
        guard let copy = loadCopy(accountId) else { return call.reject("No copy", "BROKEN") }
        // Face ID first, and the Keychain read with the same context, so it asks once. The
        // Keychain also holds the secret to .biometryCurrentSet itself, which the
        // simulator doesn't enforce.
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Unlock vauly") {
            passed, error in
            guard passed else {
                // No face or finger enrolled any more: the set changed, and the copy ends.
                if (error as? LAError)?.code == .biometryNotEnrolled {
                    self.forgetCopy(accountId)
                    return call.reject("Face ID changed", "INVALIDATED")
                }
                return self.reject(call, error)
            }
            var query = Keychain.item(service: Self.secretService, account: accountId)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            query[kSecUseAuthenticationContext as String] = context
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            switch status {
            case errSecSuccess:
                guard var secret = result as? Data else { return call.reject("No secret", "BROKEN") }
                defer { secret.resetBytes(in: 0..<secret.count) }
                do {
                    // The account and key pair come from the server, not from the copy.
                    let privateKey = try openDeviceCopy(
                        deviceKey(secret: secret, pepper: pepper), copy.sealed,
                        context: DeviceCopyContext(
                            accountId: accountId, credentialId: copy.credentialId, publicKey: publicKey))
                    call.resolve(["privateKey": privateKey.derRepresentation.base64EncodedString()])
                } catch {
                    self.forgetCopy(accountId)
                    call.reject("The copy didn't open", "BROKEN")
                }
            case errSecUserCanceled:
                call.reject("Cancelled", "CANCELLED")
            case errSecItemNotFound:
                // .biometryCurrentSet: a face or finger added or removed since ends the secret.
                self.forgetCopy(accountId)
                call.reject("Face ID changed", "INVALIDATED")
            default:
                call.reject("Face ID didn't pass (\(status))", "CANCELLED")
            }
        }
    }

    /// Deletes the copy for `accountId`, or every copy when it's left out.
    @objc func forget(_ call: CAPPluginCall) {
        if let accountId = call.getString("accountId") {
            forgetCopy(accountId)
        } else {
            for copy in allCopies() { forgetCopy(copy.accountId) }
        }
        call.resolve()
    }

    // MARK: - The Keychain

    /// A Face ID turned down, failed or locked out leaves the copy, to try again.
    private func reject(_ call: CAPPluginCall, _ error: Error?) {
        switch (error as? LAError)?.code {
        case .userCancel, .systemCancel, .appCancel, .userFallback, .authenticationFailed, .biometryLockout:
            call.reject("Face ID didn't pass", "CANCELLED")
        default:
            call.reject("Face ID isn't available", "UNAVAILABLE")
        }
    }

    /// Only a face or finger enrolled now releases it, and only while the iPhone has a passcode.
    private func keepSecret(_ secret: Data, for accountId: String) throws {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &error)
        else { throw VaulyKitError.malformed("access control") }
        var item = Keychain.item(service: Self.secretService, account: accountId)
        item[kSecValueData as String] = secret
        item[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaulyKitError.malformed("keychain (\(status))") }
    }

    private func keep(_ copy: Copy) throws {
        var item = Keychain.item(service: Self.copyService, account: copy.accountId)
        item[kSecValueData as String] = try JSONEncoder().encode(copy)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaulyKitError.malformed("keychain (\(status))") }
    }

    private func loadCopy(_ accountId: String) -> Copy? {
        var query = Keychain.item(service: Self.copyService, account: accountId)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return try? JSONDecoder().decode(Copy.self, from: data)
    }

    private func allCopies() -> [Copy] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.copyService,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        if let group = Keychain.sharedGroup { query[kSecAttrAccessGroup as String] = group }
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [Data]
        else { return [] }
        return items.compactMap { try? JSONDecoder().decode(Copy.self, from: $0) }
    }

    private func forgetCopy(_ accountId: String) {
        SecItemDelete(Keychain.item(service: Self.secretService, account: accountId) as CFDictionary)
        SecItemDelete(Keychain.item(service: Self.copyService, account: accountId) as CFDictionary)
    }
}
