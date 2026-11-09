import Foundation
import SwiftUI
import AppKit
import UniformTypeIdentifiers

enum JobStatus: Equatable {
    case waiting
    case working(String)
    case done
    case partial(String)
    case failed(String)

    var symbol: String {
        switch self {
        case .waiting: return "clock"
        case .working: return "gearshape.2"
        case .done: return "checkmark.circle.fill"
        case .partial: return "exclamationmark.triangle.fill"
        case .failed: return "xmark.octagon.fill"
        }
    }

    var color: Color {
        switch self {
        case .waiting: return .secondary
        case .working: return .accentColor
        case .done: return .green
        case .partial: return .orange
        case .failed: return .red
        }
    }

    var text: String {
        switch self {
        case .waiting: return "Czeka"
        case .working(let s): return s
        case .done: return "Gotowe"
        case .partial(let s): return s
        case .failed(let s): return s
        }
    }
}

struct Job: Identifiable {
    let id = UUID()
    let source: URL
    var status: JobStatus = .waiting
    var outputs: [URL] = []
    var pages: Int

    init(source: URL) {
        self.source = source
        self.pages = Imaging.isPDF(source) ? Imaging.pageCount(of: source) : 1
    }
}

enum OutputLocation: String, CaseIterable, Identifiable {
    case nextToSource
    case chosenFolder
    var id: String { rawValue }
    var label: String { self == .nextToSource ? "Obok pliku źródłowego" : "Wybrany folder" }
}

@MainActor
final class Converter: ObservableObject {
    @Published var jobs: [Job] = []
    @Published var log: [String] = []
    @Published var isRunning = false
    @Published var audiverisPath: String?
    @Published var oemerPath: String?
    @Published var vectorReady = false

    // Ustawienia zapamiętywane między uruchomieniami.
    @Published var engine: EngineChoice = .audiveris { didSet { save(engine.rawValue, "engine") } }
    @Published var outputLocation: OutputLocation = .nextToSource { didSet { save(outputLocation.rawValue, "outputLocation") } }
    @Published var outputFolder: String = "" { didSet { save(outputFolder, "outputFolder") } }
    @Published var keepMXL: Bool = false { didSet { save(keepMXL, "keepMXL") } }
    @Published var oemerDeskew: Bool = true { didSet { save(oemerDeskew, "oemerDeskew") } }
    @Published var mergeOemerPages: Bool = true { didSet { save(mergeOemerPages, "mergeOemerPages") } }
    @Published var ocrLanguages: String = "pol+eng" { didSet { save(ocrLanguages, "ocrLanguages") } }
    @Published var useVector: Bool = true { didSet { save(useVector, "useVector") } }
    @Published var customAudiveris: String = "" { didSet { save(customAudiveris, "customAudiveris"); refreshEngines() } }
    @Published var customOemer: String = "" { didSet { save(customOemer, "customOemer"); refreshEngines() } }

    private func save(_ value: Any, _ key: String) { UserDefaults.standard.set(value, forKey: key) }

    private let runner = ProcessRunner()
    private var task: Task<Void, Never>?

    init() {
        let d = UserDefaults.standard
        engine = EngineChoice(rawValue: d.string(forKey: "engine") ?? "") ?? .audiveris
        outputLocation = OutputLocation(rawValue: d.string(forKey: "outputLocation") ?? "") ?? .nextToSource
        outputFolder = d.string(forKey: "outputFolder") ?? ""
        keepMXL = d.bool(forKey: "keepMXL")
        oemerDeskew = d.object(forKey: "oemerDeskew") as? Bool ?? true
        mergeOemerPages = d.object(forKey: "mergeOemerPages") as? Bool ?? true
        ocrLanguages = d.string(forKey: "ocrLanguages") ?? "pol+eng"
        useVector = d.object(forKey: "useVector") as? Bool ?? true
        customAudiveris = d.string(forKey: "customAudiveris") ?? ""
        customOemer = d.string(forKey: "customOemer") ?? ""
        refreshEngines()
    }

    func refreshEngines() {
        audiverisPath = EngineLocator.resolve(custom: customAudiveris, candidates: EngineLocator.audiverisCandidates)
        oemerPath = EngineLocator.resolve(custom: customOemer, candidates: EngineLocator.oemerCandidates)
        vectorReady = EngineLocator.toolsPython != nil && EngineLocator.vectorScript != nil
    }

    var missingEngineMessage: String? {
        // If all files are PDFs and the vector reader is ready, OMR may not be needed.
        let waiting = jobs.filter { $0.status == .waiting }
        if useVector && vectorReady && !waiting.isEmpty && waiting.allSatisfy({ Imaging.isPDF($0.source) }) {
            return nil
        }
        var missing: [String] = []
        if engine.usesAudiveris && audiverisPath == nil { missing.append("Audiveris") }
        if engine.usesOemer && oemerPath == nil { missing.append("oemer") }
        guard !missing.isEmpty else { return nil }
        return "Brak silnika: \(missing.joined(separator: ", ")). Uruchom zainstaluj-silniki.sh albo wskaż ścieżkę w Ustawieniach (⌘,)."
    }

    var canStart: Bool {
        !isRunning && jobs.contains { $0.status == .waiting } && missingEngineMessage == nil
            && (outputLocation == .nextToSource || !outputFolder.isEmpty)
    }

    // MARK: - Lista plików

    func add(urls: [URL], fromFolder: Bool = false) {
        for url in urls {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                let items = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? []
                add(urls: items.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending },
                    fromFolder: true)
                continue
            }
            // A MusicXML file dragged in directly (not from a folder) → open it straight in the player.
            if PlayerFiles.isMusicXML(url) {
                if !fromFolder { play(url) }
                continue
            }
            guard Imaging.acceptedExtensions.contains(url.pathExtension.lowercased()) else { continue }
            guard !jobs.contains(where: { $0.source == url }) else { continue }
            jobs.append(Job(source: url))
        }
    }

    func remove(_ ids: Set<UUID>) {
        guard !isRunning else { return }
        jobs.removeAll { ids.contains($0.id) }
    }

    func clearAll() {
        guard !isRunning else { return }
        jobs.removeAll()
    }

    // MARK: - Log

    func clearLog() {
        log.removeAll()
    }

    var logText: String {
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return "Nuty → MusicXML \(ver) · log z \(df.string(from: Date()))\n"
            + "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)\n\n"
            + log.joined(separator: "\n") + "\n"
    }

    func copyLog() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(logText, forType: .string)
    }

    func saveLog() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd-HHmm"
        panel.nameFieldStringValue = "Nuty-MusicXML-log-\(df.string(from: Date())).txt"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try logText.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            append("⚠︎ Nie udało się zapisać logu: \(error.localizedDescription)")
        }
    }

    func resetFinished() {
        guard !isRunning else { return }
        for i in jobs.indices { jobs[i].status = .waiting; jobs[i].outputs = [] }
    }

    // MARK: - Konwersja

    func start() {
        guard canStart else { return }
        isRunning = true
        let chosen = engine
        task = Task { [weak self] in
            guard let self else { return }
            for i in self.jobs.indices where self.jobs[i].status == .waiting {
                if Task.isCancelled { break }
                await self.process(index: i, engine: chosen)
            }
            self.isRunning = false
            self.append("— Zakończono —")
            NSSound(named: NSSound.Name("Glass"))?.play()
        }
    }

    func cancel() {
        task?.cancel()
        runner.cancel()
        append("Przerwano przez użytkownika.")
        for i in jobs.indices {
            if case .working = jobs[i].status { jobs[i].status = .failed("Przerwano") }
        }
    }

    func appendLog(_ line: String) { append(line) }

    private func append(_ line: String) {
        log.append(line)
        if log.count > 3000 { log.removeFirst(log.count - 3000) }
    }

    private nonisolated func logger(_ prefix: String) -> @Sendable (String) -> Void {
        return { line in
            Task { @MainActor [weak self] in self?.append("[\(prefix)] \(line)") }
        }
    }

    private func destinationFolder(for source: URL) -> URL {
        switch outputLocation {
        case .nextToSource: return source.deletingLastPathComponent()
        case .chosenFolder: return URL(fileURLWithPath: (outputFolder as NSString).expandingTildeInPath, isDirectory: true)
        }
    }

    private func uniqueURL(_ url: URL) -> URL {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return url }
        let base = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        let dir = url.deletingLastPathComponent()
        var n = 2
        while true {
            let candidate = dir.appendingPathComponent("\(base) (\(n)).\(ext)")
            if !fm.fileExists(atPath: candidate.path) { return candidate }
            n += 1
        }
    }

    private func process(index i: Int, engine: EngineChoice) async {
        let source = jobs[i].source
        let fm = FileManager.default
        let scratch = fm.temporaryDirectory.appendingPathComponent("NutyMusicXML-\(UUID().uuidString)", isDirectory: true)
        let outDir = destinationFolder(for: source)
        let baseOut = source.deletingPathExtension().lastPathComponent
        let safe = Imaging.safeName(source)
        var errors: [String] = []
        var outputs: [URL] = []

        let tf = DateFormatter()
        tf.dateFormat = "HH:mm:ss"
        append("▶︎ \(tf.string(from: Date()))  \(source.lastPathComponent)")
        do {
            try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
            try fm.createDirectory(at: outDir, withIntermediateDirectories: true)
        } catch {
            jobs[i].status = .failed("Brak dostępu do folderu: \(error.localizedDescription)")
            return
        }
        defer { try? fm.removeItem(at: scratch) }

        var suffixed = engine == .both
        var notes: [String] = []
        var vectorDone = false

        // --- Vector read (PDF from a notation program): exact, no recognition ---
        if useVector, Imaging.isPDF(source), !Task.isCancelled {
            if let py = EngineLocator.toolsPython, let script = EngineLocator.vectorScript {
                jobs[i].status = .working("Czytam nuty bezpośrednio z PDF…")
                let tmp = scratch.appendingPathComponent("wektor.musicxml")
                do {
                    let res = try await runner.run(executable: py, arguments: ["-I", script, source.path, tmp.path],
                                                   workingDirectory: scratch,
                                                   extraEnvironment: ["PYTHONIOENCODING": "utf-8"],
                                                   onLine: logger("PDF"))
                    if res.exitCode == 0, fm.fileExists(atPath: tmp.path) {
                        let dest = uniqueURL(outDir.appendingPathComponent("\(baseOut).musicxml"))
                        try fm.copyItem(at: tmp, to: dest)
                        outputs.append(dest)
                        vectorDone = true
                        notes = res.output.split(separator: "\n")
                            .filter { $0.hasPrefix("UWAGA: ") }
                            .map { String($0.dropFirst(7)) }
                    } else if res.exitCode == 3 {
                        append("ℹ︎ \(source.lastPathComponent): PDF bez nut wektorowych (skan) — używam rozpoznawania obrazu.")
                    } else if res.exitCode == 4 {
                        append("ℹ︎ \(source.lastPathComponent): odczyt bezpośredni niepewny — używam rozpoznawania obrazu.")
                    } else {
                        append("⚠︎ Czytnik wektorowy nie poradził sobie (kod \(res.exitCode)) — używam rozpoznawania obrazu.")
                    }
                } catch {
                    append("⚠︎ Czytnik wektorowy: \(error.localizedDescription)")
                }
            } else {
                append("ℹ︎ Czytnik wektorowy PDF nie jest zainstalowany — uruchom ./zainstaluj-silniki.sh narzedzia")
            }
        }
        if vectorDone { suffixed = false }

        // --- Audiveris ---
        if !vectorDone, engine.usesAudiveris, let exe = audiverisPath, !Task.isCancelled {
            jobs[i].status = .working("Audiveris rozpoznaje…")
            do {
                let files = try await runAudiveris(exe: exe, source: source, safe: safe, scratch: scratch)
                for (n, mxl) in files.enumerated() {
                    let movement = files.count > 1 ? "-cz\(n + 1)" : ""
                    let name = baseOut + (suffixed ? "-audiveris" : "") + movement
                    let dest = uniqueURL(outDir.appendingPathComponent("\(name).musicxml"))
                    try MXL.unpack(mxl, to: dest, scratch: scratch)
                    outputs.append(dest)
                    if keepMXL {
                        let mxlDest = uniqueURL(outDir.appendingPathComponent("\(name).mxl"))
                        try fm.copyItem(at: mxl, to: mxlDest)
                    }
                }
                if files.isEmpty { errors.append("Audiveris nie rozpoznał żadnej partytury") }
            } catch {
                errors.append("Audiveris: \(error.localizedDescription)")
            }
        }

        // --- oemer ---
        if !vectorDone, engine.usesOemer, let exe = oemerPath, !Task.isCancelled {
            do {
                let images: [URL]
                if Imaging.isPDF(source) {
                    jobs[i].status = .working("Przygotowuję strony PDF…")
                    images = try Imaging.rasterizePDF(source, to: scratch, baseName: safe)
                } else {
                    images = [try Imaging.preparedImage(source, in: scratch, baseName: safe)]
                }
                var pageFiles: [URL] = []
                for (n, img) in images.enumerated() {
                    if Task.isCancelled { break }
                    let pageTag = images.count > 1 ? "-str\(String(format: "%02d", n + 1))" : ""
                    jobs[i].status = .working(images.count > 1
                        ? "oemer: strona \(n + 1) z \(images.count)…"
                        : "oemer rozpoznaje… (może potrwać kilka minut)")
                    let tmpOut = scratch.appendingPathComponent("oemer-\(n + 1).musicxml")
                    var args = [img.path, "-o", tmpOut.path]
                    if !oemerDeskew { args.append("--without-deskew") }
                    let result = try await runner.run(executable: exe, arguments: args,
                                                      workingDirectory: scratch, onLine: logger("oemer"))
                    if result.exitCode == 0, fm.fileExists(atPath: tmpOut.path) {
                        if mergeOemerPages && images.count > 1 {
                            pageFiles.append(tmpOut)
                        } else {
                            let name = baseOut + (suffixed ? "-oemer" : "") + pageTag
                            let dest = uniqueURL(outDir.appendingPathComponent("\(name).musicxml"))
                            try fm.copyItem(at: tmpOut, to: dest)
                            outputs.append(dest)
                        }
                    } else {
                        errors.append("oemer\(images.count > 1 ? " (strona \(n + 1))" : ""): kod błędu \(result.exitCode)")
                    }
                }
                if !pageFiles.isEmpty && !Task.isCancelled {
                    jobs[i].status = .working("Łączę \(pageFiles.count) stron w jeden plik…")
                    let name = baseOut + (suffixed ? "-oemer" : "")
                    let dest = uniqueURL(outDir.appendingPathComponent("\(name).musicxml"))
                    let warnings = try MusicXMLMerge.merge(pageFiles, into: dest)
                    for w in warnings { append("⚠︎ \(w)") }
                    outputs.append(dest)
                }
            } catch {
                errors.append("oemer: \(error.localizedDescription)")
            }
        }

        jobs[i].outputs = outputs
        if Task.isCancelled {
            jobs[i].status = .failed("Przerwano")
        } else if vectorDone && !notes.isEmpty {
            jobs[i].status = .partial("Odczytane z PDF · do sprawdzenia: \(notes.count == 1 ? notes[0] : "\(notes.count) uwag (log)")")
        } else if vectorDone {
            jobs[i].status = .done
        } else if errors.isEmpty {
            jobs[i].status = .done
        } else if outputs.isEmpty {
            jobs[i].status = .failed(errors.joined(separator: "; "))
        } else {
            jobs[i].status = .partial(errors.joined(separator: "; "))
        }
        for e in errors { append("⚠︎ \(e)") }
        for o in outputs { append("✓ \(o.lastPathComponent)") }
    }

    /// Uruchamia Audiverisa w trybie wsadowym i zwraca wszystkie powstałe pliki .mxl.
    private func runAudiveris(exe: String, source: URL, safe: String, scratch: URL) async throws -> [URL] {
        let fm = FileManager.default
        let input = scratch.appendingPathComponent("audiveris-in", isDirectory: true)
        let output = scratch.appendingPathComponent("audiveris-out", isDirectory: true)
        try fm.createDirectory(at: input, withIntermediateDirectories: true)
        try fm.createDirectory(at: output, withIntermediateDirectories: true)

        // PDF: strony renderujemy w stałej szerokości i składamy w nowy PDF (jedna partytura z wielu stron).
        // Dzięki temu nietypowe PDF-y (np. zrzut z iPada 1450×2048 pkt) trafiają do Audiverisa we właściwej skali.
        let prepared: URL
        if Imaging.isPDF(source) {
            let pages = try Imaging.rasterizePDF(source, to: input, baseName: safe)
            prepared = input.appendingPathComponent("\(safe).pdf")
            try Imaging.makePDF(from: pages, to: prepared)
            for pg in pages { try? fm.removeItem(at: pg) }
        } else {
            prepared = try Imaging.preparedImage(source, in: input, baseName: safe)
        }

        var args = ["-batch", "-export", "-output", output.path]
        let langs = normalizedLanguages
        if !langs.isEmpty {
            args += ["-constant", "org.audiveris.omr.text.Language.defaultSpecification=\(langs)"]
            let missing = OCR.missingLanguages(langs)
            if !missing.isEmpty {
                append("⚠︎ Brak plików OCR dla: \(missing.joined(separator: ", ")) — tekst pod nutami nie zostanie odczytany. Uruchom: ./zainstaluj-silniki.sh ocr")
            }
        }
        args += ["--", prepared.path]
        let result = try await runner.run(executable: exe,
                                          arguments: args,
                                          workingDirectory: scratch,
                                          onLine: logger("Audiveris"))
        let found = findFiles(in: output, ext: "mxl")
        if found.isEmpty && result.exitCode != 0 {
            throw NSError(domain: "Audiveris", code: Int(result.exitCode),
                          userInfo: [NSLocalizedDescriptionKey: "zakończył się kodem \(result.exitCode) — szczegóły w logu"])
        }
        return found
    }

    /// "pol + eng" → "pol+eng"
    var normalizedLanguages: String {
        ocrLanguages.split(whereSeparator: { $0 == "+" || $0 == "," || $0 == " " })
            .map { $0.lowercased() }.joined(separator: "+")
    }

    private func findFiles(in dir: URL, ext: String) -> [URL] {
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { return [] }
        var out: [URL] = []
        for case let url as URL in e where url.pathExtension.lowercased() == ext { out.append(url) }
        return out.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }

    // MARK: - Akcje na wynikach

    /// Opens the file in the player window (the same one as in the choir plugin).
    func play(_ url: URL) {
        NotificationCenter.default.post(name: .openPlayerRequested, object: url)
    }

    func choosePlayerFile() {
        if let url = PlayerOpen.choose() { play(url) }
    }

    func reveal(_ job: Job) {
        let targets = job.outputs.isEmpty ? [job.source] : job.outputs
        NSWorkspace.shared.activateFileViewerSelecting(targets)
    }

    func open(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    func chooseOutputFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Wybierz"
        if panel.runModal() == .OK, let url = panel.url {
            outputFolder = url.path
            outputLocation = .chosenFolder
        }
    }

    func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = true
        panel.allowedContentTypes = Imaging.acceptedExtensions.compactMap { UTType(filenameExtension: $0) }
        panel.prompt = "Dodaj"
        if panel.runModal() == .OK { add(urls: panel.urls) }
    }
}
