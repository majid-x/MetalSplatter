import Foundation
import AppKit

struct ProductSearchMatch: Identifiable, Equatable {
    let id: String
    let title: String
    let link: URL?
    let thumbnailURL: URL?
    let price: String?
    let source: String?
}

enum ProductSearchError: LocalizedError {
    case notConfigured
    case emptyImage
    case uploadFailed(String)
    case searchFailed(String)
    case noMatches

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Set Cloudinary + SearchAPI keys in ProductSearchConfig.swift"
        case .emptyImage:
            return "Screenshot was empty"
        case .uploadFailed(let message):
            return "Upload failed: \(message)"
        case .searchFailed(let message):
            return "Search failed: \(message)"
        case .noMatches:
            return "No visual matches found. Try a clearer object."
        }
    }
}

/// Screenshot → Cloudinary upload → SearchAPI Google Lens (products).
@MainActor
final class ProductSearchClient {
    func searchProducts(image: NSImage) async throws -> [ProductSearchMatch] {
        guard ProductSearchConfig.isConfigured else {
            throw ProductSearchError.notConfigured
        }
        guard let pngData = image.pngData(), !pngData.isEmpty else {
            throw ProductSearchError.emptyImage
        }

        let imageURL = try await uploadToCloudinary(pngData: pngData)
        return try await queryGoogleLensProducts(imageURL: imageURL)
    }

    private func uploadToCloudinary(pngData: Data) async throws -> URL {
        let cloud = ProductSearchConfig.cloudinaryCloudName
        let preset = ProductSearchConfig.cloudinaryUploadPreset
        guard let uploadURL = URL(string: "https://api.cloudinary.com/v1_1/\(cloud)/image/upload") else {
            throw ProductSearchError.uploadFailed("Invalid Cloudinary URL")
        }

        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func append(_ string: String) {
            if let data = string.data(using: .utf8) {
                body.append(data)
            }
        }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"upload_preset\"\r\n\r\n")
        append("\(preset)\r\n")

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"screenshot.png\"\r\n")
        append("Content-Type: image/png\r\n\r\n")
        body.append(pngData)
        append("\r\n")
        append("--\(boundary)--\r\n")
        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let detail = String(data: data, encoding: .utf8) ?? ""
            throw ProductSearchError.uploadFailed("HTTP \(status) \(detail)")
        }

        guard
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let urlString = json["secure_url"] as? String,
            let url = URL(string: urlString)
        else {
            throw ProductSearchError.uploadFailed("No Cloudinary secure_url returned")
        }
        return url
    }

    private func queryGoogleLensProducts(imageURL: URL) async throws -> [ProductSearchMatch] {
        var components = URLComponents(string: "https://www.searchapi.io/api/v1/search")!
        components.queryItems = [
            URLQueryItem(name: "engine", value: "google_lens"),
            URLQueryItem(name: "url", value: imageURL.absoluteString),
            URLQueryItem(name: "search_type", value: "products"),
        ]
        guard let apiURL = components.url else {
            throw ProductSearchError.searchFailed("Invalid SearchAPI URL")
        }

        var request = URLRequest(url: apiURL)
        request.httpMethod = "GET"
        request.setValue("Bearer \(ProductSearchConfig.searchApiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let detail = String(data: data, encoding: .utf8) ?? ""
            throw ProductSearchError.searchFailed("HTTP \(status) \(detail)")
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProductSearchError.searchFailed("Invalid JSON")
        }

        let rawMatches = (json["visual_matches"] as? [[String: Any]])
            ?? (json["product_results"] as? [[String: Any]])
            ?? []

        let matches: [ProductSearchMatch] = rawMatches.enumerated().compactMap { index, item in
            let title = (item["title"] as? String)
                ?? (item["name"] as? String)
                ?? "Untitled result"
            let linkString = (item["link"] as? String)
                ?? (item["source_link"] as? String)
                ?? (item["url"] as? String)
            let thumbString = (item["thumbnail"] as? String)
                ?? (item["thumbnail_url"] as? String)
                ?? ((item["image"] as? [String: Any])?["link"] as? String)
                ?? (item["image"] as? String)
            let price = item["price"] as? String
                ?? ((item["price"] as? [String: Any])?["value"] as? String)
            let source = item["source"] as? String

            return ProductSearchMatch(
                id: "\(index)-\(title)",
                title: title,
                link: linkString.flatMap(URL.init(string:)),
                thumbnailURL: thumbString.flatMap(URL.init(string:)),
                price: price,
                source: source
            )
        }

        guard !matches.isEmpty else {
            throw ProductSearchError.noMatches
        }
        return matches
    }
}

extension NSImage {
    func pngData() -> Data? {
        guard let tiff = tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    func cropped(to rectInPoints: CGRect, fromViewSize viewSize: CGSize) -> NSImage? {
        guard let cgImage = self.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }

        // SwiftUI selection rects and CGImage both use top-left origin.
        let scaleX = CGFloat(cgImage.width) / max(viewSize.width, 1)
        let scaleY = CGFloat(cgImage.height) / max(viewSize.height, 1)

        var crop = CGRect(
            x: rectInPoints.minX * scaleX,
            y: rectInPoints.minY * scaleY,
            width: rectInPoints.width * scaleX,
            height: rectInPoints.height * scaleY
        ).integral

        crop = crop.intersection(CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
        guard crop.width >= 2, crop.height >= 2,
              let cropped = cgImage.cropping(to: crop) else { return nil }

        return NSImage(cgImage: cropped, size: NSSize(width: crop.width, height: crop.height))
    }
}
