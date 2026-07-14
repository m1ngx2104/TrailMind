'use client';
import { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

const icon = L.icon({
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
});

// Leaflet caches its container size on init and after CSS-driven resizes
// (like the fullscreen toggle) the tile grid no longer matches the new
// container, leaving blank space until invalidateSize() is called.
function ResizeHandler({ trigger }) {
    const map = useMap();
    useEffect(() => {
        const timer = setTimeout(() => map.invalidateSize(), 250);
        return () => clearTimeout(timer);
    }, [trigger, map]);
    return null;
}

export default function TrailMap({ lat, lon, name, fullscreen }) {
    return (
        <MapContainer
            key={`${lat}-${lon}`}
            center={[lat, lon]}
            zoom={15}
            style={{ height: '100%', width: '100%', minHeight: '100%', minWidth: '100%' }}

        >
            <ResizeHandler trigger={fullscreen} />
            <TileLayer
                attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <Marker position={[lat, lon]} icon={icon}>
                <Popup>{name}</Popup>
            </Marker>
        </MapContainer>
    );
}