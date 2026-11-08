import Foundation

/// Silniki rozpoznawania nut (OMR) obsługiwane przez aplikację.
enum EngineChoice: String, CaseIterable, Identifiable {
    case audiveris
    case oemer
    case both

    var id: String { rawValue }

    var label: String {
        switch self {
        case .audiveris: return "Audiveris"
        case .oemer: return "oemer"
        case .both: return "Oba (porównanie)"
        }
    }

    var usesAudiveris: Bool { self == .audiveris || self == .both }
    var usesOemer: Bool { self == .oemer || self == .both }
}

/// Wyszukiwanie zainstalowanych silników.
enum EngineLocator {
    static let supportDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("NutyMusicXML", isDirectory: true)
    }()

    /// Domyślne miejsca, w których szukamy Audiverisa (aplikacja z oficjalnego instalatora .dmg).
    static var audiverisCandidates: [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            "/Applications/Audiveris.app/Contents/MacOS/Audiveris",
            "\(home)/Applications/Audiveris.app/Contents/MacOS/Audiveris",
            supportDir.appendingPathComponent("Audiveris.app/Contents/MacOS/Audiveris").path
        ]
    }

    /// Domyślne miejsce oemera — środowisko Pythona tworzone przez zainstaluj-silniki.sh.
    static var oemerCandidates: [String] {
        [supportDir.appendingPathComponent("oemer-venv/bin/oemer").path]
    }

    /// Python z biblioteką PyMuPDF — do czytnika wektorowych PDF (tworzy go zainstaluj-silniki.sh).
    static var toolsPython: String? {
        let path = supportDir.appendingPathComponent("tools-venv/bin/python3").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    /// Skrypt czytnika dołączony do aplikacji.
    static var vectorScript: String? {
        Bundle.main.url(forResource: "wektor_pdf", withExtension: "py")?.path
    }

    static func resolve(custom: String, candidates: [String]) -> String? {
        let fm = FileManager.default
        let trimmed = custom.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            var path = (trimmed as NSString).expandingTildeInPath
            // Ktoś mógł wskazać samą aplikację .app — szukamy pliku wykonywalnego w środku.
            if path.hasSuffix(".app") {
                let name = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
                path = (path as NSString).appendingPathComponent("Contents/MacOS/\(name)")
            }
            return fm.isExecutableFile(atPath: path) ? path : nil
        }
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }
}

/// Wynik uruchomienia zewnętrznego programu.
struct ProcessResult {
    let exitCode: Int32
    let output: String
}

/// Uruchamia proces, przekazując na bieżąco jego wyjście do logu. Obsługuje anulowanie.
final class ProcessRunner: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Process?

    func cancel() {
        lock.lock(); defer { lock.unlock() }
        if let p = current, p.isRunning { p.terminate() }
    }

    func run(executable: String,
             arguments: [String],
             workingDirectory: URL? = nil,
             extraEnvironment: [String: String] = [:],
             onLine: @escaping @Sendable (String) -> Void) async throws -> ProcessResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let wd = workingDirectory { process.currentDirectoryURL = wd }

        var env = ProcessInfo.processInfo.environment
        // Aplikacje uruchamiane z Findera mają bardzo ubogi PATH.
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["PYTHONUNBUFFERED"] = "1"
        for (k, v) in extraEnvironment { env[k] = v }
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        let collector = OutputCollector(onLine: onLine)
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { return }
            collector.append(data)
        }

        return try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { [weak self] p in
                pipe.fileHandleForReading.readabilityHandler = nil
                let rest = pipe.fileHandleForReading.readDataToEndOfFile()
                if !rest.isEmpty { collector.append(rest) }
                collector.flush()
                self?.lock.lock(); self?.current = nil; self?.lock.unlock()
                continuation.resume(returning: ProcessResult(exitCode: p.terminationStatus,
                                                             output: collector.text))
            }
            do {
                lock.lock(); current = process; lock.unlock()
                try process.run()
            } catch {
                lock.lock(); current = nil; lock.unlock()
                continuation.resume(throwing: error)
            }
        }
    }
}

/// Składa wyjście procesu w linie (procesy wypisują dane kawałkami).
private final class OutputCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = ""
    private(set) var text = ""
    private let onLine: @Sendable (String) -> Void

    init(onLine: @escaping @Sendable (String) -> Void) { self.onLine = onLine }

    func append(_ data: Data) {
        let chunk = String(decoding: data, as: UTF8.self)
        lock.lock()
        text += chunk
        buffer += chunk.replacingOccurrences(of: "\r", with: "\n")
        var lines: [String] = []
        while let idx = buffer.firstIndex(of: "\n") {
            lines.append(String(buffer[..<idx]))
            buffer = String(buffer[buffer.index(after: idx)...])
        }
        // Nie trzymamy w pamięci całego wyjścia gadatliwych procesów.
        if text.count > 200_000 { text = String(text.suffix(100_000)) }
        lock.unlock()
        for line in lines where !line.trimmingCharacters(in: .whitespaces).isEmpty { onLine(line) }
    }

    func flush() {
        lock.lock()
        let rest = buffer
        buffer = ""
        lock.unlock()
        if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { onLine(rest) }
    }
}
