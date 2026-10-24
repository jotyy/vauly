import AuthenticationServices
import SwiftUI

@main
struct ProtoApp: App {
	var body: some Scene {
		WindowGroup { ContentView() }
	}
}

struct ContentView: View {
	@State private var report = "Not run yet"
	@State private var username = ""

	var body: some View {
		VStack(alignment: .leading, spacing: 16) {
			Text(report).font(.footnote).accessibilityIdentifier("report")
			Button("Run in the app") { run() }
			Button("Turn on AutoFill") { Task { await turnOn() } }
			TextField("Username", text: $username)
				.textContentType(.username)
				.textFieldStyle(.roundedBorder)
				.accessibilityIdentifier("username")
		}
		.padding()
		.onAppear {
			if ProcessInfo.processInfo.arguments.contains("-runCheck") { run() }
			if ProcessInfo.processInfo.arguments.contains("-measure") { measureType() }
		}
	}

	private func run() {
		do {
			report = try checkVectors(in: "app").map(\.description).joined(separator: "\n")
		} catch {
			report = "\(error)"
		}
	}

	/// Widths UIKit gives the system font at Apple's text-style sizes, to compare with WebKit.
	private func measureType() {
		let sample = "Overview All items Settings 0123456789"
		var out: [String] = []
		for (size, weight) in [(11.0, UIFont.Weight.regular), (13, .regular), (15, .regular), (17, .regular), (17, .semibold), (20, .semibold), (22, .regular), (28, .bold), (34, .bold)] {
			let font = UIFont.systemFont(ofSize: size, weight: weight)
			let width = (sample as NSString).size(withAttributes: [.font: font]).width
			out.append(String(format: "%.0f/%.0f=%.2f", size, weight.rawValue * 1000, width))
		}
		log.notice("VAULY-TYPE uikit \(out.joined(separator: " "), privacy: .public)")
		report = out.joined(separator: "\n")
	}

	private func turnOn() async {
		if #available(iOS 18.0, *) {
			_ = try? await ASSettingsHelper.requestToTurnOnCredentialProviderExtension()
		}
	}
}
