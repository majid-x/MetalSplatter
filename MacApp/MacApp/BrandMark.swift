import SwiftUI

struct BrandMark: View {
    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let maxR = min(size.width, size.height) / 2

            for i in 1...5 {
                let r = maxR * CGFloat(i) / 5
                var path = Path()
                path.addEllipse(in: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
                context.stroke(path, with: .color(.white.opacity(0.55)), lineWidth: 0.7)
            }

            for i in 0..<16 {
                let angle = Double(i) / 16 * .pi * 2
                var tick = Path()
                let inner = maxR * 0.35
                let outer = maxR * 0.92
                tick.move(to: CGPoint(
                    x: center.x + CGFloat(cos(angle)) * inner,
                    y: center.y + CGFloat(sin(angle)) * inner
                ))
                tick.addLine(to: CGPoint(
                    x: center.x + CGFloat(cos(angle)) * outer,
                    y: center.y + CGFloat(sin(angle)) * outer
                ))
                context.stroke(tick, with: .color(.white.opacity(0.28)), lineWidth: 0.5)
            }

            var spiral = Path()
            let turns = 2.2
            let steps = 80
            for s in 0...steps {
                let t = Double(s) / Double(steps)
                let angle = t * turns * .pi * 2 - .pi / 2
                let r = maxR * 0.12 + maxR * 0.78 * t
                let point = CGPoint(
                    x: center.x + CGFloat(cos(angle)) * r,
                    y: center.y + CGFloat(sin(angle)) * r
                )
                if s == 0 { spiral.move(to: point) } else { spiral.addLine(to: point) }
            }
            context.stroke(spiral, with: .color(.white.opacity(0.45)), lineWidth: 0.7)
        }
        .accessibilityHidden(true)
    }
}
