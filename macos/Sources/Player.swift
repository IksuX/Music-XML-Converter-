import SwiftUI
import WebKit
import AppKit
import UniformTypeIdentifiers

/// The MusicXML player — the same one as in the chor-repertuar plugin (OSMD + soundfont-player + player.js).
/// Files are served to the page through our own address scheme "nutyplayer://", so that
/// player.js and OSMD can fetch them with fetch()/XHR just like on the website.
enum PlayerFiles {
    static let scheme = "nutyplayer"
    static let musicExtensions: Set<String> = ["musicxml", "mxl", "xml"]

    private static let lock = NSLock()
    private static var registry: [String: URL] = [:]

    static func isMusicXML(_ url: URL) -> Bool {
        musicExtensions.contains(url.pathExtension.lowercased())
    }

    /// Registers a file and returns its token (stable for a given path).
    static func token(for url: URL) -> String {
        lock.lock(); defer { lock.unlock() }
        let key = String(url.standardizedFileURL.path.hashValue, radix: 36).replacingOccurrences(of: "-", with: "m")
        registry[key] = url
        return key
    }

    static func file(for token: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        return registry[token]
    }

    static var resourcesDir: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("Player", isDirectory: true)
    }
}

final class PlayerSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return fail(task, 400) }
        let path = url.path   // np. /index.html, /score/<token>/plik.musicxml, /vendor/x.js

        do {
            if path == "/index.html" || path == "/" {
                let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
                guard let token = comps?.queryItems?.first(where: { $0.name == "t" })?.value,
                      let file = PlayerFiles.file(for: token),
                      let dir = PlayerFiles.resourcesDir else { return fail(task, 404) }
                var html = try String(contentsOf: dir.appendingPathComponent("index.html"), encoding: .utf8)
                let ext = file.pathExtension.lowercased()
                let safeName = file.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "score.\(ext)"
                let fileURL = "\(PlayerFiles.scheme)://app/score/\(token)/\(safeName)"
                html = html.replacingOccurrences(of: "{{FILE_URL}}", with: fileURL)
                    .replacingOccurrences(of: "{{FORMAT}}", with: ext == "mxl" ? "mxl" : "musicxml")
                    .replacingOccurrences(of: "{{TITLE}}", with: escapeHTML(file.deletingPathExtension().lastPathComponent))
                return respond(task, url, Data(html.utf8), "text/html; charset=utf-8")
            }
            if path.hasPrefix("/score/") {
                let parts = path.split(separator: "/")
                guard parts.count >= 2, let file = PlayerFiles.file(for: String(parts[1])) else { return fail(task, 404) }
                let data = try Data(contentsOf: file)   // zawsze świeża wersja z dysku (przycisk „Odśwież”)
                let mime = file.pathExtension.lowercased() == "mxl"
                    ? "application/vnd.recordare.musicxml" : "application/vnd.recordare.musicxml+xml"
                return respond(task, url, data, mime)
            }
            // Pliki odtwarzacza z paczki aplikacji (bez wychodzenia poza katalog Player).
            guard let dir = PlayerFiles.resourcesDir else { return fail(task, 404) }
            let rel = path.split(separator: "/").filter { $0 != ".." }.joined(separator: "/")
            let file = dir.appendingPathComponent(rel)
            guard FileManager.default.fileExists(atPath: file.path) else { return fail(task, 404) }
            let data = try Data(contentsOf: file)
            let mime: String
            switch file.pathExtension.lowercased() {
            case "js": mime = "text/javascript; charset=utf-8"
            case "css": mime = "text/css; charset=utf-8"
            case "html": mime = "text/html; charset=utf-8"
            case "json": mime = "application/json"
            default: mime = "application/octet-stream"
            }
            respond(task, url, data, mime)
        } catch {
            fail(task, 500)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, _ url: URL, _ data: Data, _ mime: String) {
        let headers = ["Content-Type": mime,
                       "Content-Length": String(data.count),
                       "Cache-Control": "no-store",
                       "Access-Control-Allow-Origin": "*"]
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, _ code: Int) {
        if let url = task.request.url,
           let resp = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil) {
            task.didReceive(resp)
            task.didReceive(Data())
            task.didFinish()
        } else {
            task.didFailWithError(NSError(domain: "nutyplayer", code: code))
        }
    }

    private func escapeHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
}

/// Holds a reference to the WKWebView — needed for the toolbar buttons (reload, print).
@MainActor
final class PlayerController: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    weak var webView: WKWebView?
    let fileURL: URL
    let token: String

    init(fileURL: URL) {
        self.fileURL = fileURL
        self.token = PlayerFiles.token(for: fileURL)
    }

    var pageURL: URL {
        URL(string: "\(PlayerFiles.scheme)://app/index.html?t=\(token)")!
    }

    func reload() {
        // Pełne przeładowanie: odtwarzacz od nowa wczytuje plik z dysku (np. po poprawkach w MuseScore).
        webView?.load(URLRequest(url: pageURL))
    }

    func printScore() {
        guard let webView, let window = webView.window else { return }
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = true
        info.isVerticallyCentered = false
        let op = webView.printOperation(with: info)
        op.view?.frame = webView.bounds
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }

    // window.print() z player.js → nasze drukowanie (WKWebView na macOS samo go nie obsługuje).
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "nutyPrint" { printScore() }
    }

    // Linki zewnętrzne otwieramy w przeglądarce, nie w oknie odtwarzacza.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https",
           action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // alert()/confirm() z player.js — pokazujemy jako zwykłe okienka macOS.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Anuluj")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
}

struct PlayerWebView: NSViewRepresentable {
    let controller: PlayerController

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(PlayerSchemeHandler(), forURLScheme: PlayerFiles.scheme)
        config.mediaTypesRequiringUserActionForPlayback = []
        let ucc = WKUserContentController()
        ucc.add(controller, name: "nutyPrint")
        ucc.addUserScript(WKUserScript(
            source: "window.print = function () { window.webkit.messageHandlers.nutyPrint.postMessage(1); };",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = controller
        wv.uiDelegate = controller
        wv.allowsMagnification = true
        if #available(macOS 13.3, *) {
            wv.isInspectable = true   // prawy przycisk → „Zbadaj element”, gdyby trzeba było szukać błędu
        }
        controller.webView = wv
        wv.load(URLRequest(url: controller.pageURL))
        return wv
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    static func dismantleNSView(_ nsView: WKWebView, coordinator: ()) {
        // Zatrzymujemy dźwięk przy zamknięciu okna.
        nsView.configuration.userContentController.removeScriptMessageHandler(forName: "nutyPrint")
        nsView.loadHTMLString("", baseURL: nil)
    }
}

struct PlayerWindow: View {
    @StateObject private var controller: PlayerController

    init(fileURL: URL) {
        _controller = StateObject(wrappedValue: PlayerController(fileURL: fileURL))
    }

    var body: some View {
        PlayerWebView(controller: controller)
            .frame(minWidth: 760, minHeight: 560)
            .navigationTitle(controller.fileURL.deletingPathExtension().lastPathComponent)
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { controller.reload() } label: {
                        Label("Odśwież", systemImage: "arrow.clockwise")
                    }
                    .help("Wczytaj plik ponownie z dysku (⌘R) — np. po poprawkach w MuseScore")
                    .keyboardShortcut("r")

                    Button { NSWorkspace.shared.open(controller.fileURL) } label: {
                        Label("Otwórz w edytorze", systemImage: "square.and.pencil")
                    }
                    .help("Otwórz plik w domyślnym programie do nut (np. MuseScore)")

                    Button { NSWorkspace.shared.activateFileViewerSelecting([controller.fileURL]) } label: {
                        Label("Pokaż w Finderze", systemImage: "folder")
                    }

                    Button { controller.printScore() } label: {
                        Label("Drukuj", systemImage: "printer")
                    }
                }
            }
    }
}

extension Notification.Name {
    static let openPlayerRequested = Notification.Name("NutyMusicXML.openPlayer")
}

/// Choosing a MusicXML file from disk for the player.
enum PlayerOpen {
    static func choose() -> URL? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = PlayerFiles.musicExtensions.compactMap { UTType(filenameExtension: $0) }
        panel.prompt = "Odtwórz"
        panel.message = "Wybierz plik MusicXML (.musicxml, .mxl, .xml)"
        return panel.runModal() == .OK ? panel.url : nil
    }
}
