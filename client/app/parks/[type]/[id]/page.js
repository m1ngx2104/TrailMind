'use client';
import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Navbar from '../../../../components/Navbar';
import LoopFilterPanel, { EMPTY_LOOP_FILTERS } from '../../../../components/LoopFilterPanel';
import { getUnitPreference, formatElevation, formatTemp, formatDistance, formatDuration, UNITS_CHANGED_EVENT } from '../../../../lib/units';

const Map = dynamic(() => import('../../../../components/TrailMap'), { ssr: false });

export default function ParkDetailPage() {
  const { type, id } = useParams();
  const searchParams = useSearchParams();
  const lat = parseFloat(searchParams.get('lat'));
  const lon = parseFloat(searchParams.get('lon'));
  const date = searchParams.get('date');
  const name = searchParams.get('name');
  const location = searchParams.get('location');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [unit, setUnit] = useState('imperial');
  const [mounted, setMounted] = useState(false);

  const [route, setRoute] = useState(null);
  const [rawTrails, setRawTrails] = useState([]);
  const [rawTrailColor, setRawTrailColor] = useState(null);
  const [routeMessage, setRouteMessage] = useState(null);
  const [routeLoading, setRouteLoading] = useState(true);
  const [routeError, setRouteError] = useState(null);
  const [filters, setFilters] = useState(EMPTY_LOOP_FILTERS);
  const [routeRetryCount, setRouteRetryCount] = useState(0);
  const [routingStrategy, setRoutingStrategy] = useState(null);
  const [timeBudgetMinutes, setTimeBudgetMinutes] = useState(null);
  const [trailCoveragePercent, setTrailCoveragePercent] = useState(null);
  const [totalParkTrailKm, setTotalParkTrailKm] = useState(null);

  const [parkingLots, setParkingLots] = useState([]);
  const [restrooms, setRestrooms] = useState([]);
  const [restroomCount, setRestroomCount] = useState(0);
  const [selectedParkingLotId, setSelectedParkingLotId] = useState(null);
  const [showParkingLayer, setShowParkingLayer] = useState(true);
  const [showRestroomLayer, setShowRestroomLayer] = useState(true);

  const selectedParkingLot = parkingLots.find((lot) => lot.id === selectedParkingLotId) || null;

  useEffect(() => {
    setMounted(true);
  }, []);

  // Lock body scroll while the map is fullscreen so the page behind it can't
  // be scrolled/dragged underneath the fixed overlay.
  useEffect(() => {
    if (mounted && fullscreen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mounted, fullscreen]);

  useEffect(() => {
    setUnit(getUnitPreference());
    const onUnitsChanged = (e) => setUnit(e.detail);
    window.addEventListener(UNITS_CHANGED_EVENT, onUnitsChanged);
    return () => window.removeEventListener(UNITS_CHANGED_EVENT, onUnitsChanged);
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(
          `http://localhost:5000/api/trails/detail?lat=${lat}&lon=${lon}&date=${date}`,
          { credentials: 'include' }
        );
        const json = await res.json();
        setData(json);
      } catch (err) {
        setError('Failed to load park details');
      } finally {
        setLoading(false);
      }
    };
    if (lat && lon && date) fetchData();
  }, [lat, lon, date]);

  useEffect(() => {
    if (!lat || !lon || !type || !id) return;
    fetch('http://localhost:5000/api/trails/recent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        osmType: type,
        osmId: id,
        name: name ? decodeURIComponent(name) : 'Park',
        lat,
        lon,
        location: location ? decodeURIComponent(location) : ''
      })
    }).catch(() => {});
  }, [lat, lon, type, id, name, location]);

  useEffect(() => {
    if (!lat || !lon) return;
    setRouteLoading(true);
    setRouteError(null);
    const params = new URLSearchParams({ lat, lon });
    if (filters.difficulty.length) params.set('difficulty', filters.difficulty.join(','));
    if (filters.activity.length) params.set('activity', filters.activity.join(','));
    if (filters.timeBudget) params.set('maxTimeMinutes', filters.timeBudget);
    if (filters.elevationOrder) params.set('elevationOrder', filters.elevationOrder);
    if (selectedParkingLot) {
      params.set('parkingLat', selectedParkingLot.lat);
      params.set('parkingLon', selectedParkingLot.lon);
    }

    fetch(`http://localhost:5000/api/trails/loops?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) {
          setRouteError({
            message: json.message || 'Could not calculate a route for this park.',
            retryable: !!json.retryable
          });
          setRoute(null);
          setRawTrails([]);
          setRawTrailColor(null);
          setRouteMessage(null);
          return;
        }
        setRoute(json.route || null);
        setRawTrails(json.rawTrails || []);
        setRawTrailColor(json.rawTrailColor || null);
        setRouteMessage(json.message || null);
        setParkingLots(json.parkingLots || []);
        setRestrooms(json.restrooms || []);
        setRestroomCount(json.restroomCount || 0);
        setRoutingStrategy(json.routingStrategy || null);
        setTimeBudgetMinutes(json.timeBudgetMinutes ?? null);
        setTrailCoveragePercent(json.trailCoveragePercent ?? null);
        setTotalParkTrailKm(json.totalParkTrailKm ?? null);
      })
      .catch(() => {
        setRouteError({ message: 'Could not calculate a route for this park.', retryable: false });
        setRoute(null);
        setRawTrails([]);
        setRawTrailColor(null);
        setRouteMessage(null);
        setRoutingStrategy(null);
        setTimeBudgetMinutes(null);
        setTrailCoveragePercent(null);
        setTotalParkTrailKm(null);
      })
      .finally(() => setRouteLoading(false));
    // Depend on the selected lot's coordinates (primitives), not the object
    // itself — parkingLots gets replaced by a new array on every response,
    // which would otherwise refetch on every load even with no real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, filters, routeRetryCount, selectedParkingLot?.lat, selectedParkingLot?.lon]);

  const getWeatherEmoji = (condition) => {
    if (!condition) return '🌤';
    const c = condition.toLowerCase();
    if (c.includes('clear')) return '☀️';
    if (c.includes('cloud') || c.includes('overcast')) return '☁️';
    if (c.includes('rain') || c.includes('drizzle')) return '🌧️';
    if (c.includes('snow')) return '❄️';
    if (c.includes('thunder')) return '⛈️';
    if (c.includes('fog')) return '🌫️';
    return '🌤️';
  };

  const difficultyClass = (difficulty) =>
    difficulty === 'Easy' ? 'bg-green-500/20 text-green-400' :
    difficulty === 'Moderate' ? 'bg-yellow-500/20 text-yellow-400' :
    difficulty === 'Hard' ? 'bg-orange-500/20 text-orange-400' :
    'bg-red-500/20 text-red-400';

  return (
    <main className="min-h-screen bg-forest-bg text-forest-text">
      <Navbar backButton={true} />

      <div className="max-w-4xl mx-auto px-6 py-10">
        <h2 className="text-3xl font-bold mb-2">{decodeURIComponent(name || 'Park Detail')}</h2>
        <div className="w-10 h-1 bg-green-500 rounded-full mb-3" aria-hidden="true" />
        <p className="text-forest-muted mb-8">Hiking date: <span className="text-green-400 font-medium">{date}</span></p>

        <div className="bg-forest-surface border border-forest-border rounded-2xl p-6 mb-6">
          {!routeLoading && (parkingLots.length > 0 || restrooms.length > 0) && (
            <div className="flex flex-wrap items-center gap-4 mb-3">
              {parkingLots.length > 0 && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-forest-muted">Start from parking lot:</label>
                  <select
                    value={selectedParkingLotId ?? ''}
                    onChange={(e) => setSelectedParkingLotId(e.target.value ? Number(e.target.value) : null)}
                    className="bg-forest-bg border border-forest-border text-forest-text text-xs rounded-lg px-2 py-1.5 outline-none focus:border-green-500 transition-colors"
                  >
                    <option value="">Best available start point</option>
                    {parkingLots.map((lot) => (
                      <option key={lot.id} value={lot.id}>{lot.name} — {lot.fee}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-center gap-3">
                {parkingLots.length > 0 && (
                  <label className="flex items-center gap-1.5 text-xs text-forest-muted">
                    <input
                      type="checkbox"
                      checked={showParkingLayer}
                      onChange={(e) => setShowParkingLayer(e.target.checked)}
                    />
                    Parking
                  </label>
                )}
                {restrooms.length > 0 && (
                  <label className="flex items-center gap-1.5 text-xs text-forest-muted">
                    <input
                      type="checkbox"
                      checked={showRestroomLayer}
                      onChange={(e) => setShowRestroomLayer(e.target.checked)}
                    />
                    Restrooms
                  </label>
                )}
              </div>
            </div>
          )}

          <div
            className={
              mounted && fullscreen
                ? 'fixed inset-0 w-screen h-screen z-[9999] overflow-hidden'
                : 'relative rounded-xl border border-forest-border overflow-hidden transition-all h-[500px]'
            }
          >
            <div
              className={
                mounted && fullscreen
                  ? 'fixed top-4 left-4 z-[10000] flex items-center gap-2'
                  : 'absolute top-3 left-14 z-[1000] flex items-center gap-2'
              }
            >
              <button
                onClick={() => setFullscreen(!fullscreen)}
                className="bg-[rgba(26,36,32,0.85)] backdrop-blur-md border border-forest-border hover:border-green-500/50 text-forest-text text-xs px-3 py-2 rounded-lg shadow-lg transition-colors"
              >
                {fullscreen ? 'Exit Fullscreen' : 'Fullscreen Map'}
              </button>
            </div>

            <LoopFilterPanel filters={filters} onChange={setFilters} />

            {lat && lon && (
              <Map
                lat={lat}
                lon={lon}
                name={decodeURIComponent(name || 'Park')}
                fullscreen={fullscreen}
                route={route}
                rawTrails={rawTrails}
                rawTrailColor={rawTrailColor}
                parkingLots={parkingLots}
                restrooms={restrooms}
                showParkingLayer={showParkingLayer}
                showRestroomLayer={showRestroomLayer}
                selectedParkingLotId={selectedParkingLotId}
              />
            )}

            {routeLoading && (
              <div className="absolute inset-0 z-[1000] bg-forest-bg/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3">
                <div className="w-8 h-8 border-2 border-forest-border border-t-green-500 rounded-full animate-spin" aria-hidden="true" />
                <p className="text-sm text-forest-text">Calculating optimal route...</p>
              </div>
            )}

            {!routeLoading && routeError && (
              <div className="absolute top-14 left-3 z-[1000] bg-[rgba(26,36,32,0.85)] backdrop-blur-md border border-forest-border rounded-lg px-3 py-3 text-xs text-forest-text shadow-lg max-w-[260px]">
                <p className="mb-2">
                  {routeError.retryable
                    ? 'Trail data temporarily unavailable — OpenStreetMap is not responding. Try again in a few minutes.'
                    : 'Could not calculate a route for this park.'}
                </p>
                <button
                  onClick={() => setRouteRetryCount((c) => c + 1)}
                  className="bg-forest-bg hover:bg-forest-surface-hover border border-forest-border text-forest-text text-xs px-3 py-1.5 rounded-lg transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {!routeLoading && !routeError && !route && (
              <div className="absolute top-14 left-3 z-[1000] bg-[rgba(26,36,32,0.85)] backdrop-blur-md border border-forest-border rounded-lg px-3 py-2 text-xs text-forest-muted shadow-lg max-w-[260px]">
                {routeMessage || 'No trail data found for this park'}
              </div>
            )}

            {route && (
              <div className="absolute bottom-3 left-3 right-3 z-[1000]">
                <div className="bg-forest-surface/95 backdrop-blur border border-forest-border rounded-xl p-3 shadow-2xl">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🥾</span>
                    <p className="text-forest-text font-semibold text-sm">
                      {routingStrategy === 'budget_subnetwork' ? 'Recommended Route' : 'Full Park Route'}
                    </p>
                    {routingStrategy === 'full_coverage' && (
                      <span className="text-[10px] bg-green-600 text-white px-1.5 py-0.5 rounded-full">✓ Covers all trails</span>
                    )}
                    {routingStrategy === 'budget_subnetwork' && trailCoveragePercent != null && (
                      <span className="text-[10px] bg-blue-600 text-white px-1.5 py-0.5 rounded-full">{trailCoveragePercent}% of park trails</span>
                    )}
                    {route.isClosedLoop && (
                      <span className="text-[10px] bg-green-600 text-white px-1.5 py-0.5 rounded-full">✓ closed loop</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center divide-x divide-forest-border mt-1.5 text-xs text-forest-text/90">
                    <span className={`px-2 py-0.5 mr-2 rounded-full font-medium ${difficultyClass(route.difficulty)}`}>
                      {route.difficulty}
                    </span>
                    <span className="pl-2 pr-2">📏 {formatDistance(route.totalDistanceKm, unit)}</span>
                    <span className="pl-2 pr-2">⏱ {formatDuration(route.estimatedTimeMinutes)}</span>
                    <span className="pl-2">📈 {formatElevation(route.elevationGain, unit)}</span>
                  </div>
                  {routingStrategy === 'budget_subnetwork' && timeBudgetMinutes != null && (
                    <p className="text-[11px] text-forest-muted mt-1.5">
                      Est. {formatDuration(route.estimatedTimeMinutes)} · Based on a {formatDuration(timeBudgetMinutes)} time budget — tap Filters to adjust
                    </p>
                  )}
                  {route.namedTrails.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {route.namedTrails.map((t) => (
                        <span key={t} className="text-[11px] text-forest-muted border border-green-500/40 px-2 py-0.5 rounded-full">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {route.deadheadDistanceMi > 0 && (
                    <p className="text-[11px] text-forest-muted/70 mt-1.5">
                      {formatDistance(route.deadheadDistanceKm, unit)} repeated segments
                    </p>
                  )}
                  {routingStrategy === 'budget_subnetwork' && trailCoveragePercent != null && trailCoveragePercent < 50 && totalParkTrailKm != null && (
                    <p className="text-[11px] text-forest-muted/70 mt-1">
                      This park has {formatDistance(totalParkTrailKm, unit)} of trails total — increase time budget to cover more
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {!routeLoading && !routeError && (parkingLots.length > 0 || restroomCount > 0) && (
            <p className="text-forest-muted text-xs mt-3">
              {[
                parkingLots.length > 0 ? `${parkingLots.length} parking area${parkingLots.length === 1 ? '' : 's'}` : null,
                restroomCount > 0 ? `${restroomCount} restroom${restroomCount === 1 ? '' : 's'}` : null
              ].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>

        <div className="bg-forest-surface border border-forest-border rounded-2xl p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">Weather on {date}</h3>
          {loading ? (
            <p className="text-forest-muted">Loading weather...</p>
          ) : data?.weather ? (
            <div>
              <div className="flex items-center gap-6">
                <span className="text-6xl">{getWeatherEmoji(data.weather.condition)}</span>
                <div>
                  <p className="text-3xl font-bold text-forest-text">{formatTemp(data.weather.maxTemp, unit)}</p>
                  <p className="text-forest-muted text-sm">Low: {formatTemp(data.weather.minTemp, unit)}</p>
                  <p className="text-forest-text mt-1">{data.weather.condition}</p>
                  <p className="text-forest-muted text-sm">Precipitation: {data.weather.precipitation}mm</p>
                </div>
              </div>
              {data.weatherWarning && (
                <div className="mt-4 bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 rounded-lg p-3 text-sm">
                  Weather forecast may be inaccurate for dates more than 10 days away.
                </div>
              )}
            </div>
          ) : (
            <p className="text-forest-muted">Weather data unavailable for this date.</p>
          )}
        </div>

        {data?.elevationGain && (
          <div className="bg-forest-surface border border-forest-border rounded-2xl p-6 mb-6">
            <h3 className="text-lg font-semibold mb-2">Elevation</h3>
            <p className="text-3xl font-bold text-green-400">{formatElevation(data.elevationGain, unit)}</p>
            <p className="text-forest-muted text-sm mt-1">Estimated elevation gain in this area</p>
          </div>
        )}

        <div className="bg-forest-surface border border-forest-border rounded-2xl p-6">
          <h3 className="text-lg font-semibold mb-4">Park Information</h3>
          <p className="text-forest-muted text-sm mb-3">
            Trail and park data sourced from OpenStreetMap via Geoapify and Overpass.
          </p>
          <p className="text-forest-muted text-sm">
            {routingStrategy === 'budget_subnetwork'
              ? 'This route covers a priority subset of the park\'s trails within your time budget, starting and ending at your selected point. Dashed segments on the map are walked twice to complete the route.'
              : 'This route covers every trail in the park at least once, starting and ending at your selected point. Dashed segments on the map are walked twice to complete the route.'}
          </p>
        </div>
      </div>
    </main>
  );
}
