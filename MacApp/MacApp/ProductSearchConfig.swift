import Foundation

/// Credentials for screenshot → Cloudinary → SearchAPI Google Lens product search.
/// Fill these in before using Search Products in the client viewer.
enum ProductSearchConfig {
    static let cloudinaryCloudName = "dna3zaknx"
    static let cloudinaryUploadPreset = "vroomkplaycanvas"
    static let searchApiKey = "4ujfCpHGxFRN3Lnp49mGr8zg"

    static var isConfigured: Bool {
        cloudinaryCloudName != "YOUR_CLOUD_NAME"
            && !cloudinaryCloudName.isEmpty
            && cloudinaryUploadPreset != "YOUR_UPLOAD_PRESET"
            && !cloudinaryUploadPreset.isEmpty
            && searchApiKey != "YOUR_SEARCHAPI_KEY"
            && !searchApiKey.isEmpty
    }
}
