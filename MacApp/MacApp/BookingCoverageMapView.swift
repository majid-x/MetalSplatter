import SwiftUI
import WebKit
#if canImport(UIKit)
import UIKit
#endif

#if os(macOS)
private typealias PlatformViewRepresentable = NSViewRepresentable
#else
private typealias PlatformViewRepresentable = UIViewRepresentable
#endif

/// Leaflet + OSM coverage map (matches web `BookingCoverageMap`).
struct BookingCoverageMapCanvas: PlatformViewRepresentable {
#if os(macOS)
    func makeNSView(context: Context) -> WKWebView { makeWebView() }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
#else
    func makeUIView(context: Context) -> WKWebView { makeWebView() }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
#endif

    private func makeWebView() -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
#if os(macOS)
        webView.setValue(false, forKey: "drawsBackground")
#else
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
#endif
        webView.loadHTMLString(Self.html, baseURL: URL(string: "https://www.vroomk.com"))
        return webView
    }

    private static let html: String = {
        let lat = BookingGeo.baseLat
        let lng = BookingGeo.baseLng
        let radiusM = BookingGeo.radiusMiles * 1609.344
        let address = BookingGeo.baseLabel
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        return """
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
          <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
          <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
          <style>
            html, body, #map { margin: 0; padding: 0; width: 100%; height: 100%; background: #1a1a1a; }
            .leaflet-container { background: #1a1a1a; font: 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; }
            .leaflet-control-attribution { font-size: 10px; }
          </style>
        </head>
        <body>
          <div id="map"></div>
          <script>
            const center = [\(lat), \(lng)];
            const map = L.map("map", {
              scrollWheelZoom: false,
              zoomControl: true,
              attributionControl: true
            });
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
              maxZoom: 19,
              attribution: "&copy; OpenStreetMap"
            }).addTo(map);
            const circle = L.circle(center, {
              radius: \(radiusM),
              color: "#4285F4",
              weight: 2,
              fillColor: "#4285F4",
              fillOpacity: 0.18
            }).addTo(map);
            L.circleMarker(center, {
              radius: 7,
              color: "#ffffff",
              weight: 2,
              fillColor: "#E53935",
              fillOpacity: 1
            }).addTo(map).bindTooltip("\(address)", { direction: "top", offset: [0, -8] });
            map.fitBounds(circle.getBounds(), { padding: [12, 12], maxZoom: 9 });
          </script>
        </body>
        </html>
        """
    }()
}

/// Rate + coverage map aside (web `.bk-aside` / `.bk-rate` / `.bk-map*`).
struct BookingCoverageAside: View {
    var compactMapHeight: Bool = false

    private let border = Color(red: 0.812, green: 0.812, blue: 0.812) // #cfcfcf

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            rateBlock
            mapBlock
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.clear)
        .overlay {
            Rectangle()
                .strokeBorder(border, lineWidth: 1)
        }
    }

    private var rateBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("RATE")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(.white.opacity(0.55))
                Text(BookingGeo.rateDisplay)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.white)
            }
            Text("\(BookingGeo.advanceDisplay) advance · \(Int(BookingGeo.radiusMiles)) mi coverage")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.45))
        }
    }

    private var mapBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(BookingGeo.baseLabel)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)

            Text("\(Int(BookingGeo.radiusMiles)) mile coverage radius")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.45))

            BookingCoverageMapCanvas()
                .frame(height: compactMapHeight ? 220 : 240)
                .frame(maxWidth: .infinity)
                .clipped()
                .overlay {
                    Rectangle()
                        .strokeBorder(border, lineWidth: 1)
                }
        }
    }
}
