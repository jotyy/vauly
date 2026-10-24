# VaulyKit

vauly's cryptography in Swift, for the iPhone app and its AutoFill extension (#12). The extension runs without the app and its WebView, so it can't use `packages/crypto`; this package does the same work with CryptoKit, CommonCrypto and libsodium, and is checked against the same test vectors.

## What it covers

Everything unlocking and filling needs, each checked against `packages/crypto/test-vectors.json`:

| In `packages/crypto`                                  | Here                                                                  | Vectors                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `deriveMasterKeys`, `checkedMasterKeys`, `kdfAllowed` | the same names                                                        | `masterKeys`, `createAccount`, `upgradeKdf` |
| `seal`, `open`, `sealJson`, `openJson`                | the same, on CryptoKit's AES-GCM                                      | `seal`, `sealJson`                          |
| `wrapKey`, `unwrapKey`                                | the same                                                              | `wrapKey`                                   |
| `wrapKeyFor`, `unwrapKeyFrom`                         | `wrapKey(for:)`, `unwrapKey(from:)`, with WebCrypto's PKCS#8 and SPKI | `wrapKeyFor`                                |
| `unlockAccount`, `openPrivateKey`                     | the same                                                              | `createAccount`, `changeMasterPassword`     |
| `deviceKey`, `sealDeviceCopy`, `openDeviceCopy`       | the same, with the device's secret in place of the PRF output (#80)   | `deviceKey`                                 |
| `sealPasskeyKey`, `openPasskeyKey`                    | the same (#27)                                                        | `passkeyKey`                                |
| `totpCode`, `parseTotp`                               | the same                                                              | `totp`, `parseTotp`                         |
- **Argon2id** comes from libsodium through [swift-sodium](https://github.com/jedisct1/swift-sodium), pinned to one version, as the web app's comes from libsodium.js. Inside an AutoFill extension it peaks at about 88 MiB (#8).
- **Not here:** files, share-link keys and agent tokens, which neither the AutoFill extension nor the app's native side handles.
- **Checked settings:** the apps derive with `checkedMasterKeys`, which refuses key derivation outside vauly's limits, as `packages/crypto` does; `refuseDowngrade` refuses PBKDF2 for an account seen on Argon2id.

## Tests

```sh
cd native/VaulyKit
swift test
```

The tests read `packages/crypto/test-vectors.json` from the repository, so a change to the formats that breaks a vector fails here too. CI runs them on macOS.
