import Foundation
import simd

enum PhotoSearchAPI {
    static let baseURL = URL(string: "https://hakob.ngrok.app")!

    /// MetalSplatter applies a 180° Z rotation for display; undo it before querying
    /// so the API receives splat/COLMAP-aligned coordinates.
    static func apiPoint(fromDisplayWorld point: SIMD3<Float>) -> SIMD3<Float> {
        SIMD3(-point.x, -point.y, point.z)
    }
}

struct PhotoSearchResult: Identifiable, Sendable {
    let id: Int
    let filename: String
    let score: Double
    let cameraDistance: Double
    let imageData: Data
}

struct PhotoSearchClient: Sendable {
    struct QueryRequest: Encodable {
        var x: Double
        var y: Double
        var z: Double
        var max_results: Int = 6
        var include_images: Bool = true
        var camera_position: [Double]?
        var view_direction: [Double]?
    }

    private struct QueryResponse: Decodable {
        let returned: Int?
        let results: [ResultItem]?
        let images: [ResultItem]?
    }

    private struct ResultItem: Decodable {
        let image_id: Int?
        let filename: String?
        let image_name: String?
        let score: Double?
        let camera_distance: Double?
        let image_b64: String?
        let base64: String?
        let data_url: String?
        let content_type: String?
        let rank: Int?
    }

    enum ClientError: LocalizedError {
        case invalidURL
        case badStatus(Int)
        case noImages
        case decoding

        var errorDescription: String? {
            switch self {
            case .invalidURL: return "Invalid photo API URL"
            case .badStatus(let code): return "Photo API error (\(code))"
            case .noImages: return "No matching photos"
            case .decoding: return "Could not decode photo API response"
            }
        }
    }

    func search(
        displayWorldPoint: SIMD3<Float>,
        cameraPosition: SIMD3<Float>? = nil,
        viewDirection: SIMD3<Float>? = nil,
        maxResults: Int = 6
    ) async throws -> [PhotoSearchResult] {
        let point = PhotoSearchAPI.apiPoint(fromDisplayWorld: displayWorldPoint)
        let url = PhotoSearchAPI.baseURL.appendingPathComponent("query")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 60

        let body = QueryRequest(
            x: Double(point.x),
            y: Double(point.y),
            z: Double(point.z),
            max_results: maxResults,
            include_images: true,
            camera_position: cameraPosition.map { p in
                let q = PhotoSearchAPI.apiPoint(fromDisplayWorld: p)
                return [Double(q.x), Double(q.y), Double(q.z)]
            },
            view_direction: viewDirection.map { d in
                // Direction transforms like a vector under 180° Z: (-x, -y, z)
                let q = SIMD3(-d.x, -d.y, d.z)
                return [Double(q.x), Double(q.y), Double(q.z)]
            }
        )
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            throw ClientError.badStatus(status)
        }

        let decoded: QueryResponse
        do {
            decoded = try JSONDecoder().decode(QueryResponse.self, from: data)
        } catch {
            throw ClientError.decoding
        }

        let items = decoded.results ?? decoded.images ?? []
        let photos: [PhotoSearchResult] = items.compactMap { item in
            guard let imageData = Self.decodeImageData(from: item) else { return nil }
            let id = item.image_id ?? item.rank ?? imageData.hashValue
            return PhotoSearchResult(
                id: id,
                filename: item.filename ?? item.image_name ?? "image \(id)",
                score: item.score ?? 0,
                cameraDistance: item.camera_distance ?? 0,
                imageData: imageData
            )
        }

        guard !photos.isEmpty else { throw ClientError.noImages }
        return Array(photos.prefix(maxResults))
    }

    private static func decodeImageData(from item: ResultItem) -> Data? {
        if let dataURL = item.data_url, let comma = dataURL.firstIndex(of: ",") {
            let b64 = String(dataURL[dataURL.index(after: comma)...])
            if let data = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]) {
                return data
            }
        }
        if let b64 = item.image_b64 ?? item.base64,
           let data = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]) {
            return data
        }
        return nil
    }
}
