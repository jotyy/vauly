import Capacitor

// Capacitor registers a few plugins of its own in every app, whatever capacitor.config.json
// says. Two of them would let a script that got into the page around the app's limits, so
// these take their place, under the same names, and refuse every call.

/// Capacitor's native HTTP sends requests from native code, where the page's
/// Content-Security-Policy doesn't reach, so it could send anything anywhere. vauly's
/// requests go through the WebView's own fetch, under that policy.
@objc(RefusedHttpPlugin)
public class RefusedHttpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RefusedHttpPlugin"
    public let jsName = "CapacitorHttp"
    public let pluginMethods: [CAPPluginMethod] = ["request", "get", "post", "put", "patch", "delete"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    @objc func request(_ call: CAPPluginCall) { refuse(call) }
    @objc func get(_ call: CAPPluginCall) { refuse(call) }
    @objc func post(_ call: CAPPluginCall) { refuse(call) }
    @objc func put(_ call: CAPPluginCall) { refuse(call) }
    @objc func patch(_ call: CAPPluginCall) { refuse(call) }
    @objc func delete(_ call: CAPPluginCall) { refuse(call) }
}

/// Capacitor's WebView plugin points the web view at other files on the device, for apps
/// that update themselves. vauly runs only the files it shipped with.
@objc(RefusedWebViewPlugin)
public class RefusedWebViewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RefusedWebViewPlugin"
    public let jsName = "WebView"
    public let pluginMethods: [CAPPluginMethod] = [
        "setServerAssetPath", "setServerBasePath", "getServerBasePath", "persistServerBasePath"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    @objc func setServerAssetPath(_ call: CAPPluginCall) { refuse(call) }
    @objc func setServerBasePath(_ call: CAPPluginCall) { refuse(call) }
    @objc func getServerBasePath(_ call: CAPPluginCall) { refuse(call) }
    @objc func persistServerBasePath(_ call: CAPPluginCall) { refuse(call) }
}

private func refuse(_ call: CAPPluginCall) {
    call.unavailable("vauly's app doesn't allow this")
}
