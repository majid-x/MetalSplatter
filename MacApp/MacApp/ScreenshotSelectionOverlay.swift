import SwiftUI

/// Darkened drag-to-select overlay for screenshot product search.
struct ScreenshotSelectionOverlay: View {
    var onComplete: (CGRect) -> Void
    var onCancel: () -> Void

    @State private var startPoint: CGPoint?
    @State private var currentPoint: CGPoint?

    private var selectionRect: CGRect? {
        guard let startPoint, let currentPoint else { return nil }
        let x = min(startPoint.x, currentPoint.x)
        let y = min(startPoint.y, currentPoint.y)
        let w = abs(currentPoint.x - startPoint.x)
        let h = abs(currentPoint.y - startPoint.y)
        return CGRect(x: x, y: y, width: w, height: h)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black.opacity(0.01)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                if startPoint == nil {
                                    startPoint = value.startLocation
                                }
                                currentPoint = value.location
                            }
                            .onEnded { value in
                                let end = value.location
                                let start = startPoint ?? value.startLocation
                                let rect = CGRect(
                                    x: min(start.x, end.x),
                                    y: min(start.y, end.y),
                                    width: abs(end.x - start.x),
                                    height: abs(end.y - start.y)
                                )
                                startPoint = nil
                                currentPoint = nil
                                if rect.width >= 8, rect.height >= 8 {
                                    onComplete(rect)
                                } else {
                                    onCancel()
                                }
                            }
                    )

                if let rect = selectionRect {
                    // Dim everything outside the selection.
                    Canvas { context, size in
                        let full = Path(CGRect(origin: .zero, size: size))
                        let hole = Path(rect)
                        context.fill(
                            full,
                            with: .color(.black.opacity(0.52))
                        )
                        context.blendMode = .destinationOut
                        context.fill(hole, with: .color(.white))
                    }
                    .compositingGroup()
                    .allowsHitTesting(false)

                    Rectangle()
                        .strokeBorder(Color(red: 0.18, green: 0.48, blue: 1.0), lineWidth: 2)
                        .frame(width: rect.width, height: rect.height)
                        .position(x: rect.midX, y: rect.midY)
                        .allowsHitTesting(false)

                    Text("\(Int(rect.width)) × \(Int(rect.height))")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Color(red: 0.36, green: 0.64, blue: 1.0))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(red: 0.051, green: 0.059, blue: 0.078).opacity(0.95), in: RoundedRectangle(cornerRadius: 5))
                        .position(
                            x: rect.minX + 40,
                            y: min(rect.maxY + 16, geo.size.height - 16)
                        )
                        .allowsHitTesting(false)
                } else {
                    Color.black.opacity(0.35)
                        .allowsHitTesting(false)
                }

                VStack {
                    Spacer()
                    Text("Drag to select screenshot area · Esc to cancel")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.75))
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(Color(red: 0.051, green: 0.059, blue: 0.078).opacity(0.95), in: Capsule())
                        .padding(.bottom, 28)
                }
                .allowsHitTesting(false)
            }
        }
        .focusable()
        .onKeyPress(.escape) {
            onCancel()
            return .handled
        }
    }
}
