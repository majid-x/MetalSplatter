import SwiftUI

struct PrivacyPolicyView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(AppLegal.privacyPolicyTitle)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.white)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 18)

            Divider().overlay(.white.opacity(0.08))

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Last updated \(AppLegal.privacyPolicyLastUpdated)")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.4))

                    Text(AppLegal.privacyPolicyBody)
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.78))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Link("Open web version", destination: AppLegal.privacyPolicyURL)
                        .font(.system(size: 13, weight: .medium))
                        .padding(.top, 8)
                }
                .padding(24)
            }
        }
        .frame(minWidth: 520, minHeight: 560)
        .background(Color.black)
        .preferredColorScheme(.dark)
    }
}

#Preview {
    PrivacyPolicyView()
}
