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

    /// Matches PlayCanvas `SplatClickQuery` attribute defaults.
    static let defaultMaxResults = 6
    static let defaultCenterThreshold = 0.3
    static let defaultMaxViewAngle = 55.0
    static let viewFilterEnabledByDefault = true
    static let defaultAddMarker = false
    static let defaultOffset = 0
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
    /// Mirrors PlayCanvas `SplatClickQuery._callAPI` payload.
    struct QueryRequest: Encodable {
        var x: Double
        var y: Double
        var z: Double
        var max_results: Int
        var center_threshold: Double
        var include_images: Bool
        var add_marker: Bool
        var offset: Int
        var camera_position: [Double]?
        var view_direction: [Double]?
        var max_view_angle: Double?
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
        maxResults: Int = PhotoSearchAPI.defaultMaxResults,
        /// Inverted vs original: off = send display as-is; on = apply 180° Z undo.
        useSPZCoordinates: Bool = false,
        /// PlayCanvas `useServerCalibration`: always send raw display coords.
        useServerCalibration: Bool = false,
        /// PlayCanvas `viewFilterEnabled` (default true).
        viewFilterEnabled: Bool = PhotoSearchAPI.viewFilterEnabledByDefault,
        /// PlayCanvas `centerThreshold` (default 0.3).
        centerThreshold: Double = PhotoSearchAPI.defaultCenterThreshold,
        /// PlayCanvas `maxViewAngle` degrees (default 55).
        maxViewAngle: Double = PhotoSearchAPI.defaultMaxViewAngle,
        /// PlayCanvas Ctrl+P marker overlay (default off).
        addMarker: Bool = PhotoSearchAPI.defaultAddMarker
    ) async throws -> PhotoSearchResponse {
        // PlayCanvas: useRaw = useServerCalibration → raw world.
        // Mac SPZ path: when not using server calibration and SPZ is on, undo 180° Z.
        let sendRaw = useServerCalibration || !useSPZCoordinates
        let toAPIPoint: (SIMD3<Float>) -> SIMD3<Float> = { point in
            sendRaw ? point : PhotoSearchAPI.apiPoint(fromDisplayWorld: point)
        }

        let point = toAPIPoint(displayWorldPoint)
        let url = baseURL.appendingPathComponent("query")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
        request.timeoutInterval = 60

        // PlayCanvas payload keys (exact).
        var body = QueryRequest(
            x: Double(point.x),
            y: Double(point.y),
            z: Double(point.z),
            max_results: maxResults,
            center_threshold: centerThreshold,
            include_images: true,
            add_marker: addMarker,
            offset: PhotoSearchAPI.defaultOffset
        )

        // PlayCanvas: view filter attaches view_direction + max_view_angle, and
        // camera_position when available. Direction is computed in the SAME frame
        // as the sent point: normalize(sendPoint − camera).
        if viewFilterEnabled, let cameraPosition {
            let cam = toAPIPoint(cameraPosition)
            let delta = point - cam
            let len = simd_length(delta)
            if len > 1e-6 {
                let n = delta / len
                body.view_direction = [Double(n.x), Double(n.y), Double(n.z)]
                body.max_view_angle = maxViewAngle
                body.camera_position = [Double(cam.x), Double(cam.y), Double(cam.z)]
            }
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

        // PlayCanvas `_showResults`: prefer `data.images` only; keep `results` as fallback.
        let items = decoded.images ?? decoded.results ?? []
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
        // Keep API order — PlayCanvas does not client-side re-rank.
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
