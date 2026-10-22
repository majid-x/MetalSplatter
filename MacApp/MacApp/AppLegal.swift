import Foundation

enum AppLegal {
    /// Public privacy policy URL for App Store Connect. Host the same text as `privacyPolicyBody` here.
    static let privacyPolicyURL = URL(string: "https://vroomk.com/privacy")!

    static let supportEmail = "contactvroomk@gmail.com"

    static let privacyPolicyTitle = "Privacy Policy"

    static let privacyPolicyLastUpdated = "October 7, 2026"

    static let privacyPolicyBody = """
    Vroomk (“we”, “us”, or “our”) provides a spatial design viewer for exploring 3D projects. This Privacy Policy explains what information we collect, how we use it, and the choices you have.

    1. Information we collect
    • Account information: name, email address, and password (stored securely by our authentication provider).
    • Project metadata: project names, download URLs, and related settings linked to your account.
    • App usage data needed to operate the product (for example, download progress stored on your device).
    • When you use Search Products, a screenshot you select may be uploaded to our image and visual-search providers so we can return product matches.

    2. How we use information
    • To create and manage your account
    • To sync and download your projects
    • To provide product search and related features you request
    • To secure the service and prevent abuse
    • To communicate about account or service issues

    3. Third-party services
    We use service providers to run Vroomk, including authentication/database hosting (Supabase) and, when you use Search Products, image hosting (Cloudinary) and visual search (SearchAPI). These providers process data only to deliver the features you use.

    4. Data stored on your device
    Downloaded project packages and a local session token may be stored in the app’s private container on your device so you can stay signed in and work offline. You can remove local project downloads from the Projects screen. Signing out or deleting your account clears the local session.

    5. Sharing
    We do not sell your personal information. We share data with service providers only as needed to operate Vroomk, or when required by law.

    6. Retention
    We keep account and project data while your account is active. If you delete your account, we delete your authentication record and associated project metadata we control. Local downloads on your device are removed when you delete the account from this app. Backups may persist for a limited period before permanent erasure.

    7. Your choices
    • Update your name, email, or password in Settings
    • Sign out at any time
    • Delete your account in Settings → Delete Account (this permanently removes your account and associated project data we control)
    • Contact us to request access or correction where applicable

    8. Children
    Vroomk is not directed to children under 13, and we do not knowingly collect personal information from children under 13.

    9. International transfers
    Your information may be processed in countries where our providers operate. We use providers that implement appropriate safeguards for such transfers.

    10. Changes
    We may update this Privacy Policy from time to time. The “Last updated” date at the top will change when we do. Continued use of Vroomk after an update means you accept the revised policy.

    11. Contact
    Questions about privacy: \(supportEmail)
    """
}
