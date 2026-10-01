import Foundation
import simd

enum PhotoSearchAPI {
    /// MetalSplatter applies a 180° Z rotation for display; undo it before querying
    /// so the API receives splat/COLMAP-aligned coordinates.
    static func apiPoint(fromDisplayWorld point: SIMD3<Float>) -> SIMD3<Float> {
        SIMD3(-point.x, -point.y, point.z)
    }

    /// Direction transforms like a vector under 180° Z: (-x, -y, z).
    static func apiDirection(fromDisplayWorld direction: SIMD3<Float>) -> SIMD3<Float> {
        SIMD3(-direction.x, -direction.y, direction.z)
    }

    static let defaultMaxResults = 6
}

struct PhotoSearchResult: Identifiable, Sendable, Hashable {
    let id: Int
    let filename: String
    let score: Double
    let cameraDistance: Double
    let imageData: Data
    let rank: Int?
    let is360: Bool
    let imageURLPath: String?
    let panoYaw: Double
    let panoPitch: Double
}

struct PhotoSearchResponse: Sendable {
    let photos: [PhotoSearchResult]
    let hasMore: Bool
}

struct PhotoSearchClient: Sendable {
    struct QueryRequest: Encodable {
        var x: Double
        var y: Double
        var z: Double
        var max_results: Int = PhotoSearchAPI.defaultMaxResults
        var include_images: Bool = true
        var camera_position: [Double]?
        var view_direction: [Double]?
    }

    private struct QueryResponse: Decodable {
        let returned: Int?
        let has_more: Bool?
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
        let is_360: Bool?
        let image_url: String?
        let pano_yaw: Double?
        let pano_pitch: Double?
    }

    enum ClientError: LocalizedError {
        case invalidURL
        case missingAPIBaseURL
        case badStatus(Int)
        case noImages
        case decoding

        var errorDescription: String? {
            switch self {
            case .invalidURL: return "Invalid photo API URL"
            case .missingAPIBaseURL: return "This project has no photo search API"
            case .badStatus(let code): return "Photo API error (\(code))"
            case .noImages: return "No matching photos"
            case .decoding: return "Could not decode photo API response"
            }
        }
    }

    func search(
        baseURL: URL,
        displayWorldPoint: SIMD3<Float>,
        cameraPosition: SIMD3<Float>? = nil,
        /// Direction from camera toward the clicked point (PlayCanvas semantics).
        viewDirection: SIMD3<Float>? = nil,
        maxResults: Int = PhotoSearchAPI.defaultMaxResults,
        /// SPZ scenes are often inverted vs PLY — skip the usual display→API 180° Z undo.
        useSPZCoordinates: Bool = false,
        /// PlayCanvas `useServerCalibration`: send raw display coords; server maps to COLMAP.
        useServerCalibration: Bool = false
    ) async throws -> PhotoSearchResponse {
        // Either flag means "don't apply the client PLY COLMAP estimate" — send display/raw coords.
        let sendRaw = useSPZCoordinates || useServerCalibration
        let toAPIPoint: (SIMD3<Float>) -> SIMD3<Float> = { point in
            sendRaw ? point : PhotoSearchAPI.apiPoint(fromDisplayWorld: point)
        }
        let toAPIDirection: (SIMD3<Float>) -> SIMD3<Float> = { direction in
            sendRaw ? direction : PhotoSearchAPI.apiDirection(fromDisplayWorld: direction)
        }

        let point = toAPIPoint(displayWorldPoint)
        let url = baseURL.appendingPathComponent("query")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
        request.timeoutInterval = 60

        var body = QueryRequest(
            x: Double(point.x),
            y: Double(point.y),
            z: Double(point.z),
            max_results: maxResults,
            include_images: true
        )

        if let viewDirection {
            let dir = toAPIDirection(viewDirection)
            let len = simd_length(dir)
            if len > 1e-6 {
                let n = dir / len
                body.view_direction = [Double(n.x), Double(n.y), Double(n.z)]
            }
        }
        if let cameraPosition {
            let cam = toAPIPoint(cameraPosition)
            body.camera_position = [Double(cam.x), Double(cam.y), Double(cam.z)]
        }

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
        let photos: [PhotoSearchResult] = items.enumerated().compactMap { index, item in
            guard let imageData = Self.decodeImageData(from: item) else { return nil }
            let id = item.image_id ?? item.rank ?? index
            return PhotoSearchResult(
                id: id,
                filename: item.filename ?? item.image_name ?? "image \(id)",
                score: item.score ?? 0,
                cameraDistance: item.camera_distance ?? 0,
                imageData: imageData,
                rank: item.rank,
                is360: item.is_360 ?? false,
                imageURLPath: item.image_url,
                panoYaw: item.pano_yaw ?? 0,
                panoPitch: item.pano_pitch ?? 0
            )
        }

        guard !photos.isEmpty else { throw ClientError.noImages }
        return PhotoSearchResponse(photos: photos, hasMore: decoded.has_more ?? false)
    }

    /// Fetch a full-resolution panorama (or any image) relative to the API base.
    func fetchImage(baseURL: URL, path: String) async throws -> Data {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let url: URL
        if let absolute = URL(string: path), absolute.scheme != nil {
            url = absolute
        } else {
            url = baseURL.appendingPathComponent(trimmed)
        }
        var request = URLRequest(url: url)
        request.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
        request.timeoutInterval = 120
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            throw ClientError.badStatus(status)
        }
        return data
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
