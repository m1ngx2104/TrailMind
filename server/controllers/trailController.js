const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const User = require('../models/user');
const { findOptimalParkRoute, buildTrailGraph } = require('../utils/loopFinder');

// Simple in-memory cache (5 minute TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

const getCached = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return item.data;
};

const setCache = (key, data) => {
  cache.set(key, { data, timestamp: Date.now() });
};

// Geocode location using Geoapify
const geocodeLocation = async (location) => {
  const key = process.env.GEOAPIFY_API_KEY;
  const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(location)}&limit=1&apiKey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.features || data.features.length === 0) throw new Error('Location not found');
  const [lon, lat] = data.features[0].geometry.coordinates;
  const displayName = data.features[0].properties.formatted;
  return { lat, lon, displayName };
};

// Reverse geocode coordinates (e.g. from browser geolocation) to a place name
const reverseGeocodeLocation = async (lat, lon) => {
  const key = process.env.GEOAPIFY_API_KEY;
  const url = `https://api.geoapify.com/v1/geocode/reverse?lat=${lat}&lon=${lon}&apiKey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.features || data.features.length === 0) throw new Error('Could not determine your location');
  const props = data.features[0].properties;
  const parts = [props.city || props.county, props.state, props.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : props.formatted;
};

// Get weather from Open-Meteo
const getWeather = async (lat, lon, date) => {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto&start_date=${date}&end_date=${date}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.daily || !data.daily.time.length) return null;
    const weatherCodes = {
      0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Foggy', 48: 'Icy fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
      61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
      80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
      95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail'
    };
    const code = data.daily.weathercode[0];
    return {
      date,
      maxTemp: Math.round(data.daily.temperature_2m_max[0]),
      minTemp: Math.round(data.daily.temperature_2m_min[0]),
      precipitation: data.daily.precipitation_sum[0],
      condition: weatherCodes[code] || 'Unknown',
      code
    };
  } catch (err) { return null; }
};

// Get elevation using Geoapify Elevation API
const getElevationGain = async (lat, lon) => {
  try {
    const key = process.env.GEOAPIFY_API_KEY;
    const spread = 0.01;
    const locations = [];
    for (let i = 0; i < 5; i++) {
      locations.push({
        lat: lat + (i - 2) * spread,
        lon: lon + (i - 2) * spread
      });
    }
    const url = `https://api.geoapify.com/v1/geodata/elevation?apiKey=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations })
    });
    const data = await res.json();
    if (!data.results) return null;
    const elevations = data.results.map(l => l.elevation).filter(e => e != null);
    if (elevations.length < 2) return null;
    let gain = 0;
    for (let i = 1; i < elevations.length; i++) {
      const diff = elevations[i] - elevations[i - 1];
      if (diff > 0) gain += diff;
    }
    return Math.round(gain);
  } catch (err) { return null; }
};

// Pick up to maxPoints evenly-spaced points from a path, to keep elevation
// batch requests small regardless of how many nodes the source geometry has.
const resamplePoints = (points, maxPoints) => {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const sampled = [];
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(points[Math.round(i * step)]);
  }
  return sampled;
};

// Elevation gain sampled along an actual trail path (as opposed to
// getElevationGain's synthetic grid around a single point).
const getElevationGainAlongPath = async (points) => {
  try {
    const sampled = resamplePoints(points, 10);
    if (sampled.length < 2) return 0;
    const key = process.env.GEOAPIFY_API_KEY;
    const url = `https://api.geoapify.com/v1/geodata/elevation?apiKey=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: sampled.map((p) => ({ lat: p.lat, lon: p.lon })) })
    });
    const data = await res.json();
    if (!data.results) return 0;
    const elevations = data.results.map((l) => l.elevation).filter((e) => e != null);
    if (elevations.length < 2) return 0;
    let gain = 0;
    for (let i = 1; i < elevations.length; i++) {
      const diff = elevations[i] - elevations[i - 1];
      if (diff > 0) gain += diff;
    }
    return Math.round(gain);
  } catch (err) { return 0; }
};

// Check if date is beyond 10 days
const isDateBeyondForecast = (date) => {
  const today = new Date();
  const targetDate = new Date(date);
  const diffDays = Math.ceil((targetDate - today) / (1000 * 60 * 60 * 24));
  return diffDays > 10;
};

// Calculate distance between two coords in km
const calcDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Geoapify's Places API doesn't expose real per-trail length, difficulty or
// activity tags, so these are heuristics derived from what we do have
// (trail spread around the park center, and area elevation gain) rather
// than authoritative trail stats.

const getLengthBucket = (miles) => {
  if (miles < 3) return 'Short';
  if (miles <= 10) return 'Medium';
  return 'Long';
};

const getElevationBucket = (feet) => {
  if (feet < 300) return 'Low';
  if (feet <= 1500) return 'Moderate';
  return 'High';
};

// Adapted from the Shenandoah hiking-difficulty formula: sqrt(gain_ft * 2 * distance_mi)
const getDifficulty = (elevationGainFt, lengthMiles) => {
  const score = Math.sqrt(Math.max(elevationGainFt, 0) * 2 * Math.max(lengthMiles, 0.1));
  if (score < 50) return 'Easy';
  if (score < 100) return 'Moderate';
  if (score < 160) return 'Hard';
  return 'Expert';
};

const getActivities = (difficulty, lengthMiles) => {
  const activities = ['Hiking'];
  if ((difficulty === 'Easy' || difficulty === 'Moderate') && lengthMiles <= 10) {
    activities.push('Trail Running');
  }
  if (lengthMiles >= 3) {
    activities.push('Backpacking');
  }
  return activities;
};

const parseFilterParam = (raw) => {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
};

// Search parks using Geoapify Places API
const searchParksGeoapify = async (lat, lon, radius = 15000, areaFilter = null) => {
  const key = process.env.GEOAPIFY_API_KEY;
  const categories = 'leisure.park.nature_reserve,natural.forest,natural.protected_area,national_park';
  const filter = areaFilter || `circle:${lon},${lat},${radius}`;
  const url = `https://api.geoapify.com/v2/places?categories=${categories}&filter=${filter}&limit=25&apiKey=${key}`;
  console.log('Fetching parks from:', url);
  const res = await fetch(url);
  const data = await res.json();
  console.log('Parks response:', JSON.stringify(data).slice(0, 300));
  return data.features || [];
};

// Search trails using Geoapify Places API
const searchTrailsGeoapify = async (lat, lon, radius = 15000, areaFilter = null) => {
  const key = process.env.GEOAPIFY_API_KEY;
  const categories = 'highway.path,highway.track,leisure.park.nature_reserve';
  const filter = areaFilter || `circle:${lon},${lat},${radius}`;
  const url = `https://api.geoapify.com/v2/places?categories=${categories}&filter=${filter}&limit=30&apiKey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.features || [];
};

// Build the full candidate park list (with derived filter attributes) for a
// location, independent of any filters — this is what gets cached, so
// filters can be applied fresh on every request without re-hitting Geoapify.
// `origin` is always the actual point distances are measured FROM (search
// center for a plain search, or the drive-from point for a drive-time
// search) — kept separate from `areaFilter` since a drive-time search's
// query AREA (an isoline bbox) isn't the same as its distance ORIGIN.
// `areaFilter`, when given, overrides the default circle query (e.g. a
// `rect:...` bbox for drive-time search) for both the parks and trails
// Geoapify calls. `radiusMeters` only matters when areaFilter is absent (a
// plain circle search) — searchParksGeoapify/searchTrailsGeoapify already
// ignore it whenever areaFilter is set, so drive-time callers are
// unaffected by the default here.
const buildParkCandidates = async (origin, areaFilter = null, radiusMeters = 15000) => {
  const parkFeatures = await searchParksGeoapify(origin.lat, origin.lon, radiusMeters, areaFilter);
  const trailFeatures = await searchTrailsGeoapify(origin.lat, origin.lon, radiusMeters, areaFilter);

  const excludeKeywords = ['sports complex', 'baseball', 'soccer', 'football', 'golf course', 'tennis', 'swimming', 'stadium', 'arena', 'gym', 'fitness', 'school', 'elementary', 'middle school', 'high school', 'church', 'parking'];
  const seenParks = new Set();
  const candidates = [];

  for (const feature of parkFeatures) {
    const props = feature.properties;
    const name = props.name;
    if (!name || typeof name !== 'string' || seenParks.has(name)) continue;

    const nameLower = name.toLowerCase();
    if (excludeKeywords.some(keyword => nameLower.includes(keyword))) continue;

    seenParks.add(name);

    const [parkLon, parkLat] = feature.geometry.coordinates;
    const distanceFromOriginKm = calcDistance(origin.lat, origin.lon, parkLat, parkLon);

    const nearbyTrails = [];
    const distances = [];
    const seenTrails = new Set();

    for (const trail of trailFeatures) {
      const tProps = trail.properties;
      const tName = tProps.name;
      if (tName && seenTrails.has(tName)) continue;
      if (tName) seenTrails.add(tName);

      const [tLon, tLat] = trail.geometry.coordinates;
      const dist = calcDistance(parkLat, parkLon, tLat, tLon);
      if (dist > 2) continue;

      distances.push(dist);

      nearbyTrails.push({
        id: tProps.place_id || Math.random().toString(36),
        name: tName || 'Unnamed Trail',
        surface: tProps.surface || 'Natural',
        distance: dist,
        lat: tLat,
        lon: tLon,
        osmType: 'way',
        osmId: tProps.osm_id || ''
      });
    }

    let distanceRange = 'Varies';
    const maxDistKm = distances.length > 0 ? Math.max(...distances) : 0.5;
    if (distances.length > 0) {
      const minDist = Math.min(...distances);
      distanceRange = minDist.toFixed(1) === maxDistKm.toFixed(1)
        ? `${minDist.toFixed(1)} km`
        : `${minDist.toFixed(1)} – ${maxDistKm.toFixed(1)} km`;
    }

    candidates.push({
      id: props.place_id,
      osmType: 'way',
      osmId: props.osm_id || props.place_id,
      name,
      lat: parkLat,
      lon: parkLon,
      trailCount: nearbyTrails.length,
      trails: nearbyTrails.slice(0, 10),
      distanceRange,
      maxDistKm,
      distanceFromOriginKm,
      location: origin.displayName.split(',').slice(0, 3).join(','),
      address: props.formatted || ''
    });
  }

  // Elevation is its own network call per park — run them concurrently
  // rather than one at a time now that we're evaluating more candidates.
  const elevationGains = await Promise.all(
    candidates.map((c) => getElevationGain(c.lat, c.lon))
  );

  return candidates.map((c, i) => {
    const elevationGain = elevationGains[i];
    const elevationGainFt = Math.round((elevationGain || 0) * 3.28084);
    const lengthMiles = Math.round(c.maxDistKm * 0.621371 * 10) / 10;
    const difficulty = getDifficulty(elevationGainFt, lengthMiles);

    return {
      ...c,
      elevationGain,
      difficulties: [difficulty],
      lengthMiles,
      lengthBucket: getLengthBucket(lengthMiles),
      elevationBucket: getElevationBucket(elevationGainFt),
      activities: getActivities(difficulty, lengthMiles)
    };
  });
};

// Feature keywords the AI can extract that we actually know how to check
// for on Geoapify. Anything extracted outside this map still shows up in
// the `features` list for display/reply purposes, it just can't contribute
// to scoring since there's no reliable category to search for it.
//
// Verified directly against Geoapify's live API (several category names
// that looked plausible turned out not to exist — natural.water.waterfall,
// natural.water.lake, natural.water.river, and natural.hill all return
// HTTP 400 "category not supported"). Geoapify doesn't break natural.water
// down by water-body type at all, so waterfall/lake/river share that one
// broad category and get disambiguated afterward by checking each result's
// own name for the specific keyword.
const FEATURE_CATEGORY_MAP = {
  waterfall: 'natural.water',
  lake: 'natural.water',
  river: 'natural.water',
  beach: 'natural.water',
  // "views"/"viewpoint" map to tourism.attraction, not natural.hill —
  // natural.hill also returns HTTP 400 "category not supported" on
  // Geoapify's live API (verified directly), same as the invalid
  // natural.water.* subcategories above.
  views: 'tourism.attraction',
  viewpoint: 'tourism.attraction',
  summit: 'natural.mountain',
  forest: 'natural.forest',
};

const FEATURE_NAME_HINTS = {
  waterfall: ['waterfall', 'falls'],
  lake: ['lake', 'reservoir', 'pond'],
  river: ['river', 'creek', 'stream'],
  beach: ['beach', 'shore'],
};

// Wide enough to register the 1km/3km scoring tiers below.
const FEATURE_SEARCH_RADIUS_M = 3000;

// Scores/reorders parks by how many requested features are found nearby,
// weighted by how close the nearest match is (closer = more likely the
// feature is actually reachable from/relevant to that park). Batches every
// requested feature into ONE Geoapify query per park (not one query per
// feature per park) — keeps the extra call count at parks.length rather
// than parks.length * features.length. The field stays `matchedFeatures`
// (not renamed) since the chat UI already reads that field name.
const scoreParksByFeatures = async (parks, features) => {
  const key = process.env.GEOAPIFY_API_KEY;
  const requested = [...new Set(features.map((f) => f.toLowerCase()))].filter((f) => FEATURE_CATEGORY_MAP[f]);
  if (requested.length === 0) return parks.map((p) => ({ ...p, matchedFeatures: [] }));

  const categories = [...new Set(requested.flatMap((f) => FEATURE_CATEGORY_MAP[f].split(',')))].join(',');

  const scored = await Promise.all(parks.map(async (park) => {
    try {
      const url = `https://api.geoapify.com/v2/places?categories=${categories}&filter=circle:${park.lon},${park.lat},${FEATURE_SEARCH_RADIUS_M}&limit=20&apiKey=${key}`;
      const res = await fetch(url);
      const data = await res.json();
      const found = data.features || [];

      const matchedFeatures = [];
      let featureScore = 0;

      for (const keyword of requested) {
        const cats = FEATURE_CATEGORY_MAP[keyword].split(',');
        const hints = FEATURE_NAME_HINTS[keyword];
        const matches = found.filter((f) => {
          const inCategory = (f.properties.categories || []).some((cat) => cats.includes(cat));
          if (!inCategory) return false;
          if (!hints) return true;
          const name = (f.properties.name || '').toLowerCase();
          return hints.some((hint) => name.includes(hint));
        });
        if (matches.length === 0) continue;

        matchedFeatures.push(keyword);
        const closestKm = Math.min(...matches.map((f) => {
          const [poiLon, poiLat] = f.geometry.coordinates;
          return calcDistance(park.lat, park.lon, poiLat, poiLon);
        }));
        featureScore += closestKm <= 1 ? 50 : closestKm <= 3 ? 25 : 0;
      }

      return { ...park, matchedFeatures, featureScore };
    } catch (err) {
      return { ...park, matchedFeatures: [], featureScore: 0 };
    }
  }));

  return scored.sort((a, b) => b.featureScore - a.featureScore);
};

// Core search pipeline, shared by the /search endpoint and the chat assistant:
// geocode -> load/cache candidate parks -> filter -> attach weather for the date.
//
// maxDistanceMiles/minDistanceMiles/excludeParkNames/refinementType/
// similarToPark are chat-assistant refinement params (all optional/no-op for
// the plain /search endpoint, which never passes them). "closer" is the only
// refinement about proximity to the searcher (distanceFromOriginKm) —
// "shorter"/"longer" and their paired max/minDistanceMiles are about hike
// length (lengthMiles) instead, since that's what those phrases actually
// mean and lengthMiles is already in miles (no unit conversion needed there).
const performParkSearch = async ({
  location, date, difficulty, length, elevation, activity, features,
  maxDistanceMiles, minDistanceMiles, excludeParkNames, refinementType, similarToPark
}) => {
  const difficultyFilter = parseFilterParam(difficulty);
  const lengthFilter = parseFilterParam(length);
  const elevationFilter = parseFilterParam(elevation);
  const activityFilter = parseFilterParam(activity);

  // Split out from matchesFilters so the difficulty-relaxation retry below
  // can re-check length/elevation/activity without re-applying (or
  // hard-coding a second copy of) the difficulty check itself.
  const matchesNonDifficultyFilters = (park) => {
    if (lengthFilter.length && !lengthFilter.includes(park.lengthBucket)) return false;
    if (elevationFilter.length && !elevationFilter.includes(park.elevationBucket)) return false;
    if (activityFilter.length && !park.activities.some((a) => activityFilter.includes(a))) return false;
    return true;
  };

  const matchesFilters = (park) => {
    if (difficultyFilter.length && !difficultyFilter.includes(park.difficulties[0])) return false;
    return matchesNonDifficultyFilters(park);
  };

  // The default 15km Geoapify search radius only finds parks close to the
  // origin — a "closer" refinement asking for something farther away (e.g.
  // "over 10 miles away") would have every candidate filtered out afterward
  // even though wider candidates genuinely exist, since none were ever
  // fetched. Only widen/narrow for "closer" specifically: maxDistanceMiles/
  // minDistanceMiles mean hike length for "shorter"/"longer" refinements,
  // and capping the search radius by a length constraint would incorrectly
  // exclude perfectly good, short-trailed parks just for being far away.
  let searchRadiusKm = 15;
  if (refinementType === 'closer') {
    if (minDistanceMiles) {
      searchRadiusKm = Math.max(searchRadiusKm, (minDistanceMiles * 1.609) * 1.5);
    }
    if (maxDistanceMiles) {
      searchRadiusKm = Math.min(searchRadiusKm, (maxDistanceMiles * 1.609) * 1.2);
    }
  }

  const coords = await geocodeLocation(location);
  console.log('[ChatSearch] geocoded location:', coords);
  // Radius folded into the cache key — otherwise a wider-radius refinement
  // request right after a normal search would just reuse the already-cached
  // narrow-radius candidate list and still come back empty.
  const cacheKey = `${coords.lat.toFixed(3)}-${coords.lon.toFixed(3)}-r${Math.round(searchRadiusKm)}`;

  let cached = getCached(cacheKey);
  if (!cached) {
    const allParks = await buildParkCandidates(coords, null, Math.round(searchRadiusKm * 1000));
    cached = {
      location: coords.displayName,
      coords: { lat: coords.lat, lon: coords.lon },
      allParks
    };
    setCache(cacheKey, cached);
  } else {
    console.log('Serving from cache:', cacheKey);
  }

  const weather = await getWeather(coords.lat, coords.lon, date);
  const weatherWarning = isDateBeyondForecast(date);

  console.log('[ChatSearch] parks before difficulty filter:', cached.allParks.length);
  console.log('[ChatSearch] difficulty filter value:', difficulty);
  let parks = cached.allParks.filter(matchesFilters);
  console.log('[ChatSearch] parks after difficulty filter:', parks.length);

  // A strict single-difficulty request (chat assistant's difficultyFilter
  // is always exactly one value) can wipe out an entire small local
  // candidate pool if none of them happen to be classified at that exact
  // tier — verified: Denver's 7-candidate pool has zero "Moderate" parks,
  // so "moderate trail near Denver" returned nothing even though 7 real
  // candidates exist. Widen to the adjacent tier(s) first rather than
  // failing outright; only fall back to ignoring difficulty entirely if
  // even that comes up empty.
  if (parks.length === 0 && difficultyFilter.length > 0) {
    const order = ['Easy', 'Moderate', 'Hard', 'Expert'];
    const relaxedDifficulties = new Set();
    difficultyFilter.forEach((d) => {
      const idx = order.indexOf(d);
      if (idx === -1) return;
      order.forEach((tier, i) => { if (Math.abs(i - idx) <= 1) relaxedDifficulties.add(tier); });
    });
    parks = cached.allParks.filter((p) => relaxedDifficulties.has(p.difficulties[0]) && matchesNonDifficultyFilters(p));
    console.log('[ChatSearch] parks after relaxed difficulty (+/-1 tier):', parks.length);

    if (parks.length === 0) {
      parks = cached.allParks.filter(matchesNonDifficultyFilters);
      console.log('[ChatSearch] parks after dropping difficulty entirely:', parks.length);
    }
  }

  // Never show a park the user's already been shown again in this
  // conversation, unless they explicitly ask to revisit it.
  if (Array.isArray(excludeParkNames) && excludeParkNames.length > 0) {
    parks = parks.filter((p) =>
      !excludeParkNames.some((name) => p.name.toLowerCase().includes(name.toLowerCase()))
    );
  }

  console.log(`[ChatFilter] refinementType: ${refinementType}, maxDist: ${maxDistanceMiles}mi, ` +
    `minDist: ${minDistanceMiles}mi, parks before filter: ${parks.length}`);

  if (refinementType === 'closer') {
    // Proximity to the searcher — distanceFromOriginKm is already computed
    // and attached to every candidate back in buildParkCandidates, well
    // before this function ever runs, so it's guaranteed present here.
    if (maxDistanceMiles) {
      const maxKm = maxDistanceMiles * 1.609;
      parks = parks.filter((p) => p.distanceFromOriginKm <= maxKm);
    }
    if (minDistanceMiles) {
      const minKm = minDistanceMiles * 1.609;
      parks = parks.filter((p) => p.distanceFromOriginKm >= minKm);
    }
  } else {
    if (maxDistanceMiles) {
      parks = parks.filter((p) => (p.lengthMiles ?? 0) <= maxDistanceMiles);
    }
    if (minDistanceMiles) {
      parks = parks.filter((p) => (p.lengthMiles ?? 0) >= minDistanceMiles);
    }
  }

  console.log(`[ChatFilter] parks after filter: ${parks.length}`);

  // Reference park must already be in this location's candidate pool — a
  // fresh cross-location Geoapify lookup for an arbitrary named park is out
  // of scope here; per the system prompt's own location-carry-forward rule,
  // "similar to X" almost always follows a park just shown for this same
  // location, so this covers the real case without an extra network round
  // trip for the common path.
  if (similarToPark) {
    const referenceLower = similarToPark.toLowerCase();
    const reference = cached.allParks.find((p) =>
      p.name.toLowerCase().includes(referenceLower) || referenceLower.includes(p.name.toLowerCase())
    );
    if (reference) {
      parks = parks
        .filter((p) => p.name !== reference.name)
        .map((p) => {
          let similarityScore = 0;
          if (p.difficulties[0] === reference.difficulties[0]) similarityScore += 50;
          const refLen = reference.lengthMiles || 0;
          if (refLen > 0 && Math.abs(p.lengthMiles - refLen) / refLen <= 0.3) similarityScore += 30;
          if (calcDistance(reference.lat, reference.lon, p.lat, p.lon) <= 20) similarityScore += 20;
          return { ...p, similarityScore };
        })
        .sort((a, b) => b.similarityScore - a.similarityScore);
    }
  }

  // Sort/shuffle whatever survived exclusion/distance/similarity filtering —
  // applied before the display-size slice so refinement actually changes
  // which parks make the cut, not just their order within an already-fixed
  // top 8.
  if (refinementType === 'shorter') {
    parks = [...parks].sort((a, b) => (a.lengthMiles ?? 0) - (b.lengthMiles ?? 0));
  } else if (refinementType === 'longer') {
    parks = [...parks].sort((a, b) => (b.lengthMiles ?? 0) - (a.lengthMiles ?? 0));
  } else if (refinementType === 'closer') {
    parks = [...parks].sort((a, b) => a.distanceFromOriginKm - b.distanceFromOriginKm);
  } else if (refinementType === 'harder') {
    const order = ['Easy', 'Moderate', 'Hard', 'Expert'];
    parks = [...parks].sort((a, b) => order.indexOf(b.difficulties[0]) - order.indexOf(a.difficulties[0]));
  } else if (refinementType === 'different') {
    parks = [...parks].sort(() => Math.random() - 0.5);
  }

  parks = parks.slice(0, 8);

  let matchedFeatures = [];
  if (features && features.length > 0) {
    parks = await scoreParksByFeatures(parks, features);
    matchedFeatures = [...new Set(parks.flatMap((p) => p.matchedFeatures || []))];
  }

  if (parks.length === 0) {
    // minDistanceMiles gets its own specific wording (its search-radius
    // widening already ran earlier, so "try a smaller distance" is the
    // actionable next step there); anything else empty at this point falls
    // back to a general message covering the difficulty-relaxation case
    // above and any other filter combination that still came up dry.
    const message = minDistanceMiles
      ? `No parks found over ${minDistanceMiles} miles from ${cached.location}. Try a smaller distance or a different location.`
      : `No ${difficulty ? `${difficulty.toLowerCase()} ` : ''}trails found near ${cached.location}. Try a different location or difficulty.`;
    return {
      location: cached.location,
      coords: cached.coords,
      date,
      weather,
      weatherWarning,
      parks: [],
      matchedFeatures: [],
      message
    };
  }

  return {
    location: cached.location,
    coords: cached.coords,
    date,
    weather,
    weatherWarning,
    parks,
    matchedFeatures
  };
};

// Drive-time-radius equivalent of geocodeLocation+circle search: given an
// origin point and a drive time, ask Geoapify's Isoline API for the actual
// driveable area and use its bounding box as the search area. GeoJSON
// coordinates are [lon, lat] order (opposite of this file's own {lat, lon}
// convention) and can be a Polygon or a MultiPolygon (a drive-time isoline
// commonly produces several disconnected reachable pockets), so both shapes
// are flattened before computing the box.
const getDriveTimeRadius = async (originLat, originLon, driveTimeMinutes) => {
  try {
    const key = process.env.GEOAPIFY_API_KEY;
    const rangeSeconds = Math.round(driveTimeMinutes * 60);
    const url = `https://api.geoapify.com/v1/isoline?lat=${originLat}&lon=${originLon}&type=time&mode=drive&range=${rangeSeconds}&apiKey=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    const feature = data.features && data.features[0];
    if (!feature || !feature.geometry) return null;

    const geom = feature.geometry;
    const rings = geom.type === 'MultiPolygon'
      ? geom.coordinates.flatMap((polygon) => polygon[0])
      : geom.coordinates[0];
    if (!rings || rings.length === 0) return null;

    let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
    for (const [lon, lat] of rings) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
    }
    return { south, west, north, east };
  } catch (err) {
    return null;
  }
};

// Drive-time-based search: same result shape as performParkSearch, but the
// search area comes from the actual driveable reach (Isoline API) rather
// than a fixed circle around a geocoded point, falling back to a
// straight-line km radius if the Isoline call fails. Weather is fetched per
// park rather than once for a shared center — results can be spread across
// a much wider area than a single-location circle search, so a single
// shared reading would be far less representative.
const performDriveTimeSearch = async ({ originLat, originLon, originDisplayName, date, driveTimeMinutes, searchRadius, difficulty, activity, features }) => {
  const origin = { lat: originLat, lon: originLon, displayName: originDisplayName };
  const bbox = await getDriveTimeRadius(originLat, originLon, driveTimeMinutes);

  let allParks;
  if (bbox) {
    const areaFilter = `rect:${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    allParks = await buildParkCandidates(origin, areaFilter);
  } else {
    const fallbackRadiusKm = searchRadius || Math.round(driveTimeMinutes * (4 / 3));
    allParks = await buildParkCandidates(origin, `circle:${originLon},${originLat},${Math.round(fallbackRadiusKm * 1000)}`);
  }

  const difficultyFilter = parseFilterParam(difficulty);
  const activityFilter = parseFilterParam(activity);
  const matchesFilters = (park) => {
    if (difficultyFilter.length && !difficultyFilter.includes(park.difficulties[0])) return false;
    if (activityFilter.length && !park.activities.some((a) => activityFilter.includes(a))) return false;
    return true;
  };

  let parks = allParks.filter(matchesFilters).sort((a, b) => a.distanceFromOriginKm - b.distanceFromOriginKm).slice(0, 8);

  let matchedFeatures = [];
  if (features && features.length > 0) {
    parks = await scoreParksByFeatures(parks, features);
    matchedFeatures = [...new Set(parks.flatMap((p) => p.matchedFeatures || []))];
  }

  const weathers = await Promise.all(parks.map((p) => getWeather(p.lat, p.lon, date)));
  parks = parks.map((p, i) => ({ ...p, weather: weathers[i] }));

  return {
    location: originDisplayName,
    coords: { lat: originLat, lon: originLon },
    date,
    weather: weathers[0] || null,
    weatherWarning: isDateBeyondForecast(date),
    parks,
    matchedFeatures
  };
};

const searchTrails = async (req, res) => {
  try {
    const { location, date, difficulty, length, elevation, activity } = req.query;
    if (!location || !date) {
      return res.status(400).json({ message: 'Location and date are required' });
    }

    const result = await performParkSearch({ location, date, difficulty, length, elevation, activity });
    res.json(result);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message || 'Failed to search' });
  }
};

const getTrailDetail = async (req, res) => {
  try {
    const { lat, lon, date } = req.query;
    if (!lat || !lon || !date) {
      return res.status(400).json({ message: 'lat, lon and date are required' });
    }
    const weather = await getWeather(parseFloat(lat), parseFloat(lon), date);
    const weatherWarning = isDateBeyondForecast(date);
    const elevationGain = await getElevationGain(parseFloat(lat), parseFloat(lon));
    res.json({ weather, weatherWarning, elevationGain });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to get details' });
  }
};

// Get the current user's recent park views (most recent first)
const getRecentSearches = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('recentSearches');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ recentSearches: user.recentSearches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to load recent searches' });
  }
};

// Record a park view, keeping only the 4 most recent distinct parks
const addRecentSearch = async (req, res) => {
  try {
    const { osmType, osmId, name, lat, lon, location } = req.body;
    if (!osmType || !osmId || !name || lat == null || lon == null) {
      return res.status(400).json({ message: 'Missing park details' });
    }

    // Single atomic aggregation-pipeline update: drop any existing entry for
    // this osmType+osmId, prepend the fresh one, then cap at 4 — all as one
    // document-level operation. A separate $pull followed by a separate
    // $push (the previous approach) isn't atomic *together*: two concurrent
    // requests for the same park (e.g. a double-invoked effect) can both
    // complete their $pull before either $push runs, inserting two copies.
    const user = await User.findByIdAndUpdate(
      req.userId,
      [
        {
          $set: {
            recentSearches: {
              $concatArrays: [
                [{ osmType, osmId, name, lat, lon, location, viewedAt: new Date() }],
                {
                  $filter: {
                    input: '$recentSearches',
                    as: 'item',
                    cond: {
                      $not: [{
                        $and: [
                          { $eq: ['$$item.osmType', osmType] },
                          { $eq: ['$$item.osmId', osmId] }
                        ]
                      }]
                    }
                  }
                }
              ]
            }
          }
        },
        { $set: { recentSearches: { $slice: ['$recentSearches', 4] } } }
      ],
      { new: true, updatePipeline: true }
    ).select('recentSearches');
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ recentSearches: user.recentSearches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to save recent search' });
  }
};

// Turn browser geolocation coordinates into a place name for the search field
const reverseGeocode = async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
      return res.status(400).json({ message: 'lat and lon are required' });
    }
    const displayName = await reverseGeocodeLocation(parseFloat(lat), parseFloat(lon));
    res.json({ displayName });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message || 'Failed to determine your location' });
  }
};

// The free public Overpass instances are individually unreliable — they
// return 504 timeouts and even outright 406 rejections in bursts. Rather
// than retrying one instance, cycle through several public mirrors, giving
// each a couple of quick attempts before moving on.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const OVERPASS_TIMEOUT_MS = 10000;
const ATTEMPTS_PER_MIRROR = 2;
const RETRY_DELAY_MS = 2000;

// A single attempt against one mirror. Throws with a message describing
// exactly what went wrong (HTTP status, timeout, HTML body, network error)
// so the caller can log a useful reason per attempt. timeoutMs defaults to
// the original flat value but can be overridden per-call so the client-side
// abort stays ahead of a heavier query's own [timeout:N] Overpass QL clause.
const fetchOverpassOnce = async (url, query, timeoutMs = OVERPASS_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'TrailMind/1.0 (trail discovery app; contact: monhm1210@gmail.com)',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (text.trimStart().startsWith('<')) throw new Error('received HTML error page instead of JSON');
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
};

const fetchOverpassWithRetry = async (query, timeoutMs = OVERPASS_TIMEOUT_MS) => {
  for (const url of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MIRROR; attempt++) {
      try {
        return await fetchOverpassOnce(url, query, timeoutMs);
      } catch (err) {
        console.error(`Overpass mirror failed [${url}] (attempt ${attempt}/${ATTEMPTS_PER_MIRROR}): ${err.message}`);
        if (attempt < ATTEMPTS_PER_MIRROR) await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error('Overpass request failed: all mirrors exhausted');
};

// 3-bucket difficulty scale for loops (Easy/Moderate/Hard — deliberately
// coarser than the park-search heuristic's 4-bucket scale, per spec).
const getLoopDifficulty = (elevationGainFt, distanceMiles) => {
  const score = Math.sqrt(Math.max(elevationGainFt, 0) * 2 * Math.max(distanceMiles, 0.1));
  if (score < 50) return 'Easy';
  if (score < 120) return 'Moderate';
  return 'Hard';
};

const extractWays = (overpassData) => {
  return (overpassData.elements || [])
    .filter((el) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map((el) => ({
      id: el.id,
      name: el.tags && el.tags.name ? el.tags.name.trim() : null,
      geometry: el.geometry.map((p) => ({ lat: p.lat, lon: p.lon })),
      // Kept for the route optimizer's edge-level filters (difficulty
      // proxy, activity restriction) — no new Overpass fields queried,
      // just retaining more of what a way's response already carries.
      tags: el.tags ? {
        surface: el.tags.surface || null,
        bicycle: el.tags.bicycle || null,
        sac_scale: el.tags.sac_scale || null
      } : null
    }));
};

const computeWayDistanceKm = (way) => {
  let distanceKm = 0;
  for (let i = 1; i < way.geometry.length; i++) {
    distanceKm += calcDistance(way.geometry[i - 1].lat, way.geometry[i - 1].lon, way.geometry[i].lat, way.geometry[i].lon);
  }
  return distanceKm;
};

const attachWayDistances = (ways, minWayLengthKm) => {
  return ways
    .map((w) => ({ ...w, distanceKm: computeWayDistanceKm(w) }))
    .filter((w) => w.distanceKm > minWayLengthKm);
};

// STEP 1 — fetch the park's own boundary polygon so trail fetching/filtering
// can be scoped to the actual park, not just "whatever's near this point"
// (which is what let a sidewalk north of Heros Grove get picked up before).
const polygonArea = (polygon) => {
  if (polygon.length < 3) return 0;
  const meanLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
  const kmPerDegLat = 110.574;
  const kmPerDegLon = 111.320 * Math.cos((meanLat * Math.PI) / 180);
  const pts = polygon.map((p) => ({ x: p.lon * kmPerDegLon, y: p.lat * kmPerDegLat }));

  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area) / 2; // km^2
};

const polygonCentroid = (polygon) => ({
  lat: polygon.reduce((s, p) => s + p.lat, 0) / polygon.length,
  lon: polygon.reduce((s, p) => s + p.lon, 0) / polygon.length
});

// Every closed-ring way in the response that could plausibly be a park
// boundary (>=4 nodes, non-zero area) — fetchParkBoundary picks among them.
// Relations return a `members` list (type/ref/role) instead of one flat
// geometry array — the actual node geometry lives on each member *way*,
// which Overpass also emits as its own top-level element in `elements`
// because the query recurses with `(._;>;)`. Reassembling the polygon means
// chaining those outer-role member ways end-to-end into one ring.
const getWayNodes = (way) => {
  if (way.geometry?.length > 0) return way.geometry;
  return way.nodes?.map((n) => ({ lat: n.lat, lon: n.lon })) || [];
};

const isSameNode = (a, b) => {
  if (!a || !b) return false;
  return Math.abs(a.lat - b.lat) < 0.00001 && Math.abs(a.lon - b.lon) < 0.00001;
};

// Chains outer-member ways into a single ring by matching shared endpoints,
// reversing a way's node order when it connects tail-to-tail rather than
// tail-to-head. A gap (no matching endpoint found) just appends the
// remaining way in place — real park boundaries are near-universally one
// contiguous ring, so this simplification is a reasonable fallback rather
// than a full multi-ring/hole-aware polygon reconstruction.
const chainWaysIntoRing = (ways) => {
  if (ways.length === 0) return [];
  if (ways.length === 1) return getWayNodes(ways[0]);

  const result = [];
  const remaining = [...ways];

  const current = remaining.shift();
  result.push(...getWayNodes(current));

  while (remaining.length > 0) {
    const lastNode = result[result.length - 1];

    const nextIdx = remaining.findIndex((w) => {
      const nodes = getWayNodes(w);
      return isSameNode(nodes[0], lastNode) || isSameNode(nodes[nodes.length - 1], lastNode);
    });

    if (nextIdx === -1) {
      const next = remaining.shift();
      result.push(...getWayNodes(next));
      continue;
    }

    const next = remaining.splice(nextIdx, 1)[0];
    let nextNodes = getWayNodes(next);
    if (isSameNode(nextNodes[nextNodes.length - 1], lastNode)) {
      nextNodes = nextNodes.reverse();
    }
    result.push(...nextNodes.slice(1));
  }

  return result;
};

const extractBoundaryFromRelation = (relationElement, allElements) => {
  const outerMemberIds = relationElement.members
    ?.filter((m) => m.type === 'way' && m.role === 'outer')
    .map((m) => m.ref) || [];
  if (outerMemberIds.length === 0) return null;

  const outerWays = outerMemberIds
    .map((id) => allElements.find((e) => e.type === 'way' && e.id === id))
    .filter(Boolean);
  if (outerWays.length === 0) return null;

  return chainWaysIntoRing(outerWays);
};

const extractBoundaryCandidates = (overpassData) => {
  const elements = overpassData.elements || [];
  const candidates = [];

  for (const el of elements) {
    let polygon = null;
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      polygon = el.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
    } else if (el.type === 'relation') {
      polygon = extractBoundaryFromRelation(el, elements);
    }
    if (!polygon || polygon.length < 4) continue;
    if (polygonArea(polygon) <= 0) continue;
    candidates.push(polygon);
  }

  return candidates;
};

// A 100m search radius (as in the original spec) only finds a park's
// boundary way if the query point happens to land within 100m of the
// polygon's own edge/vertices — for anything but small parks, a center-ish
// point is usually much farther than that from the nearest boundary vertex.
// Verified empirically: Central Park's boundary way is 0 results at 100m,
// found immediately at 500m. Cascade tight -> wide instead of one fixed
// radius: tight radii are less likely to accidentally grab a neighboring
// park, but large parks or an off-center Geoapify point need the wider net.
// The 3000m tier exists for large state/national parks specifically —
// verified against East Fork State Park's real OSM relation (boundary=
// protected_area, correctly matched by the relation query above), whose
// nearest boundary node sits ~2216m from Geoapify's own geocoded point for
// "East Fork State Park" — a large park's labeled/geocoded center is not
// reliably close to its actual mapped perimeter.
const BOUNDARY_SEARCH_RADII_M = [200, 500, 1500, 3000];

const WAY_BOUNDARY_TAGS = [
  '["leisure"="park"]',
  '["leisure"="nature_reserve"]',
  '["boundary"="protected_area"]',
  '["landuse"="recreation_ground"]',
  '["leisure"="garden"]'
];

// Large parks (state parks, national parks, big nature reserves) are
// routinely mapped in OSM as multipolygon relations rather than a single
// closed way — a way-only query finds nothing for them no matter how wide
// the search radius gets. state_park/national_park have no way-tag
// equivalent above since those are relation-only conventions in practice.
const RELATION_BOUNDARY_TAGS = [
  '["leisure"="park"]',
  '["leisure"="nature_reserve"]',
  '["boundary"="protected_area"]',
  '["leisure"="state_park"]',
  '["boundary"="national_park"]'
];

// One Overpass call per radius, unioning every candidate tag/type — batching
// avoids issuing many sequential requests per attempt against a public
// instance that already throttles multi-clause queries (see
// fetchOverpassWithRetry above). [timeout:30] gives relation queries (which
// recurse into every member way's nodes) more room than the client's own
// default abort — see the bumped client-side timeout in fetchParkBoundary.
const buildBoundaryQuery = (radius, lat, lon) => {
  const wayClauses = WAY_BOUNDARY_TAGS.map((tag) => `way${tag}(around:${radius},${lat},${lon});`).join('');
  const relationClauses = RELATION_BOUNDARY_TAGS.map((tag) => `relation${tag}(around:${radius},${lat},${lon});`).join('');
  return `[out:json][timeout:30];(${wayClauses}${relationClauses});(._;>;);out geom;`;
};

// Matches the query's own [timeout:30] plus a few seconds of network/queue
// slack — the prior flat 10s client abort fired well before a relation
// query (which recurses into every member way's nodes) could ever finish,
// making the server-side timeout increase pointless on its own.
const BOUNDARY_CLIENT_TIMEOUT_MS = 35000;

const fetchParkBoundary = async (lat, lon) => {
  for (const radius of BOUNDARY_SEARCH_RADII_M) {
    const data = await fetchOverpassWithRetry(buildBoundaryQuery(radius, lat, lon), BOUNDARY_CLIENT_TIMEOUT_MS);
    const candidates = extractBoundaryCandidates(data);
    if (candidates.length === 0) continue;

    // Multiple tags/radius can each return their own ring — the one whose
    // centroid sits closest to the search point is almost always the actual
    // park being viewed, not a neighboring one the wider radius also caught.
    const best = candidates.reduce((a, b) => {
      const centroidA = polygonCentroid(a);
      const centroidB = polygonCentroid(b);
      const distA = calcDistance(lat, lon, centroidA.lat, centroidA.lon);
      const distB = calcDistance(lat, lon, centroidB.lat, centroidB.lon);
      return distB < distA ? b : a;
    });
    return best;
  }
  return null;
};

const computeBBox = (polygon) => {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const p of polygon) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
  }
  return { south, west, north, east };
};

// Park size classification — every trail-fetching/filtering parameter below
// (buffer distance, bbox padding, point-in-polygon thresholds, minimum way
// length, radius fallback, target loop distances) is tuned per size tier
// rather than using one fixed set of values for every park.
const computePolygonAreaKm2 = (nodes) => {
  let area = 0;
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const curr = nodes[i];
    const next = nodes[(i + 1) % n];
    // Convert to meters using lat scaling
    const x1 = curr.lon * 111320 * Math.cos(curr.lat * Math.PI / 180);
    const y1 = curr.lat * 111320;
    const x2 = next.lon * 111320 * Math.cos(next.lat * Math.PI / 180);
    const y2 = next.lat * 111320;
    area += (x1 * y2 - x2 * y1);
  }
  return Math.abs(area) / 2 / 1_000_000; // convert m² to km²
};

const classifyParkSize = (areaKm2) => {
  if (areaKm2 < 0.15) return 'tiny';   // true pocket parks
  if (areaKm2 < 0.5) return 'small';   // neighborhood parks
  if (areaKm2 < 2.0) return 'medium';  // mid-size parks
  return 'large';                        // large parks/preserves
};

const PARK_SIZE_CONFIG = {
  tiny: {
    boundaryBufferMeters: 120,     // tight — avoid grabbing neighboring streets
    bboxPaddingFraction: 0.10,     // wider bbox, filtered precisely afterward
    pointInPolygonThresholds: {    // fraction of nodes that must be inside
      short: 0.70,                 // ways < 10 nodes
      medium: 0.60,                // ways 10-30 nodes
      long: 0.50,                  // ways > 30 nodes
    },
    minWayLengthKm: 0.01,          // include very short connectors
    overpassRadiusFallback: 500,   // if boundary fetch fails
    overpassQueryTimeoutSec: 25,   // trail-fetch [timeout:N] — small way count
    sizeClass: 'tiny',
    defaultTimeBudgetMinutes: null, // no budget — always full coverage
  },
  small: {
    boundaryBufferMeters: 250,
    bboxPaddingFraction: 0.15,
    pointInPolygonThresholds: {
      short: 0.60,
      medium: 0.45,
      long: 0.35,
    },
    minWayLengthKm: 0.02,
    overpassRadiusFallback: 800,
    overpassQueryTimeoutSec: 25,
    sizeClass: 'small',
    defaultTimeBudgetMinutes: null, // no budget — always full coverage
  },
  medium: {
    boundaryBufferMeters: 350,
    bboxPaddingFraction: 0.20,
    pointInPolygonThresholds: {
      short: 0.50,                 // current values
      medium: 0.35,
      long: 0.25,
    },
    minWayLengthKm: 0.02,
    overpassRadiusFallback: 1000,
    overpassQueryTimeoutSec: 30,
    sizeClass: 'medium',
    defaultTimeBudgetMinutes: 180, // 3 hours — only applies once trail network exceeds full-coverage threshold
  },
  large: {
    boundaryBufferMeters: 450,     // bigger buffer for large parks
    bboxPaddingFraction: 0.25,     // wider bbox to catch edge trails
    pointInPolygonThresholds: {
      short: 0.40,                 // more lenient — large parks often have
      medium: 0.25,                // trails that clip the boundary edge
      long: 0.15,
    },
    minWayLengthKm: 0.05,          // filter out very short connectors
    overpassRadiusFallback: 2000,
    // Large parks pull far more trail ways per bbox query — give Overpass
    // more room to process before its own server-side timeout kicks in.
    overpassQueryTimeoutSec: 60,
    sizeClass: 'large',
    defaultTimeBudgetMinutes: 240, // 4 hours flat default; computeTimeBudget scales this by area for large parks specifically
  },
};

// A user-picked time budget (the existing frontend time-budget filter, sent
// as filters.maxTimeMinutes) always wins over any default. Otherwise: no
// budget for tiny/small (routing always covers everything there anyway),
// medium's flat default, and for large parks a value scaled by actual area
// rather than the flat default — a 2 km² "large" park and a 30 km² one
// shouldn't get the same budget. 2 km² -> 180min, 10 km² -> 240min,
// 30+ km² -> 300min (capped).
const computeTimeBudget = (sizeClass, areaKm2, userBudget) => {
  if (userBudget) return userBudget;

  const config = PARK_SIZE_CONFIG[sizeClass];
  if (!config || config.defaultTimeBudgetMinutes == null) return null;
  if (sizeClass !== 'large') return config.defaultTimeBudgetMinutes;

  const area = areaKm2 ?? 2;
  const scaled = 180 + Math.min(120, (area - 2) * 4);
  return Math.round(scaled);
};

// Trails that start just outside the boundary but run inside it get missed
// by an exact-fit bbox — pad each side before querying Overpass. The
// fraction is now per park-size tier (see PARK_SIZE_CONFIG) rather than a
// single fixed ratio.
const padBBox = ({ south, west, north, east }, bboxPaddingFraction) => {
  const latPad = (north - south) * bboxPaddingFraction;
  const lonPad = (east - west) * bboxPaddingFraction;
  return { south: south - latPad, west: west - lonPad, north: north + latPad, east: east + lonPad };
};

// STEP 2 — trails within the park's (now much wider) bounding box. Sidewalks,
// street crossings, and private/no-foot-access ways are excluded at the
// query level; motor_vehicle tracks are excluded too. The dedicated
// sac_scale clause catches hiking-rated paths regardless of their highway
// tag. Precision now comes from these tag filters plus the point-in-polygon
// filter downstream, not from a tight bbox.
const fetchTrailWaysInBBox = async (bbox, bboxPaddingFraction, timeoutSec = 25) => {
  const { south, west, north, east } = padBBox(bbox, bboxPaddingFraction);
  const b = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:${timeoutSec}];(way["highway"="path"]["foot"!="no"]["access"!="private"](${b});way["highway"="footway"]["footway"!="sidewalk"]["footway"!="crossing"]["foot"!="no"]["access"!="private"](${b});way["highway"="track"]["foot"!="no"]["access"!="private"]["motor_vehicle"!="yes"](${b});way["route"="hiking"](${b});way["highway"="path"]["sac_scale"](${b}););(._;>;);out geom;`;
  // Client-side abort needs headroom beyond the query's own [timeout:N],
  // same reasoning as the boundary query's BOUNDARY_CLIENT_TIMEOUT_MS above.
  const data = await fetchOverpassWithRetry(query, (timeoutSec + 5) * 1000);
  return extractWays(data);
};

// STEP 4 fallback — same tag exclusions as Step 2, just centered on the
// point with a radius instead of the (unavailable) park bbox.
const fetchTrailWaysByRadius = async (lat, lon, radius = 1000) => {
  const query = `[out:json];(way["highway"="path"](around:${radius},${lat},${lon});way["highway"="footway"]["footway"!="sidewalk"]["footway"!="crossing"](around:${radius},${lat},${lon});way["highway"="track"](around:${radius},${lat},${lon});way["route"="hiking"](around:${radius},${lat},${lon}););(._;>;);out geom;`;
  const data = await fetchOverpassWithRetry(query);
  return extractWays(data);
};

// STEP 3 — ray-casting point-in-polygon, keep a way only if most of its
// nodes are actually inside the park boundary (this is what filters out the
// street/sidewalk segments that a bbox alone can't exclude).
const isPointInPolygon = (point, polygon) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon, yi = polygon[i].lat;
    const xj = polygon[j].lon, yj = polygon[j].lat;
    const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
      (point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

// Parking lots + restrooms, same bbox as the trail query. Ways (parking lot
// polygons) get reduced to a centroid; nodes are used directly.
const buildAmenitiesQuery = ({ south, west, north, east }) => {
  return `[out:json];(node["amenity"="parking"](${south},${west},${north},${east});way["amenity"="parking"](${south},${west},${north},${east});node["amenity"="toilets"](${south},${west},${north},${east});way["amenity"="toilets"](${south},${west},${north},${east}););(._;>;);out geom;`;
};

const wayCentroid = (points) => ({
  lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
  lon: points.reduce((s, p) => s + p.lon, 0) / points.length
});

// Looser than the 50% trail-way threshold — a parking lot polygon can
// legitimately straddle the boundary edge (entrance off the street) while
// still belonging to the park, so any node landing inside is enough.
const hasNodeInsideBoundary = (points, boundary) => points.some((p) => isPointInPolygon(p, boundary));

// Amenity fetch failures must never take down the loop pipeline — caught
// here and reported as "found nothing" rather than propagating.
const fetchParkAmenities = async (bbox, boundary) => {
  try {
    const data = await fetchOverpassWithRetry(buildAmenitiesQuery(bbox));
    const elements = data.elements || [];

    const parkingLots = [];
    const restrooms = [];
    let unnamedParkingCount = 0;

    for (const el of elements) {
      const tags = el.tags || {};
      if (tags.amenity !== 'parking' && tags.amenity !== 'toilets') continue;

      let point;
      if (el.type === 'node') {
        point = { lat: el.lat, lon: el.lon };
        if (!hasNodeInsideBoundary([point], boundary)) continue;
      } else if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length > 0) {
        const points = el.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
        if (!hasNodeInsideBoundary(points, boundary)) continue;
        point = wayCentroid(points);
      } else {
        continue;
      }

      if (tags.amenity === 'parking') {
        let name = tags.name;
        if (!name) {
          unnamedParkingCount++;
          name = `Parking Area ${unnamedParkingCount}`;
        }
        parkingLots.push({ id: el.id, name, lat: point.lat, lon: point.lon, fee: tags.fee === 'yes' ? 'Paid' : 'Free' });
      } else {
        restrooms.push({ id: el.id, lat: point.lat, lon: point.lon });
      }
    }

    return { parkingLots, restrooms };
  } catch (err) {
    console.error('fetchParkAmenities failed:', err.message);
    return { parkingLots: [], restrooms: [] };
  }
};

// Nearest graph cluster to a given coordinate (e.g. a chosen parking lot) —
// used to anchor findOptimalParkRoute's start/end node. Any edge touching
// a cluster carries that cluster's own point as its coordinates[0].
const findNearestClusterId = (graph, lat, lon) => {
  let best = null;
  let bestDist = Infinity;
  for (const [cluster, edges] of graph) {
    if (edges.length === 0) continue;
    const point = edges[0].coordinates[0];
    const dist = calcDistance(lat, lon, point.lat, point.lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = cluster;
    }
  }
  return best;
};

// Overpass draws a park's boundary way independently of its trail network —
// a real, named trail can legitimately run just outside the formal polygon
// edge. Only used for the boundary filter below — the original, unbuffered
// polygon is still used everywhere else (centroid picks, bbox, area
// validation).
//
// Shoelace sign convention: sum of (x2-x1)(y2+y1) is positive for a
// clockwise ring, negative for counter-clockwise.
const isClockwise = (nodes) => {
  let sum = 0;
  for (let i = 0; i < nodes.length; i++) {
    const curr = nodes[i];
    const next = nodes[(i + 1) % nodes.length];
    sum += (next.lon - curr.lon) * (next.lat + curr.lat);
  }
  return sum > 0;
};

// True perpendicular edge offset (miter join) rather than radial-from-centroid
// scaling — that approach only guarantees each *vertex* moves bufferMeters
// from the centroid, not that each *edge* ends up bufferMeters from its
// original position, so far-from-centroid or sparsely-vertexed edges could
// end up under-buffered. This offsets each vertex along the bisector of its
// two adjacent edge normals, which tracks the actual edge distance instead.
const expandPolygon = (polygonNodes, bufferMeters) => {
  // Remove closing duplicate vertex (OSM closed ways repeat first node at end)
  const nodes = (
    polygonNodes.length > 1 &&
    polygonNodes[0].lat === polygonNodes[polygonNodes.length - 1].lat &&
    polygonNodes[0].lon === polygonNodes[polygonNodes.length - 1].lon
  ) ? polygonNodes.slice(0, -1) : polygonNodes;

  const n = nodes.length;
  const flip = isClockwise(nodes) ? -1 : 1;
  const result = [];

  for (let i = 0; i < n; i++) {
    const prev = nodes[(i - 1 + n) % n];
    const curr = nodes[i];
    const next = nodes[(i + 1) % n];

    // Convert lat/lon offsets to approximate meters
    const metersPerLat = 111320;
    const metersPerLon = 111320 * Math.cos(curr.lat * Math.PI / 180);

    // Vector from prev to curr (edge 1)
    const dx1 = (curr.lon - prev.lon) * metersPerLon;
    const dy1 = (curr.lat - prev.lat) * metersPerLat;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    if (len1 === 0) {
      result.push({ lat: curr.lat, lon: curr.lon });
      continue;
    }
    // Perpendicular normal of edge 1 (pointing outward for CCW polygon)
    const nx1 = flip * (dy1 / len1);
    const ny1 = flip * (-dx1 / len1);

    // Vector from curr to next (edge 2)
    const dx2 = (next.lon - curr.lon) * metersPerLon;
    const dy2 = (next.lat - curr.lat) * metersPerLat;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    if (len2 === 0) {
      result.push({ lat: curr.lat, lon: curr.lon });
      continue;
    }
    // Perpendicular normal of edge 2
    const nx2 = flip * (dy2 / len2);
    const ny2 = flip * (-dx2 / len2);

    // Miter: average the two normals and scale to buffer distance
    const mx = nx1 + nx2;
    const my = ny1 + ny2;
    const mLen = Math.sqrt(mx * mx + my * my);

    // Cap miter length to avoid extreme spikes at sharp corners
    const miterScale = mLen > 0
      ? Math.min(bufferMeters / mLen, bufferMeters * 2)
      : bufferMeters;

    result.push({
      lat: curr.lat + (my / (mLen || 1)) * miterScale / metersPerLat,
      lon: curr.lon + (mx / (mLen || 1)) * miterScale / metersPerLon,
    });
  }

  return result;
};

// Longer ways are more likely to be genuine named trails that clip the
// boundary edge; short ways failing a loose threshold are more likely to be
// sidewalks/connectors that are genuinely outside the park. Thresholds are
// per park-size tier (see PARK_SIZE_CONFIG) rather than fixed.
const boundaryInsideThreshold = (nodeCount, thresholds) => {
  if (nodeCount < 10) return thresholds.short;
  if (nodeCount <= 30) return thresholds.medium;
  return thresholds.long;
};

const getBoundingBox = (polygon) => {
  const bbox = computeBBox(polygon);
  return { ...bbox, centerLat: (bbox.north + bbox.south) / 2 };
};

const expandBoundingBox = (box, meters) => {
  const latDelta = meters / 111320;
  const lonDelta = meters / (111320 * Math.cos(box.centerLat * Math.PI / 180));
  return {
    north: box.north + latDelta,
    south: box.south - latDelta,
    east: box.east + lonDelta,
    west: box.west - lonDelta,
    centerLat: box.centerLat,
  };
};

const RESCUE_EXPANSION_METERS = 300;
const RESCUE_FRACTION_THRESHOLD = 0.6;

// Some OSM boundary ways just don't cover a park's full named trail network
// (confirmed for Parker Woods' "A Loop" — the boundary is ~207m short of
// where it's actually mapped). Rather than widening the buffer further for
// every park, rescue specific EXCLUDED named ways when either another
// segment of the same named trail already passed, or most of this way's own
// nodes still sit within a generous 300m bounding-box margin around the
// boundary. Unnamed ways are never rescued — this targets known real named
// trails clipping a boundary gap, not "anything nearby."
const rescueNamedTrails = (excludedWays, passedWays, boundaryPolygon) => {
  const rescued = [];
  const expandedBox = expandBoundingBox(getBoundingBox(boundaryPolygon), RESCUE_EXPANSION_METERS);

  for (const way of excludedWays) {
    if (!way.name) continue;

    const sameNamePassed = passedWays.some((w) => w.name === way.name);

    const nodesInExpandedBox = way.geometry.filter((n) =>
      n.lat >= expandedBox.south &&
      n.lat <= expandedBox.north &&
      n.lon >= expandedBox.west &&
      n.lon <= expandedBox.east
    ).length;
    const fractionInBox = nodesInExpandedBox / way.geometry.length;

    if (sameNamePassed || fractionInBox >= RESCUE_FRACTION_THRESHOLD) {
      rescued.push(way);
    }
  }

  return rescued;
};

const filterWaysByBoundary = (ways, boundary, config) => {
  const expandedBoundary = expandPolygon(boundary, config.boundaryBufferMeters);

  const passed = [];
  const failed = [];
  for (const way of ways) {
    const total = way.geometry.length;
    if (total === 0) {
      failed.push(way);
      continue;
    }
    const insideCount = way.geometry.filter((p) => isPointInPolygon(p, expandedBoundary)).length;
    if (insideCount / total >= boundaryInsideThreshold(total, config.pointInPolygonThresholds)) {
      passed.push(way);
    } else {
      failed.push(way);
    }
  }

  const excludedNamedWays = failed.filter((w) => w.name).map((w) => w.name);
  console.log(`[TrailFilter] ${passed.length} ways passed, ${failed.length} failed. ` +
    `Named ways excluded: ${excludedNamedWays.join(', ') || 'none'}`);

  const rescued = rescueNamedTrails(failed, passed, boundary);
  console.log(`[TrailFilter] Rescued named trails: ${rescued.map((w) => w.name).join(', ') || 'none'}`);

  return [...passed, ...rescued];
};

// The angle of the line from a way's first to last node, normalized to
// 0-180° (a line has no "forward" direction, so 10° and 190° are the same).
const computeBearing = (lat1, lon1, lat2, lon2) => {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const lat1R = lat1 * Math.PI / 180;
  const lat2R = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2R);
  const x = Math.cos(lat1R) * Math.sin(lat2R) -
             Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLon);
  const bearing = Math.atan2(y, x) * 180 / Math.PI;
  return Math.abs(bearing) % 180; // normalize to 0-180°
};

const wayBearing = (way) => {
  const first = way.geometry[0];
  const last = way.geometry[way.geometry.length - 1];
  return computeBearing(first.lat, first.lon, last.lat, last.lon);
};

const medianOf = (nums) => {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Bearings live on a 0-180° axis where 0° and 180° are the same direction,
// so the gap between two bearings wraps around at that boundary.
const bearingDiff = (a, b) => {
  const diff = Math.abs(a - b);
  return Math.min(diff, 180 - diff);
};

const ORIENTATION_TOLERANCE_DEGREES = 45;
const MIN_UNNAMED_AFTER_ORIENTATION = 3;

// Named ways (real trail names) keep short segments — loop connectors like
// "A Loop" matter even when brief. Unnamed ways need 3x the length (a short
// unnamed way is more likely a sidewalk stub than a real trail) and, when
// there are enough named ways to establish a reference direction, must run
// in a broadly similar direction to them — a street crossing at an angle to
// the park's own trail network stands out and gets dropped.
const applyNamedUnnamedFilters = (boundaryFilteredWays, config) => {
  const withDistances = boundaryFilteredWays.map((w) => ({ ...w, distanceKm: computeWayDistanceKm(w) }));

  const namedWays = withDistances.filter((w) => w.name && w.distanceKm > config.minWayLengthKm);
  const unnamedCandidates = withDistances.filter((w) => !w.name && w.distanceKm > config.minWayLengthKm * 3);

  let unnamedWays = unnamedCandidates;
  if (namedWays.length > 0) {
    const referenceBearing = medianOf(namedWays.map(wayBearing));
    const orientationFiltered = unnamedCandidates.filter(
      (w) => bearingDiff(wayBearing(w), referenceBearing) <= ORIENTATION_TOLERANCE_DEGREES
    );
    // Too few named ways to trust the reference direction — skip the
    // orientation filter rather than over-prune a small park's trails.
    if (orientationFiltered.length >= MIN_UNNAMED_AFTER_ORIENTATION) {
      unnamedWays = orientationFiltered;
    }
  }

  console.log(`[TrailFilter] Named: ${namedWays.length} passed, ` +
    `Unnamed: ${unnamedWays.length} passed (after length filter)`);

  return [...namedWays, ...unnamedWays];
};

const wayToRawTrail = (w) => ({ id: w.id, coordinates: w.geometry.map((p) => [p.lat, p.lon]) });

// Overpass-dependent fetch step (boundary + trail ways + amenities) for a
// park location — independent of any parking-lot start-node choice or loop
// filters, so it's cached per lat/lon and reused across those.
const buildParkTrailData = async (lat, lon) => {
  const boundary = await fetchParkBoundary(lat, lon);

  if (!boundary) {
    // STEP 4 — no reliable polygon to filter against, so don't attempt loop
    // detection on possibly-noisy data; just show the raw segments as-is.
    // No polygon means no area to classify, so default to medium for every
    // size-dependent parameter used in this branch.
    console.log(`[ParkSize] No boundary found — defaulting to medium config`);
    const config = PARK_SIZE_CONFIG.medium;
    const ways = attachWayDistances(await fetchTrailWaysByRadius(lat, lon, config.overpassRadiusFallback), config.minWayLengthKm);
    return {
      boundary: null,
      ways,
      parkingLots: [],
      restrooms: [],
      rawTrailColor: 'gray',
      message: 'Showing nearby trails — park boundary unavailable for precise filtering.',
      parkSize: 'medium',
      parkAreaKm2: null
    };
  }

  const areaKm2 = computePolygonAreaKm2(boundary);
  const sizeClass = classifyParkSize(areaKm2);
  console.log(`[ParkSize] Park: ${areaKm2.toFixed(3)} km² → ${sizeClass}`);
  const config = PARK_SIZE_CONFIG[sizeClass];

  const bbox = computeBBox(boundary);
  const [boundedWays, amenities] = await Promise.all([
    fetchTrailWaysInBBox(bbox, config.bboxPaddingFraction, config.overpassQueryTimeoutSec),
    fetchParkAmenities(bbox, boundary)
  ]);
  const ways = applyNamedUnnamedFilters(filterWaysByBoundary(boundedWays, boundary, config), config);

  return {
    boundary,
    ways,
    parkingLots: amenities.parkingLots,
    restrooms: amenities.restrooms,
    rawTrailColor: null,
    message: null,
    parkSize: sizeClass,
    parkAreaKm2: Math.round(areaKm2 * 1000) / 1000
  };
};

// Cheap, network-light (elevation-only) compute step: given already-fetched
// trail data, pick a start node (optionally overridden by a parking-lot
// coordinate) and run loop detection. Returns exactly one of:
//  - { route: {...}, rawTrails: [], rawTrailColor: null, message: null }                  — normal case
//  - { route: null, rawTrails: [...], rawTrailColor: 'gray', message: '...' }              — step 4 (no boundary)
//  - { route: null, rawTrails: [...], rawTrailColor: 'green', message: '...' }             — step 5 (boundary found, route calc failed)
//  - { route: null, rawTrails: [], rawTrailColor: null, message: '...' }                   — genuinely nothing found
const NO_STRATEGY_FIELDS = { routingStrategy: null, timeBudgetMinutes: null, trailCoveragePercent: null, totalParkTrailKm: null };

const buildParkLoopData = async (trailData, parkingLat = null, parkingLon = null, filters = {}) => {
  const { boundary, ways } = trailData;

  if (!boundary) {
    return {
      route: null,
      rawTrails: ways.map(wayToRawTrail),
      rawTrailColor: trailData.rawTrailColor,
      message: trailData.message,
      ...NO_STRATEGY_FIELDS
    };
  }

  if (ways.length === 0) {
    return { route: null, rawTrails: [], rawTrailColor: null, message: 'No trail data found for this park', ...NO_STRATEGY_FIELDS };
  }

  let startNode = null;
  if (parkingLat != null && parkingLon != null) {
    const graph = buildTrailGraph(ways);
    startNode = findNearestClusterId(graph, parkingLat, parkingLon);
  }

  const timeBudgetMinutes = computeTimeBudget(trailData.parkSize, trailData.parkAreaKm2, filters.maxTimeMinutes);
  const rawRoute = findOptimalParkRoute(ways, filters, startNode, trailData.parkSize, timeBudgetMinutes);

  if (!rawRoute) {
    return {
      route: null,
      rawTrails: ways.map(wayToRawTrail),
      rawTrailColor: 'green',
      message: 'Could not calculate a route for this park — showing all trails instead.',
      ...NO_STRATEGY_FIELDS
    };
  }

  // Elevation is fetched once for the whole finished route — same approach
  // the old per-loop system used — rather than per trail segment.
  const elevationGainM = await getElevationGainAlongPath(rawRoute.geometry.map(([lat, lon]) => ({ lat, lon })));
  const elevationGainFt = Math.round(elevationGainM * 3.28084);
  const difficulty = getLoopDifficulty(elevationGainFt, rawRoute.totalDistanceMi);

  const route = { ...rawRoute, elevationGain: elevationGainM, elevationGainFt, difficulty };
  const trailCoveragePercent = rawRoute.totalParkTrailKm > 0
    ? Math.round((rawRoute.coveredTrailKm / rawRoute.totalParkTrailKm) * 1000) / 10
    : null;

  return {
    route,
    rawTrails: [],
    rawTrailColor: null,
    message: null,
    routingStrategy: rawRoute.routingStrategy,
    // Only meaningful once a budget is actually being enforced — full
    // coverage routes every trail regardless of any computed budget.
    timeBudgetMinutes: rawRoute.routingStrategy === 'budget_subnetwork' ? timeBudgetMinutes : null,
    trailCoveragePercent,
    totalParkTrailKm: rawRoute.totalParkTrailKm,
  };
};

const getParkLoops = async (req, res) => {
  try {
    const { lat, lon, difficulty, activity, parkingLat, parkingLon } = req.query;
    if (!lat || !lon) {
      return res.status(400).json({ message: 'lat and lon are required' });
    }
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);

    // Single-route filters need one concrete cutoff, not a multi-select
    // ranking signal — if several difficulties/activities are selected,
    // the most permissive (highest) one is used as the ceiling.
    const difficultyOrder = ['Easy', 'Moderate', 'Hard', 'Expert'];
    const difficultyValue = parseFilterParam(difficulty)
      .sort((a, b) => difficultyOrder.indexOf(b) - difficultyOrder.indexOf(a))[0] || null;
    const activityOptions = parseFilterParam(activity);
    const activityValue = activityOptions.length === 1 ? activityOptions[0] : null;

    // Primary path: the frontend's time-budget filter sends maxTimeMinutes
    // directly. Fallback: a legacy maxDistance-in-miles param, converted at
    // the same 2mph pace used everywhere else in this app.
    const maxTimeMinutes = req.query.maxTimeMinutes ? parseFloat(req.query.maxTimeMinutes)
      : (req.query.maxDistance ? (parseFloat(req.query.maxDistance) / 2) * 60 : null);
    const elevationOrder = req.query.elevationOrder || null;

    const filters = { difficulty: difficultyValue, activity: activityValue, maxTimeMinutes, elevationOrder };

    const parkingLatN = parkingLat !== undefined ? parseFloat(parkingLat) : NaN;
    const parkingLonN = parkingLon !== undefined ? parseFloat(parkingLon) : NaN;
    const hasParkingStart = !Number.isNaN(parkingLatN) && !Number.isNaN(parkingLonN);

    // Overpass-dependent fetch (boundary/ways/amenities) is cached per
    // lat/lon only — it doesn't depend on the chosen start node or filters.
    const trailCacheKey = `trail-v3-${latN.toFixed(3)}-${lonN.toFixed(3)}`;
    let trailData = getCached(trailCacheKey);
    if (!trailData) {
      trailData = await buildParkTrailData(latN, lonN);
      setCache(trailCacheKey, trailData);
    }

    // The route genuinely differs per start node and per filter set, so
    // that (network-light but not free — it still fetches elevation)
    // computation is cached separately from the Overpass fetch above.
    const startNodeKey = hasParkingStart ? `p${parkingLatN.toFixed(5)}-${parkingLonN.toFixed(5)}` : 'default';
    const filterKey = `${difficultyValue || 'any'}-${activityValue || 'any'}-${maxTimeMinutes || 'any'}-${elevationOrder || 'any'}`;
    const routeCacheKey = `route-${latN.toFixed(3)}-${lonN.toFixed(3)}-${startNodeKey}-${filterKey}`;
    let cached = getCached(routeCacheKey);
    if (!cached) {
      cached = await buildParkLoopData(trailData, hasParkingStart ? parkingLatN : null, hasParkingStart ? parkingLonN : null, filters);
      setCache(routeCacheKey, cached);
    }

    const { route, rawTrails, rawTrailColor, message, routingStrategy, timeBudgetMinutes, trailCoveragePercent, totalParkTrailKm } = cached;
    const { parkingLots, restrooms, parkSize, parkAreaKm2 } = trailData;
    const restroomCount = restrooms.length;

    res.json({
      route, rawTrails, rawTrailColor, message, parkingLots, restrooms, restroomCount, parkSize, parkAreaKm2,
      routingStrategy, timeBudgetMinutes, trailCoveragePercent, totalParkTrailKm
    });
  } catch (error) {
    console.error(error);

    const isOverpassDown = error.message.includes('Overpass request failed')
      || error.message.includes('overpass');

    if (isOverpassDown) {
      return res.status(503).json({
        error: 'trail_data_unavailable',
        message: 'Trail data is temporarily unavailable. The OpenStreetMap ' +
                 'data service is not responding. Please try again in a few minutes.',
        retryable: true,
      });
    }

    res.status(500).json({
      error: 'loop_calculation_failed',
      message: 'Could not calculate trail loops for this park.',
      retryable: false,
    });
  }
};

// Standalone amenities lookup — same boundary + amenity fetch as
// getParkLoops, but independent so the frontend can fetch it separately if
// needed without going through the full loop-calculation pipeline.
const getParkAmenities = async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
      return res.status(400).json({ message: 'lat and lon are required' });
    }
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);

    const boundary = await fetchParkBoundary(latN, lonN);
    if (!boundary) {
      return res.json({ parkingLots: [], restrooms: [], restroomCount: 0 });
    }

    const bbox = computeBBox(boundary);
    const amenities = await fetchParkAmenities(bbox, boundary);
    res.json({ parkingLots: amenities.parkingLots, restrooms: amenities.restrooms, restroomCount: amenities.restrooms.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to load park amenities' });
  }
};

// Get the current user's saved trails
const getSavedTrails = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('savedTrails');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ savedTrails: user.savedTrails });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to load saved trails' });
  }
};

// Save a trail (no-op if already saved)
const saveTrail = async (req, res) => {
  try {
    const { trailId, name, difficulty, distanceMiles, parkOsmType, parkOsmId, parkLat, parkLon, parkName } = req.body;
    if (!trailId || !name) {
      return res.status(400).json({ message: 'Missing trail details' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const alreadySaved = user.savedTrails.some((t) => t.trailId === trailId);
    if (!alreadySaved) {
      user.savedTrails.push({ trailId, name, difficulty, distanceMiles, parkOsmType, parkOsmId, parkLat, parkLon, parkName });
      await user.save();
    }

    res.json({ savedTrails: user.savedTrails });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to save trail' });
  }
};

// Unsave a trail
const unsaveTrail = async (req, res) => {
  try {
    const { trailId } = req.params;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.savedTrails = user.savedTrails.filter((t) => t.trailId !== trailId);
    await user.save();

    res.json({ savedTrails: user.savedTrails });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to unsave trail' });
  }
};

module.exports = {
  searchTrails,
  getTrailDetail,
  getRecentSearches,
  addRecentSearch,
  reverseGeocode,
  performParkSearch,
  performDriveTimeSearch,
  geocodeLocation,
  getParkLoops,
  getParkAmenities,
  getSavedTrails,
  saveTrail,
  unsaveTrail
};