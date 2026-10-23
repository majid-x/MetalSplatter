import MapKit
import SwiftUI

/// Native coverage map: base office + 60 mi radius.
struct BookingCoverageMapCanvas: View {
    private var center: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: BookingGeo.baseLat, longitude: BookingGeo.baseLng)
    }

    private var radiusMeters: CLLocationDistance {
        BookingGeo.radiusMiles * 1609.344
    }

    private var region: MKCoordinateRegion {
        MKCoordinateRegion(
            center: center,
            latitudinalMeters: radiusMeters * 2.35,
            longitudinalMeters: radiusMeters * 2.35
        )
    }

    var body: some View {
        Map(initialPosition: .region(region), interactionModes: [.pan, .zoom]) {
            MapCircle(center: center, radius: radiusMeters)
                .foregroundStyle(Color(red: 0.26, green: 0.52, blue: 0.96).opacity(0.18))
                .stroke(Color(red: 0.26, green: 0.52, blue: 0.96), lineWidth: 2)

            Annotation(BookingGeo.baseLabel, coordinate: center, anchor: .center) {
                ZStack {
                    Circle()
                        .fill(Color(red: 0.90, green: 0.22, blue: 0.21))
                        .frame(width: 14, height: 14)
                    Circle()
                        .strokeBorder(.white, lineWidth: 2)
                        .frame(width: 14, height: 14)
                }
            }
        }
        .mapStyle(.standard(elevation: .flat))
    }
}

/// Rate + coverage map block under the location form.
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
            Text("\(BookingGeo.advanceDisplay) deposit · \(Int(BookingGeo.radiusMiles)) mi coverage")
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
