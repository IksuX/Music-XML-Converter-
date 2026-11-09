import SwiftUI
import AppKit

@main
struct NutyMusicXMLApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var converter = Converter()

    var body: some Scene {
        WindowGroup("Nuty → MusicXML") {
            ContentView()
                .environmentObject(converter)
                .frame(minWidth: 720, minHeight: 520)
                .onReceive(NotificationCenter.default.publisher(for: .openFilesRequested)) { note in
                    if let urls = note.object as? [URL] { converter.add(urls: urls) }
                }
        }
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Sprawdź aktualizacje…") { Task { await Updater.shared.check(manual: true) } }
            }
            CommandGroup(replacing: .newItem) {
                Button("Dodaj pliki…") { converter.chooseFiles() }
                    .keyboardShortcut("o")
                Button("Odtwórz plik MusicXML…") { converter.choosePlayerFile() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
            }
            CommandMenu("Log") {
                Button("Zapisz log…") { converter.saveLog() }
                    .keyboardShortcut("s", modifiers: [.command, .shift])
                Button("Kopiuj log") { converter.copyLog() }
                Divider()
                Button("Wyczyść log") { converter.clearLog() }
                    .keyboardShortcut("k")
            }
        }

        // Player window — one per file (opening the same file again brings up the existing window).
        WindowGroup("Odtwarzacz", id: "player", for: URL.self) { $url in
            if let url {
                PlayerWindow(fileURL: url)
            }
        }
        .defaultSize(width: 1000, height: 820)

        Settings {
            SettingsView()
                .environmentObject(converter)
        }
    }
}

extension Notification.Name {
    static let openFilesRequested = Notification.Name("NutyMusicXML.openFiles")
}

/// Obsługa „Otwórz za pomocą…” i upuszczania plików na ikonę w Docku.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        NotificationCenter.default.post(name: .openFilesRequested, object: urls)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
