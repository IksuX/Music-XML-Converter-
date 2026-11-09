import SwiftUI

/// Stan widoku trzymany w obiekcie zamiast w @State.
final class ViewState: ObservableObject {
    @Published var selection = Set<UUID>()
    @Published var dropTargeted = false
    @Published var showLog = false
}

struct ContentView: View {
    @EnvironmentObject var conv: Converter
    @Environment(\.openWindow) private var openWindow
    // Bez @State: w nowym SDK to makro, którego Command Line Tools (bez Xcode) nie potrafią rozwinąć.
    @StateObject private var ui = ViewState()
    @ObservedObject private var upd = Updater.shared

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let info = upd.available, !upd.dismissed || upd.busy {
                updateBanner(info)
                Divider()
            }
            fileArea
                .dropDestination(for: URL.self) { urls, _ in
                    conv.add(urls: urls)
                    return true
                } isTargeted: { ui.dropTargeted = $0 }
            Divider()
            options
            if ui.showLog { logView.transition(.move(edge: .bottom)) }
            Divider()
            footer
        }
        .onAppear {
            conv.refreshEngines()
            upd.converter = conv
            upd.checkOnLaunch()
        }
        .onReceive(NotificationCenter.default.publisher(for: .openPlayerRequested)) { note in
            if let url = note.object as? URL { openWindow(value: url) }
        }
    }

    // MARK: Nagłówek

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Nuty → MusicXML").font(.title2.weight(.semibold))
                Text("PDF, skany i zdjęcia nut do pliku .musicxml")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                Picker("Silnik", selection: $conv.engine) {
                    ForEach(EngineChoice.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 330)
                .disabled(conv.isRunning)
                HStack(spacing: 12) {
                    EngineBadge(name: "PDF wektorowy", ok: conv.vectorReady)
                    EngineBadge(name: "Audiveris", ok: conv.audiverisPath != nil)
                    EngineBadge(name: "oemer", ok: conv.oemerPath != nil)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    // MARK: Aktualizacja

    private func updateBanner(_ info: UpdateInfo) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.down.circle.fill").foregroundStyle(Color.accentColor)
            Text("Dostępna nowa wersja \(info.version)").fontWeight(.semibold)
            Text("(masz \(Updater.currentVersion))").foregroundStyle(.secondary)
            Spacer()
            if upd.busy {
                ProgressView().controlSize(.small)
                Text(upd.status).font(.caption).foregroundStyle(.secondary)
            }
            Button("Co nowego") { upd.openPage() }
            Button("Później") { upd.dismissed = true }
                .disabled(upd.busy)
            Button("Zaktualizuj") { Task { await upd.install() } }
                .buttonStyle(.borderedProminent)
                .disabled(upd.busy || conv.isRunning)
                .help(conv.isRunning ? "Poczekaj na koniec konwersji" : "Pobierz, zainstaluj i uruchom ponownie")
        }
        .controlSize(.small)
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(Color.accentColor.opacity(0.08))
    }

    // MARK: Lista plików

    @ViewBuilder
    private var fileArea: some View {
        if conv.jobs.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "music.note.list")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(ui.dropTargeted ? Color.accentColor : .secondary)
                Text("Przeciągnij tutaj pliki PDF, JPG, PNG lub HEIC")
                Text("albo gotowy plik .musicxml / .mxl, żeby go od razu odsłuchać")
                    .font(.callout).foregroundStyle(.secondary)
                    .font(.headline)
                Text("albo cały folder ze skanami")
                    .foregroundStyle(.secondary)
                Button("Wybierz pliki…") { conv.chooseFiles() }
                    .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
                    .foregroundStyle(ui.dropTargeted ? Color.accentColor : Color.secondary.opacity(0.35))
                    .padding(20)
            )
        } else {
            List(selection: $ui.selection) {
                ForEach(conv.jobs) { job in
                    JobRow(job: job)
                        .tag(job.id)
                        .contextMenu {
                            Button("Pokaż w Finderze") { conv.reveal(job) }
                            ForEach(job.outputs, id: \.self) { url in
                                Button("Odtwórz \(url.lastPathComponent)") { conv.play(url) }
                                Button("Otwórz w edytorze \(url.lastPathComponent)") { conv.open(url) }
                            }
                            Divider()
                            Button("Usuń z listy") { conv.remove([job.id]) }
                                .disabled(conv.isRunning)
                        }
                }
            }
            .listStyle(.inset(alternatesRowBackgrounds: true))
            .onDeleteCommand { conv.remove(ui.selection); ui.selection.removeAll() }
            .overlay {
                if ui.dropTargeted {
                    RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, lineWidth: 3).padding(4)
                }
            }
        }
    }

    // MARK: Opcje zapisu

    private var options: some View {
        HStack(spacing: 14) {
            Text("Zapisz:").foregroundStyle(.secondary)
            Picker("", selection: $conv.outputLocation) {
                ForEach(OutputLocation.allCases) { Text($0.label).tag($0) }
            }
            .labelsHidden()
            .frame(width: 200)

            if conv.outputLocation == .chosenFolder {
                Button {
                    conv.chooseOutputFolder()
                } label: {
                    Label(conv.outputFolder.isEmpty ? "Wybierz folder…"
                          : (conv.outputFolder as NSString).lastPathComponent,
                          systemImage: "folder")
                }
                .help(conv.outputFolder)
            }
            Spacer()
            if conv.engine.usesAudiveris {
                Toggle("Zachowaj też .mxl", isOn: $conv.keepMXL)
                    .help("Audiveris tworzy skompresowany MusicXML (.mxl). Aplikacja zawsze zapisuje zwykły .musicxml; tu możesz zachować też oryginał.")
            }
        }
        .disabled(conv.isRunning)
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }

    // MARK: Log

    private var logView: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("Log").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text("\(conv.log.count) linii").font(.caption).foregroundStyle(.tertiary)
                Spacer()
                Button { conv.copyLog() } label: { Label("Kopiuj", systemImage: "doc.on.doc") }
                    .help("Kopiuj cały log do schowka")
                Button { conv.saveLog() } label: { Label("Zapisz…", systemImage: "square.and.arrow.down") }
                    .help("Zapisz log do pliku .txt (⇧⌘S)")
                Button(role: .destructive) { conv.clearLog() } label: { Label("Wyczyść", systemImage: "trash") }
                    .help("Wyczyść log (⌘K)")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(conv.log.isEmpty)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            Divider()
            logLines
        }
    }

    private var logLines: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(conv.log.enumerated()), id: \.offset) { idx, line in
                        Text(line)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(line.hasPrefix("⚠︎") ? Color.orange : (line.hasPrefix("✓") ? Color.green :
                                (line.hasPrefix("▶︎") ? Color.accentColor : Color.primary)))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(idx)
                    }
                }
                .padding(10)
            }
            .frame(height: 170)
            .background(Color(nsColor: .textBackgroundColor))
            .onChange(of: conv.log.count) { count in
                if count > 0 { proxy.scrollTo(count - 1, anchor: .bottom) }
            }
        }
    }

    // MARK: Stopka

    private var footer: some View {
        HStack(spacing: 10) {
            Button { conv.chooseFiles() } label: { Label("Dodaj", systemImage: "plus") }
                .disabled(conv.isRunning)
            Button("Wyczyść listę") { conv.clearAll(); ui.selection.removeAll() }
                .disabled(conv.isRunning || conv.jobs.isEmpty)
            if conv.jobs.contains(where: { $0.status != .waiting }) && !conv.isRunning {
                Button("Konwertuj ponownie") { conv.resetFinished() }
            }
            Button { withAnimation { ui.showLog.toggle() } } label: {
                Label("Log", systemImage: ui.showLog ? "chevron.down" : "chevron.up")
            }

            Spacer()

            if let msg = conv.missingEngineMessage {
                Text(msg).font(.caption).foregroundStyle(.red).lineLimit(2)
                    .frame(maxWidth: 330, alignment: .trailing)
            }

            if conv.isRunning {
                ProgressView().controlSize(.small)
                Button("Przerwij", role: .cancel) { conv.cancel() }
            } else {
                Button { conv.start() } label: {
                    Label("Konwertuj", systemImage: "wand.and.stars")
                        .padding(.horizontal, 6)
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(!conv.canStart)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
}

private struct EngineBadge: View {
    let name: String
    let ok: Bool
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(ok ? Color.green : Color.red.opacity(0.8)).frame(width: 7, height: 7)
            Text(ok ? name : "\(name): brak").font(.caption2).foregroundStyle(.secondary)
        }
    }
}

private struct JobRow: View {
    @EnvironmentObject var conv: Converter
    let job: Job

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: Imaging.isPDF(job.source) ? "doc.richtext" : "photo")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(job.source.lastPathComponent).lineLimit(1).truncationMode(.middle)
                HStack(spacing: 6) {
                    if Imaging.isPDF(job.source) {
                        Text(job.pages == 1 ? "1 strona" : "\(job.pages) str.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Image(systemName: job.status.symbol).foregroundStyle(job.status.color).font(.caption)
                    Text(job.status.text).font(.caption).foregroundStyle(job.status.color)
                        .lineLimit(2)
                }
            }
            Spacer()
            ForEach(job.outputs, id: \.self) { url in
                Button {
                    conv.play(url)
                } label: {
                    Label(outputLabel(url) == "Otwórz" ? "Odtwórz" : outputLabel(url), systemImage: "play.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Odtwórz \(url.lastPathComponent) w odtwarzaczu (jak we wtyczce chóralnej)")
                Button { conv.open(url) } label: { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.borderless)
                    .help("Otwórz \(url.lastPathComponent) w domyślnym programie (np. MuseScore)")
            }
            if !job.outputs.isEmpty {
                Button { conv.reveal(job) } label: { Image(systemName: "magnifyingglass") }
                    .buttonStyle(.borderless)
                    .help("Pokaż w Finderze")
            }
        }
        .padding(.vertical, 4)
    }

    private func outputLabel(_ url: URL) -> String {
        let name = url.deletingPathExtension().lastPathComponent
        let base = job.source.deletingPathExtension().lastPathComponent
        let rest = name.hasPrefix(base) ? String(name.dropFirst(base.count)) : name
        let trimmed = rest.trimmingCharacters(in: CharacterSet(charactersIn: "-_ "))
        return trimmed.isEmpty ? "Otwórz" : trimmed
    }
}

struct SettingsView: View {
    @EnvironmentObject var conv: Converter
    @ObservedObject private var upd = Updater.shared

    var body: some View {
        Form {
            Section("PDF z programu nutowego") {
                Toggle("Czytaj nuty bezpośrednio z PDF, gdy to możliwe", isOn: $conv.useVector)
                Text("PDF wyeksportowany z Finale, Sibeliusa, MuseScore itp. ma nuty zapisane jako dane, nie obraz. Odczyt jest wtedy dokładny: nuty, rytm, tekst i akordy bez błędów rozpoznawania. Skany i zdjęcia nadal idą przez Audiveris/oemer.")
                    .font(.caption).foregroundStyle(.secondary)
                if conv.vectorReady {
                    Label("Czytnik gotowy", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
                } else {
                    Label("Brak czytnika — uruchom ./zainstaluj-silniki.sh narzedzia", systemImage: "xmark.circle.fill")
                        .font(.caption).foregroundStyle(.red)
                }
            }
            Section("Audiveris") {
                TextField("Własna ścieżka (puste = szukaj automatycznie)", text: $conv.customAudiveris)
                pathStatus(conv.audiverisPath)
                TextField("Języki tekstu pod nutami (OCR)", text: $conv.ocrLanguages)
                    .help("Kody Tesseracta połączone plusem, np. pol+eng albo pol+lat+deu")
                ocrStatus
            }
            Section("oemer") {
                TextField("Własna ścieżka (puste = szukaj automatycznie)", text: $conv.customOemer)
                pathStatus(conv.oemerPath)
                Toggle("Prostowanie krzywych zdjęć (deskew)", isOn: $conv.oemerDeskew)
                    .help("Dla czystych PDF-ów można wyłączyć — będzie szybciej.")
                Toggle("Łącz strony PDF w jeden plik", isOn: $conv.mergeOemerPages)
                Text("oemer nie odczytuje tekstu pod nutami — do tego służy Audiveris.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Aktualizacje") {
                Toggle("Sprawdzaj automatycznie przy uruchomieniu (z GitHuba)", isOn: $upd.autoCheck)
                HStack {
                    Text("Wersja \(Updater.currentVersion)").foregroundStyle(.secondary)
                    Spacer()
                    if upd.busy { ProgressView().controlSize(.small) }
                    Button("Sprawdź teraz") { Task { await upd.check(manual: true) } }
                        .disabled(upd.busy)
                }
                if !upd.status.isEmpty {
                    Text(upd.status).font(.caption).foregroundStyle(.secondary)
                }
            }
            Section {
                Button("Sprawdź ponownie") { conv.refreshEngines() }
                Text("Silniki instaluje skrypt zainstaluj-silniki.sh z paczki aplikacji.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 560, height: 720)
    }

    @ViewBuilder
    private var ocrStatus: some View {
        let missing = OCR.missingLanguages(conv.normalizedLanguages)
        if missing.isEmpty {
            Label("Pliki OCR zainstalowane", systemImage: "checkmark.circle.fill")
                .font(.caption).foregroundStyle(.green)
        } else {
            Label("Brak plików OCR: \(missing.joined(separator: ", ")) — uruchom ./zainstaluj-silniki.sh ocr",
                  systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private func pathStatus(_ path: String?) -> some View {
        if let path {
            Label(path, systemImage: "checkmark.circle.fill")
                .font(.caption).foregroundStyle(.green).lineLimit(2).textSelection(.enabled)
        } else {
            Label("Nie znaleziono", systemImage: "xmark.circle.fill")
                .font(.caption).foregroundStyle(.red)
        }
    }
}
