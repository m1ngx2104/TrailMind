const OpenAI = require('openai');
const { performParkSearch, performDriveTimeSearch, geocodeLocation } = require('./trailController');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VALID_DIFFICULTIES = ['Easy', 'Moderate', 'Hard', 'Expert'];
const VALID_ACTIVITIES = ['Hiking', 'Trail Running', 'Backpacking'];

const SYSTEM_PROMPT = `
You are TrailMind's hiking assistant. Extract structured search parameters
from the user's message and conversation history.

Respond ONLY with a JSON object of this exact shape:
{
  "reply": "<1-3 sentence conversational reply>",
  "location": "<searchable place name like 'Denver, Colorado', or null>",
  "difficulty": "<Easy, Moderate, Hard, Expert, or null>",
  "activityType": "<Hiking, Trail Running, Backpacking, or null>",
  "features": ["<keywords like 'waterfall', 'lake', 'views'>"],
  "driveTimeMinutes": <integer minutes, or null>,
  "driveFromLocation": "<place name to drive FROM, or 'current_location' if user says 'from my place'/'from here'/'from me', or null>",
  "searchRadius": <radius in km derived from drive time, or null>
}

Rules:
- location = WHERE the trails/parks are (the destination)
- driveFromLocation = WHERE the user is driving FROM
- If user says "30 min drive from Denver" → location=null,
  driveFromLocation="Denver", driveTimeMinutes=30
- If user says "trails near me within 1 hour drive" → location=null,
  driveFromLocation="current_location", driveTimeMinutes=60
- If user says "find trails in Rocky Mountain National Park" →
  location="Rocky Mountain National Park", driveFromLocation=null
- If the user says "near X" or "in X" or "around X" with NO mention of
  driving, minutes, or hours at all, that is a plain destination search:
  set location=X and leave BOTH driveFromLocation and driveTimeMinutes
  null. Do not invent a drive time or treat X as driveFromLocation just
  because "near"/"in" was used — only set driveFromLocation/driveTimeMinutes
  when the user actually mentions a drive/commute time.
- Convert drive time to approximate search radius:
  30 min → 40km, 1 hour → 80km, 2 hours → 160km
  Store this as searchRadius.
- Use conversation history to remember location/difficulty already given.
- If no location AND no driveFromLocation given at all, ask for one.
- features: extract specific trail features mentioned
  (waterfall, lake, river, views, summit, forest, meadow,
  wildlife, bridge, cave, beach, canyon, desert)
- Keep "reply" friendly and confirm what you're searching for.
`;

const chat = async (req, res) => {
  try {
    const { message, date, history, homepageLocation } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'message is required' });
    }
    const hikeDate = date || new Date().toISOString().split('T')[0];

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(Array.isArray(history) ? history.slice(-10) : [])
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.4
    });

    let parsed;
    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch (err) {
      parsed = {};
    }

    const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : "Here's what I found.";
    const location = typeof parsed.location === 'string' && parsed.location.trim()
      ? parsed.location.trim()
      : null;
    const difficulty = VALID_DIFFICULTIES.includes(parsed.difficulty) ? parsed.difficulty : null;
    const activityType = VALID_ACTIVITIES.includes(parsed.activityType) ? parsed.activityType : null;
    const features = Array.isArray(parsed.features)
      ? parsed.features.filter((f) => typeof f === 'string' && f.trim()).slice(0, 5)
      : [];
    const driveFromLocation = typeof parsed.driveFromLocation === 'string' && parsed.driveFromLocation.trim()
      ? parsed.driveFromLocation.trim()
      : null;
    const driveTimeMinutes = Number.isFinite(parsed.driveTimeMinutes) && parsed.driveTimeMinutes > 0
      ? Math.round(parsed.driveTimeMinutes)
      : null;
    // The model is asked to derive searchRadius itself, but arithmetic from
    // an LLM isn't fully reliable — recompute from the same linear
    // relationship its own prompt examples imply (30->40, 60->80, 120->160,
    // i.e. radius = minutes * 4/3) so a bad model value can't silently break
    // the fallback-radius path.
    const searchRadius = driveTimeMinutes ? Math.round(driveTimeMinutes * (4 / 3)) : null;

    const extracted = { difficulty, activityType, features, driveTimeMinutes, driveFromLocation, searchRadius };

    const isDriveTimeSearch = !!(driveFromLocation && driveTimeMinutes);

    if (!isDriveTimeSearch && !location && !driveFromLocation && !homepageLocation) {
      return res.json({ reply, parks: [], location: null, extracted });
    }

    // Location resolution priority:
    // 1. driveFromLocation === 'current_location' -> homepageLocation as origin
    // 2. driveFromLocation is a place name -> geocode it as origin
    // 3. location extracted from message -> destination directly
    // 4. no location in message -> homepageLocation as destination
    // 5. still nothing -> ask (handled above)
    let searchResult;
    let attemptedLocationName = null;
    try {
      if (isDriveTimeSearch) {
        attemptedLocationName = driveFromLocation === 'current_location' ? homepageLocation : driveFromLocation;
        if (!attemptedLocationName) {
          return res.json({
            reply: `${reply} (I don't know your current location yet — enable location on the homepage, or tell me a city to drive from.)`,
            parks: [],
            location: null,
            extracted
          });
        }
        const origin = await geocodeLocation(attemptedLocationName);
        searchResult = await performDriveTimeSearch({
          originLat: origin.lat,
          originLon: origin.lon,
          originDisplayName: origin.displayName,
          date: hikeDate,
          driveTimeMinutes,
          searchRadius,
          difficulty: difficulty || undefined,
          activity: activityType || undefined,
          features
        });
      } else {
        // Safety net: the model sometimes puts a plain "near X" location
        // into driveFromLocation instead of location even when it correctly
        // leaves driveTimeMinutes null (verified — a prompt rule alone
        // didn't fully stop this). Since there's no real drive time here,
        // driveFromLocation in this branch is really just the destination.
        attemptedLocationName = location || driveFromLocation || homepageLocation;
        searchResult = await performParkSearch({
          location: attemptedLocationName,
          date: hikeDate,
          difficulty: difficulty || undefined,
          activity: activityType || undefined,
          features
        });
      }
    } catch (searchErr) {
      return res.json({
        reply: `${reply} (I had trouble finding "${attemptedLocationName}" — try naming a nearby city or region.)`,
        parks: [],
        location: attemptedLocationName || null,
        extracted
      });
    }

    // Circle-mode search shares one weather reading across all parks (same
    // as before); drive-time search already attaches its own per-park
    // weather internally, so it isn't overwritten here.
    let parks = searchResult.parks.slice(0, 4);
    if (!isDriveTimeSearch) {
      parks = parks.map((p) => ({ ...p, weather: searchResult.weather }));
    }

    const finalReply = searchResult.matchedFeatures && searchResult.matchedFeatures.length > 0
      ? `${reply} (Found parks with ${searchResult.matchedFeatures.join(', ')} nearby.)`
      : reply;

    res.json({
      reply: finalReply,
      parks,
      location: searchResult.location,
      extracted
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Chat request failed. Please try again.' });
  }
};

module.exports = { chat };
