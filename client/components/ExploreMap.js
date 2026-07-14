'use client';
import { useState, useCallback, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import Link from 'next/link';

const DEFAULT_CENTER = [39.8283, -98.5795];

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const greenIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

function MapEventHandler({ onMoveEnd }) {
  useMapEvents({
    moveend: (e) => {
      const map = e.target;
      const center = map.getCenter();
      const zoom = map.getZoom();
      if (zoom >= 10) {
        onMoveEnd(center.lat, center.lng);
      }
    }
  });
  return null;
}

export default function ExploreMap() {
  const [parks, setParks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const today = new Date().toISOString().split('T')[0];

  const fetchTrailsAtLocation = useCallback(async (lat, lon) => {
    setLoading(true);
    try {
      // /api/trails/search geocodes its `location` param as free text, so a
      // raw "lat,lon" string never resolves — reverse-geocode first to get
      // a place name it can actually search on.
      const geoRes = await fetch(
        `http://localhost:5000/api/trails/reverse-geocode?lat=${lat}&lon=${lon}`
      );
      const geoData = await geoRes.json();
      if (!geoRes.ok) throw new Error(geoData.message || 'Could not resolve this area');

      const res = await fetch(
        `http://localhost:5000/api/trails/search?location=${encodeURIComponent(geoData.displayName)}&date=${today}`,
        { credentials: 'include' }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to load parks');

      if (data.parks && data.parks.length > 0) {
        setParks(prev => {
          const existingIds = new Set(prev.map(p => p.id));
          const newParks = data.parks.filter(p => !existingIds.has(p.id));
          return [...prev, ...newParks];
        });
      }
      setSearched(true);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => {
    fetchTrailsAtLocation(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-full w-full">
      {loading && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] bg-gray-900 text-white text-sm px-4 py-2 rounded-full shadow-lg">
          Loading parks...
        </div>
      )}

      {!searched && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] bg-gray-900 text-white text-sm px-4 py-2 rounded-full shadow-lg">
          Pan or zoom the map to discover parks
        </div>
      )}

      <MapContainer
        center={DEFAULT_CENTER}
        zoom={5}
        style={{ height: '100%', width: '100%' }}
        className="z-0"
      >
        <TileLayer
          attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapEventHandler onMoveEnd={fetchTrailsAtLocation} />
        {parks.map((park) => {
          const difficulty = park.difficulties?.[0] || 'Easy';
          return (
            <Marker
              key={park.id}
              position={[park.lat, park.lon]}
              icon={greenIcon}
            >
              <Popup>
                <div className="min-w-40">
                  <p className="font-semibold text-gray-900">{park.name}</p>
                  <p className="text-xs text-gray-500 mt-1">{park.location}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full mt-1 inline-block ${
                    difficulty === 'Easy' ? 'bg-green-100 text-green-700' :
                    difficulty === 'Moderate' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {difficulty}
                  </span>
                  <Link
                    href={`/parks/${park.osmType}/${park.osmId}?lat=${park.lat}&lon=${park.lon}&date=${today}&name=${encodeURIComponent(park.name)}&location=${encodeURIComponent(park.location || '')}`}
                    className="block mt-2 text-xs text-green-600 font-medium hover:text-green-800"
                  >
                    View park details
                  </Link>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}