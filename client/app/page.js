'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Navbar from '../components/Navbar';
import ChatWidget from '../components/ChatWidget';
import { getUnitPreference, formatDistanceRange, formatElevation, formatTemp, UNITS_CHANGED_EVENT } from '../lib/units';

// Filter buckets are defined server-side in miles/feet (Short < 3mi, Low < 300ft, etc.)
// — only the displayed hint text switches with the unit preference.
const getFilterGroups = (unit) => {
  const isMetric = unit === 'metric';
  return [
    { key: 'difficulty', label: 'Difficulty', options: ['Easy', 'Moderate', 'Hard', 'Expert'] },
    {
      key: 'length',
      label: 'Length',
      options: isMetric
        ? [
            { value: 'Short', hint: '< 4.8 km' },
            { value: 'Medium', hint: '4.8–16.1 km' },
            { value: 'Long', hint: '> 16.1 km' }
          ]
        : [
            { value: 'Short', hint: '< 3 mi' },
            { value: 'Medium', hint: '3–10 mi' },
            { value: 'Long', hint: '> 10 mi' }
          ]
    },
    {
      key: 'elevation',
      label: 'Elevation gain',
      options: isMetric
        ? [
            { value: 'Low', hint: '< 91 m' },
            { value: 'Moderate', hint: '91–457 m' },
            { value: 'High', hint: '> 457 m' }
          ]
        : [
            { value: 'Low', hint: '< 300 ft' },
            { value: 'Moderate', hint: '300–1500 ft' },
            { value: 'High', hint: '> 1500 ft' }
          ]
    },
    { key: 'activity', label: 'Activity', options: ['Hiking', 'Trail Running', 'Backpacking'] }
  ];
};

const EMPTY_FILTERS = { difficulty: [], length: [], elevation: [], activity: [] };

export default function Home() {
  const [date, setDate] = useState('');
  const [location, setLocation] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recentSearches, setRecentSearches] = useState([]);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState('');
  const [geoSupported, setGeoSupported] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [unit, setUnit] = useState('imperial');

  const today = new Date().toISOString().split('T')[0];
  const activeFilterCount = Object.values(filters).reduce((sum, vals) => sum + vals.length, 0);

  useEffect(() => {
    setUnit(getUnitPreference());
    const onUnitsChanged = (e) => setUnit(e.detail);
    window.addEventListener(UNITS_CHANGED_EVENT, onUnitsChanged);
    return () => window.removeEventListener(UNITS_CHANGED_EVENT, onUnitsChanged);
  }, []);

  const toggleFilter = (group, value) => {
    setFilters((prev) => {
      const current = prev[group];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return { ...prev, [group]: next };
    });
  };

  useEffect(() => {
    const saved = sessionStorage.getItem('lastSearch');
    if (saved) {
      try {
        const { date: d, location: l, results: r, filters: f } = JSON.parse(saved);
        setDate(d);
        setLocation(l);
        setResults(r);
        if (f) setFilters({ ...EMPTY_FILTERS, ...f });
      } catch (e) {}
    }
  }, []);

  useEffect(() => {
    const fetchRecent = () => {
      fetch('http://localhost:5000/api/trails/recent', { credentials: 'include' })
        .then(res => res.ok ? res.json() : null)
        .then(data => setRecentSearches(data?.recentSearches || []))
        .catch(() => setRecentSearches([]));
    };
    fetchRecent();

    const resetOnLogout = () => {
      setRecentSearches([]);
      setDate('');
      setLocation('');
      setResults(null);
      setError('');
      setFilters(EMPTY_FILTERS);
    };
    window.addEventListener('trailmind:logout', resetOnLogout);
    return () => window.removeEventListener('trailmind:logout', resetOnLogout);
  }, []);

  useEffect(() => {
    setGeoSupported(typeof navigator !== 'undefined' && !!navigator.geolocation);
  }, []);

  const handleUseLocation = () => {
    setGeoError('');
    if (!navigator.geolocation) {
      setGeoError('Geolocation is not supported by your browser.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(
            `http://localhost:5000/api/trails/reverse-geocode?lat=${latitude}&lon=${longitude}`
          );
          const data = await res.json();
          if (!res.ok) throw new Error(data.message);
          setLocation(data.displayName);
        } catch (err) {
          setGeoError(err.message || 'Could not determine your location.');
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. You can still search by typing a location.'
            : 'Could not get your current location.'
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    setError('');
    setResults(null);
    setLoading(true);
    try {
      const filterParams = Object.entries(filters)
        .filter(([, values]) => values.length > 0)
        .map(([key, values]) => `&${key}=${encodeURIComponent(values.join(','))}`)
        .join('');
      const res = await fetch(
        `http://localhost:5000/api/trails/search?location=${encodeURIComponent(location)}&date=${date}${filterParams}`,
        { credentials: 'include' }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      setResults(data);
      sessionStorage.setItem('lastSearch', JSON.stringify({ date, location, results: data, filters }));
    } catch (err) {
      setError(err.message || 'Failed to search trails');
    } finally {
      setLoading(false);
    }
  };

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

  return (
    <main className="min-h-screen bg-forest-bg text-forest-text">
      <Navbar />

      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(ellipse 900px 550px at 28% 15%, #1a3d2a 0%, transparent 62%),
              linear-gradient(to bottom, transparent 0%, #0f1712 92%),
              #0f1712
            `
          }}
        />
        <div className="relative px-6 pt-20 pb-40 text-center">
          <p className="text-green-400 text-xs font-semibold tracking-[0.2em] uppercase mb-4">
            AI-Powered Trail Discovery
          </p>
          <h2
            className="text-5xl md:text-7xl font-bold mb-4"
            style={{ textShadow: '0 4px 24px rgba(0,0,0,0.5)' }}
          >
            Find your next trail
          </h2>
          <p className="text-[#a0b4a8] text-lg">Search parks worldwide with real-time weather forecasts</p>
        </div>
      </section>

      <form onSubmit={handleSearch} className="relative z-10 max-w-2xl mx-auto px-6 -mt-32">
        <div className="bg-[rgba(26,36,32,0.85)] backdrop-blur-xl border border-forest-border rounded-2xl p-6 space-y-4 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          <div>
            <label className="block text-sm text-forest-muted mb-1 text-left">When are you hiking?</label>
            <input
              type="date"
              value={date}
              min={today}
              onChange={(e) => setDate(e.target.value)}
              required
              className="w-full bg-forest-bg border border-forest-border text-forest-text rounded-lg px-4 py-3 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/30 transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm text-forest-muted mb-1 text-left">Where do you want to hike?</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={location}
                onChange={(e) => { setLocation(e.target.value); setGeoError(''); }}
                required
                placeholder="e.g. Denver, Colorado or Yosemite"
                className="flex-1 bg-forest-bg border border-forest-border text-forest-text rounded-lg px-4 py-3 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/30 placeholder-forest-muted/50 transition-colors"
              />
              {geoSupported && (
                <button
                  type="button"
                  onClick={handleUseLocation}
                  disabled={locating}
                  className="shrink-0 bg-transparent border border-forest-border hover:border-green-500/60 disabled:opacity-60 text-forest-muted hover:text-green-400 text-sm px-4 rounded-lg transition-colors whitespace-nowrap"
                >
                  {locating ? 'Locating…' : '📍 Use current location'}
                </button>
              )}
            </div>
            {geoError && (
              <p className="text-red-400 text-xs mt-1 text-left">{geoError}</p>
            )}
          </div>

          <div className="text-left">
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              className="text-sm text-forest-text/70 hover:text-forest-text flex items-center gap-2 transition-colors duration-200"
            >
              {showFilters ? <>Hide filters <span className="text-green-400">▴</span></> : <>Filters <span className="text-green-400">▾</span></>}
              {activeFilterCount > 0 && (
                <span className="bg-green-600 text-white text-xs px-2 py-0.5 rounded-full">
                  {activeFilterCount}
                </span>
              )}
            </button>

            {showFilters && (
              <div className="mt-3 bg-forest-bg border border-forest-border rounded-lg p-4 space-y-4">
                {getFilterGroups(unit).map((group) => (
                  <div key={group.key}>
                    <p className="text-xs uppercase tracking-wide text-forest-muted mb-2">{group.label}</p>
                    <div className="flex flex-wrap gap-2">
                      {group.options.map((opt) => {
                        const value = typeof opt === 'string' ? opt : opt.value;
                        const hint = typeof opt === 'string' ? null : opt.hint;
                        const active = filters[group.key].includes(value);
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => toggleFilter(group.key, value)}
                            className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                              active
                                ? 'bg-green-600 border-green-600 text-white'
                                : 'bg-forest-surface border-forest-border text-forest-text/80 hover:border-green-500/50'
                            }`}
                          >
                            {value}{hint ? ` (${hint})` : ''}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setFilters(EMPTY_FILTERS)}
                    className="text-xs text-forest-muted hover:text-forest-text underline"
                  >
                    Clear all filters
                  </button>
                )}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gradient-to-r from-green-500 to-green-600 disabled:from-green-800 disabled:to-green-800 hover:brightness-110 text-white font-semibold py-3.5 rounded-lg transition-[filter] duration-200"
          >
            {loading ? 'Searching parks...' : 'Search Parks'}
          </button>
        </div>
      </form>

      {recentSearches.length > 0 && (
        <section className="max-w-2xl mx-auto px-6 mb-10">
          <h3 className="text-sm text-forest-muted mb-3 flex items-center gap-1.5">
            <span aria-hidden="true">🕐</span> Recently viewed parks
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {recentSearches
              .filter(
                (s, index, self) =>
                  index === self.findIndex((x) => x.osmType === s.osmType && x.osmId === s.osmId)
              )
              .map((s) => (
              <Link
                key={`${s.osmType}-${s.osmId}`}
                href={`/parks/${s.osmType}/${s.osmId}?lat=${s.lat}&lon=${s.lon}&date=${today}&name=${encodeURIComponent(s.name)}&location=${encodeURIComponent(s.location || '')}`}
                className="group relative flex items-center gap-3 bg-forest-surface hover:bg-forest-surface-hover border border-forest-border hover:border-green-500/50 rounded-xl pl-5 pr-4 py-5 transition-all duration-200 overflow-hidden"
              >
                <span className="absolute left-0 top-0 bottom-0 w-1 bg-green-500" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-forest-text font-semibold text-base truncate">{s.name}</p>
                  {s.location && <p className="text-[#6b9e7a] text-sm truncate mt-0.5">{s.location}</p>}
                </div>
                <span className="text-green-400 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shrink-0">→</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {error && (
        <div className="max-w-2xl mx-auto px-6 mb-6">
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg p-4">
            {error}
          </div>
        </div>
      )}

      {results && (
        <section className="max-w-4xl mx-auto px-6 pb-16">
          <div className="bg-forest-surface border border-forest-border rounded-2xl p-6 mb-6">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <p className="text-forest-muted text-sm">Weather on {results.date}</p>
                <p className="text-forest-text font-semibold text-lg">{results.location.split(',').slice(0, 2).join(',')}</p>
              </div>
              {results.weather && (
                <div className="flex items-center gap-6">
                  <span className="text-4xl">{getWeatherEmoji(results.weather.condition)}</span>
                  <div>
                    <p className="text-forest-text font-bold text-xl">{formatTemp(results.weather.maxTemp, unit)} / {formatTemp(results.weather.minTemp, unit)}</p>
                    <p className="text-forest-muted text-sm">{results.weather.condition}</p>
                    <p className="text-forest-muted text-sm">Precipitation: {results.weather.precipitation}mm</p>
                  </div>
                </div>
              )}
            </div>
            {results.weatherWarning && (
              <div className="mt-4 bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 rounded-lg p-3 text-sm">
                Weather forecast may be inaccurate for dates more than 10 days away.
              </div>
            )}
          </div>

          <h3 className="text-xl mb-4">
            <span className="font-bold text-forest-text">{results.parks?.length || 0} parks</span>{' '}
            <span className="text-[#6b9e7a]">found <span aria-hidden="true">📍</span> near {results.location?.split(',')[0]}</span>
          </h3>

          {results.parks?.length === 0 && (
            <div className="bg-forest-surface border border-forest-border rounded-2xl p-8 text-center text-forest-muted">
              No parks found in this area{activeFilterCount > 0 ? ' matching your filters' : ''}.{' '}
              {activeFilterCount > 0 ? 'Try loosening a filter or ' : 'Try '}a different location.
            </div>
          )}

          <div className="grid gap-3">
            {results.parks?.map((park) => (
              <Link
                key={park.id}
                href={`/parks/${park.osmType}/${park.osmId}?lat=${park.lat}&lon=${park.lon}&date=${results.date}&name=${encodeURIComponent(park.name)}&location=${encodeURIComponent(park.location || '')}`}
                className="block bg-forest-surface border border-forest-border hover:border-green-500 rounded-xl px-6 py-5 transition-all duration-200 hover:shadow-[0_4px_20px_rgba(34,197,94,0.1)]"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-white font-bold text-xl truncate">{park.name}</h4>
                    {results.weather && (
                      <span className="text-sm text-forest-muted shrink-0 whitespace-nowrap">
                        {getWeatherEmoji(results.weather.condition)} {formatTemp(results.weather.maxTemp, unit)}
                      </span>
                    )}
                  </div>
                  <p className="text-forest-muted text-sm mt-1"><span aria-hidden="true">📍</span> {park.location}</p>
                  <div className="flex gap-3 mt-3 flex-wrap items-center">
                    {park.difficulties?.map(d => (
                      <span key={d} className={`text-xs px-3 py-1 rounded-full font-medium ${
                        d === 'Easy' ? 'bg-green-500/20 text-green-400' :
                        d === 'Moderate' ? 'bg-yellow-500/20 text-yellow-400' :
                        d === 'Hard' ? 'bg-orange-500/20 text-orange-400' :
                        'bg-red-500/20 text-red-400'
                      }`}>
                        {d}
                      </span>
                    ))}
                    <span className="text-sm text-forest-muted">🥾 {park.trailCount} trails</span>
                    <span className="text-sm text-forest-muted">📏 {formatDistanceRange(park.distanceRange, unit)}{park.lengthBucket ? ` (${park.lengthBucket})` : ''}</span>
                    {park.elevationGain != null && (
                      <span className="text-sm text-forest-muted">📈 {formatElevation(park.elevationGain, unit)} gain{park.elevationBucket ? ` (${park.elevationBucket})` : ''}</span>
                    )}
                  </div>
                  {park.activities?.length > 0 && (
                    <div className="flex gap-2 mt-2.5 flex-wrap">
                      {park.activities.map((a) => (
                        <span key={a} className="text-xs text-forest-muted border border-forest-border px-2.5 py-1 rounded-full">
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <ChatWidget date={date} homepageLocation={location} />
    </main>
  );
}