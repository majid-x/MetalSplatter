import { BookingGeo, type BookingPlace } from './models'

/**
 * Coverage map via OpenStreetMap embed (same role as Mac MapKit).
 * Avoids Leaflet/React Strict Mode crashes that blacked out the Booking tab.
 */
export function CoverageMap({
  selectedPlace,
  height = 240
}: {
  selectedPlace?: BookingPlace | null
  height?: number
}) {
  const centerLat = selectedPlace?.lat ?? BookingGeo.baseLat
  const centerLng = selectedPlace?.lng ?? BookingGeo.baseLng
  // ~60 mi ≈ 0.87° latitude; pad a bit so the radius reads clearly.
  const pad = 1.05
  const minLng = BookingGeo.baseLng - pad
  const minLat = BookingGeo.baseLat - pad
  const maxLng = BookingGeo.baseLng + pad
  const maxLat = BookingGeo.baseLat + pad

  const markerLat = selectedPlace?.lat ?? BookingGeo.baseLat
  const markerLng = selectedPlace?.lng ?? BookingGeo.baseLng

  const src =
    `https://www.openstreetmap.org/export/embed.html?` +
    `bbox=${minLng}%2C${minLat}%2C${maxLng}%2C${maxLat}` +
    `&layer=mapnik` +
    `&marker=${markerLat}%2C${markerLng}`

  return (
    <div className="coverage-map" style={{ height }}>
      <iframe
        className="coverage-map-frame"
        title="Vroomk coverage map"
        src={src}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
      <div className="coverage-map-overlay" aria-hidden>
        <span className="coverage-map-chip">
          {BookingGeo.radiusMiles} mi from office
          {selectedPlace ? ` · pin at selected address` : ''}
        </span>
        {/* Approximate radius ring drawn over the embed */}
        <div
          className="coverage-radius-ring"
          style={
            selectedPlace
              ? {
                  // Keep ring centered on office even when marker moves.
                  // Embed recenters on selection slightly; ring stays visual-only.
                  left: `${50 + ((BookingGeo.baseLng - centerLng) / (pad * 2)) * 100}%`,
                  top: `${50 - ((BookingGeo.baseLat - centerLat) / (pad * 2)) * 100}%`
                }
              : undefined
          }
        />
      </div>
    </div>
  )
}

export function BookingCoverageAside({
  selectedPlace
}: {
  selectedPlace?: BookingPlace | null
}) {
  return (
    <section className="coverage-aside">
      <div className="coverage-rate">
        <div className="coverage-rate-row">
          <span className="coverage-rate-label">RATE</span>
          <span className="coverage-rate-value">{BookingGeo.rateDisplay}</span>
        </div>
        <p>
          {BookingGeo.advanceDisplay} deposit · {BookingGeo.radiusMiles} mi coverage
        </p>
      </div>
      <div className="coverage-map-block">
        <strong>{BookingGeo.baseLabel}</strong>
        <p>{BookingGeo.radiusMiles} mile coverage radius</p>
        <CoverageMap selectedPlace={selectedPlace} />
      </div>
    </section>
  )
}
