import Foundation

enum ModelIdentifier: Equatable, Hashable, Codable, CustomStringConvertible {
    case gaussianSplat(URL, navigation: SceneNavigationData? = nil)
    case proceduralSplat
    case sampleBox

    var description: String {
        switch self {
        case .gaussianSplat(let url, _):
            "Gaussian Splat: \(url.lastPathComponent)"
        case .proceduralSplat:
            "Procedural Splat"
        case .sampleBox:
            "Sample Box"
        }
    }

    var navigation: SceneNavigationData? {
        if case .gaussianSplat(_, let navigation) = self {
            return navigation
        }
        return nil
    }
}
