# VaulyKit

vauly's cryptography in Swift, for the iPhone app and its AutoFill extension (#12). The extension runs without the app and its WebView, so it can't use `packages/crypto`; this package does the same work with CryptoKit, CommonCrypto and libsodium, and is checked against the same test vectors.

## What it covers

Everything unlocking and filling needs, each checked against `packages/crypto/test-vectors.json`:

| In `packages/crypto`                            | Here                                                                  | Vectors                                    |
| ----------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| `checkedMasterKeys`, `kdfAllowed`, `checkKdf`   | the same names, taking `KdfSettings` as prelogin returns them         | `masterKeys`, `kdfLimits`, `createAccount` |
| `seal`, `open`, `sealJson`, `openJson`          | the same, on CryptoKit's AES-GCM                                      | `seal`, `sealJson`                         |
| `wrapKey`, `unwrapKey`                          | the same                                                              | `wrapKey`                                  |
| `wrapKeyFor`, `unwrapKeyFrom`                   | `wrapKey(for:)`, `unwrapKey(from:)`, with WebCrypto's PKCS#8 and SPKI | `wrapKeyFor`                               |
| `unlockAccount`, `openPrivateKey`               | the same, checking the opened key against the account's public key    | `createAccount`, `changeMasterPassword`    |
| `deviceKey`, `sealDeviceCopy`, `openDeviceCopy` | the same, with the device's secret in place of the PRF output (#80)   | `deviceKey`                                |
| `sealPasskeyKey`, `openPasskeyKey`              | the same (#27)                                                        | `passkeyKey`                               |
| `openSnapshot`, `isFresh` (in `apps/web`)       | the same, with `vaultKey` and `openItem` to open one item (#81)       | `snapshot`                                 |
| `totpCode`, `parseTotp`                         | the same                                                              | `totp`, `parseTotp`                        |
- **Argon2id** comes from libsodium through [swift-sodium](https://github.com/jedisct1/swift-sodium), pinned to one version, as the web app's comes from libsodium.js. Inside an AutoFill extension it peaks at about 88 MiB (#8).
- **Not here:** files, share-link keys and agent tokens, which neither the AutoFill extension nor the app's native side handles.
- **Checked settings:** the only way to derive is through `checkKdf`, which `checkedMasterKeys` and `unlockAccount` call first. It refuses:
  - key derivation outside vauly's limits, as `packages/crypto` does;
  - PBKDF2 for an account this device has seen on Argon2id (`argon2idSeen`, which the caller must give);
  - Argon2id that needs more memory than the caller can spare (`memoryLimit`). The AutoFill extension passes `Argon2Memory.autoFill`, 64 MiB (today's default, measured at an 88 MiB peak in the extension), and sends the person to the app on `overMemoryLimit`, since iOS ends an extension that goes over rather than failing the allocation.
- **Refused rather than trusted:** JSON with a key twice in one object (`openJson`: the web app reads the last, `JSONDecoder` the first), one-time code settings outside 6 to 10 digits and 1 to 300 seconds, and device secrets or peppers that are too short.

## Tests

```sh
cd native/VaulyKit
swift test
```

The tests read `packages/crypto/test-vectors.json` from the repository, so a change to the formats that breaks a vector fails here too. CI runs them on macOS.
