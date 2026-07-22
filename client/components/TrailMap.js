'use client';
import { useEffect, Fragment } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
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

const parkingIcon = L.divIcon({
    className: '',
    html: '<div style="background:#2563eb;color:#fff;width:22px;height:22px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);">P</div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -11],
});

const parkingIconSelected = L.divIcon({
    className: '',
    html: '<div style="background:#2563eb;color:#fff;width:24px;height:24px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;border:3px solid #22c55e;box-shadow:0 1px 4px rgba(0,0,0,0.5);">P</div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
});

const restroomIcon = L.divIcon({
    className: '',
    html: '<div style="background:#374151;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);">🚻</div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -11],
});

// Marks the midpoint of a road-crossing connector — the route is split into
// disconnected trail-network components (e.g. a park bisected by a road with
// no mapped footpath crossing it), so this is where the walk briefly leaves
// the trail network.
const connectorIcon = L.divIcon({
    className: '',
    html: '<div style="background:#6b7280;color:#fff;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);">↔</div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10],
});

// Leaflet caches its container size on init and after CSS-driven resizes
// (like the fullscreen toggle) the tile grid no longer matches the new
// container, leaving blank space until invalidateSize() is called.
function ResizeHandler({ trigger }) {
    const map = useMap();
    useEffect(() => {
        const timer = setTimeout(() => map.invalidateSize(), 100);
        return () => clearTimeout(timer);
    }, [trigger, map]);
    return null;
}

// Auto-fit the map to show the route's (or raw trail fallback's) full
// geometry once loaded. invalidateSize() runs first — the container's size
// isn't always settled yet at the moment route data first arrives (e.g.
// mid-CSS-transition), and fitBounds computed against a stale size can
// leave the route panned/zoomed somewhere the user doesn't see until some
// later interaction happens to force Leaflet to recompute.
function FitBoundsHandler({ route, rawTrails }) {
    const map = useMap();
    useEffect(() => {
        const points = [
            ...(route ? route.geometry : []),
            ...(route?.additionalLoops || []).flat(),
            ...(route?.connectorSegments || []).flatMap((s) => [[s.from.lat, s.from.lon], [s.to.lat, s.to.lon]]),
            ...(rawTrails || []).flatMap((t) => t.coordinates)
        ];
        if (points.length === 0) return;
        const timer = setTimeout(() => {
            map.invalidateSize();
            map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
        }, 100);
        return () => clearTimeout(timer);
    }, [route, rawTrails, map]);
    return null;
}

const RAW_TRAIL_COLORS = { gray: '#9ca3af', green: '#22c55e' };
const ROUTE_COLOR = '#22c55e';
const DEADHEAD_COLOR = '#f97316';
const CONNECTOR_COLOR = '#6b7280';

export default function TrailMap({
    lat, lon, name, fullscreen,
    route = null,
    rawTrails = [], rawTrailColor,
    parkingLots = [], restrooms = [],
    showParkingLayer = true, showRestroomLayer = true,
    selectedParkingLotId = null
}) {
    return (
        <MapContainer
            key={`${lat}-${lon}`}
            center={[lat, lon]}
            zoom={15}
            style={{ height: '100%', width: '100%', minHeight: '100%', minWidth: '100%' }}

        >
            <ResizeHandler trigger={fullscreen} />
            <FitBoundsHandler route={route} rawTrails={rawTrails} />
            <TileLayer
                attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {route && (
                <Polyline
                    positions={route.geometry}
                    pathOptions={{ color: ROUTE_COLOR, weight: 5, opacity: 1 }}
                />
            )}
            {route && route.deadheadGeometry.map((segment, i) => (
                <Polyline
                    key={`deadhead-${i}`}
                    positions={segment}
                    pathOptions={{ color: DEADHEAD_COLOR, weight: 4, opacity: 0.9, dashArray: '8 6' }}
                />
            ))}
            {route && (route.additionalLoops || []).map((segment, i) => (
                <Polyline
                    key={`extra-loop-${i}`}
                    positions={segment}
                    pathOptions={{ color: ROUTE_COLOR, weight: 5, opacity: 1 }}
                />
            ))}
            {route && (route.connectorSegments || []).map((seg, i) => (
                <Fragment key={`connector-${i}`}>
                    <Polyline
                        positions={[[seg.from.lat, seg.from.lon], [seg.to.lat, seg.to.lon]]}
                        pathOptions={{ color: CONNECTOR_COLOR, weight: 3, opacity: 0.85, dashArray: '4 8' }}
                    />
                    <Marker
                        position={[(seg.from.lat + seg.to.lat) / 2, (seg.from.lon + seg.to.lon) / 2]}
                        icon={connectorIcon}
                    >
                        <Popup>Road crossing — {seg.distanceMi} mi</Popup>
                    </Marker>
                </Fragment>
            ))}
            {rawTrails.map((trail) => (
                <Polyline
                    key={trail.id}
                    positions={trail.coordinates}
                    pathOptions={{
                        color: RAW_TRAIL_COLORS[rawTrailColor] || RAW_TRAIL_COLORS.gray,
                        weight: 3,
                        opacity: 0.8
                    }}
                />
            ))}
            {showParkingLayer && parkingLots.map((lot) => (
                <Marker
                    key={`parking-${lot.id}`}
                    position={[lot.lat, lot.lon]}
                    icon={lot.id === selectedParkingLotId ? parkingIconSelected : parkingIcon}
                >
                    <Popup>{lot.name} — {lot.fee}</Popup>
                </Marker>
            ))}
            {showRestroomLayer && restrooms.map((restroom) => (
                <Marker key={`restroom-${restroom.id}`} position={[restroom.lat, restroom.lon]} icon={restroomIcon}>
                    <Popup>Restroom</Popup>
                </Marker>
            ))}
            <Marker position={[lat, lon]} icon={icon}>
                <Popup>{name}</Popup>
            </Marker>
        </MapContainer>
    );
}
