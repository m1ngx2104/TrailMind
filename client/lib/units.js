const STORAGE_KEY = 'trailmind:units';
export const UNITS_CHANGED_EVENT = 'trailmind:units-changed';

export const getUnitPreference = () => {
  if (typeof window === 'undefined') return 'imperial';
  return localStorage.getItem(STORAGE_KEY) || 'imperial';
};

// Updates the local unit preference and notifies any mounted pages.
// Does not talk to the backend — callers handle syncing to the account.
export const setUnitPreference = (unit) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, unit);
  window.dispatchEvent(new CustomEvent(UNITS_CHANGED_EVENT, { detail: unit }));
};

// Server sends distance as a formatted km string, e.g. "0.8 – 1.9 km" or "Varies".
export const formatDistanceRange = (distanceRangeKm, unit) => {
  if (!distanceRangeKm) return distanceRangeKm;
  if (unit === 'metric') return distanceRangeKm;
  const numbers = distanceRangeKm.match(/\d+\.?\d*/g);
  if (!numbers) return distanceRangeKm;
  const miles = numbers.map((n) => (parseFloat(n) * 0.621371).toFixed(1));
  return miles.length === 1 ? `${miles[0]} mi` : `${miles[0]} – ${miles[1]} mi`;
};

export const formatElevation = (meters, unit) => {
  if (meters == null) return meters;
  return unit === 'metric' ? `${Math.round(meters)} m` : `${Math.round(meters * 3.28084)} ft`;
};

export const formatTemp = (celsius, unit) => {
  if (celsius == null) return celsius;
  return unit === 'metric' ? `${Math.round(celsius)}C` : `${Math.round((celsius * 9) / 5 + 32)}F`;
};
