import AppKit

// Path baked in at build time by scripts/build-service.sh
let launcher = URL(fileURLWithPath: "{{APP_ROOT}}/scripts/zhongwen.sh")

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.servicesProvider = self
        NSUpdateDynamicServices()
    }

    // NSMessage "zhongwen" in Info.plist → selector zhongwen:userData:error:
    @objc func zhongwen(_ pboard: NSPasteboard?, userData: String?, error: NSError?) {
        let text = pboard?.string(forType: .string) ?? ""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [launcher.path, text]
        p.environment = [
            "PATH": "/usr/bin:/bin:/opt/homebrew/bin",
            "HOME": NSHomeDirectory(),
        ]
        try? p.run()
        // stay alive briefly, then exit (idle provider has no value)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
