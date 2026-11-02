import { useAuth } from '../auth/AuthContext'
import { bookingApi } from '../booking/api'
import { BookingCoverageAside } from '../booking/CoverageMap'
import { PaymentFrame } from '../booking/PaymentFrame'
import {
  BOOKING_PROGRESS_LABELS,
  BookingDraftSession,
  BookingGeo,
  BookingSlots,
  SCAN_SCOPES,
  bookingProgressIndex,
  locationGateMessage,
  placeIsUS,
  scanScopeLabel,
  type BookingCoverage,
  type BookingLocationGate,
  type BookingPlace,
  type BookingScanScope,
  type BookingStep
} from '../booking/models'
import { isValidEmail } from '../auth/validation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function isValidEmailLocal(value: string): boolean {
  return isValidEmail(value)
}

export function BookingPane() {
  const auth = useAuth()
  const [step, setStep] = useState<BookingStep>('location')
  const [addressQuery, setAddressQuery] = useState('')
  const [suggestions, setSuggestions] = useState<BookingPlace[]>([])
  const [locationGate, setLocationGate] = useState<BookingLocationGate>('idle')
  const [selectedPlace, setSelectedPlace] = useState<BookingPlace | null>(null)
  const [coverage, setCoverage] = useState<BookingCoverage | null>(null)
  const [scanScope, setScanScope] = useState<BookingScanScope>('entire_house')
  const [selectedDate, setSelectedDate] = useState(
    BookingSlots.minSelectableDateString(true)
  )
  const [selectedTime24, setSelectedTime24] = useState<string | null>(null)
  const [bookedTimes, setBookedTimes] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null)
  const [paymentClientSecret, setPaymentClientSecret] = useState<string | null>(null)
  const [calendarLink, setCalendarLink] = useState<string | null>(null)
  const [serverDraftId, setServerDraftId] = useState<string | null>(BookingDraftSession.serverId)
  const [isBusy, setIsBusy] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [isLoadingSlots, setIsLoadingSlots] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const geocodeTimer = useRef<number | null>(null)
  const draftTimer = useRef<number | null>(null)

  const phoneDigits = phone.replace(/\D/g, '')
  const contactValid =
    name.trim().length > 0 && isValidEmailLocal(email) && phoneDigits.length >= 10
  const canContinueLocation = locationGate === 'ok' && selectedPlace != null && coverage != null
  const availableTimes = BookingSlots.allTimes24h.filter((time) => !bookedTimes.has(time))

  const canAdvance = useMemo(() => {
    switch (step) {
      case 'location':
        return canContinueLocation
      case 'scan':
        return true
      case 'schedule':
        return selectedTime24 != null
      case 'contact':
        return contactValid
      default:
        return false
    }
  }, [step, canContinueLocation, selectedTime24, contactValid])

  useEffect(() => {
    void BookingDraftSession.localId()
    if (!name) setName(auth.fullName ?? '')
    if (!email) setEmail(auth.email ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persistDraft = useCallback(
    async (paymentStatus?: string) => {
      const hasLocation = selectedPlace != null
      const markingPaid = paymentStatus === 'paid'
      if (!hasLocation && !markingPaid) return

      const draftEmail =
        email.trim().toLowerCase() || auth.email?.trim().toLowerCase() || undefined

      const body: Record<string, unknown> = {
        id: serverDraftId ?? BookingDraftSession.localId(),
        email: draftEmail,
        scanScope,
        house_coverage: scanScope,
        date: selectedDate,
        payment_status: paymentStatus ?? 'pending'
      }
      if (name.trim()) body.name = name.trim()
      if (phone.trim()) body.phone = phone.trim()
      if (selectedPlace) {
        body.address = selectedPlace.label
        body.location = selectedPlace.label
        body.lat = selectedPlace.lat
        body.lng = selectedPlace.lng
      }
      if (coverage) {
        body.inCoverage = coverage.inCoverage
        body.distanceKm = coverage.distanceKm
      }
      if (selectedTime24) body.time = selectedTime24
      if (paymentIntentId) body.paymentIntentId = paymentIntentId

      try {
        const response = await bookingApi.saveBookingDraft(body)
        const nextId = response.data?.[0]?.id
        if (nextId) {
          BookingDraftSession.serverId = nextId
          setServerDraftId(nextId)
        }
      } catch {
        // Draft save is best-effort.
      }
    },
    [
      selectedPlace,
      email,
      auth.email,
      serverDraftId,
      scanScope,
      selectedDate,
      name,
      phone,
      coverage,
      selectedTime24,
      paymentIntentId
    ]
  )

  const scheduleDraftSave = useCallback(
    (immediate = false) => {
      if (draftTimer.current) window.clearTimeout(draftTimer.current)
      draftTimer.current = window.setTimeout(
        () => {
          void persistDraft()
        },
        immediate ? 0 : 1000
      )
    },
    [persistDraft]
  )

  const selectPlace = useCallback(
    (place: BookingPlace) => {
      setErrorMessage(null)
      if (BookingGeo.isFakeCoordinate(place.lat, place.lng)) {
        setSelectedPlace(null)
        setCoverage(null)
        setLocationGate('fake')
        return
      }
      if (!placeIsUS(place)) {
        setSelectedPlace(place)
        setCoverage(null)
        setLocationGate('outOfCountry')
        return
      }
      const nextCoverage = BookingGeo.coverage(place)
      setSelectedPlace(place)
      setCoverage(nextCoverage)
      setAddressQuery(place.label)
      setSuggestions([])
      setLocationGate('ok')
      const minDate = BookingSlots.minSelectableDateString(nextCoverage.inCoverage)
      setSelectedDate((current) => (current < minDate ? minDate : current))
      scheduleDraftSave(true)
    },
    [scheduleDraftSave]
  )

  useEffect(() => {
    if (geocodeTimer.current) window.clearTimeout(geocodeTimer.current)
    const trimmed = addressQuery.trim()
    if (trimmed.length < 3) {
      setSuggestions([])
      if (!selectedPlace) setLocationGate('idle')
      return
    }
    if (selectedPlace && selectedPlace.label === trimmed) return

    geocodeTimer.current = window.setTimeout(() => {
      void (async () => {
        setIsSearching(true)
        try {
          const response = await bookingApi.geocode(trimmed)
          const places = bookingApi.mapPlaces(response)
          setSuggestions(places)
          switch (response.status) {
            case 'ok':
              setLocationGate(places.length === 0 ? 'notFound' : 'pickSuggestion')
              break
            case 'out_of_country':
              setLocationGate('outOfCountry')
              setSelectedPlace(null)
              setCoverage(null)
              break
            case 'fake':
              setLocationGate('fake')
              setSelectedPlace(null)
              setCoverage(null)
              break
            case 'not_found':
              setLocationGate('notFound')
              setSelectedPlace(null)
              setCoverage(null)
              break
            default:
              setLocationGate(places.length === 0 ? 'notFound' : 'pickSuggestion')
          }
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : 'Geocode failed.')
        } finally {
          setIsSearching(false)
        }
      })()
    }, 450)

    return () => {
      if (geocodeTimer.current) window.clearTimeout(geocodeTimer.current)
    }
  }, [addressQuery, selectedPlace])

  async function loadBookedTimes(date = selectedDate) {
    setIsLoadingSlots(true)
    try {
      const response = await bookingApi.bookedTimes(date)
      const next = new Set(response.bookedTimes)
      setBookedTimes(next)
      setSelectedTime24((current) => (current && next.has(current) ? null : current))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not load slots.')
      setBookedTimes(new Set())
    } finally {
      setIsLoadingSlots(false)
    }
  }

  useEffect(() => {
    if (step === 'schedule') void loadBookedTimes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedDate])

  async function useCurrentLocation() {
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 15000
        })
      })
      const { latitude, longitude } = position.coords
      if (BookingGeo.isFakeCoordinate(latitude, longitude)) {
        setLocationGate('fake')
        return
      }
      const response = await bookingApi.reverseGeocode(latitude, longitude)
      if (response.status === 'ok') {
        const place = bookingApi.mapPlace(response.place)
        if (place) selectPlace(place)
        else setLocationGate('notFound')
      } else if (response.status === 'out_of_country') {
        setLocationGate('outOfCountry')
      } else if (response.status === 'fake') {
        setLocationGate('fake')
      } else {
        setLocationGate('notFound')
        if (response.message) setErrorMessage(response.message)
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Location access denied. Search by address instead.'
      )
    } finally {
      setIsBusy(false)
    }
  }

  function goBack() {
    setErrorMessage(null)
    if (step === 'scan') setStep('location')
    else if (step === 'schedule') setStep('scan')
    else if (step === 'contact') setStep('schedule')
    else if (step === 'payment') {
      setPaymentClientSecret(null)
      setPaymentIntentId(null)
      setStep('contact')
    }
  }

  async function submitContact() {
    if (!selectedPlace || !coverage || !selectedTime24) return
    setIsBusy(true)
    setErrorMessage(null)
    try {
      if (coverage.inCoverage) {
        const intent = await bookingApi.createPaymentIntent(
          name.trim(),
          email.trim().toLowerCase(),
          phone.trim()
        )
        setPaymentIntentId(intent.paymentIntentId)
        setPaymentClientSecret(intent.clientSecret)
        await persistDraft('pending')
        setStep('payment')
      } else {
        const response = await bookingApi.scheduleMeeting({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          date: selectedDate,
          time: selectedTime24,
          address: selectedPlace.label,
          lat: selectedPlace.lat,
          lng: selectedPlace.lng,
          scanScope,
          scanScopeLabel: scanScopeLabel(scanScope),
          inCoverage: coverage.inCoverage,
          inServiceCountry: placeIsUS(selectedPlace),
          distanceKm: coverage.distanceKm,
          paymentIntentId: null,
          advancePaid: false
        })
        await persistDraft('pending')
        setCalendarLink(response.link ?? response.meetLink ?? null)
        setStep('done')
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not continue.')
    } finally {
      setIsBusy(false)
    }
  }

  async function finishAfterStripe(piId: string) {
    if (!selectedPlace || !coverage || !selectedTime24) return
    setIsBusy(true)
    setErrorMessage(null)
    setPaymentIntentId(piId)
    try {
      await bookingApi.confirmPayment(piId)
      await persistDraft('paid')
      const response = await bookingApi.scheduleMeeting({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        date: selectedDate,
        time: selectedTime24,
        address: selectedPlace.label,
        lat: selectedPlace.lat,
        lng: selectedPlace.lng,
        scanScope,
        scanScopeLabel: scanScopeLabel(scanScope),
        inCoverage: coverage.inCoverage,
        inServiceCountry: placeIsUS(selectedPlace),
        distanceKm: coverage.distanceKm,
        paymentIntentId: piId,
        advancePaid: true,
        advanceAmount: BookingGeo.advanceDisplay
      })
      setCalendarLink(response.link ?? response.meetLink ?? null)
      setStep('done')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not confirm booking.')
    } finally {
      setIsBusy(false)
    }
  }

  async function goForward() {
    setErrorMessage(null)
    if (step === 'location') {
      await persistDraft()
      setStep('scan')
    } else if (step === 'scan') {
      await persistDraft()
      setStep('schedule')
    } else if (step === 'schedule') {
      await persistDraft()
      setStep('contact')
    } else if (step === 'contact') {
      await persistDraft()
      await submitContact()
    }
  }

  function resetWizard() {
    BookingDraftSession.startFresh()
    setServerDraftId(null)
    setStep('location')
    setAddressQuery('')
    setSuggestions([])
    setLocationGate('idle')
    setSelectedPlace(null)
    setCoverage(null)
    setScanScope('entire_house')
    setSelectedDate(BookingSlots.minSelectableDateString(true))
    setSelectedTime24(null)
    setBookedTimes(new Set())
    setPaymentIntentId(null)
    setPaymentClientSecret(null)
    setCalendarLink(null)
    setErrorMessage(null)
    setName(auth.fullName ?? '')
    setEmail(auth.email ?? '')
    setPhone('')
  }

  const primaryTitle =
    step === 'contact'
      ? coverage?.inCoverage
        ? 'Continue to payment'
        : 'Confirm booking'
      : 'Continue'

  return (
    <section className="pane booking-pane">
      <div className="booking-column">
        <header className="pane-header">
          <div>
            <h1>Book a scan</h1>
            <p className="pane-subtitle">
              Schedule an on-site Vroomk scan. {BookingGeo.rateDisplay} · {BookingGeo.advanceDisplay}{' '}
              deposit inside coverage.
            </p>
          </div>
        </header>

        <div className="booking-progress">
          {BOOKING_PROGRESS_LABELS.map((label, index) => {
            const active = index <= bookingProgressIndex(step)
            return (
              <div key={label} className={`booking-progress-item ${active ? 'active' : ''}`}>
                <span className="booking-progress-bar" />
                <span>{label}</span>
              </div>
            )
          })}
        </div>

        {errorMessage && <p className="form-error booking-error">{errorMessage}</p>}

        <div className="booking-stack">
          {step === 'location' && (
            <section className="settings-card">
              <div className="settings-card-head">
                <h2>Location</h2>
                <p>Search a US address or use your current location.</p>
              </div>
              <label className="field">
                <span>Address</span>
                <input
                  value={addressQuery}
                  onChange={(e) => setAddressQuery(e.target.value)}
                  placeholder="Street, city, state…"
                />
              </label>
              <div className="booking-row">
                <button
                  type="button"
                  className="pill-button compact"
                  disabled={isBusy}
                  onClick={() => void useCurrentLocation()}
                >
                  {isBusy ? 'Locating…' : 'Use current location'}
                </button>
                {isSearching && <span className="spinner" />}
              </div>
              {suggestions.length > 0 && (
                <div className="suggestion-list">
                  {suggestions.map((place) => (
                    <button
                      key={`${place.lat},${place.lng},${place.label}`}
                      type="button"
                      className="suggestion-item"
                      onClick={() => selectPlace(place)}
                    >
                      {place.label}
                    </button>
                  ))}
                </div>
              )}
              {locationGateMessage(locationGate) && (
                <p className="form-info warn">{locationGateMessage(locationGate)}</p>
              )}
              {selectedPlace && (
                <div className="selected-place">
                  <div>
                    <strong>{selectedPlace.label}</strong>
                    {coverage && (
                      <p>
                        {coverage.inCoverage
                          ? `Inside coverage · ${coverage.distanceMiles.toFixed(1)} mi · ${BookingGeo.advanceDisplay} deposit`
                          : `Outside coverage · ${coverage.distanceMiles.toFixed(1)} mi · no deposit; earliest date is tomorrow`}
                      </p>
                    )}
                    <p className="settings-note">
                      Rate {BookingGeo.rateDisplay} · base {BookingGeo.baseLabel}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setSelectedPlace(null)
                      setCoverage(null)
                      setAddressQuery('')
                      setSuggestions([])
                      setLocationGate('idle')
                      setSelectedDate(BookingSlots.minSelectableDateString(true))
                      scheduleDraftSave(true)
                    }}
                  >
                    Clear
                  </button>
                </div>
              )}
            </section>
          )}

          {step === 'scan' && (
            <section className="settings-card">
              <div className="settings-card-head">
                <h2>Scan area</h2>
                <p>What should we capture on site?</p>
              </div>
              <div className="scope-list">
                {SCAN_SCOPES.map((scope) => (
                  <button
                    key={scope.id}
                    type="button"
                    className={`scope-item ${scanScope === scope.id ? 'active' : ''}`}
                    onClick={() => {
                      setScanScope(scope.id)
                      scheduleDraftSave()
                    }}
                  >
                    <span>{scanScope === scope.id ? '●' : '○'}</span>
                    {scope.label}
                  </button>
                ))}
              </div>
            </section>
          )}

          {step === 'schedule' && (
            <section className="settings-card">
              <div className="settings-card-head">
                <h2>Time</h2>
                <p>Pacific time · each visit is 4 hours.</p>
              </div>
              <label className="field">
                <span>Date</span>
                <input
                  type="date"
                  value={selectedDate}
                  min={BookingSlots.minSelectableDateString(coverage?.inCoverage ?? false)}
                  onChange={(e) => {
                    setSelectedDate(e.target.value)
                    scheduleDraftSave()
                  }}
                />
              </label>
              {isLoadingSlots ? (
                <span className="spinner" />
              ) : availableTimes.length === 0 ? (
                <p className="muted tight">No open slots on this day. Try another date.</p>
              ) : (
                <div className="time-grid">
                  {availableTimes.map((time) => (
                    <button
                      key={time}
                      type="button"
                      className={`time-chip ${selectedTime24 === time ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedTime24(time)
                        scheduleDraftSave()
                      }}
                    >
                      {BookingSlots.display12h(time)}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {step === 'contact' && (
            <section className="settings-card">
              <div className="settings-card-head">
                <h2>Details</h2>
                <p>We&apos;ll confirm by email and text.</p>
              </div>
              <label className="field">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    scheduleDraftSave()
                  }}
                  placeholder="Full name"
                />
              </label>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    scheduleDraftSave()
                  }}
                  placeholder="you@example.com"
                />
              </label>
              <label className="field">
                <span>Phone</span>
                <input
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value)
                    scheduleDraftSave()
                  }}
                  placeholder="+1 …"
                />
              </label>
              <p className="muted tight">
                {coverage?.inCoverage
                  ? `Next you'll pay a ${BookingGeo.advanceDisplay} deposit to confirm the on-site visit.`
                  : "Outside coverage — no deposit. We'll confirm your request."}
              </p>
            </section>
          )}

          {step === 'payment' && (
            <section className="settings-card">
              <div className="settings-card-head">
                <h2>Deposit</h2>
                <p>{BookingGeo.advanceDisplay} for your on-site scan appointment.</p>
              </div>
              {paymentClientSecret ? (
                <PaymentFrame
                  clientSecret={paymentClientSecret}
                  amountDisplay={BookingGeo.advanceDisplay}
                  onSuccess={(id) => void finishAfterStripe(id)}
                  onError={setErrorMessage}
                />
              ) : (
                <div className="payment-loading">
                  <span className="spinner" />
                  <span>Preparing payment…</span>
                </div>
              )}
            </section>
          )}

          {step === 'done' && (
            <section className="settings-card">
              <div className="settings-card-head">
                <h2>You&apos;re booked</h2>
                <p>We&apos;ll see you on site.</p>
              </div>
              <p className="muted tight">
                Thanks, {name.trim()}. Your Vroomk scan is confirmed.
              </p>
              {selectedPlace && selectedTime24 && (
                <p className="muted tight">
                  {selectedPlace.label}
                  <br />
                  {selectedDate} · {BookingSlots.display12h(selectedTime24)} PT ·{' '}
                  {scanScopeLabel(scanScope)}
                </p>
              )}
              {calendarLink && (
                <a className="settings-link" href={calendarLink} target="_blank" rel="noreferrer">
                  Open calendar event
                </a>
              )}
              <button type="button" className="pill-button compact" onClick={resetWizard}>
                Book another
              </button>
            </section>
          )}
        </div>

        {step !== 'done' && step !== 'payment' && (
          <div className="booking-nav">
            {step !== 'location' && (
              <button type="button" className="pill-button compact" disabled={isBusy} onClick={goBack}>
                Back
              </button>
            )}
            <div className="toolbar-spacer" />
            <button
              type="button"
              className="pill-button compact"
              disabled={isBusy || !canAdvance}
              onClick={() => void goForward()}
            >
              {isBusy ? <span className="spinner" /> : primaryTitle}
            </button>
          </div>
        )}
        {step === 'payment' && (
          <div className="booking-nav">
            <button type="button" className="pill-button compact" disabled={isBusy} onClick={goBack}>
              Back
            </button>
          </div>
        )}

        {step === 'location' && <BookingCoverageAside selectedPlace={selectedPlace} />}
      </div>
    </section>
  )
}
