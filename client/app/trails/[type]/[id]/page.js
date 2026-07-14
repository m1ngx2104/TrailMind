'use client';
import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';

const Map = dynamic(() => import('../../../../components/TrailMap'), { ssr: false });

export default function TrailDetailPage() {
  const { type, id } = useParams();
  const searchParams = useSearchParams();
  const lat = parseFloat(searchParams.get('lat'));
  const lon = parseFloat(searchParams.get('lon'));
  const date = searchParams.get('date');
  const name = searchParams.get('name');
  const [weather, setWeather] = useState(null);
  const [weatherWarning, setWeatherWarning] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        const res = await fetch(
          'http://localhost:5000/api/trails/detail?lat=' + lat + '&lon=' + lon + '&date=' + date,
          { credentials: 'include' }
        );
        const data = await res.json();
        setWeather(data.weather);
        setWeatherWarning(data.weatherWarning);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    if (lat && lon && date) fetchWeather();
  }, [lat, lon, date]);

  const getWeatherEmoji = (condition) => {
    if (!condition) return '?';
    const c = condition.toLowerCase();
    if (c.includes('clear')) return 'Sunny';
    if (c.includes('cloud') || c.includes('overcast')) return 'Cloudy';
    if (c.includes('rain') || c.includes('drizzle')) return 'Rainy';
    if (c.includes('snow')) return 'Snowy';
    if (c.includes('thunder')) return 'Stormy';
    if (c.includes('fog')) return 'Foggy';
    return 'Partly cloudy';
  };

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <Link href="/" className="text-green-400 hover:text-green-300 text-sm">
          Back to search
        </Link>
        <h1 className="text-xl font-bold text-green-400">TrailMind</h1>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-10">
        <h2 className="text-4xl font-bold mb-2">
          {decodeURIComponent(name || 'Trail Detail')}
        </h2>
        <p className="text-gray-400 mb-8">
          {'OpenStreetMap ID: ' + type + '/' + id}
        </p>

        <div className="bg-gray-900 rounded-2xl p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">{'Weather on ' + date}</h3>
          {loading && <p className="text-gray-400">Loading weather...</p>}
          {!loading && weather && (
            <div>
              <div className="flex items-center gap-6">
                <div>
                  <p className="text-3xl font-bold">
                    {weather.maxTemp + 'C / ' + weather.minTemp + 'C'}
                  </p>
                  <p className="text-gray-400">{weather.condition}</p>
                  <p className="text-gray-400 text-sm">
                    {'Condition: ' + getWeatherEmoji(weather.condition)}
                  </p>
                  <p className="text-gray-400 text-sm">
                    {'Precipitation: ' + weather.precipitation + 'mm'}
                  </p>
                </div>
              </div>
              {weatherWarning && (
                <div className="mt-4 bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 rounded-lg p-3 text-sm">
                  Weather forecast may be inaccurate for dates more than 10 days away.
                </div>
              )}
            </div>
          )}
          {!loading && !weather && (
            <p className="text-gray-400">Weather data unavailable</p>
          )}
        </div>

        <div className="bg-gray-900 rounded-2xl p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">Trail Location</h3>
          <div className="rounded-xl overflow-hidden h-80">
            {lat && lon && (
              <Map lat={lat} lon={lon} name={decodeURIComponent(name || 'Trail')} />
            )}
          </div>
        </div>

        <div className="bg-gray-900 rounded-2xl p-6">
          <h3 className="text-lg font-semibold mb-4">Trail Information</h3>
          <p className="text-gray-400 text-sm mb-3">
            This trail data is sourced from OpenStreetMap contributors.
          </p>
          <a href={'https://www.openstreetmap.org/' + type + '/' + id} target="_blank" rel="noopener noreferrer" className="text-green-400 hover:text-green-300 text-sm">View on OpenStreetMap</a>
        </div>
      </div>
    </main>
  );
}