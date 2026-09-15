import SwiftUI

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

struct PhotoSearchSidePanel: View {
    let photos: [PhotoSearchResult]
    let isLoading: Bool
    let statusText: String
    let onClose: () -> Void

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

            if isLoading {
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
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(photos) { photo in
                            VStack(alignment: .leading, spacing: 6) {
                                photoImage(photo)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(maxWidth: .infinity)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))

                                Text(photo.filename)
                                    .font(.caption2)
                                    .lineLimit(2)
                                    .foregroundStyle(.secondary)

                                Text(String(format: "score %.2f · dist %.2f", photo.score, photo.cameraDistance))
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .padding(14)
        .frame(width: 280)
        .frame(maxHeight: .infinity)
        .background(.ultraThinMaterial)
    }

#if os(macOS)
    private func photoImage(_ photo: PhotoSearchResult) -> Image {
        if let nsImage = NSImage(data: photo.imageData) {
            return Image(nsImage: nsImage)
        }
        return Image(systemName: "photo")
    }
#elseif os(iOS)
    private func photoImage(_ photo: PhotoSearchResult) -> Image {
        if let uiImage = UIImage(data: photo.imageData) {
            return Image(uiImage: uiImage)
        }
        return Image(systemName: "photo")
    }
#endif
}
