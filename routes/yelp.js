/**
 * routes/yelp.js
 * All Yelp Fusion API routes — no CORS issues since this runs server-side.
 */

const express = require('express');
const axios = require('axios');
const cache = require('../cache/store');

const router = express.Router();

const YELP_BASE = 'https://api.yelp.com/v3';
const MKE_LAT = parseFloat(process.env.MKE_LATITUDE) || 43.0389;
const MKE_LON = parseFloat(process.env.MKE_LONGITUDE) || -87.9065;
const MKE_RADIUS = parseInt(process.env.MKE_RADIUS_METERS) || 25000;

// ─── Yelp axios instance ──────────────────────────────────────────
function yelpClient() {
  const key = process.env.YELP_API_KEY;
  if (!key || key === 'your_yelp_fusion_api_key_here') {
    throw new Error('YELP_API_KEY is not configured in your .env file.');
  }
  return axios.create({
    baseURL: YELP_BASE,
    headers: { Authorization: `Bearer ${key}` },
    timeout: 10_000,
  });
}

// ─── GET /api/restaurants ─────────────────────────────────────────
// Query params:
//   category  – yelp category alias (default: "restaurants")
//   sort_by   – rating | best_match | review_count | distance
//   limit     – 1–50 (default 20)
//   offset    – for pagination (default 0)
//   open_now  – true/false (optional)
router.get('/restaurants', async (req, res) => {
  const {
    category = 'restaurants',
    sort_by = 'rating',
    limit = 20,
    offset = 0,
    open_now,
  } = req.query;

  const cacheKey = `restaurants::${category}::${sort_by}::${limit}::${offset}::${open_now}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return res.json({ ...cached, fromCache: true });
  }

  try {
    const yelp = yelpClient();
    const params = {
      latitude: MKE_LAT,
      longitude: MKE_LON,
      radius: MKE_RADIUS,
      categories: category,
      sort_by,
      limit: Math.min(parseInt(limit), 50),
      offset: parseInt(offset),
      locale: 'en_US',
    };
    if (open_now === 'true') params.open_now = true;

    const { data } = await yelp.get('/businesses/search', { params });

    const result = {
      businesses: data.businesses,
      total: data.total,
      fetchedAt: new Date().toISOString(),
      region: 'Milwaukee County, WI',
    };

    cache.set(cacheKey, result);
    console.log(`[YELP] Fetched ${data.businesses.length} restaurants (total: ${data.total})`);
    res.json({ ...result, fromCache: false });

  } catch (err) {
    handleYelpError(err, res);
  }
});

// ─── GET /api/restaurants/:id ─────────────────────────────────────
// Full business details for a single restaurant
router.get('/restaurants/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `business::${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const yelp = yelpClient();
    const { data } = await yelp.get(`/businesses/${id}`);
    cache.set(cacheKey, data);
    res.json({ ...data, fromCache: false });
  } catch (err) {
    handleYelpError(err, res);
  }
});

// ─── GET /api/restaurants/:id/reviews ────────────────────────────
// Top 3 reviews for a restaurant (Yelp free tier max)
router.get('/restaurants/:id/reviews', async (req, res) => {
  const { id } = req.params;
  const { sort_by = 'yelp_sort' } = req.query;
  const cacheKey = `reviews::${id}::${sort_by}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const yelp = yelpClient();
    const { data } = await yelp.get(`/businesses/${id}/reviews`, {
      params: { limit: 3, sort_by },
    });

    const result = {
      reviews: data.reviews,
      total: data.total,
      businessId: id,
      fetchedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, result);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    handleYelpError(err, res);
  }
});

// ─── GET /api/restaurants/batch-reviews ──────────────────────────
// Fetch reviews for multiple business IDs in one request.
// POST body: { ids: ["abc123", "def456", ...] }
// Respects Yelp rate limits with small inter-request delay.
router.post('/restaurants/batch-reviews', async (req, res) => {
  const { ids = [] } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty "ids" array.' });
  }
  if (ids.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 IDs per batch request.' });
  }

  const yelp = yelpClient();
  const results = {};

  for (const id of ids) {
    const cacheKey = `reviews::${id}::yelp_sort`;
    const cached = cache.get(cacheKey);
    if (cached) {
      results[id] = { ...cached, fromCache: true };
      continue;
    }
    try {
      await delay(150); // stay within Yelp rate limits
      const { data } = await yelp.get(`/businesses/${id}/reviews`, {
        params: { limit: 3, sort_by: 'yelp_sort' },
      });
      const result = {
        reviews: data.reviews,
        total: data.total,
        fetchedAt: new Date().toISOString(),
      };
      cache.set(cacheKey, result);
      results[id] = { ...result, fromCache: false };
    } catch (err) {
      results[id] = { error: err.response?.data?.error?.description || err.message };
    }
  }

  res.json({ results, processedAt: new Date().toISOString() });
});

// ─── GET /api/categories ──────────────────────────────────────────
// Returns the curated list of Milwaukee-relevant food categories
router.get('/categories', (_req, res) => {
  res.json({
    categories: [
      { alias: 'restaurants',      title: 'All Restaurants' },
      { alias: 'pizza',            title: 'Pizza' },
      { alias: 'burgers',          title: 'Burgers' },
      { alias: 'mexican',          title: 'Mexican' },
      { alias: 'seafood',          title: 'Seafood' },
      { alias: 'italian',          title: 'Italian' },
      { alias: 'bars',             title: 'Bars & Pubs' },
      { alias: 'breakfast_brunch', title: 'Breakfast & Brunch' },
      { alias: 'sandwiches',       title: 'Sandwiches' },
      { alias: 'newamerican',      title: 'New American' },
      { alias: 'vietnamese',       title: 'Vietnamese' },
      { alias: 'sushi',            title: 'Sushi' },
      { alias: 'bbq',              title: 'BBQ' },
      { alias: 'vegetarian',       title: 'Vegetarian' },
    ],
  });
});

// ─── Helpers ──────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function handleYelpError(err, res) {
  console.error('[YELP ERROR]', err.response?.data || err.message);
  if (err.message.includes('YELP_API_KEY')) {
    return res.status(500).json({ error: err.message });
  }
  if (err.response?.status === 401) {
    return res.status(401).json({ error: 'Invalid Yelp API key. Check your .env file.' });
  }
  if (err.response?.status === 429) {
    return res.status(429).json({ error: 'Yelp rate limit hit (500/day on free tier). Try again tomorrow or upgrade your Yelp plan.' });
  }
  res.status(err.response?.status || 500).json({
    error: err.response?.data?.error?.description || err.message,
  });
}

module.exports = router;
