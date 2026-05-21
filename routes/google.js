/**
 * routes/google.js
 * Google Places API integration for Milwaukee restaurant data.
 * Uses the Places API (New) — Text Search + Place Details endpoints.
 *
 * Setup: Get a key at console.cloud.google.com
 *   → Enable "Places API" and "Places API (New)"
 *   → Create an API key under Credentials
 */

const express = require('express');
const axios = require('axios');
const cache = require('../cache/store');

const router = express.Router();

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';
const MKE_LAT = parseFloat(process.env.MKE_LATITUDE) || 43.0389;
const MKE_LON = parseFloat(process.env.MKE_LONGITUDE) || -87.9065;
const MKE_RADIUS = parseInt(process.env.MKE_RADIUS_METERS) || 25000;

function googleKey() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key || key === 'your_google_places_api_key_here') {
    throw new Error('GOOGLE_PLACES_API_KEY is not configured in your .env file.');
  }
  return key;
}

// ─── GET /api/google/restaurants ─────────────────────────────────
// Searches for restaurants in Milwaukee County via Google Places
router.get('/restaurants', async (req, res) => {
  const {
    keyword = 'restaurant',
    sort_by = 'prominence',  // prominence | distance
    limit = 20,
    open_now,
    page_token,             // for pagination (Google returns up to 20 per page, 3 pages max)
  } = req.query;

  const cacheKey = `google::restaurants::${keyword}::${sort_by}::${open_now}::${page_token || 0}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return res.json({ ...cached, fromCache: true });
  }

  try {
    const key = googleKey();
    const params = {
      location: `${MKE_LAT},${MKE_LON}`,
      radius: MKE_RADIUS,
      type: 'restaurant',
      keyword,
      rankby: sort_by === 'distance' ? 'distance' : undefined,
      key,
    };
    if (sort_by !== 'distance') params.radius = MKE_RADIUS;
    if (open_now === 'true') params.opennow = true;
    if (page_token) params.pagetoken = page_token;

    // Remove undefined params
    Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);

    const { data } = await axios.get(`${PLACES_BASE}/nearbysearch/json`, { params });

    if (data.status === 'REQUEST_DENIED') {
      throw new Error(`Google API denied: ${data.error_message}`);
    }

    // Normalize to a consistent shape similar to Yelp
    const businesses = (data.results || []).slice(0, parseInt(limit)).map(normalizeGoogle);

    const result = {
      businesses,
      total: data.results?.length || 0,
      nextPageToken: data.next_page_token || null,
      fetchedAt: new Date().toISOString(),
      source: 'google',
      region: 'Milwaukee County, WI',
    };

    cache.set(cacheKey, result);
    console.log(`[GOOGLE] Fetched ${businesses.length} restaurants`);
    res.json({ ...result, fromCache: false });

  } catch (err) {
    handleGoogleError(err, res);
  }
});

// ─── GET /api/google/restaurants/:placeId ─────────────────────────
// Full place details including reviews (up to 5 from Google)
router.get('/restaurants/:placeId', async (req, res) => {
  const { placeId } = req.params;
  const cacheKey = `google::place::${placeId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const key = googleKey();
    const { data } = await axios.get(`${PLACES_BASE}/details/json`, {
      params: {
        place_id: placeId,
        fields: 'name,rating,user_ratings_total,price_level,formatted_address,formatted_phone_number,website,opening_hours,reviews,photos,url,types',
        key,
      },
    });

    if (data.status !== 'OK') {
      throw new Error(`Google Places error: ${data.status} — ${data.error_message || ''}`);
    }

    const result = {
      ...normalizeGoogleDetail(data.result),
      fetchedAt: new Date().toISOString(),
      source: 'google',
      fromCache: false,
    };

    cache.set(cacheKey, result);
    res.json(result);

  } catch (err) {
    handleGoogleError(err, res);
  }
});

// ─── GET /api/google/restaurants/:placeId/reviews ─────────────────
// Returns Google reviews for a place (up to 5, most relevant)
router.get('/restaurants/:placeId/reviews', async (req, res) => {
  const { placeId } = req.params;
  const cacheKey = `google::reviews::${placeId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const key = googleKey();
    const { data } = await axios.get(`${PLACES_BASE}/details/json`, {
      params: {
        place_id: placeId,
        fields: 'reviews,rating,user_ratings_total,name',
        key,
      },
    });

    if (data.status !== 'OK') {
      throw new Error(`Google Places error: ${data.status}`);
    }

    const reviews = (data.result.reviews || []).map(r => ({
      id: `google_${r.time}`,
      rating: r.rating,
      text: r.text,
      user: { name: r.author_name, image_url: r.profile_photo_url },
      time_created: new Date(r.time * 1000).toISOString(),
      source: 'google',
    }));

    const result = {
      reviews,
      total: data.result.user_ratings_total || reviews.length,
      businessId: placeId,
      fetchedAt: new Date().toISOString(),
      source: 'google',
    };

    cache.set(cacheKey, result);
    res.json({ ...result, fromCache: false });

  } catch (err) {
    handleGoogleError(err, res);
  }
});

// ─── Normalizers ──────────────────────────────────────────────────
// Convert Google's format to match our unified restaurant shape

function normalizeGoogle(place) {
  return {
    id: place.place_id,
    source: 'google',
    name: place.name,
    rating: place.rating || 0,
    review_count: place.user_ratings_total || 0,
    price: place.price_level,        // 0–4 (Google) vs $ signs (Yelp)
    price_display: '$'.repeat(place.price_level || 0) || null,
    categories: (place.types || [])
      .filter(t => !['point_of_interest', 'establishment', 'food'].includes(t))
      .slice(0, 3)
      .map(t => ({ alias: t, title: t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) })),
    location: {
      display_address: [place.vicinity],
      address1: place.vicinity,
    },
    image_url: place.photos?.[0]
      ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${place.photos[0].photo_reference}&key=${process.env.GOOGLE_PLACES_API_KEY}`
      : null,
    url: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
    is_open: place.opening_hours?.open_now,
    coordinates: {
      latitude: place.geometry?.location?.lat,
      longitude: place.geometry?.location?.lng,
    },
  };
}

function normalizeGoogleDetail(place) {
  return {
    ...normalizeGoogle(place),
    phone: place.formatted_phone_number,
    website: place.website,
    hours: place.opening_hours?.weekday_text || [],
    is_open: place.opening_hours?.open_now,
    reviews: (place.reviews || []).map(r => ({
      id: `google_${r.time}`,
      rating: r.rating,
      text: r.text,
      user: { name: r.author_name, image_url: r.profile_photo_url },
      time_created: new Date(r.time * 1000).toISOString(),
      source: 'google',
    })),
  };
}

function handleGoogleError(err, res) {
  console.error('[GOOGLE ERROR]', err.message);
  if (err.message.includes('GOOGLE_PLACES_API_KEY')) {
    return res.status(503).json({ error: err.message, source: 'google' });
  }
  res.status(500).json({ error: err.message, source: 'google' });
}

module.exports = router;
