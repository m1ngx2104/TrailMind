const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const User = require('../models/user');

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
const searchParksGeoapify = async (lat, lon, radius = 15000) => {
  const key = process.env.GEOAPIFY_API_KEY;
  const categories = 'leisure.park.nature_reserve,natural.forest,natural.protected_area,national_park';
  const url = `https://api.geoapify.com/v2/places?categories=${categories}&filter=circle:${lon},${lat},${radius}&limit=25&apiKey=${key}`;
  console.log('Fetching parks from:', url);
  const res = await fetch(url);
  const data = await res.json();
  console.log('Parks response:', JSON.stringify(data).slice(0, 300));
  return data.features || [];
};

// Search trails using Geoapify Places API
const searchTrailsGeoapify = async (lat, lon, radius = 15000) => {
  const key = process.env.GEOAPIFY_API_KEY;
  const categories = 'highway.path,highway.track,leisure.park.nature_reserve';
  const url = `https://api.geoapify.com/v2/places?categories=${categories}&filter=circle:${lon},${lat},${radius}&limit=30&apiKey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.features || [];
};

// Build the full candidate park list (with derived filter attributes) for a
// location, independent of any filters — this is what gets cached, so
// filters can be applied fresh on every request without re-hitting Geoapify.
const buildParkCandidates = async (coords) => {
  const parkFeatures = await searchParksGeoapify(coords.lat, coords.lon);
  const trailFeatures = await searchTrailsGeoapify(coords.lat, coords.lon, 15000);

  const excludeKeywords = ['sports complex', 'baseball', 'soccer', 'football', 'golf course', 'tennis', 'swimming', 'stadium', 'arena', 'gym', 'fitness', 'school', 'elementary', 'middle school', 'high school', 'church', 'parking'];
  const seenParks = new Set();
  const candidates = [];

  for (const feature of parkFeatures) {
    const props = feature.properties;
    const name = props.name;
    if (!name || seenParks.has(name)) continue;

    const nameLower = name.toLowerCase();
    if (excludeKeywords.some(keyword => nameLower.includes(keyword))) continue;

    seenParks.add(name);

    const [parkLon, parkLat] = feature.geometry.coordinates;

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
      location: coords.displayName.split(',').slice(0, 3).join(','),
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

const searchTrails = async (req, res) => {
  try {
    const { location, date, difficulty, length, elevation, activity } = req.query;
    if (!location || !date) {
      return res.status(400).json({ message: 'Location and date are required' });
    }

    const difficultyFilter = parseFilterParam(difficulty);
    const lengthFilter = parseFilterParam(length);
    const elevationFilter = parseFilterParam(elevation);
    const activityFilter = parseFilterParam(activity);

    const matchesFilters = (park) => {
      if (difficultyFilter.length && !difficultyFilter.includes(park.difficulties[0])) return false;
      if (lengthFilter.length && !lengthFilter.includes(park.lengthBucket)) return false;
      if (elevationFilter.length && !elevationFilter.includes(park.elevationBucket)) return false;
      if (activityFilter.length && !park.activities.some((a) => activityFilter.includes(a))) return false;
      return true;
    };

    const coords = await geocodeLocation(location);
    const cacheKey = `${coords.lat.toFixed(3)}-${coords.lon.toFixed(3)}`;

    let cached = getCached(cacheKey);
    if (!cached) {
      const allParks = await buildParkCandidates(coords);
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
    const parks = cached.allParks.filter(matchesFilters).slice(0, 8);

    res.json({
      location: cached.location,
      coords: cached.coords,
      date,
      weather,
      weatherWarning,
      parks
    });

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

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.recentSearches = user.recentSearches.filter(
      (s) => !(s.osmType === osmType && s.osmId === osmId)
    );
    user.recentSearches.unshift({ osmType, osmId, name, lat, lon, location });
    user.recentSearches = user.recentSearches.slice(0, 4);
    await user.save();

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

module.exports = { searchTrails, getTrailDetail, getRecentSearches, addRecentSearch, reverseGeocode };