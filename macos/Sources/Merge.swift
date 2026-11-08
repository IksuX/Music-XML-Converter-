import Foundation

/// Łączy osobne pliki MusicXML (po jednym na stronę) w jedną partyturę.
/// Takty z kolejnych stron są dopisywane do odpowiednich głosów (wg kolejności),
/// a numeracja taktów jest ustawiana od nowa.
enum MusicXMLMerge {
    enum MergeError: LocalizedError {
        case unreadable(String)
        var errorDescription: String? {
            if case .unreadable(let n) = self { return "Nie można odczytać \(n) jako MusicXML" }
            return nil
        }
    }

    @discardableResult
    static func merge(_ files: [URL], into destination: URL) throws -> [String] {
        var warnings: [String] = []
        guard let first = files.first else { return warnings }

        let base = try load(first)
        guard let root = base.rootElement() else { throw MergeError.unreadable(first.lastPathComponent) }
        if root.name != "score-partwise" {
            throw MergeError.unreadable(first.lastPathComponent)
        }
        let baseParts = root.elements(forName: "part")
        guard !baseParts.isEmpty else { throw MergeError.unreadable(first.lastPathComponent) }

        // Wyrównaj pierwszą stronę, żeby wszystkie głosy miały tyle samo taktów.
        pad(baseParts, to: maxMeasures(baseParts))

        for (pageIndex, url) in files.dropFirst().enumerated() {
            let pageNo = pageIndex + 2
            let doc: XMLDocument
            do { doc = try load(url) } catch {
                warnings.append("Strona \(pageNo) pominięta — nieczytelny wynik oemera")
                continue
            }
            let parts = doc.rootElement()?.elements(forName: "part") ?? []
            if parts.isEmpty {
                warnings.append("Strona \(pageNo): brak rozpoznanych nut")
                continue
            }
            if parts.count != baseParts.count {
                warnings.append("Strona \(pageNo): oemer rozpoznał \(parts.count) pięciolinii zamiast \(baseParts.count) — sprawdź tę stronę w edytorze")
            }
            let pageMax = maxMeasures(parts)
            for (i, target) in baseParts.enumerated() {
                let measures = i < parts.count ? parts[i].elements(forName: "measure") : []
                if let firstMeasure = measures.first {
                    // Nowa strona zaczyna nowy system w edytorze.
                    let print = XMLElement(name: "print")
                    print.addAttribute(XMLNode.attribute(withName: "new-system", stringValue: "yes") as! XMLNode)
                    firstMeasure.insertChild(print, at: 0)
                }
                for m in measures {
                    m.detach()
                    target.addChild(m)
                }
                if measures.count < pageMax {
                    for _ in measures.count..<pageMax { target.addChild(XMLElement(name: "measure")) }
                }
            }
        }

        // Numeracja taktów od 1 w każdym głosie.
        for part in baseParts {
            for (n, m) in part.elements(forName: "measure").enumerated() {
                if let attr = m.attribute(forName: "number") {
                    attr.stringValue = String(n + 1)
                } else {
                    m.addAttribute(XMLNode.attribute(withName: "number", stringValue: String(n + 1)) as! XMLNode)
                }
            }
        }

        let data = base.xmlData(options: [.nodePrettyPrint])
        try data.write(to: destination, options: .atomic)
        return warnings
    }

    private static func load(_ url: URL) throws -> XMLDocument {
        // Bez walidacji i bez pobierania DTD z internetu.
        try XMLDocument(contentsOf: url, options: [.nodeLoadExternalEntitiesNever])
    }

    private static func maxMeasures(_ parts: [XMLElement]) -> Int {
        parts.map { $0.elements(forName: "measure").count }.max() ?? 0
    }

    /// Puste takty — edytory (np. MuseScore) wypełniają je pauzą całotaktową.
    private static func pad(_ parts: [XMLElement], to count: Int) {
        for p in parts {
            let have = p.elements(forName: "measure").count
            if have < count {
                for _ in have..<count { p.addChild(XMLElement(name: "measure")) }
            }
        }
    }
}

/// Pliki językowe Tesseracta, z których Audiveris czyta tekst pod nutami.
enum OCR {
    static var tessdataDir: URL {
        if let env = ProcessInfo.processInfo.environment["TESSDATA_PREFIX"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("AudiverisLtd/audiveris/tessdata", isDirectory: true)
    }

    static func missingLanguages(_ spec: String) -> [String] {
        spec.split(separator: "+").map(String.init).filter {
            !FileManager.default.fileExists(atPath: tessdataDir.appendingPathComponent("\($0).traineddata").path)
        }
    }
}
