import Capacitor
import UIKit

/// The web view the app runs vauly in, with vauly's own plugins added to Capacitor's bridge.
class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SessionPlugin())
        // These take the place of two plugins Capacitor always registers; see RefusedPlugins.
        bridge?.registerPluginInstance(RefusedHttpPlugin())
        bridge?.registerPluginInstance(RefusedWebViewPlugin())
    }
}
