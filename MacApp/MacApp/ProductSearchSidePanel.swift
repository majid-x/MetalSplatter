import SwiftUI

struct ProductSearchSidePanel: View {
    let matches: [ProductSearchMatch]
    let isLoading: Bool
    let statusText: String
    let onClose: () -> Void

    @Environment(\.openURL) private var openURL

    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Visual Matches")
                        .font(.system(size: 16, weight: .heavy))
                        .foregroundStyle(.white)
                    Text("Similar results from screenshot")
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.42))
                }

                Spacer(minLength: 8)

                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white.opacity(0.85))
                        .frame(width: 30, height: 30)
                        .background(Color.white.opacity(0.1), in: Circle())
                        .overlay {
                            Circle()
                                .strokeBorder(.white.opacity(0.12), lineWidth: 1)
                        }
                }
                .buttonStyle(.plain)
                .help("Close")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .background(Color(red: 0.075, green: 0.086, blue: 0.118))

            if isLoading {
                VStack(spacing: 12) {
                    ProgressView()
                        .controlSize(.regular)
                    Text(statusText)
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.45))
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
            } else if matches.isEmpty {
                Text(statusText)
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.45))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(20)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 16) {
                        ForEach(matches) { match in
                            ProductMatchCard(match: match, openURL: openURL)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                }
            }
        }
        .frame(width: 340)
        .frame(maxHeight: .infinity)
        .background(Color(red: 0.051, green: 0.059, blue: 0.078))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(.white.opacity(0.1))
                .frame(width: 1)
        }
    }
}

private struct ProductMatchCard: View {
    let match: ProductSearchMatch
    let openURL: OpenURLAction

    var body: some View {
        Button {
            if let link = match.link {
                openURL(link)
            }
        } label: {
            VStack(spacing: 8) {
                AsyncImage(url: match.thumbnailURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    case .failure:
                        placeholder
                    case .empty:
                        ProgressView()
                    @unknown default:
                        placeholder
                    }
                }
                .frame(maxWidth: .infinity)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay {
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(.white.opacity(0.08), lineWidth: 1)
                }
                .background(Color(red: 0.067, green: 0.094, blue: 0.153), in: RoundedRectangle(cornerRadius: 14))

                Text(match.title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.88))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)

                if let price = match.price, !price.isEmpty {
                    Text(price)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Color(red: 0.36, green: 0.64, blue: 1.0))
                } else if let source = match.source {
                    Text(source)
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.35))
                        .lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var placeholder: some View {
        ZStack {
            Color(red: 0.067, green: 0.094, blue: 0.153)
            Image(systemName: "photo")
                .font(.title2)
                .foregroundStyle(.white.opacity(0.25))
        }
    }
}
