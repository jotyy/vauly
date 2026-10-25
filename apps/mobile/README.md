# vauly for iPhone

The vauly app for iPhone: the web app, `apps/web`, in a [Capacitor](https://capacitorjs.com) shell. It isn't released yet; [the mobile RFC](../../docs/rfcs/mobile.md) has the plan, and [Security](../../docs/security.md#the-app-for-iphone) how it holds its session.

## Building it

It needs Xcode 26 and Bun.

```sh
bun install
bun run --cwd apps/mobile sync  # builds apps/web, copies it in, updates the plugins
bun run --cwd apps/mobile open  # opens the project in Xcode
```

Then run the **App** scheme on a simulator. There's no signing team yet, so it doesn't build for a device.

The app asks which vauly to connect to when it starts. For one on this computer, run vauly as one Worker from the repository's root with `bun run build && bunx wrangler dev`, and give the app `http://localhost:8787`. Any other address has to be `https://`.

## What's here

- `scripts/copy-web.ts` copies `apps/web/dist` to `www/`, which Capacitor puts in the app. The app's files come with no headers, so it writes the Content-Security-Policy into `index.html`, and it drops the build's `vauly.json`: the app reads the settings of the vauly it connects to.
- `capacitor.config.json` turns Capacitor's native HTTP off, and has the keyboard resize the WebView, so a sheet stays under the status bar while the keyboard is open.
- `ios/App/App/` is Capacitor's iOS project, with vauly's own Swift:
  - `AppViewController.swift` adds vauly's plugins to Capacitor's bridge.
  - `SessionPlugin.swift` is `VaulySession`: the vauly the app is connected to, and its session token, in the Keychain.
  - `RefusedPlugins.swift` takes the place of Capacitor's HTTP and WebView plugins, which Capacitor registers in every app, and refuses every call.
- The Haptics, Keyboard and Status Bar plugins come from npm. Capacitor itself comes as a Swift package, so there's no CocoaPods.

The bundle ID, `app.vauly`, is a placeholder until the app's name and IDs are decided.
