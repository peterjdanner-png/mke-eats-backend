/**
 * routes/tripadvisor.js
 * TripAdvisor Content API integration for Milwaukee restaurant data.
 *
 * Setup: Get a free key at tripadvisor.com/developers
 *   → Sign up, create an app, get your API key instantly
 *   → Free tier: 5,000 calls/month
 */

const express = require('express');
const axios = require('axios');
const cache = require('../cache/store');

const router = express.Router();

const TA_BASE = 'https://api.content.tripadvisor.com/api/v1';
const MKE_LAT = parseFloat(process.env.MKE_LATITUDE) || 43.0389;
const MKE_LON = parseFloat(process.env.MKE_LONGITUDE) || -87.9065;

function taKey() {
  const key = process.env.TRIPADVISOR_API_KEY;
  if (!key || key === 'your_tripadvisor_api_key_here') {
    throw new Error('TRIPADVISOR_API_KEY is not configured in your .env file.');
  }
  return key;
}

// ─── GET /api/tripadvisor/restaurants ────────────────────────────
// Search nearby restaurants in Milwaukee via TripAdvisor
router.get('/restaurants', async (req, res) => {
  const { category = 'restaurants', limit = 20 } = req.query;
  const cacheKey = `tripadvisor::restaurants::${category}::${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return res.json({ ...cached, fromCache: true });
  }

  try {
    const key = taKey();
    const { data } = await axios.get(`${TA_BASE}/location/nearby_search`, {
      params: {
        latLong: `${MKE_LAT},${MKE_LON}`,
        category,
        radius: 25,
        radiusUnit: 'km',
        language: 'en',
        key,
      },
    });

    const locations = data.data || [];
    const businesses = locations.slice(0, parseInt(limit)).map(normalizeTA);

    const result = {
      businesses,
      total: locations.length,
      fetchedAt: new Date().toISOString(),
      source: 'tripadvisor',
      region: 'Milwaukee County, WI',
    };

    cache.set(cacheKey, result);
    console.log(`[TRIPADVISOR] Fetched ${businesses.length} restaurants`);
    res.json({ ...result, fromCache: false });

  } catch (err) {
    handleTAError(err, res);
  }
});

// ─── GET /api/tripadvisor/restaurants/:locationId ─────────────────
// Full details for a single TripAdvisor location
router.get('/restaurants/:locationId', async (req, res) => {
  const { locationId } = req.params;
  const cacheKey = `tripadvisor::detail::${locationId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const key = taKey();
    const { data } = await axios.get(`${TA_BASE}/location/${locationId}/details`, {
      params: { language: 'en', currency: 'USD', key },
    });

    const result = {
      ...normalizeTADetail(data),
      fetchedAt: new Date().toISOString(),
      source: 'tripadvisor',
      fromCache: false,
    };

    cache.set(cacheKey, result);
    res.json(result);

  } catch (err) {
    handleTAError(err, res);
  }
});

// ─── GET /api/tripadvisor/restaurants/:locationId/reviews ─────────
// Top reviews for a TripAdvisor location (up to 5 on free tier)
router.get('/restaurants/:locationId/reviews', async (req, res) => {
  const { locationId } = req.params;
  const cacheKey = `tripadvisor::reviews::${locationId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const key = taKey();
    const { data } = await axios.get(`${TA_BASE}/location/${locationId}/reviews`, {
      params: { language: 'en', key },
    });

    const reviews = (data.data || []).map(r => ({
      id: `ta_${r.id}`,
      rating: r.rating,
      text: r.text,
      title: r.title,
      user: { name: r.user?.username || 'TripAdvisor User' },
      time_created: r.published_date,
      source: 'tripadvisor',
    }));

    const result = {
      reviews,
      total: reviews.length,
      businessId: locationId,
      fetchedAt: new Date().toISOString(),
      source: 'tripadvisor',
    };

    cache.set(cacheKey, result);
    res.json({ ...result, fromCache: false });

  } catch (err) {
    handleTAError(err, res);
  }
});

// ─── GET /api/tripadvisor/restaurants/:locationId/photos ──────────
// Photos for a TripAdvisor location
router.get('/restaurants/:locationId/photos', async (req, res) => {
  const { locationId } = req.params;
  const cacheKey = `tripadvisor::photos::${locationId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const key = taKey();
    const { data } = await axios.get(`${TA_BASE}/location/${locationId}/photos`, {
      params: { language: 'en', limit: 5, key },
    });

    const photos = (data.data || []).map(p => ({
      id: p.id,
      url: p.images?.large?.url || p.images?.medium?.url || p.images?.small?.url,
      caption: p.caption,
      source: 'tripadvisor',
    }));

    const result = { photos, fetchedAt: new Date().toISOString() };
    cache.set(cacheKey, result);
    res.json({ ...result, fromCache: false });

  } catch (err) {
    handleTAError(err, res);
  }
});

// ─── Normalizers ──────────────────────────────────────────────────

function normalizeTA(location) {
  return {
    id: location.location_id,
    source: 'tripadvisor',
    name: location.name,
    rating: parseFloat(location.rating) || 0,
    review_count: parseInt(location.num_reviews) || 0,
    price_display: location.price_level || null,
    categories: (location.cuisine || []).slice(0, 3).map(c => ({
      alias: c.key,
      title: c.name,
    })),
    location: {
      display_address: [location.address_obj?.address_string || location.address_obj?.street1].filter(Boolean),
      address1: location.address_obj?.street1,
      city: location.address_obj?.city,
    },
    image_url: location.photo?.images?.large?.url || null,
    url: `https://www.tripadvisor.com${location.web_url || ''}`,
    coordinates: {
      latitude: parseFloat(location.latitude),
      longitude: parseFloat(location.longitude),
    },
  };
}

function normalizeTADetail(location) {
  return {
    ...normalizeTA(location),
    phone: location.phone,
    website: location.website,
    hours: location.hours?.weekday_text || [],
    is_open: location.hours?.open_now,
    description: location.description,
    ranking: location.ranking_data?.ranking_string,
    awards: (location.awards || []).map(a => a.display_name),
    dietary_restrictions: (location.dietary_restrictions || []).map(d => d.name),
  };
}

function handleTAError(err, res) {
  console.error('[TRIPADVISOR ERROR]', err.response?.data || err.message);
  if (err.message.includes('TRIPADVISOR_API_KEY')) {
    return res.status(503).json({ error: err.message, source: 'tripadvisor' });
  }
  if (err.response?.status === 401) {
    return res.status(401).json({ error: 'Invalid TripAdvisor API key.', source: 'tripadvisor' });
  }
  if (err.response?.status === 429) {
    return res.status(429).json({ error: 'TripAdvisor rate limit hit (5,000/month on free tier).', source: 'tripadvisor' });
  }
  res.status(err.response?.status || 500).json({
    error: err.response?.data?.message || err.message,
    source: 'tripadvisor',
  });
}

module.exports = router;
