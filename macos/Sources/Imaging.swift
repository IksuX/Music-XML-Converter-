import Foundation
import PDFKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum ImagingError: LocalizedError {
    case cannotOpen(String)
    case cannotRender(String)

    var errorDescription: String? {
        switch self {
        case .cannotOpen(let n): return "Nie można otworzyć pliku \(n)"
        case .cannotRender(let n): return "Nie można przetworzyć obrazu \(n)"
        }
    }
}

enum Imaging {
    static let pdfExtensions: Set<String> = ["pdf"]
    /// Formaty, które oba silniki czytają bez konwersji.
    static let directImageExtensions: Set<String> = ["jpg", "jpeg", "png", "tif", "tiff", "bmp"]
    /// Pozostałe formaty, które najpierw zamieniamy na PNG (np. zdjęcia HEIC z iPhone'a).
    static let convertibleExtensions: Set<String> = ["heic", "heif", "webp", "gif"]

    static var acceptedExtensions: Set<String> {
        pdfExtensions.union(directImageExtensions).union(convertibleExtensions)
    }

    static func isPDF(_ url: URL) -> Bool { pdfExtensions.contains(url.pathExtension.lowercased()) }

    static func pageCount(of pdf: URL) -> Int {
        PDFDocument(url: pdf)?.pageCount ?? 0
    }

    /// OMR engines work best at roughly A4 / 300 dpi, i.e. ~2480 px of page width.
    static let targetWidth = 2480

    /// Renders each PDF page to PNG with a fixed width (independent of the page size in points).
    /// Previously this rendered at a fixed 300 dpi — a 1450-pt-wide page (e.g. a screenshot from an iPad
    /// pasted into a PDF) produced an image 6000 px wide, which OMR handles poorly.
    static func rasterizePDF(_ url: URL, to dir: URL, baseName: String) throws -> [URL] {
        guard let doc = PDFDocument(url: url) else { throw ImagingError.cannotOpen(url.lastPathComponent) }
        var result: [URL] = []
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            let box = page.bounds(for: .mediaBox)
            let rotated = page.rotation % 180 != 0
            let wPts = rotated ? box.height : box.width
            let hPts = rotated ? box.width : box.height
            guard wPts > 1, hPts > 1 else { continue }
            let scale = CGFloat(targetWidth) / wPts
            let w = targetWidth
            let h = Int((hPts * scale).rounded())

            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
                throw ImagingError.cannotRender(url.lastPathComponent)
            }
            ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.interpolationQuality = .high
            ctx.scaleBy(x: scale, y: scale)
            // transform(_:for:) uwzględnia obrót strony i przesunięcie mediaBox.
            page.transform(ctx, for: .mediaBox)
            page.draw(with: .mediaBox, to: ctx)

            guard let image = ctx.makeImage() else { throw ImagingError.cannotRender(url.lastPathComponent) }
            let out = dir.appendingPathComponent(String(format: "%@-str%02d.png", baseName, i + 1))
            try writePNG(image, to: out)
            result.append(out)
        }
        return result
    }

    /// Scales the image to ~2480 px wide when it is clearly too small (screenshots) or huge.
    static func normalized(_ img: CGImage) -> CGImage {
        guard img.width < 1900 || img.width > 4200 else { return img }
        let w = targetWidth
        let h = Int((CGFloat(img.height) * CGFloat(w) / CGFloat(img.width)).rounded())
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return img }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage() ?? img
    }

    /// Returns the path of an image ready for the engine: the original (when its size is good) or a normalized PNG.
    static func preparedImage(_ url: URL, in dir: URL, baseName: String) throws -> URL {
        let ext = url.pathExtension.lowercased()
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldAllowFloat: false] as CFDictionary) else {
            throw ImagingError.cannotOpen(url.lastPathComponent)
        }
        let norm = normalized(img)
        if norm === img && directImageExtensions.contains(ext) {
            // Kopiujemy pod bezpieczną nazwą (bez spacji i polskich znaków) — oemer i Java tego nie lubią.
            let out = dir.appendingPathComponent("\(baseName).\(ext == "jpeg" ? "jpg" : ext)")
            if FileManager.default.fileExists(atPath: out.path) { try FileManager.default.removeItem(at: out) }
            try FileManager.default.copyItem(at: url, to: out)
            return out
        }
        let out = dir.appendingPathComponent("\(baseName).png")
        try writePNG(norm, to: out)
        return out
    }

    /// Builds a PDF with A4-width pages from PNG images (Audiveris renders a PDF at 300 dpi,
    /// so it gets the pages at ~2480 px regardless of the size of the original PDF page).
    static func makePDF(from pngs: [URL], to out: URL) throws {
        var box = CGRect(x: 0, y: 0, width: 595, height: 842)
        guard let ctx = CGContext(out as CFURL, mediaBox: &box, nil) else {
            throw ImagingError.cannotRender(out.lastPathComponent)
        }
        for png in pngs {
            guard let src = CGImageSourceCreateWithURL(png as CFURL, nil),
                  let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
                throw ImagingError.cannotOpen(png.lastPathComponent)
            }
            var page = CGRect(x: 0, y: 0, width: 595, height: (595 * CGFloat(img.height) / CGFloat(img.width)).rounded())
            let boxData = Data(bytes: &page, count: MemoryLayout<CGRect>.size)
            ctx.beginPDFPage([kCGPDFContextMediaBox as String: boxData] as CFDictionary)
            ctx.interpolationQuality = .high
            ctx.draw(img, in: page)
            ctx.endPDFPage()
        }
        ctx.closePDF()
    }

    static func writePNG(_ image: CGImage, to url: URL) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw ImagingError.cannotRender(url.lastPathComponent)
        }
        // 300 dpi w metadanych — Audiveris korzysta z tego przy szacowaniu skali.
        let props: [CFString: Any] = [kCGImagePropertyDPIWidth: 300, kCGImagePropertyDPIHeight: 300]
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        if !CGImageDestinationFinalize(dest) { throw ImagingError.cannotRender(url.lastPathComponent) }
    }

    /// Nazwa pliku bez rozszerzenia, pozbawiona znaków kłopotliwych dla narzędzi wiersza poleceń.
    static func safeName(_ url: URL) -> String {
        let raw = url.deletingPathExtension().lastPathComponent
        let folded = raw.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "pl_PL"))
            .replacingOccurrences(of: "ł", with: "l").replacingOccurrences(of: "Ł", with: "L")
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let mapped = String(folded.unicodeScalars.map { allowed.contains($0) && $0.isASCII ? Character($0) : "_" })
        let collapsed = mapped.replacingOccurrences(of: "__+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        return collapsed.isEmpty ? "nuty" : collapsed
    }
}

/// Rozpakowanie skompresowanego MusicXML (.mxl) do zwykłego pliku .musicxml.
enum MXL {
    static func unpack(_ mxl: URL, to destination: URL, scratch: URL) throws {
        let fm = FileManager.default
        let dir = scratch.appendingPathComponent("mxl-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", mxl.path, dir.path]
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw ImagingError.cannotOpen(mxl.lastPathComponent) }

        var root: URL?
        let container = dir.appendingPathComponent("META-INF/container.xml")
        if let xml = try? String(contentsOf: container, encoding: .utf8),
           let range = xml.range(of: #"full-path\s*=\s*"([^"]+)""#, options: .regularExpression) {
            let attr = String(xml[range])
            if let q1 = attr.firstIndex(of: "\""), let q2 = attr.lastIndex(of: "\""), q1 < q2 {
                root = dir.appendingPathComponent(String(attr[attr.index(after: q1)..<q2]))
            }
        }
        if root == nil || !fm.fileExists(atPath: root!.path) {
            let items = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            root = items.first { ["xml", "musicxml"].contains($0.pathExtension.lowercased()) }
        }
        guard let src = root else { throw ImagingError.cannotOpen(mxl.lastPathComponent) }
        if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
        try fm.copyItem(at: src, to: destination)
    }
}
