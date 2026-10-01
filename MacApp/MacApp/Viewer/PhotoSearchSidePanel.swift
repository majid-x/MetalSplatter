import SwiftUI
import PDFKit
import WebKit
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
#elseif os(iOS) || os(visionOS)
import UIKit
#endif

struct PhotoSearchSidePanel: View {
    let photos: [PhotoSearchResult]
    let isLoading: Bool
    let isFetchingMore: Bool
    let hasMore: Bool
    let statusText: String
    let apiBaseURL: URL?
    let onClose: () -> Void
    let onFetchMore: () -> Void

    @State private var selectedIDs: Set<Int> = []
    @State private var fullscreenIndex: Int? = nil
    @State private var pdfExportError: String?
    @State private var sharePDFURL: URL?
    @State private var isSharePresented = false

    private var pageStep: Int { PhotoSearchAPI.defaultMaxResults }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Nearby Photos")
                    .font(.headline)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            Text(statusText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            if isLoading && photos.isEmpty {
                Spacer()
                ProgressView("Searching…")
                    .frame(maxWidth: .infinity)
                Spacer()
            } else if photos.isEmpty {
                Spacer()
                Text("Click a surface to find photos.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                HStack(spacing: 8) {
                    Button(selectedIDs.count == photos.count ? "Deselect All" : "Select All") {
                        if selectedIDs.count == photos.count {
                            selectedIDs.removeAll()
                        } else {
                            selectedIDs = Set(photos.map(\.id))
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)

                    Spacer()

                    if !selectedIDs.isEmpty {
                        Button("Export PDF") {
                            exportSelectedPDF()
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                }

                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                            photoCard(photo, index: index)
                        }
                    }
                    .padding(.vertical, 4)
                }

                if hasMore {
                    Button {
                        onFetchMore()
                    } label: {
                        if isFetchingMore {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Fetch More (+\(pageStep))")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(isFetchingMore || isLoading)
                }
            }

            if let pdfExportError {
                Text(pdfExportError)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .padding(14)
        .frame(width: 300)
        .frame(maxHeight: .infinity)
        .background(.ultraThinMaterial)
        .onChange(of: photos.map(\.id)) { _, _ in
            selectedIDs = selectedIDs.intersection(Set(photos.map(\.id)))
        }
#if os(macOS)
        .sheet(isPresented: Binding(
            get: { fullscreenIndex != nil },
            set: { if !$0 { fullscreenIndex = nil } }
        )) {
            if let index = fullscreenIndex {
                PhotoFullscreenViewer(
                    photos: photos,
                    index: index,
                    apiBaseURL: apiBaseURL,
                    onClose: { fullscreenIndex = nil }
                )
                .frame(minWidth: 900, minHeight: 640)
            }
        }
#else
        .fullScreenCover(isPresented: Binding(
            get: { fullscreenIndex != nil },
            set: { if !$0 { fullscreenIndex = nil } }
        )) {
            if let index = fullscreenIndex {
                PhotoFullscreenViewer(
                    photos: photos,
                    index: index,
                    apiBaseURL: apiBaseURL,
                    onClose: { fullscreenIndex = nil }
                )
            }
        }
#endif
#if os(iOS) || os(visionOS)
        .sheet(isPresented: $isSharePresented) {
            if let sharePDFURL {
                PhotoShareSheet(items: [sharePDFURL])
            }
        }
#endif
    }

    @ViewBuilder
    private func photoCard(_ photo: PhotoSearchResult, index: Int) -> some View {
        let selected = selectedIDs.contains(photo.id)
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topLeading) {
                Button {
                    fullscreenIndex = index
                } label: {
                    photoImage(photo)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)

                HStack {
                    Button {
                        if selected {
                            selectedIDs.remove(photo.id)
                        } else {
                            selectedIDs.insert(photo.id)
                        }
                    } label: {
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(selected ? Color.accentColor : .white)
                            .shadow(radius: 2)
                    }
                    .buttonStyle(.plain)
                    .padding(6)

                    Spacer()

                    Text(rankLabel(for: photo, index: index))
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(index == 0 ? Color.orange.opacity(0.9) : Color.black.opacity(0.55), in: Capsule())
                        .foregroundStyle(.white)
                        .padding(6)
                }

                if photo.is360 {
                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            Text("360°")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(.black.opacity(0.6), in: Capsule())
                                .foregroundStyle(.white)
                                .padding(6)
                        }
                    }
                }
            }

            Text(photo.filename)
                .font(.caption2)
                .lineLimit(2)
                .foregroundStyle(.secondary)

            Text(String(format: "score %.2f · dist %.2f", photo.score, photo.cameraDistance))
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
        }
        .padding(6)
        .background(selected ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
    }

    private func rankLabel(for photo: PhotoSearchResult, index: Int) -> String {
        if let rank = photo.rank {
            return "#\(rank + 1)"
        }
        return "#\(index + 1)"
    }

    private func exportSelectedPDF() {
        pdfExportError = nil
        let selected = photos.filter { selectedIDs.contains($0.id) }
        guard !selected.isEmpty else {
            pdfExportError = "Select at least one image"
            return
        }
        guard let data = PhotoPDFExporter.makePDF(from: selected) else {
            pdfExportError = "Could not build PDF"
            return
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("splat_images_\(Int(Date().timeIntervalSince1970)).pdf")
        do {
            try data.write(to: url, options: .atomic)
#if os(macOS)
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.pdf]
            panel.nameFieldStringValue = url.lastPathComponent
            if panel.runModal() == .OK, let dest = panel.url {
                try? FileManager.default.removeItem(at: dest)
                try data.write(to: dest, options: .atomic)
            }
#else
            sharePDFURL = url
            isSharePresented = true
#endif
        } catch {
            pdfExportError = error.localizedDescription
        }
    }

#if os(macOS)
    private func photoImage(_ photo: PhotoSearchResult) -> Image {
        if let nsImage = NSImage(data: photo.imageData) {
            return Image(nsImage: nsImage)
        }
        return Image(systemName: "photo")
    }
#elseif os(iOS) || os(visionOS)
    private func photoImage(_ photo: PhotoSearchResult) -> Image {
        if let uiImage = UIImage(data: photo.imageData) {
            return Image(uiImage: uiImage)
        }
        return Image(systemName: "photo")
    }
#endif
}

// MARK: - PDF

enum PhotoPDFExporter {
    static func makePDF(from photos: [PhotoSearchResult]) -> Data? {
        let pdf = PDFDocument()
        for (index, photo) in photos.enumerated() {
#if os(macOS)
            guard let nsImage = NSImage(data: photo.imageData),
                  let page = pdfPage(from: nsImage, filename: photo.filename) else { continue }
#else
            guard let uiImage = UIImage(data: photo.imageData),
                  let page = pdfPage(from: uiImage, filename: photo.filename) else { continue }
#endif
            pdf.insert(page, at: index)
        }
        return pdf.pageCount > 0 ? pdf.dataRepresentation() : nil
    }

#if os(macOS)
    private static func pdfPage(from image: NSImage, filename: String) -> PDFPage? {
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)
        let landscape = width >= height
        let pageWidth: CGFloat = landscape ? 842 : 595
        let pageHeight: CGFloat = landscape ? 595 : 842
        let margin: CGFloat = 28
        let titleH: CGFloat = 22
        let bounds = CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)

        let data = NSMutableData()
        var mediaBox = bounds
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return nil }
        ctx.beginPDFPage(nil)
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(bounds)

        let availW = pageWidth - margin * 2
        let availH = pageHeight - margin * 2 - titleH
        let scale = min(availW / width, availH / height)
        let drawW = width * scale
        let drawH = height * scale
        let x = margin + (availW - drawW) / 2
        let y = margin + (availH - drawH) / 2
        ctx.draw(cgImage, in: CGRect(x: x, y: y, width: drawW, height: drawH))

        ctx.setFillColor(CGColor(gray: 0.3, alpha: 1))
        let text = filename as CFString
        let font = CTFontCreateWithName("Helvetica" as CFString, 10, nil)
        let attrs: [CFString: Any] = [
            kCTFontAttributeName: font,
            kCTForegroundColorAttributeName: CGColor(gray: 0.3, alpha: 1),
        ]
        let attr = CFAttributedStringCreate(nil, text, attrs as CFDictionary)!
        let line = CTLineCreateWithAttributedString(attr)
        ctx.textPosition = CGPoint(x: margin, y: pageHeight - margin - 10)
        CTLineDraw(line, ctx)

        ctx.endPDFPage()
        ctx.closePDF()
        guard let single = PDFDocument(data: data as Data), let page = single.page(at: 0) else { return nil }
        return page
    }
#else
    private static func pdfPage(from image: UIImage, filename: String) -> PDFPage? {
        guard let cgImage = image.cgImage else { return nil }
        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)
        let landscape = width >= height
        let pageWidth: CGFloat = landscape ? 842 : 595
        let pageHeight: CGFloat = landscape ? 595 : 842
        let margin: CGFloat = 28
        let titleH: CGFloat = 22
        let bounds = CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)

        let data = NSMutableData()
        var mediaBox = bounds
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return nil }
        ctx.beginPDFPage(nil)
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(bounds)

        let availW = pageWidth - margin * 2
        let availH = pageHeight - margin * 2 - titleH
        let scale = min(availW / width, availH / height)
        let drawW = width * scale
        let drawH = height * scale
        let x = margin + (availW - drawW) / 2
        let y = margin + (availH - drawH) / 2
        ctx.draw(cgImage, in: CGRect(x: x, y: y, width: drawW, height: drawH))

        let text = filename as CFString
        let font = CTFontCreateWithName("Helvetica" as CFString, 10, nil)
        let attrs: [CFString: Any] = [
            kCTFontAttributeName: font,
            kCTForegroundColorAttributeName: CGColor(gray: 0.3, alpha: 1),
        ]
        let attr = CFAttributedStringCreate(nil, text, attrs as CFDictionary)!
        let line = CTLineCreateWithAttributedString(attr)
        ctx.textPosition = CGPoint(x: margin, y: pageHeight - margin - 10)
        CTLineDraw(line, ctx)

        ctx.endPDFPage()
        ctx.closePDF()
        guard let single = PDFDocument(data: data as Data), let page = single.page(at: 0) else { return nil }
        return page
    }
#endif
}

// MARK: - Fullscreen / 360

private struct PhotoFullscreenViewer: View {
    let photos: [PhotoSearchResult]
    @State var index: Int
    let apiBaseURL: URL?
    let onClose: () -> Void

    @State private var panoHTML: String?
    @State private var panoLoading = false
    @State private var panoError: String?

    private var photo: PhotoSearchResult { photos[index] }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if photo.is360 {
                if let panoHTML {
                    PhotoPannellumWebView(html: panoHTML)
                        .ignoresSafeArea()
                } else if panoLoading {
                    ProgressView("Loading 360°…")
                        .tint(.white)
                } else if let panoError {
                    VStack(spacing: 12) {
                        Text(panoError).foregroundStyle(.white)
                        flatImage
                    }
                } else {
                    flatImage
                }
            } else {
                flatImage
            }

            VStack {
                HStack {
                    Text(photo.filename)
                        .font(.caption)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Spacer()
                    Text("\(index + 1) / \(photos.count)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.white.opacity(0.8))
                    Button(action: onClose) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.white)
                    }
                    .buttonStyle(.plain)
                }
                .padding()
                Spacer()
                HStack {
                    Button {
                        navigate(-1)
                    } label: {
                        Image(systemName: "chevron.left.circle.fill")
                            .font(.largeTitle)
                            .foregroundStyle(.white.opacity(canNavigate(-1) ? 1 : 0.3))
                    }
                    .disabled(!canNavigate(-1))
                    .buttonStyle(.plain)

                    Spacer()

                    Button {
                        navigate(1)
                    } label: {
                        Image(systemName: "chevron.right.circle.fill")
                            .font(.largeTitle)
                            .foregroundStyle(.white.opacity(canNavigate(1) ? 1 : 0.3))
                    }
                    .disabled(!canNavigate(1))
                    .buttonStyle(.plain)
                }
                .padding(24)
            }
        }
        .task(id: index) {
            await loadPanoIfNeeded()
        }
    }

    @ViewBuilder
    private var flatImage: some View {
#if os(macOS)
        if let nsImage = NSImage(data: photo.imageData) {
            Image(nsImage: nsImage)
                .resizable()
                .scaledToFit()
                .padding(40)
        }
#elseif os(iOS) || os(visionOS)
        if let uiImage = UIImage(data: photo.imageData) {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFit()
                .padding(40)
        }
#endif
    }

    private func canNavigate(_ direction: Int) -> Bool {
        let next = index + direction
        return next >= 0 && next < photos.count
    }

    private func navigate(_ direction: Int) {
        let next = index + direction
        guard next >= 0, next < photos.count else { return }
        index = next
    }

    private func loadPanoIfNeeded() async {
        panoHTML = nil
        panoError = nil
        guard photo.is360 else { return }
        guard let base = apiBaseURL, let path = photo.imageURLPath, !path.isEmpty else {
            // Fall back to embedded thumbnail as a flat image.
            return
        }
        panoLoading = true
        defer { panoLoading = false }
        do {
            let data = try await PhotoSearchClient().fetchImage(baseURL: base, path: path)
            let b64 = data.base64EncodedString()
            let mime = mimeType(for: path)
            let yaw = photo.panoYaw
            let pitch = photo.panoPitch
            panoHTML = """
            <!DOCTYPE html>
            <html><head>
            <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/pannellum.css"/>
            <style>html,body,#pano{margin:0;height:100%;background:#000;}</style>
            </head><body>
            <div id="pano"></div>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/pannellum.js"></script>
            <script>
              pannellum.viewer('pano', {
                type: 'equirectangular',
                panorama: 'data:\(mime);base64,\(b64)',
                autoLoad: true,
                showControls: true,
                yaw: \(yaw),
                pitch: \(pitch),
                hfov: 100,
                hotSpots: [{ yaw: \(yaw), pitch: \(pitch), cssClass: 'pnlm-hotspot' }]
              });
            </script>
            </body></html>
            """
        } catch {
            panoError = "360 load failed — showing preview"
        }
    }

    private func mimeType(for path: String) -> String {
        let lower = path.lowercased()
        if lower.hasSuffix(".png") { return "image/png" }
        if lower.hasSuffix(".webp") { return "image/webp" }
        return "image/jpeg"
    }
}

#if os(macOS)
private struct PhotoPannellumWebView: NSViewRepresentable {
    let html: String

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let view = WKWebView(frame: .zero, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        nsView.loadHTMLString(html, baseURL: URL(string: "https://cdnjs.cloudflare.com/"))
    }
}
#else
private struct PhotoPannellumWebView: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        uiView.loadHTMLString(html, baseURL: URL(string: "https://cdnjs.cloudflare.com/"))
    }
}
#endif

#if os(iOS) || os(visionOS)
private struct PhotoShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#endif
