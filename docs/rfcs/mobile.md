# RFC: how vauly gets onto iPhone and Android

- **Status:** accepted on October 24, 2026. The maintainer's choices are under [Decisions](#decisions); two are still open.
- **Issue:** [#8](https://github.com/jotyy/vauly/issues/8). It also plans [#10](https://github.com/jotyy/vauly/issues/10), [#11](https://github.com/jotyy/vauly/issues/11), [#12](https://github.com/jotyy/vauly/issues/12) and [#13](https://github.com/jotyy/vauly/issues/13).
- **Facts checked:** October 23, 2026, against the sources at the end. Effort figures are estimates, not facts.

## In short

A password manager on a phone is worth installing for one thing: it fills logins in other apps and in the browser. On both platforms that takes native code that runs outside the main app. On iOS it's an AutoFill credential provider extension. On Android it's an autofill service, and later a Credential Manager provider. No framework removes that work. So the real decisions are how the main app's screens get built, and how many copies of vauly's crypto we keep in step.

**Recommendation: wrap the web app in Capacitor, with native autofill on each platform.**
- **The main app** is `apps/web` inside Capacitor. It keeps one UI, which is about 14,000 lines of React we already have.
- **The autofill code is native.** Each platform gets a small Swift or Kotlin core:
  - vauly's crypto, from the platform's own libraries;
  - a reader for an encrypted cache;
  - unlocking with a key kept in the Keychain or the Keystore, behind Face ID or a fingerprint.
- **The test vectors keep the copies in step.** Each core is checked against [`packages/crypto/test-vectors.json`](../../packages/crypto/test-vectors.json) (#7).
- **No code is downloaded at run time.** The app runs only the code it was reviewed with.

If we later want native screens, these cores are the foundation they would need, so we could swap the Capacitor UI out one screen at a time.

**The plan, in phases:**
- Phase 0, the web app, starting now: #10, plus what the stores require.
- Phase 1, iPhone: #12 and #13.
- Phase 2, Android: #11.
- Phase 3, later: passkeys, and native screens where the WebView falls short.

**Where it stands:**
- The prototypes ran and back the plan; see [Prototype first](#prototype-first). Argon2id fits in the AutoFill extension at 64 MiB, and Capacitor runs the web app unchanged. The results are in [#8](https://github.com/jotyy/vauly/issues/8).
- The maintainer chose (b), iPhone first; see [Decisions](#decisions).

## Where vauly is today

On a phone, vauly is the web app installed from the browser as a PWA. Since #9 it unlocks with a passkey. What a PWA can't do decides most of this RFC:
- **It can't fill other apps or the browser.** iOS takes AutoFill only from an app extension with an entitlement [A1]. Android takes it only from a service declared in an installed APK [G1]. An installed PWA can be filled, but it can't fill anything else [G9].
- **There are no extensions on Chrome for Android.** "You can only use extensions and themes on computers" [G10]. On iOS, a Safari web extension has to ship inside an app [A20].
- **It has no offline copy of the items** until #10.

## What a mobile app has to do

1. **Fill.**
   - On iOS, it needs an AutoFill credential provider that the person turns on under **Settings › General › AutoFill & Passwords** [A3].
   - On Android, it needs an `AutofillService`. Since Chrome 135 that service fills inside Chrome too, once the person picks it under **Autofill using another service** [G4]. Credential Manager follows later.
2. **Unlock quickly.** It uses Face ID, Touch ID or a fingerprint, with the master password as the fallback. Signing in on a new device still needs the master password.
3. **Work offline** for reading and filling.
4. **Keep vauly's model.** The server sees only ciphertext, and the bytes match the formats in [docs/security.md](../security.md#formats) exactly.
5. **Connect to any vauly.** Every team runs its own copy, at its own address.
6. **Pass review in both stores.**
   - Apple: minimum functionality (4.2), no downloaded features (2.5.2), and account deletion inside the app (5.1.1(v)) [A16].
   - Google Play: target API 36 [G13], the Data safety form [G14], and account deletion [G15].
7. **Fit one or two maintainers.** That covers building it, and keeping it alive through yearly OS and framework releases.

## What every option needs: native autofill

These facts hold whatever builds the main app.

### iOS

- **The extension is its own process.**
  - It subclasses `ASCredentialProviderViewController` and needs the AutoFill entitlement on both the app and the extension [A1].
  - The app doesn't have to be running, and the two talk only through shared storage: an App Group container and a shared Keychain access group [A7, A8].
- **Memory is tight and undocumented.** Apple publishes no number, only that extension limits are "significantly lower" than an app's, and that an extension should launch "well under one second" [A5]. KeePassium and Bitwarden report about 120 MB for AutoFill [A6]. React Native's docs give the same figure for share extensions [F7]. Assume about 120 MB, and less on old devices.
- **Answers must be fast.** When someone taps a suggestion, `provideCredentialWithoutUserInteraction` has to answer within a few seconds and can't show any UI. If the vault is locked, it asks for `.userInteractionRequired`, and iOS then calls the extension's unlock UI [A2].
- **Face ID only works in the UI path.** LocalAuthentication works only in the foreground [A10]. So the extension unlocks in its list or unlock screen, by reading a Keychain item protected with `.biometryCurrentSet` from the shared access group [A9].
- **The crypto is all native.**
  - CryptoKit has AES-GCM, HKDF and P-256 key agreement, and reads DER keys [A11].
  - Argon2id isn't in CryptoKit or CommonCrypto. It comes from libsodium (swift-sodium), as on the web, or the RFC 9106 reference code. Its 64 MiB is about half the extension's budget, so the extension should unlock with the biometric secret and leave the master password to the app, as Bitwarden does with large Argon2 settings [A6]. Accounts that haven't moved yet still need PBKDF2, from CommonCrypto's `CCKeyDerivationPBKDF`, which KeePassium also relies on [A12].
- **Suggestions in the keyboard bar** need `ASCredentialIdentityStore` to hold sites and usernames. iOS keeps those outside vauly's encryption, though never in backups or iCloud [A4]. This should be optional.
- **The rest of a full provider is newer API.** Passkeys came in iOS 17, one-time codes in iOS 18, and save-password requests in iOS 26.2 [A2].

### Android

- **The service runs on the system's schedule.**
  - `AutofillService` is bound only while a request is open. The system can kill the process when it unbinds, and callbacks arrive on the main thread [G1, G2].
  - AOSP times a fill request out after 5 seconds [G3]. So the service never touches the network or runs Argon2id there. It answers from a local index and the encrypted cache.
- **Unlocking goes through an Activity.**
  - The service returns a response with `setAuthentication`, which opens our unlock Activity [G2].
  - That Activity runs `BiometricPrompt` with a `CryptoObject` over a Keystore AES-GCM key. It falls back to the master password when the key is invalidated [G6, G7].
- **Apps and sites have to be matched safely.**
  - For apps, check the signing certificate, not just the package name.
  - For sites, reduce the domain with the Public Suffix List and link apps to sites with Digital Asset Links. [G1]
- **Chrome and passkeys.**
  - Chrome dropped compatibility mode in version 137. The person turns on third-party autofill in Chrome's settings, and our app can open that screen for them [G4, G5].
  - Passkeys come through `CredentialProviderService`, on Android 14 and later [G8].
- **The crypto is all native, except HKDF.**
  - The JCA has AES-GCM, PBKDF2WithHmacSHA256 (API 26 and later, for accounts that haven't moved to Argon2id), ECDH on P-256, and SPKI and PKCS#8 key specs. Argon2id comes from libsodium (Lazysodium), as on the web.
  - HKDF has no platform API. It's about 30 lines of RFC 5869 over HMAC-SHA256, and the test vectors check them [G11].

### The native surface, on each platform

This is what each native core has to do, for #11 and #12.

| Job                             | How                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unlock with biometrics          | Read the unlock secret from the Keychain (shared access group, `.biometryCurrentSet`) or decrypt it with a Keystore key under `BiometricPrompt`.                 |
| Unlock with the master password | Argon2id (64 MiB, 3 passes, 1 lane), or PBKDF2-SHA256 (600,000 rounds) for accounts that haven't moved, then HKDF `vauly/wrap`, then open `encryptedPrivateKey`. |
| Use the private key             | Read PKCS#8 into a P-256 key-agreement key.                                                                                                                      |
| Unwrap vault keys               | Split `ephemeral SPKI : sealed`. Run ECDH, then HKDF `vauly/share:` plus your own public key, then AES-GCM open.                                                 |
| Unwrap item keys, open items    | AES-256-GCM open, then read the JSON item fields.                                                                                                                |
| One-time codes                  | RFC 6238 with SHA-1, SHA-256 or SHA-512, from base32 or `otpauth://`.                                                                                            |
| Match                           | Domains through the Public Suffix List; Android apps by package and signing certificate, with Digital Asset Links.                                               |
| Read the cache                  | The encrypted snapshot from #10, in the App Group container or app-private storage, never decrypted at rest.                                                     |
| Save a new login                | Seal it with a new item key, wrap that key with the vault key, and queue the upload.                                                                             |

Every row has a test vector already, except matching and the cache format, which #10 adds. Each core should come to a few hundred lines.

## The options

### (a) The PWA and the browser extension, as now

- **Autofill:** none on either phone, as shown above. On iOS, the Safari extension (#13) fills only in Safari, and only from inside an app.
- **Biometrics:** a passkey unlock (#9), in Safari and Chrome.
- **Offline:** #10 makes it work.
- **Reuse:** everything.
- **Security:** the server delivers the code on every visit, which is the first item under [Limits](../security.md#limits).
- **Review:** none.
- **Effort and upkeep:** none beyond today.

**Verdict:** keep improving it. It's what a self-hosting team gets without any store. But it can't meet the requirement that matters most.

### (b) Capacitor around `apps/web`, with native autofill

- **How it works:**
  - The Vite build runs inside a WKWebView or an Android WebView, served from `capacitor://localhost` or `https://localhost`.
  - Capacitor 8 needs iOS 15 or later and Android 7 or later. Version 9 is due around the end of November 2026, and moves iOS to Swift Package Manager [F1, F2].
  - The native projects are ordinary Xcode and Android Studio projects in the repository. Adding an extension target or a `<service>` is regular native work [F3]. No guide covers it, and no open-source Capacitor password manager with OS autofill turned up [F4].
- **Autofill:** native, as above. The extension can't read the WebView's storage or use its `crypto.subtle`. So the app writes the encrypted cache to the App Group container through a small plugin of our own, and the extension reads it there.
- **Biometrics:**
  - The passkey unlock from #9 doesn't carry over. WebAuthn in a WKWebView needs the app to have the relying party as an associated domain [A13]. A self-hosted vauly lives at any address, so that can't be done ahead of time. Android has the same requirement through Digital Asset Links [G12].
  - Instead, the app unlocks the way the extension does, through the same native plugin and the same Keychain or Keystore item.
  - The free plugins don't share a Keychain access group with an extension [F5], so we write that bridge ourselves.
- **Offline:**
  - iOS can clear a WebView's IndexedDB when space runs low [F6], and service workers aren't supported in a WKWebView [A15].
  - The app's own files come bundled, so it needs no service worker. The encrypted cache lives in native storage, through the same plugin.
- **Reuse:** all screens, routing, state and `packages/crypto` in the main app. The work is a phone layout pass, the plugin, and the store-specific screens.
- **Security:**
  - Better than the PWA in one way: the app's code ships in the reviewed binary instead of arriving from the server on each visit.
  - It also adds risks, which we take on:
    - a bridge between JavaScript and native code;
    - Android's rules for WebView bridges and file access [G16];
    - three crypto copies (TypeScript, Swift, Kotlin), held together by the vectors.
  - Live updates (2.5.2) would let anyone who controls the update channel ship key-stealing code past review [A17]. We don't use them.
- **Review:**
  - The main risk is 4.2 ("a repackaged website") [A16]. A native AutoFill extension, Face ID and offline access give the app what a website can't do, though nothing guarantees approval.
  - Account deletion inside the app is required either way.
- **Effort:** about 4 to 6 months to a first release on both platforms, for one person (estimate).
- **Upkeep:** a Capacitor major each year, our own plugin, and two small native codebases that change only when the formats or the OS do.

**Verdict:** recommended. It's the only option that reuses the UI we have. Native autofill costs the same here as anywhere.

### (c) React Native or Expo

- **How it works:**
  - The screens are rewritten in React Native. There's no DOM, so the components, CSS and routing don't carry over; hooks, API clients and TanStack Query logic do [F8].
  - Expo's DOM components can host web screens in a WebView, but Expo recommends native views "whenever possible" [F9].
- **Autofill:** still native.
  - Running React Native inside the AutoFill extension is possible but risky for memory. Buttercup did it, and its repository is now archived [F10].
  - PearPass, on Expo, wrote its extension and its Android services natively instead, through a config plugin [F11].
  - Expo's support for iOS extensions is experimental, and native edits must survive `prebuild` as config plugins [F12, F13].
- **Biometrics:** `expo-secure-store` supports a Keychain access group and `requireAuthentication` [F14]. `expo-local-authentication` returns only true or false, without binding to a key [F15].
- **Crypto:** Hermes has no `crypto.subtle`. `react-native-quick-crypto` lists every operation vauly uses, but it's a third-party native module to verify against the vectors [F16]. That makes three or four implementations.
- **Effort:** about 6 to 8 months (estimate). The UI rewrite adds about 10 to 16 weeks without removing the native autofill work.
- **Upkeep:** three Expo SDK releases a year, and config plugins kept working across them [F17].

**Verdict:** not recommended. It costs a rewrite of the UI and still needs all the native work.

### (d) Native Swift and Kotlin

- **How it works:** SwiftUI and Jetpack Compose apps, sharing their native core with the extension and the service.
  - This is where Bitwarden moved in 2024–25 [F18].
  - KeePassium, Strongbox and KeePassDX were built this way too [F19].
- **Autofill:** the cleanest, because the app and the extension share one codebase per platform.
- **Biometrics and offline:** fully native, with no WebView storage to work around.
- **Reuse:** none of the UI. Every screen is built twice, and the item model, sharing rules and sync logic exist three times.
- **Security:** the smallest attack surface, with no WebView and no bridge.
- **Effort:** about 9 to 12 months to a first release, for one person (estimate).
- **Upkeep:** every feature lands three times: web, iOS and Android.

**Verdict:** the right end state for a bigger team. For now, option (b) builds its foundation, so we can move a screen at a time if the WebView ever holds us back.

### (e) A shared Rust or Go core under native apps

- **How it works:** one library for crypto, the cache and vault logic, bound to Swift and Kotlin.
  - In Rust this is usually Mozilla's UniFFI [F20]. In Go it's gomobile [F24].
  - Bitwarden's SDK [F21], Proton Pass's common library [F22] and 1Password's core [F23] work this way.
  - Passbolt uses Go for its PGP code [F24].
- **What it saves:** one implementation instead of two native ones.
- **What it costs:**
  - **A heavy build:** the Rust toolchain, plus XCFramework and AAR builds for every architecture, and their release pipeline [F20, F21].
  - **Young or unaudited dependencies:**
    - UniFFI isn't at 1.0 yet [F20].
    - RustCrypto's `p256` has never had an independent audit [F25].
    - `ring` has no static ECDH, which vauly's stored PKCS#8 keys need [F26].
    - `aws-lc-rs` brings a C toolchain [F26].
  - **gomobile's limits:** it binds only some Go types, and a panic that crosses the boundary ends the program [F24].
  - **The web app:** using the core on the web would mean WASM in the page, and WASM needs `'wasm-unsafe-eval'` in the CSP [F27]. Argon2id runs as WASM already, but in a key worker with a policy of its own, so the page's policy still forbids it.
- **When it pays off:** when the shared logic is large, as with sync, conflict resolution and item schemas. vauly's autofill slice is small, and each platform's own crypto covers it.

**Verdict:** not now. Revisit it if offline editing and sync make the shared logic grow.

### Side by side

|                          | (a) PWA      | (b) Capacitor + native autofill | (c) React Native / Expo | (d) Native          | (e) Rust or Go core |
| ------------------------ | ------------ | ------------------------------- | ----------------------- | ------------------- | ------------------- |
| OS autofill              | No           | Yes, native                     | Yes, native             | Yes                 | Yes                 |
| Biometric unlock         | Passkey (#9) | Keychain / Keystore             | Keychain / Keystore     | Keychain / Keystore | Keychain / Keystore |
| Offline                  | #10          | Native cache                    | Native cache            | Native cache        | Native cache        |
| UI reused                | All          | All                             | Logic only              | None                | None                |
| Crypto implementations   | 1            | 3, held by the vectors          | 3–4                     | 3                   | 1–2                 |
| Code from the server     | Every visit  | Never (no live updates)         | Never (no OTA updates)  | Never               | Never               |
| Main review risk         | None         | 4.2                             | Low                     | Low                 | Low                 |
| First release (estimate) | Now          | 4–6 months                      | 6–8 months              | 9–12 months         | 10–14 months        |
| Yearly upkeep            | Low          | Medium                          | Medium–high             | High                | High                |

## Recommendation

**Choose (b): a Capacitor app around `apps/web`, with native autofill on each platform.** Build each platform's native core so it's the only code that touches the Keychain or Keystore and the shared cache. Three things decide it:
1. **The autofill work is the same everywhere.** Every option, even a cross-platform one, ends up with a native extension and a native service, as every password manager that ships iOS AutoFill shows [F10, F11, F18, F22].
2. **Only Capacitor keeps the UI we have.** The rest of the effort goes into what a phone adds, not into rebuilding screens.
3. **The copies stay in step.** vauly's crypto is small, each platform has it built in, and the test vectors check every copy. That's what makes three copies safe for a small team.

We don't:
- download code at run time;
- run JavaScript or a WebView inside the AutoFill extension;
- build the Rust core yet.

## Plan

### Phase 0: the web app, now

These need no store accounts.
- **#10, offline:** keep the API's ciphertext in a documented, portable snapshot that the native cores can read as well. Bind it to the session the way device unlock is bound, and cap how stale it can get.
- **Account deletion from inside the app.** Both stores require it, and today only an admin can remove someone. This needs a new issue.
- **Apps can connect.**
  - Allow the app origins (`capacitor://localhost`, `https://localhost`) in CORS.
  - Apps sign in with bearer tokens, which the API already accepts for the extension.
- **Spike** the questions under [Prototype first](#prototype-first).

### Phase 1: iPhone, closing #12 and #13

- **The app:** a Capacitor iOS app with **VaulyKit**, a Swift package that holds the crypto, the cache reader and Keychain unlock, and passes the test vectors.
- **The look (#82):** inside the app, `apps/web` dresses as an iPhone app. `lib/native.ts` finds Capacitor's bridge and sets `html[data-native="ios"]`, and `native.css` styles only under it, so the website never changes. The web build carries no Capacitor code.
  - **Layout:** a tab bar, large titles that collapse into the nav bar, inset-grouped lists, rows that swipe to show actions, an open item with Edit and ⋯ in its nav bar, and sheets with Cancel and the main button along the top.
  - **Type:** SF for text, through WebKit's Dynamic Type keywords, so it follows the person's text size; Spline Sans for the titles.
  - **Haptics** come from Capacitor's Haptics plugin, when the shell has it.
- **The AutoFill extension:**
  - a list screen and a Face ID unlock;
  - silent filling when the vault is unlocked;
  - saving new logins once iOS 26.2 is in reach.
  - Keyboard-bar suggestions are opt-in.
- **The Safari web extension** from `apps/extension`, packaged with `xcrun safari-web-extension-packager` inside the same app (#13) [A20].
- **Distribution:** TestFlight, then the App Store. This needs the Apple Developer Program, on a personal account that doesn't exist yet.

### Phase 2: Android, closing #11

- **The app:** a Capacitor Android app with **vauly-core**, a Kotlin module that does the same jobs as VaulyKit.
- **The `AutofillService`:**
  - fills apps and Chrome 135 and later, with a shortcut to Chrome's setting;
  - an unlock Activity with `BiometricPrompt`;
  - saving, with uploads queued.
- **Distribution:**
  - Google Play's closed testing track, then production;
  - APKs on GitHub Releases, and F-Droid later, if the maintainer agrees (decision 4 is still open).

### Phase 3: later

- **Passkeys:** a Credential Manager provider on Android [G8] and passkeys in the iOS extension [A2], once vauly stores passkeys. That belongs to the passkeys issue in Vault essentials.
- **One-time codes** in the iOS extension (iOS 18 and later) [A2].
- **Native screens** wherever the WebView falls short, built on the phase 1 and 2 cores.

**iPhone comes first**, as the maintainer decided. The PWA is weakest there, and the Safari extension (#13) can ship in the same app.

## Prototype first

Two weeks, before committing to phase 1:
1. **CryptoKit and JCA against `test-vectors.json`:**
   - reading PKCS#8 and SPKI;
   - the ECDH output;
   - our HKDF in Kotlin.

   [A11, G11]
2. **AutoFill memory:** peak memory of a minimal extension with the native core and a 1,000-item cache, on the oldest iPhone we support [A5, A6].
3. **Capacitor:** WebCrypto under `capacitor://localhost` (`isSecureContext`), and the CSP set from a meta tag [A14, F3].
4. **Face ID timing** in the extension's unlock screen [A10].
5. **Android deadline:** a fill answered from the cache within 5 seconds on a low-end phone, again with 1,000 items [G3].

If any of these fails, the options change. A failed memory test, for example, would push toward a lighter extension, not a different main app.

## Security notes for the apps

These go into docs/security.md when the apps ship.
- **What the device keeps:** ciphertext only, as on the web.
  - The unlock secret lives in the Keychain or the Keystore, behind biometrics, and is invalidated when biometrics are enrolled again. The master password always works.
  - The extension decrypts only what it fills.
- **Keyboard-bar suggestions** (iOS identity store, opt-in): iOS keeps the sites and usernames outside vauly's encryption, though never in backups or iCloud [A4].
- **The app's code:** no live updates, and only bundled code in the WebView.
  - A strict CSP, and no remote content.
  - On Android, no file access from the WebView, and HTTPS only [G16].
  - The bridge exposes a few narrow native calls.
- **Store paperwork:**
  - **Apple export compliance:** the apps rely on the operating system's crypto, plus WebCrypto in the WebView. The exact export-compliance answer is a legal question [A18].
  - **Google Data safety form:** vault contents are end-to-end encrypted, which the form treats as not collected. Account email and team membership still have to be declared [G14].

## Decisions

The maintainer decided on October 24, 2026:
1. **(b): Capacitor around `apps/web`, with native autofill.** Expo and React Native were reconsidered the same day, after the Capacitor shell looked like a web page in the simulator, and Capacitor stayed. Making the app look and feel like an iPhone app became #82.
2. **iPhone first**, then Android.
3. **Personal developer accounts** on both stores. Neither has been created yet.
   - The Apple Developer Program costs 99 USD a year [A19]. The AutoFill extension works on either account type.
   - A Google Play developer account costs a one-time 25 USD [G17]. On a personal account, Play requires a closed test with at least 12 testers for 14 days in a row before the app can go to production (#83).
   - Each store's listing shows the account holder's name.
4. **Distribution outside the stores** (APKs on GitHub Releases, and F-Droid later): **still open.**
5. **App identity** (the name, the bundle and package IDs, and who keeps the signing keys): **still open.**
6. **Keyboard-bar suggestions on iOS are opt-in** (#81).
7. **No push in the first version** (#84). The app shows what needs the person when it opens. Android gets UnifiedPush when it ships.

## Sources

Apple:
- [A1] [ASCredentialProviderViewController](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller), and the [AutoFill credential provider entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.authentication-services.autofill-credential-provider)
- [A2] Entry points:
  - [provideCredentialWithoutUserInteraction](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller/providecredentialwithoutuserinteraction(for:)-3mo23)
  - [prepareInterfaceToProvideCredential](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller/prepareinterfacetoprovidecredential(for:)-68qpo)
  - [prepareOneTimeCodeCredentialList](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller/prepareonetimecodecredentiallist(for:))
  - [save-password requests](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller/performwithoutuserinteractionifpossible(savepasswordrequest:))
  - [WWDC24 10125](https://developer.apple.com/videos/play/wwdc2024/10125/)
- [A3] [Automatically fill in strong passwords on iPhone](https://support.apple.com/guide/iphone/automatically-fill-in-strong-passwords-iphf9219d8c9/ios), and [ASSettingsHelper](https://developer.apple.com/documentation/authenticationservices/assettingshelper)
- [A4] [ASCredentialIdentityStore](https://developer.apple.com/documentation/authenticationservices/ascredentialidentitystore), and WWDC18 721 ([transcript](https://nonstrict.eu/wwdcindex/wwdc2018/721/))
- [A5] [App Extension Programming Guide: creating an extension](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html), and [Identifying high-memory use with jetsam reports](https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports)
- [A6] Third-party reports of the AutoFill memory limit: [KeePassium](https://support.keepassium.com/kb/autofill-memory/) and [Bitwarden community](https://community.bitwarden.com/t/dont-repeatedly-display-unlocking-may-fail-due-to-insufficient-memory-warning/58281)
- [A7] [Configuring App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups), and [App extension overview](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionOverview.html)
- [A8] [Sharing access to keychain items among a collection of apps](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)
- [A9] [Accessing keychain items with Face ID or Touch ID](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id), and [biometryCurrentSet](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset)
- [A10] [Apple Developer Forums 776747](https://developer.apple.com/forums/thread/776747): LocalAuthentication in extensions
- [A11] CryptoKit:
  - [AES.GCM](https://developer.apple.com/documentation/cryptokit/aes/gcm)
  - [HKDF](https://developer.apple.com/documentation/cryptokit/hkdf)
  - [P256.KeyAgreement](https://developer.apple.com/documentation/cryptokit/p256/keyagreement)
  - [PrivateKey(derRepresentation:)](https://developer.apple.com/documentation/cryptokit/p256/keyagreement/privatekey/init(derrepresentation:))
- [A12] [CryptoKit](https://developer.apple.com/documentation/cryptokit), which has no PBKDF2, and [KeePassium on CommonCrypto](https://github.com/keepassium/KeePassium)
- [A13] Apple Developer Forums [723273](https://developer.apple.com/forums/thread/723273) and [726943](https://developer.apple.com/forums/thread/726943): passkeys in a WKWebView need associated domains
- [A14] [WebKit: SecurityOrigin](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/SecurityOrigin.cpp), and [WKURLSchemeHandler](https://developer.apple.com/documentation/webkit/wkurlschemehandler)
- [A15] [Apple Developer Forums 773539](https://developer.apple.com/forums/thread/773539): service workers in a WKWebView
- [A16] [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (4.2, 2.5.2, 5.1.1), and [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [A17] [Apple Developer Program License Agreement, §3.3.1(B)](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)
- [A18] [Complying with encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations), and [export compliance documentation](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption)
- [A19] [Apple Developer Program](https://developer.apple.com/programs/)
- [A20] [Safari web extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions), and [Packaging a web extension for Safari](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)

Android and Google:
- [G1] [AutofillService](https://developer.android.com/reference/android/service/autofill/AutofillService)
- [G2] [Build autofill services](https://developer.android.com/identity/autofill/autofill-services), and [FillResponse.Builder](https://developer.android.com/reference/android/service/autofill/FillResponse.Builder)
- [G3] AOSP [RemoteFillService](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/autofill/java/com/android/server/autofill/RemoteFillService.java), which has the 5-second timeout
- [G4] [Chrome on Android to support third-party autofill services natively](https://android-developers.googleblog.com/2024/10/chrome-3p-autofill-services.html), and [the update](https://android-developers.googleblog.com/2025/02/chrome-3p-autofill-services-update.html)
- [G5] [Build autofill services: Chrome](https://developer.android.com/identity/autofill/autofill-services), on compatibility mode ending in 137, and the settings intent
- [G6] [Biometric authentication](https://developer.android.com/identity/sign-in/biometric-auth)
- [G7] [KeyGenParameterSpec.Builder](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder), and [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
- [G8] [Credential Manager: credential providers](https://developer.android.com/identity/sign-in/credential-provider), and [CredentialProviderService](https://developer.android.com/reference/android/service/credentials/CredentialProviderService)
- [G9] [WebAPKs](https://web.dev/articles/webapks), and [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity)
- [G10] [Chrome Web Store help: extensions on computers only](https://support.google.com/chrome_webstore/answer/1698338)
- [G11] JCA:
  - [Cipher](https://developer.android.com/reference/javax/crypto/Cipher)
  - [SecretKeyFactory](https://developer.android.com/reference/javax/crypto/SecretKeyFactory)
  - [KeyAgreement](https://developer.android.com/reference/javax/crypto/KeyAgreement)
  - [Cryptography guidance](https://developer.android.com/privacy-and-security/cryptography)
- [G12] [Credential Manager in a WebView](https://developer.android.com/identity/sign-in/credential-manager-webview)
- [G13] [Target API level requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [G14] [Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
- [G15] [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [G16] [Insecure WebView native bridges](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges), and [WebView unsafe file inclusion](https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion)
- [G17] [Google Play developer account registration fee](https://support.google.com/googleplay/android-developer/answer/6112435)

Frameworks and other projects:
- [F1] [The road to Capacitor 9](https://ionic.io/blog/the-road-to-capacitor-9)
- [F2] [Capacitor support policy](https://capacitorjs.com/docs/main/reference/support-policy)
- [F3] Capacitor: [native projects as source](https://capacitorjs.com/docs/cordova), [custom iOS code](https://capacitorjs.com/docs/ios/custom-code), [configuration](https://capacitorjs.com/docs/config) and [security](https://capacitorjs.com/docs/guides/security)
- [F4] [Padloc](https://github.com/padloc/padloc/tree/main/packages): a Cordova app with no OS autofill
- [F5] [@aparajita/capacitor-secure-storage](https://github.com/aparajita/capacitor-secure-storage), [@capgo/capacitor-native-biometric](https://github.com/Cap-go/capacitor-native-biometric), and [Ionic's commercial products announcement](https://ionic.io/blog/important-announcement-the-future-of-ionics-commercial-products)
- [F6] [Capacitor: storage](https://capacitorjs.com/docs/guides/storage)
- [F7] [React Native: app extensions](https://reactnative.dev/docs/app-extensions)
- [F8] [Expo SDK](https://docs.expo.dev/versions/latest/)
- [F9] [Expo DOM components](https://docs.expo.dev/guides/dom-components/)
- [F10] [Buttercup mobile, AutoFill extension](https://github.com/buttercup/buttercup-mobile/blob/HEAD/ios/BCAutoFillExtension/CredentialProviderViewController.m), archived
- [F11] [PearPass Expo autofill plugin](https://github.com/tetherto/pearpass-app-mobile/tree/HEAD/plugins/expo-autofill-plugin)
- [F12] [Expo: app extensions](https://docs.expo.dev/build-reference/app-extensions/), and [expo-apple-targets](https://github.com/EvanBacon/expo-apple-targets)
- [F13] [Expo: continuous native generation](https://docs.expo.dev/workflow/continuous-native-generation/)
- [F14] [expo-secure-store](https://docs.expo.dev/versions/latest/sdk/securestore/)
- [F15] [expo-local-authentication](https://docs.expo.dev/versions/latest/sdk/local-authentication/)
- [F16] [react-native-quick-crypto: implementation coverage](https://github.com/margelo/react-native-quick-crypto/blob/main/.docs/implementation-coverage.md)
- [F17] [Expo SDK 58](https://expo.dev/changelog/sdk-58)
- [F18] [Bitwarden: native mobile apps](https://bitwarden.com/blog/native-mobile-apps/), [bitwarden/ios](https://github.com/bitwarden/ios) and [bitwarden/android](https://github.com/bitwarden/android)
- [F19] [KeePassium](https://github.com/keepassium/KeePassium), [Strongbox](https://github.com/strongbox-password-safe/Strongbox) and [KeePassDX](https://github.com/Kunzisoft/KeePassDX)
- [F20] [UniFFI](https://github.com/mozilla/uniffi-rs), and [UniFFI for Swift](https://mozilla.github.io/uniffi-rs/latest/swift/overview.html)
- [F21] [bitwarden/sdk-internal](https://github.com/bitwarden/sdk-internal), and [Bitwarden SDK architecture](https://contributing.bitwarden.com/architecture/sdk/)
- [F22] [proton-pass-common](https://github.com/protonpass/proton-pass-common), and the [iOS AutoFill target](https://github.com/protonpass/ios-pass/tree/HEAD/AutoFill)
- [F23] [1Password 8: the story so far](https://1password.com/blog/1password-8-the-story-so-far)
- [F24] [gomobile](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile), [gobind](https://pkg.go.dev/golang.org/x/mobile/cmd/gobind), and [Passbolt's AutoFill extension](https://github.com/passbolt/mobile-passbolt-ios/tree/HEAD/Passbolt/PassboltAutofill)
- [F25] RustCrypto [aes-gcm](https://github.com/RustCrypto/AEADs/tree/master/aes-gcm) and [p256](https://github.com/RustCrypto/elliptic-curves/tree/master/p256)
- [F26] [ring agreement](https://docs.rs/ring/latest/ring/agreement/index.html), and [aws-lc-rs PrivateKey](https://docs.rs/aws-lc-rs/latest/aws_lc_rs/agreement/struct.PrivateKey.html)
- [F27] [CSP script-src and WebAssembly](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)
