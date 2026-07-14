'use client';
import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Navbar from '../../../../components/Navbar';
import { getUnitPreference, formatElevation, formatTemp, UNITS_CHANGED_EVENT } from '../../../../lib/units';

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
    <main className="min-h-screen bg-gray-950 text-white">
      <Navbar backButton={true} />

      <div className="max-w-4xl mx-auto px-6 py-10">
        <h2 className="text-4xl font-bold mb-2">{decodeURIComponent(name || 'Park Detail')}</h2>
        <p className="text-gray-400 mb-8">Hiking date: {date}</p>

        <div className="bg-gray-900 rounded-2xl p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">Weather on {date}</h3>
          {loading ? (
            <p className="text-gray-400">Loading weather...</p>
          ) : data?.weather ? (
            <div>
              <div className="flex items-center gap-6">
                <span className="text-5xl">{getWeatherEmoji(data.weather.condition)}</span>
                <div>
                  <p className="text-3xl font-bold">{formatTemp(data.weather.maxTemp, unit)} / {formatTemp(data.weather.minTemp, unit)}</p>
                  <p className="text-gray-400">{data.weather.condition}</p>
                  <p className="text-gray-400 text-sm">Precipitation: {data.weather.precipitation}mm</p>
                </div>
              </div>
              {data.weatherWarning && (
                <div className="mt-4 bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 rounded-lg p-3 text-sm">
                  Weather forecast may be inaccurate for dates more than 10 days away.
                </div>
              )}
            </div>
          ) : (
            <p className="text-gray-400">Weather data unavailable for this date.</p>
          )}
        </div>

        {data?.elevationGain && (
          <div className="bg-gray-900 rounded-2xl p-6 mb-6">
            <h3 className="text-lg font-semibold mb-2">Elevation</h3>
            <p className="text-3xl font-bold text-green-400">{formatElevation(data.elevationGain, unit)}</p>
            <p className="text-gray-400 text-sm mt-1">Estimated elevation gain in this area</p>
          </div>
        )}

        <div className="bg-gray-900 rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Park Location</h3>
            <button
              onClick={() => setFullscreen(!fullscreen)}
              className="text-sm text-green-400 hover:text-green-300 border border-green-400/30 hover:border-green-400 px-3 py-1 rounded-lg transition-colors"
            >
              {fullscreen ? 'Exit Fullscreen' : 'Fullscreen Map'}
            </button>
          </div>
          <div className={`rounded-xl overflow-hidden transition-all ${fullscreen ? 'fixed top-0 left-0 w-screen h-screen z-50 rounded-none' : 'h-[500px]'}`}>
            {fullscreen && (
              <button
                onClick={() => setFullscreen(false)}
                className="absolute top-4 right-4 z-[1000] bg-gray-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-800"
              >
                Exit Fullscreen
              </button>
            )}
            {lat && lon && (
              <Map lat={lat} lon={lon} name={decodeURIComponent(name || 'Park')} fullscreen={fullscreen} />
            )}
          </div>
        </div>

        <div className="bg-gray-900 rounded-2xl p-6">
          <h3 className="text-lg font-semibold mb-4">Park Information</h3>
          <p className="text-gray-400 text-sm mb-3">
            Trail and park data sourced from OpenStreetMap via Geoapify.
          </p>
          <p className="text-gray-400 text-sm">
            Use the map above to explore trails in this park. Zoom in to see individual paths and routes.
          </p>
        </div>
      </div>
    </main>
  );
}