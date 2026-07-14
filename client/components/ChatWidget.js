'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { getUnitPreference, formatDistance, formatTemp, UNITS_CHANGED_EVENT } from '../lib/units';

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

// Degree symbol before the trailing C/F unit letter — formatTemp itself
// doesn't include one, and other pages that use it don't need one, so it's
// added here rather than changing the shared helper.
const formatHighTemp = (celsius, unit) => {
  const formatted = formatTemp(celsius, unit);
  return formatted == null ? null : formatted.replace(/([CF])$/, '°$1');
};

const FEATURE_EMOJI = {
  waterfall: '💧',
  lake: '🏞️',
  river: '🌊',
  views: '🏔️',
  viewpoint: '🏔️',
  summit: '⛰️',
  forest: '🌲',
};

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-gray-800 rounded-xl px-3 py-2.5 flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}

function ChatParkCard({ park, date, unit, location }) {
  const difficulty = park.difficulties?.[0] || 'Easy';
  const highTemp = park.weather ? formatHighTemp(park.weather.maxTemp, unit) : null;

  return (
    <Link
      href={`/parks/${park.osmType}/${park.osmId}?lat=${park.lat}&lon=${park.lon}&date=${date}&name=${encodeURIComponent(park.name)}&location=${encodeURIComponent(park.location || '')}`}
      className="block bg-gray-900 hover:bg-gray-700 border border-gray-700 rounded-lg p-2 text-xs transition-colors"
    >
      <p className="font-semibold text-white">{park.name}</p>
      <div className="flex flex-wrap items-center gap-2 mt-1 text-gray-300">
        <span className={`px-2 py-0.5 rounded-full ${
          difficulty === 'Easy' ? 'bg-green-500/20 text-green-400' :
          difficulty === 'Moderate' ? 'bg-yellow-500/20 text-yellow-400' :
          'bg-red-500/20 text-red-400'
        }`}>
          {difficulty}
        </span>
        {park.distanceFromOriginKm != null && (
          <span>📍 {formatDistance(park.distanceFromOriginKm, unit)}{location ? ` from ${location.split(',')[0]}` : ''}</span>
        )}
      </div>
      <div className="mt-1 text-gray-400">
        {park.weather ? (
          <span>{getWeatherEmoji(park.weather.condition)} High: {highTemp} · {park.weather.condition}</span>
        ) : (
          <span>Weather unavailable</span>
        )}
      </div>
      {park.matchedFeatures && park.matchedFeatures.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {park.matchedFeatures.map((f) => (
            <span key={f} className="bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded-full text-[10px]">
              {FEATURE_EMOJI[f] || '📌'} {f.charAt(0).toUpperCase() + f.slice(1)}
            </span>
          ))}
        </div>
      )}
      <p className="text-green-500 font-medium mt-1.5">View trails →</p>
    </Link>
  );
}

export default function ChatWidget({ date, homepageLocation }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [unit, setUnit] = useState('imperial');
  const scrollRef = useRef(null);

  const today = new Date().toISOString().split('T')[0];
  const effectiveDate = date || today;

  useEffect(() => {
    setUnit(getUnitPreference());
    const onUnitsChanged = (e) => setUnit(e.detail);
    window.addEventListener(UNITS_CHANGED_EVENT, onUnitsChanged);
    return () => window.removeEventListener(UNITS_CHANGED_EVENT, onUnitsChanged);
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, open]);

  const handleSend = async (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('http://localhost:5000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: trimmed, date: effectiveDate, history, homepageLocation })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Something went wrong');
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.reply, parks: data.parks || [], location: data.location }
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: err.message || "Sorry, I couldn't process that. Please try again.", parks: [] }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const searchingLabel = homepageLocation
    ? `Searching for trails near ${homepageLocation.split(',')[0]}...`
    : 'Searching for trails...';

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-[1000] bg-green-600 hover:bg-green-500 text-white rounded-full w-14 h-14 flex items-center justify-center shadow-lg text-2xl transition-colors"
        aria-label={open ? 'Close chat assistant' : 'Open chat assistant'}
      >
        {open ? '✕' : '💬'}
      </button>

      {open && (
        <div className="fixed bottom-24 right-6 z-[1000] w-[380px] max-w-[calc(100vw-3rem)] h-[560px] max-h-[calc(100vh-8rem)] bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 shrink-0">
            <p className="font-semibold text-white">TrailMind Assistant</p>
            <p className="text-xs text-gray-400 mt-0.5">Planning for {effectiveDate}</p>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="bg-gray-800 text-gray-100 rounded-xl px-3 py-2 text-sm max-w-[85%]">
                Hi! Tell me what kind of hike you&apos;re looking for — e.g. &quot;an easy trail near Denver with a waterfall&quot; or &quot;30 min drive from Denver&quot;.
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                  m.role === 'user' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-100'
                }`}>
                  <p>{m.content}</p>
                  {m.parks && m.parks.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {m.parks.map((p) => (
                        <ChatParkCard key={p.id} park={p} date={effectiveDate} unit={unit} location={m.location} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <>
                <div className="flex justify-start">
                  <div className="bg-gray-800 text-gray-400 rounded-xl px-3 py-2 text-sm">{searchingLabel}</div>
                </div>
                <TypingIndicator />
              </>
            )}
          </div>

          <form onSubmit={handleSend} className="border-t border-gray-800 p-3 flex gap-2 shrink-0">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about a hike..."
              className="flex-1 bg-gray-800 text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-green-500 placeholder-gray-600"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="bg-green-600 hover:bg-green-500 disabled:bg-green-800 disabled:opacity-60 text-white text-sm px-4 rounded-lg transition-colors"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
