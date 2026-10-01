import Foundation

/// Row from the Supabase `projects` table.
struct RemoteProject: Identifiable, Hashable, Sendable {
    let id: UUID
    let userId: UUID
    let name: String
    let remoteURL: URL
    /// Base URL for Point Click photo search (e.g. `https://hakob.ngrok.app`). Nil = tool hidden.
    let photoAPIBaseURL: URL?
    /// When true, photo search skips the PLY 180° Z undo (SPZ scenes are often inverted).
    let isSPZ: Bool
    /// When true, send raw display coords and let the photo API apply server calibration (PlayCanvas `useServerCalibration`).
    let useServerCalibration: Bool
    /// Scale factor for Measure tool: `displayMeters = rawMeters * measureFactor` (Supabase `measur_factor`).
    let measureFactor: Float
    let createdAt: Date?

    var categoryLabel: String {
        if let createdAt {
            createdAt.formatted(date: .abbreviated, time: .omitted)
        } else {
            "Project"
        }
    }

    var supportsPhotoSearch: Bool { photoAPIBaseURL != nil }
}

extension RemoteProject: Decodable {
    enum CodingKeys: String, CodingKey {
        case id
        case uuid
        case userId = "user_id"
        case projectName = "project_name"
        case projectURL = "project_url"
        case photoAPI = "photo_api"
        case spz
        case calibration
        case measurFactor = "measur_factor"
        case createdAt = "created_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        if let value = try container.decodeIfPresent(UUID.self, forKey: .id) {
            id = value
        } else if let value = try container.decodeIfPresent(UUID.self, forKey: .uuid) {
            id = value
        } else if let raw = try container.decodeIfPresent(String.self, forKey: .id),
                  let value = UUID(uuidString: raw) {
            id = value
        } else if let raw = try container.decodeIfPresent(String.self, forKey: .uuid),
                  let value = UUID(uuidString: raw) {
            id = value
        } else {
            throw DecodingError.keyNotFound(
                CodingKeys.id,
                .init(codingPath: container.codingPath, debugDescription: "Missing project id/uuid")
            )
        }

        if let value = try container.decodeIfPresent(UUID.self, forKey: .userId) {
            userId = value
        } else if let raw = try container.decodeIfPresent(String.self, forKey: .userId),
                  let value = UUID(uuidString: raw) {
            userId = value
        } else {
            throw DecodingError.dataCorruptedError(
                forKey: .userId,
                in: container,
                debugDescription: "Invalid user_id"
            )
        }

        name = try container.decode(String.self, forKey: .projectName)
        let urlString = try container.decode(String.self, forKey: .projectURL)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: urlString) else {
            throw DecodingError.dataCorruptedError(
                forKey: .projectURL,
                in: container,
                debugDescription: "Invalid project_url: \(urlString)"
            )
        }
        remoteURL = url

        if let raw = try container.decodeIfPresent(String.self, forKey: .photoAPI)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !raw.isEmpty,
           let photoURL = URL(string: raw),
           let scheme = photoURL.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            photoAPIBaseURL = photoURL
        } else {
            photoAPIBaseURL = nil
        }

        // NULL / missing / false → false; only explicit true enables these modes.
        isSPZ = (try container.decodeIfPresent(Bool.self, forKey: .spz)) ?? false
        useServerCalibration = (try container.decodeIfPresent(Bool.self, forKey: .calibration)) ?? false
        // NULL / missing / non-positive → 1.0 (uncalibrated).
        if let value = try container.decodeIfPresent(Double.self, forKey: .measurFactor), value > 0 {
            measureFactor = Float(value)
        } else if let value = try container.decodeIfPresent(Float.self, forKey: .measurFactor), value > 0 {
            measureFactor = value
        } else {
            measureFactor = 1.0
        }

        createdAt = Self.decodeDate(from: container)
    }

    private static func decodeDate(from container: KeyedDecodingContainer<CodingKeys>) -> Date? {
        if let date = try? container.decodeIfPresent(Date.self, forKey: .createdAt) {
            return date
        }
        guard let raw = try? container.decodeIfPresent(String.self, forKey: .createdAt) else {
            return nil
        }
        let isoFractional = ISO8601DateFormatter()
        isoFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = isoFractional.date(from: raw) { return date }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        if let date = iso.date(from: raw) { return date }
        // Postgres style: "2026-09-30 07:41:53+00"
        let postgres = DateFormatter()
        postgres.locale = Locale(identifier: "en_US_POSIX")
        postgres.dateFormat = "yyyy-MM-dd HH:mm:ssxxxxx"
        return postgres.date(from: raw)
    }
}
