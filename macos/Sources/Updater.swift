import Foundation
import AppKit
import CryptoKit

/// Automatic updates from GitHub Releases: finds the newest release with
/// NutyMusicXML-macOS-<version>.zip, downloads it, verifies SHA-256, unpacks it,
/// swaps the app after it quits and launches it again.
struct UpdateInfo: Equatable {
    let version: String
    let notes: String
    let assetURL: URL
    let assetName: String
    let digest: String?
    let page: URL
}

enum UpdateError: LocalizedError {
    case http(Int), digest, noApp, wrongApp, tool(String)
    var errorDescription: String? {
        switch self {
        case .http(let c): return "GitHub odpowiedział kodem \(c)"
        case .digest: return "suma kontrolna pobranego pliku się nie zgadza (plik uszkodzony) — spróbuj ponownie"
        case .noApp: return "w pobranej paczce nie ma aplikacji"
        case .wrongApp: return "pobrana paczka zawiera inną aplikację"
        case .tool(let t): return t
        }
    }
}

@MainActor
final class Updater: ObservableObject {
    static let shared = Updater()
    nonisolated static let repo = "IksuX/Music-XML-Converter-"
    nonisolated static let assetPrefix = "NutyMusicXML-macOS-"

    @Published var available: UpdateInfo?
    @Published var status = ""
    @Published var busy = false
    @Published var dismissed = false
    @Published var autoCheck: Bool {
        didSet { UserDefaults.standard.set(autoCheck, forKey: "autoUpdateCheck") }
    }
    /// Ustawiane przez ContentView — aktualizacja nie może przerwać konwersji.
    weak var converter: Converter?

    private init() {
        autoCheck = UserDefaults.standard.object(forKey: "autoUpdateCheck") as? Bool ?? true
    }

    nonisolated static var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    nonisolated static func parts(_ v: String) -> [Int] {
        let s = v.hasPrefix("v") || v.hasPrefix("V") ? String(v.dropFirst()) : v
        var p = s.split(separator: ".").map { Int($0.prefix(while: { $0.isNumber })) ?? 0 }
        while p.count < 3 { p.append(0) }
        return p
    }

    nonisolated static func isNewer(_ a: String, than b: String) -> Bool {
        let x = parts(a), y = parts(b)
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }

    nonisolated static func request(_ url: URL, accept: String) -> URLRequest {
        var r = URLRequest(url: url)
        r.setValue(accept, forHTTPHeaderField: "Accept")
        r.setValue("NutyMusicXML/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        r.timeoutInterval = 30
        return r
    }

    // MARK: Sprawdzanie

    func checkOnLaunch() {
        guard autoCheck else { return }
        let last = UserDefaults.standard.double(forKey: "lastUpdateCheck")
        guard Date().timeIntervalSince1970 - last > 6 * 3600 else { return }
        Task { await check(manual: false) }
    }

    func check(manual: Bool) async {
        if busy { return }
        busy = true
        if manual { status = "Sprawdzam aktualizacje…" }
        do {
            let info = try await Self.fetchLatest()
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "lastUpdateCheck")
            busy = false
            if let info, Self.isNewer(info.version, than: Self.currentVersion) {
                available = info
                dismissed = false
                status = ""
                converter?.appendLog("ℹ︎ Dostępna nowa wersja \(info.version) (masz \(Self.currentVersion)).")
                if manual { askToInstall(info) }
            } else {
                available = nil
                status = manual ? "Masz najnowszą wersję (\(Self.currentVersion))." : ""
                if manual { alert("Masz najnowszą wersję", "Nuty → MusicXML \(Self.currentVersion) jest aktualna.") }
            }
        } catch {
            busy = false
            status = manual ? "Nie udało się sprawdzić aktualizacji: \(error.localizedDescription)" : ""
            if manual { alert("Nie udało się sprawdzić aktualizacji", error.localizedDescription) }
        }
    }

    nonisolated static func fetchLatest() async throws -> UpdateInfo? {
        let url = URL(string: "https://api.github.com/repos/\(repo)/releases?per_page=15")!
        let (data, resp) = try await URLSession.shared.data(for: request(url, accept: "application/vnd.github+json"))
        if let h = resp as? HTTPURLResponse, h.statusCode != 200 { throw UpdateError.http(h.statusCode) }
        guard let list = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        var best: UpdateInfo?
        for r in list {
            if (r["draft"] as? Bool) == true || (r["prerelease"] as? Bool) == true { continue }
            let tag = r["tag_name"] as? String ?? ""
            let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            let assets = r["assets"] as? [[String: Any]] ?? []
            guard let a = assets.first(where: {
                      let n = $0["name"] as? String ?? ""
                      return n.hasPrefix(assetPrefix) && n.hasSuffix(".zip")
                  }),
                  let link = a["browser_download_url"] as? String,
                  let assetURL = URL(string: link) else { continue }
            let page = URL(string: r["html_url"] as? String ?? "")
                ?? URL(string: "https://github.com/\(repo)/releases")!
            let info = UpdateInfo(version: version, notes: r["body"] as? String ?? "",
                                  assetURL: assetURL, assetName: a["name"] as? String ?? "update.zip",
                                  digest: a["digest"] as? String, page: page)
            if best == nil || isNewer(version, than: best!.version) { best = info }
        }
        return best
    }

    // MARK: Instalacja

    func openPage() {
        NSWorkspace.shared.open(available?.page ?? URL(string: "https://github.com/\(Self.repo)/releases")!)
    }

    func install() async {
        guard let info = available, !busy else { return }
        if converter?.isRunning == true {
            alert("Poczekaj na koniec konwersji", "Aktualizacja zamknie aplikację — najpierw dokończ albo przerwij konwersję.")
            return
        }
        let appURL = Bundle.main.bundleURL
        if appURL.path.contains("/AppTranslocation/") {
            alert("Przenieś aplikację do folderu Programy",
                  "macOS uruchomił aplikację z tymczasowego miejsca. Przenieś „Nuty MusicXML.app” do /Applications, uruchom ją stamtąd i spróbuj ponownie.")
            return
        }
        let parent = appURL.deletingLastPathComponent()
        guard FileManager.default.isWritableFile(atPath: parent.path) else {
            alert("Brak uprawnień", "Nie można zapisać w \(parent.path). Pobierz nową wersję ze strony wydania i podmień aplikację ręcznie.")
            openPage()
            return
        }
        busy = true
        status = "Pobieram \(info.assetName)…"
        converter?.appendLog("▶︎ Aktualizacja do \(info.version): pobieram \(info.assetURL.absoluteString)")
        do {
            let fm = FileManager.default
            let work = fm.temporaryDirectory.appendingPathComponent("NutyMusicXML-update-\(UUID().uuidString)")
            try fm.createDirectory(at: work, withIntermediateDirectories: true)
            let zip = work.appendingPathComponent(info.assetName)
            let (tmp, resp) = try await URLSession.shared.download(for: Self.request(info.assetURL, accept: "application/octet-stream"))
            if let h = resp as? HTTPURLResponse, h.statusCode != 200 { throw UpdateError.http(h.statusCode) }
            try fm.moveItem(at: tmp, to: zip)

            if let d = info.digest, d.hasPrefix("sha256:") {
                status = "Sprawdzam sumę kontrolną…"
                let hex = SHA256.hash(data: try Data(contentsOf: zip)).map { String(format: "%02x", $0) }.joined()
                guard hex == d.dropFirst(7).lowercased() else { throw UpdateError.digest }
                converter?.appendLog("✓ Suma kontrolna SHA-256 zgodna")
            }

            status = "Rozpakowuję…"
            let out = work.appendingPathComponent("x")
            try Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, out.path])
            guard let newApp = Self.findApp(in: out) else { throw UpdateError.noApp }
            let plist = NSDictionary(contentsOf: newApp.appendingPathComponent("Contents/Info.plist"))
            guard plist?["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier else { throw UpdateError.wrongApp }
            try? Self.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newApp.path])

            let script = work.appendingPathComponent("podmien.sh")
            try Self.swapScript.write(to: script, atomically: true, encoding: .utf8)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier),
                           newApp.path, appURL.path, work.path]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try p.run()
            status = "Uruchamiam ponownie…"
            converter?.appendLog("ℹ︎ Aplikacja zamknie się i uruchomi ponownie w nowej wersji.")
            try? await Task.sleep(nanoseconds: 400_000_000)
            NSApp.terminate(nil)
        } catch {
            busy = false
            status = "Aktualizacja nie powiodła się: \(error.localizedDescription)"
            converter?.appendLog("⚠︎ \(status)")
            alert("Aktualizacja nie powiodła się", error.localizedDescription)
        }
    }

    /// Czeka na zamknięcie aplikacji, podmienia pakiet (z kopią zapasową na wypadek błędu) i uruchamia nową wersję.
    nonisolated static let swapScript = """
    #!/bin/bash
    PID="$1"; NEW="$2"; DEST="$3"; WORK="$4"
    for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
    OLD="$DEST.stara-$$"
    if mv "$DEST" "$OLD"; then
      if /usr/bin/ditto "$NEW" "$DEST"; then rm -rf "$OLD"; else rm -rf "$DEST"; mv "$OLD" "$DEST"; fi
    fi
    /usr/bin/open "$DEST"
    rm -rf "$WORK"
    """

    nonisolated static func findApp(in dir: URL) -> URL? {
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { return nil }
        for case let u as URL in e where u.pathExtension == "app" {
            return u
        }
        return nil
    }

    nonisolated static func run(_ tool: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let err = Pipe()
        p.standardError = err
        p.standardOutput = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw UpdateError.tool("\((tool as NSString).lastPathComponent): \(msg.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    // MARK: Okna dialogowe

    private func askToInstall(_ info: UpdateInfo) {
        let a = NSAlert()
        a.messageText = "Dostępna nowa wersja \(info.version)"
        var notes = info.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if notes.count > 700 { notes = String(notes.prefix(700)) + "…" }
        a.informativeText = "Masz wersję \(Self.currentVersion).\n\n\(notes)"
        a.addButton(withTitle: "Zaktualizuj")
        a.addButton(withTitle: "Później")
        a.addButton(withTitle: "Strona wydania")
        switch a.runModal() {
        case .alertFirstButtonReturn: Task { await install() }
        case .alertThirdButtonReturn: openPage()
        default: dismissed = true
        }
    }

    private func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }
}
