const OpenAI = require('openai');
const { performParkSearch, performDriveTimeSearch, geocodeLocation } = require('./trailController');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VALID_DIFFICULTIES = ['Easy', 'Moderate', 'Hard', 'Expert'];
const VALID_ACTIVITIES = ['Hiking', 'Trail Running', 'Backpacking'];

// Extended from the original prompt with refinement/exclusion/weather/
// feature rules (per spec), while keeping the drive-time disambiguation
// rules from before — those aren't decorative: gpt-4o-mini reliably (and
// reproducibly, verified earlier) misclassified plain "near X" searches as
// drive-time searches without that explicit rule, and dropping it here would
// silently reintroduce that bug. searchRadius was dropped from the schema
// since the code already recomputes it deterministically from
// driveTimeMinutes rather than trusting the model's own arithmetic.
const SYSTEM_PROMPT = `
You are TrailMind's hiking assistant. Extract structured search parameters
from the user's message and conversation history.

Respond ONLY with a JSON object of this exact shape:
{
  "reply": "<1-3 sentence conversational reply>",
  "location": "<searchable place name like 'Denver, Colorado', or null>",
  "difficulty": "<Easy, Moderate, Hard, Expert, or null>",
  "activityType": "<Hiking, Trail Running, Backpacking, or null>",
  "features": ["<waterfall, lake, river, views, summit, forest, beach>"],
  "driveTimeMinutes": <integer minutes, or null>,
  "driveFromLocation": "<place name to drive FROM, or 'current_location' if user says 'from my place'/'from here'/'from me', or null>",
  "maxDistanceMiles": <max hike length in miles implied by the request, or null>,
  "minDistanceMiles": <min hike length in miles implied by the request, or null>,
  "excludeParkNames": ["<names of parks already shown that should not appear again>"],
  "refinementType": "<null | 'shorter' | 'longer' | 'easier' | 'harder' | 'closer' | 'different' | 'similar'>",
  "similarToPark": "<park name to find similar parks to, or null>",
  "weatherWarning": "<null or a 1-sentence weather note if date is very hot/cold/rainy>"
}

LOCATION / DRIVE-TIME RULES:
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
- Always carry location forward from previous messages in the conversation
  unless the user gives a new one — this applies to refinement messages too
  (a refinement narrows the current location's results, it is not a new
  search, so never drop the carried-forward location when handling one).
- If user says "near me" with no location anywhere earlier in the
  conversation, use the homepage location provided separately.
- If no location AND no driveFromLocation given at all (including from
  history), ask for one in "reply".

IMPORTANT DISAMBIGUATION — distance filters are not drive time:
- "under X miles" / "within X miles" / "less than X miles"
  → maxDistanceMiles: X, driveFromLocation: null.
  This is a DISTANCE FILTER, not a drive time request.
- "over X miles away" / "farther than X miles" / "more than X miles"
  → minDistanceMiles: X, driveFromLocation: null.
  This is a DISTANCE FILTER, not a drive time request.
- Only set driveFromLocation when the user explicitly mentions DRIVING or
  COMMUTE TIME: "30 min drive", "1 hour away by car", "within driving
  distance" → driveFromLocation + driveTimeMinutes.
- "from the city" / "from here" / "away" used WITHOUT any mention of
  driving time is describing distance from the search location, not a
  place to drive from — treat it as context for the search location, NOT
  as driveFromLocation.
- CRITICAL: any of these distance phrases that include "from the city" /
  "from here" / "away" (e.g. "under 2 miles from the city", "over 10 miles
  away", "farther than 5 miles from here") ALWAYS set
  refinementType: "closer" — even if the wording also resembles the
  "longer"/"shorter" examples below. "away"/"from X" means measured from
  the search location, which is what refinementType "closer" applies the
  distance to; it is never "longer" or "shorter" (those are for hike
  length, and only apply when there is NO "from X"/"away" qualifier at
  all, e.g. a bare "under 3 miles" or "I want more miles").

REFINEMENT RULES (the user is narrowing/adjusting results already shown):
- "show me something shorter" / "under 3 miles" (no "from X"/"away") /
  "quick hike" → refinementType: "shorter", maxDistanceMiles: 3
- "something longer" / "I want more miles" (no "from X"/"away")
  → refinementType: "longer", minDistanceMiles: 5
- "easier" → refinementType: "easier", difficulty: "Easy"
- "harder" / "more challenging" → refinementType: "harder"
- "closer to me" / "nearer" / any "away"/"from X" distance phrase (see
  CRITICAL rule above) → refinementType: "closer"
- "show me something different" / "other options"
  → refinementType: "different"
  → excludeParkNames: [all park names shown in previous assistant messages]
- "find something similar to [park]" / "like the first one"
  → refinementType: "similar", similarToPark: "[park name]"

EXCLUSION RULES:
- When the user asks for "different" results, extract ALL park names
  previously shown in the conversation and put them in excludeParkNames.
  Previous assistant messages list shown parks as
  "Parks shown near <location>: <names>" — read that line to know both
  the location and what to exclude, even if the current message doesn't
  repeat either one itself.
- Never show the same park twice in a conversation unless the user
  explicitly asks to revisit it.

WEATHER WARNING RULES:
- If the hike date temperature is likely > 90°F:
  weatherWarning: "Note: it may be very hot that day — consider
  starting early or looking for shaded trails."
- If rain is likely: weatherWarning: "Note: rain is forecast —
  waterproof boots recommended."
- Otherwise: weatherWarning: null

FEATURE RULES:
- "with a waterfall" → features: ["waterfall"]
- "near a lake" → features: ["lake"]
- "good views" / "scenic" → features: ["views"]
- Always carry features forward from previous messages in the
  conversation unless the user explicitly changes them.

Keep "reply" friendly and confirm what you're searching for.
`;

// Code-level safety net: the model reliably (reproduced 3/3 times in
// testing) drops the carried-forward location on refinement messages that
// reference a park by name instead of a place — e.g. "find something
// similar to Woodland Preserve" comes back with location=null even right
// after a successful Cincinnati search, despite the prompt's explicit
// carry-forward rule. The "Parks shown near X: ..." breadcrumb below exists
// specifically so the last searched location can be recovered
// deterministically from history instead of depending on the model to
// re-extract it from prose every turn — same pattern as the existing
// driveFromLocation safety net a few lines down.
const recoverLocationFromHistory = (history) => {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h?.role !== 'assistant' || typeof h.content !== 'string') continue;
    const match = h.content.match(/\(Parks shown near ([^:]+):/);
    if (match) return match[1].trim();
  }
  return null;
};

// Code-level safety net: verified reproducible (3/3, vs. 3/3 success with
// the difficulty word removed) that "Find me a moderate trail near Denver"
// comes back with location=null — the model understands the request well
// enough to write "near Denver" in its own conversational "reply", but a
// difficulty adjective in the same sentence ("a moderate trail near X")
// reliably breaks its own structured location extraction, even though the
// prompt's example for plain "near X" phrasing is unambiguous. With
// location null and no drive-time mention either, the priority chain fell
// through all the way to homepageLocation — the actual mechanism behind
// "searched Cincinnati instead of Denver". Extracting "near X"/"in X"/
// "around X" directly from the raw message is a last-resort fallback, only
// used when the model's own location AND driveFromLocation both came back
// empty — "me"/"here"/"there"/"my (area/place)" are excluded since those
// mean "use my current location", not a literal place named "me".
const extractLocationFromMessage = (text) => {
  const match = text.match(/\b(?:near|in|around)\s+([A-Za-z][A-Za-z0-9.'-]*(?:\s+[A-Za-z0-9.'-]+)*?)(?:\s*[.,!?]|\s+(?:on|for|with|under|over|within|less|more|farther|closer)\b|$)/i);
  if (!match) return null;
  const candidate = match[1].trim();
  if (/^(me|here|there|my(\s+(area|location|place))?)$/i.test(candidate)) return null;
  return candidate;
};

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

    const maxDistanceMiles = Number.isFinite(parsed.maxDistanceMiles) && parsed.maxDistanceMiles > 0
      ? parsed.maxDistanceMiles
      : null;
    const minDistanceMiles = Number.isFinite(parsed.minDistanceMiles) && parsed.minDistanceMiles > 0
      ? parsed.minDistanceMiles
      : null;
    const excludeParkNames = Array.isArray(parsed.excludeParkNames)
      ? parsed.excludeParkNames.filter((n) => typeof n === 'string' && n.trim()).slice(0, 20)
      : [];
    const VALID_REFINEMENT_TYPES = ['shorter', 'longer', 'easier', 'harder', 'closer', 'different', 'similar'];
    const rawRefinementType = VALID_REFINEMENT_TYPES.includes(parsed.refinementType) ? parsed.refinementType : null;
    // Code-level safety net: verified reproducible (6/6 across two prompt
    // revisions) that the model classifies "over/under X miles away/from
    // the city" as refinementType "longer"/"shorter" (hike length) instead
    // of "closer" (distance from the search location) despite an explicit
    // prompt rule telling it to do otherwise — a phrase like "over 10 miles
    // away" then gets filtered against hike length instead of proximity,
    // silently returning zero results (nearly every candidate park's own
    // trail length is well under 10mi). Detecting the "away"/"from X"
    // qualifier directly in the raw message and coercing refinementType is
    // more reliable than depending on the model to self-classify it right
    // every time.
    const hasProximityQualifier = /\b(away|from\s+(the|this|that|my)?\s*(city|town|here|there|location|place))\b/i.test(message);
    const refinementType = (hasProximityQualifier && (maxDistanceMiles || minDistanceMiles) && rawRefinementType !== 'closer')
      ? 'closer'
      : rawRefinementType;
    const similarToPark = typeof parsed.similarToPark === 'string' && parsed.similarToPark.trim()
      ? parsed.similarToPark.trim()
      : null;
    const weatherWarning = typeof parsed.weatherWarning === 'string' && parsed.weatherWarning.trim()
      ? parsed.weatherWarning.trim()
      : null;

    const extracted = {
      difficulty, activityType, features, driveTimeMinutes, driveFromLocation, searchRadius,
      maxDistanceMiles, minDistanceMiles, excludeParkNames, refinementType, similarToPark, weatherWarning
    };

    const isDriveTimeSearch = !!(driveFromLocation && driveTimeMinutes);
    const historyLocation = recoverLocationFromHistory(history);

    // 'current_location' is a sentinel meaning "resolve via homepageLocation"
    // — never a literal geocode-able place name. Resolving it once, up
    // front, stops it from leaking into the location fallback chain below:
    // previously, if the model set driveFromLocation="current_location" but
    // homepageLocation was unset (and isDriveTimeSearch was false because no
    // driveTimeMinutes came with it — e.g. a misclassified distance-filter
    // phrase like "under 2 miles from the city"), the literal string
    // "current_location" got passed straight to geocodeLocation(), which
    // then failed and surfaced a confusing "I had trouble finding
    // 'current_location'" error instead of just searching by location.
    const resolvedDriveFromLocation = driveFromLocation === 'current_location'
      ? (homepageLocation || null)
      : driveFromLocation;

    // Only worth trying to extract from raw text when the model's own
    // fields both came back empty — see extractLocationFromMessage's
    // comment for why this is needed at all.
    const messageLocation = (!location && !resolvedDriveFromLocation)
      ? extractLocationFromMessage(message)
      : null;

    if (!isDriveTimeSearch && !location && !resolvedDriveFromLocation && !messageLocation && !homepageLocation && !historyLocation) {
      return res.json({ reply, parks: [], location: null, searchedLocation: null, extracted });
    }

    // Location resolution priority:
    // 1. driveFromLocation === 'current_location' -> homepageLocation as origin
    // 2. driveFromLocation is a place name -> geocode it as origin
    // 3. location extracted from message by the model -> destination directly
    // 4. model's location/driveFromLocation both empty -> a "near X"/"in X"/
    //    "around X" pulled straight from the raw message (safety net)
    // 5. still nothing new this turn -> last searched location recovered
    //    from history (refinement safety net), then homepageLocation
    // 6. still nothing at all -> ask (handled above)
    let searchResult;
    let attemptedLocationName = null;
    try {
      if (isDriveTimeSearch) {
        attemptedLocationName = resolvedDriveFromLocation;
        if (!attemptedLocationName) {
          return res.json({
            reply: `${reply} (I don't know your current location yet — enable location on the homepage, or tell me a city to drive from.)`,
            parks: [],
            location: null,
            searchedLocation: null,
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
        // driveFromLocation in this branch is really just the destination —
        // resolvedDriveFromLocation (not the raw field) so a bare
        // "current_location" sentinel never gets used as a literal place name.
        // messageLocation sits ahead of historyLocation/homepageLocation: a
        // freshly-named place in THIS message should always win over
        // leftover context from earlier turns or the homepage default.
        attemptedLocationName = location || resolvedDriveFromLocation || messageLocation || historyLocation || homepageLocation;
        console.log('[DEBUG] extracted location from AI:', location);
        console.log('[DEBUG] homepageLocation from req.body:', homepageLocation);
        console.log('[DEBUG] final searchLocation used:', attemptedLocationName);
        console.log('[DEBUG] performParkSearch called with:', { location: attemptedLocationName, difficulty });
        searchResult = await performParkSearch({
          location: attemptedLocationName,
          date: hikeDate,
          difficulty: difficulty || undefined,
          activity: activityType || undefined,
          features,
          maxDistanceMiles,
          minDistanceMiles,
          excludeParkNames,
          refinementType,
          similarToPark
        });
      }
    } catch (searchErr) {
      return res.json({
        reply: `${reply} (I had trouble finding "${attemptedLocationName}" — try naming a nearby city or region.)`,
        parks: [],
        location: attemptedLocationName || null,
        searchedLocation: attemptedLocationName || null,
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

    // weatherWarning is prepended, the existing matched-features note stays
    // appended, and — since the client only ever persists/echoes back
    // whatever's in `reply` as this turn's history content (there's no
    // server-side conversation store), a "Parks shown: ..." breadcrumb is
    // appended here too so a later "show me something different" has the
    // shown names available in `history` for excludeParkNames without any
    // frontend change.
    let finalReply = weatherWarning ? `${weatherWarning}\n\n${reply}` : reply;
    if (searchResult.matchedFeatures && searchResult.matchedFeatures.length > 0) {
      finalReply = `${finalReply} (Found parks with ${searchResult.matchedFeatures.join(', ')} nearby.)`;
    }
    if (parks.length === 0 && searchResult.message) {
      // e.g. a minDistanceMiles refinement whose expanded search radius
      // still turned up nothing — surface why instead of showing empty cards.
      finalReply = `${finalReply}\n\n${searchResult.message}`;
    }
    if (parks.length > 0) {
      finalReply = `${finalReply}\n\n(Parks shown near ${searchResult.location}: ${parks.map((p) => p.name).join(', ')})`;
    }

    res.json({
      reply: finalReply,
      parks,
      location: searchResult.location,
      // Distinct from `location` above (which ChatParkCard also reads, for
      // its "X mi from {location}" line) — this is specifically for the
      // frontend to remember as "the last place we actually searched", so
      // the *next* message's loading indicator has something better than
      // homepageLocation to show while that request is still in flight and
      // its own destination isn't known yet.
      searchedLocation: searchResult.location,
      extracted
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Chat request failed. Please try again.' });
  }
};

module.exports = { chat };
