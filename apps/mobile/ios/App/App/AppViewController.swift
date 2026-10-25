import Capacitor
import UIKit

/// The web view the app runs vauly in, with vauly's own plugins added to Capacitor's bridge.
class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        Keychain.forgetAfterReinstall()
        bridge?.registerPluginInstance(SessionPlugin())
        bridge?.registerPluginInstance(UnlockPlugin())
        bridge?.registerPluginInstance(CopyPlugin())
        // These take the place of two plugins Capacitor always registers; see RefusedPlugins.
        for name in ["CapacitorHttp", "CAPHttpPlugin"] {
            bridge?.registerPluginInstance(RefusedHttpPlugin(jsName: name))
        }
        for name in ["WebView", "CAPWebViewPlugin"] {
            bridge?.registerPluginInstance(RefusedWebViewPlugin(jsName: name))
        }
    }

    #if DEBUG
    override func router() -> Router { DebugRouter() }
    #endif
}

#if DEBUG
/// A debug build's pages come from debug.html, whose policy also lets the app reach a vauly
/// on this computer over plain http (scripts/copy-web.ts). A release build serves
/// index.html, which allows only https.
struct DebugRouter: Router {
    var basePath: String = ""

    func route(for path: String) -> String {
        let page = URL(fileURLWithPath: path).pathExtension.isEmpty || path == "/index.html"
        return basePath + (page ? "/debug.html" : path)
    }
}
#endif
