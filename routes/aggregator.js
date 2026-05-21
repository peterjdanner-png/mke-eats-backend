/**
 * routes/aggregator.js
 * Merges Yelp + Google Places + TripAdvisor results into unified restaurant cards.
 *
 * Smart matching: uses name + address similarity to detect the same restaurant
 * across sources and combine their ratings, reviews, and data.
 *
 * GET /api/aggregate/restaurants  → unified results from all configured sources
 */

const express = require('express');
const axios = require('axios');
const cache = require('../cache/store');

const router = express.Router();

const MKE_LAT = parseFloat(process.env.MKE_LATITUDE) || 43.0389;
const MKE_LON = parseFloat(process.env.MKE_LONGITUDE) || -87.9065;
const MKE_RADIUS = parseInt(process.env.MKE_RADIUS_METERS) || 25000;
const BASE_URL = `http://localhost:${process.env.PORT || 3001}`;

// ─── GET /api/aggregate/restaurants ──────────────────────────────
router.get('/restaurants', async (req, res) => {
  const {
    category = 'restaurants',
    sort_by = 'combined_rating',  // combined_rating | review_count | name
    limit = 20,
    open_now,
    sources,                      // comma-separated: yelp,google,tripadvisor (default: all configured)
  } = req.query;

  const cacheKey = `aggregate::${category}::${sort_by}::${limit}::${open_now}::${sources || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return res.json({ ...cached, fromCache: true });
  }

  // Determine which sources are configured
  const enabledSources = getEnabledSources(sources);
  console.log(`[AGGREGATE] Fetching from sources: ${enabledSources.join(', ')}`);

  // Fetch from all enabled sources in parallel
  const fetchPromises = enabledSources.map(source => fetchFromSource(source, { category, open_now }));
  const sourceResults = await Promise.allSettled(fetchPromises);

  // Collect all restaurants with their source label
  let allRestaurants = [];
  const sourceStats = {};

  sourceResults.forEach((result, i) => {
    const source = enabledSources[i];
    if (result.status === 'fulfilled' && result.value?.businesses) {
      allRestaurants.push(...result.value.businesses);
      sourceStats[source] = { count: result.value.businesses.length, status: 'ok' };
      console.log(`[AGGREGATE] ${source}: ${result.value.businesses.length} results`);
    } else {
      sourceStats[source] = { count: 0, status: 'error', error: result.reason?.message || 'Failed' };
      console.warn(`[AGGREGATE] ${source} failed:`, result.reason?.message);
    }
  });

  if (allRestaurants.length === 0) {
    return res.status(503).json({
      error: 'No sources returned results. Check your API keys in .env',
      sourceStats,
    });
  }

  // Merge duplicates (same restaurant from multiple sources)
  const merged = mergeRestaurants(allRestaurants);

  // Sort
  const sorted = sortRestaurants(merged, sort_by);

  // Limit
  const limited = sorted.slice(0, parseInt(limit));

  const result = {
    businesses: limited,
    total: merged.length,
    sourceStats,
    enabledSources,
    fetchedAt: new Date().toISOString(),
    region: 'Milwaukee County, WI',
  };

  // Cache for 1 hour
  cache.set(cacheKey, result);
  res.json({ ...result, fromCache: false });
});

// ─── GET /api/aggregate/restaurants/:name/reviews ─────────────────
// Fetch and merge reviews for a restaurant from all sources
router.get('/restaurants/:encodedName/reviews', async (req, res) => {
  const { encodedName } = req.params;
  const { yelpId, googleId, tripadvisorId } = req.query;

  const cacheKey = `aggregate::reviews::${yelpId || ''}::${googleId || ''}::${tripadvisorId || ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  const reviewFetches = [];

  if (yelpId && process.env.YELP_API_KEY && process.env.YELP_API_KEY !== 'your_yelp_fusion_api_key_here') {
    reviewFetches.push(
      axios.get(`${BASE_URL}/api/restaurants/${yelpId}/reviews`).then(r => r.data.reviews || []).catch(() => [])
    );
  }
  if (googleId && process.env.GOOGLE_PLACES_API_KEY && process.env.GOOGLE_PLACES_API_KEY !== 'your_google_places_api_key_here') {
    reviewFetches.push(
      axios.get(`${BASE_URL}/api/google/restaurants/${googleId}/reviews`).then(r => r.data.reviews || []).catch(() => [])
    );
  }
  if (tripadvisorId && process.env.TRIPADVISOR_API_KEY && process.env.TRIPADVISOR_API_KEY !== 'your_tripadvisor_api_key_here') {
    reviewFetches.push(
      axios.get(`${BASE_URL}/api/tripadvisor/restaurants/${tripadvisorId}/reviews`).then(r => r.data.reviews || []).catch(() => [])
    );
  }

  const reviewArrays = await Promise.all(reviewFetches);
  const allReviews = reviewArrays.flat();

  // Sort by rating desc, then pick the best ones
  const sorted = allReviews.sort((a, b) => (b.rating || 0) - (a.rating || 0));

  const result = {
    reviews: sorted,
    total: sorted.length,
    sources: [...new Set(sorted.map(r => r.source))],
    fetchedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, result);
  res.json({ ...result, fromCache: false });
});

// ─── Source fetchers ──────────────────────────────────────────────

async function fetchFromSource(source, { category, open_now }) {
  const openParam = open_now ? `&open_now=${open_now}` : '';
  try {
    switch (source) {
      case 'yelp': {
        const r = await axios.get(`${BASE_URL}/api/restaurants?category=${category}&sort_by=rating&limit=20${openParam}`);
        return r.data;
      }
      case 'google': {
        const keyword = categoryToGoogleKeyword(category);
        const r = await axios.get(`${BASE_URL}/api/google/restaurants?keyword=${keyword}&limit=20${openParam}`);
        return r.data;
      }
      case 'tripadvisor': {
        const r = await axios.get(`${BASE_URL}/api/tripadvisor/restaurants?category=restaurants&limit=20`);
        return r.data;
      }
      default:
        return null;
    }
  } catch (err) {
    throw new Error(`${source}: ${err.response?.data?.error || err.message}`);
  }
}

// ─── Smart merging ────────────────────────────────────────────────
// Detects the same restaurant from multiple sources by name similarity

function mergeRestaurants(restaurants) {
  const groups = [];
  const used = new Set();

  for (let i = 0; i < restaurants.length; i++) {
    if (used.has(i)) continue;
    const group = [restaurants[i]];
    used.add(i);

    for (let j = i + 1; j < restaurants.length; j++) {
      if (used.has(j)) continue;
      if (isSameRestaurant(restaurants[i], restaurants[j])) {
        group.push(restaurants[j]);
        used.add(j);
      }
    }

    groups.push(mergeGroup(group));
  }

  return groups;
}

function isSameRestaurant(a, b) {
  // Don't match within same source
  if (a.source === b.source) return false;

  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);

  // Exact name match
  if (nameA === nameB) return true;

  // One name contains the other (handles "Beans & Barley" vs "Beans and Barley")
  if (nameA.includes(nameB) || nameB.includes(nameA)) return true;

  // Similarity score (simple character overlap)
  if (nameSimilarity(nameA, nameB) > 0.82) return true;

  return false;
}

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|a|an|and|&)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameSimilarity(a, b) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
}

function mergeGroup(group) {
  // Use the entry with the most reviews as the "primary"
  const primary = group.sort((a, b) => (b.review_count || 0) - (a.review_count || 0))[0];

  // Compute combined rating (weighted average by review count)
  const totalReviews = group.reduce((sum, r) => sum + (r.review_count || 0), 0);
  const weightedRating = totalReviews > 0
    ? group.reduce((sum, r) => sum + (r.rating || 0) * (r.review_count || 0), 0) / totalReviews
    : primary.rating;

  // Collect source attribution
  const sources = group.map(r => ({
    name: r.source,
    rating: r.rating,
    review_count: r.review_count,
    url: r.url,
    id: r.id,
  }));

  return {
    ...primary,
    combined_rating: Math.round(weightedRating * 10) / 10,
    combined_review_count: totalReviews,
    sources,                          // array of all source entries
    sourceIds: {
      yelp: group.find(r => r.source === 'yelp')?.id || null,
      google: group.find(r => r.source === 'google')?.id || null,
      tripadvisor: group.find(r => r.source === 'tripadvisor')?.id || null,
    },
    // Use best available image
    image_url: group.map(r => r.image_url).find(Boolean) || null,
  };
}

// ─── Sorting ──────────────────────────────────────────────────────

function sortRestaurants(restaurants, sort_by) {
  switch (sort_by) {
    case 'combined_rating':
      return [...restaurants].sort((a, b) => {
        const ratingDiff = (b.combined_rating || b.rating || 0) - (a.combined_rating || a.rating || 0);
        if (Math.abs(ratingDiff) > 0.1) return ratingDiff;
        return (b.combined_review_count || b.review_count || 0) - (a.combined_review_count || a.review_count || 0);
      });
    case 'review_count':
      return [...restaurants].sort((a, b) =>
        (b.combined_review_count || b.review_count || 0) - (a.combined_review_count || a.review_count || 0));
    case 'name':
      return [...restaurants].sort((a, b) => a.name.localeCompare(b.name));
    default:
      return restaurants;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function getEnabledSources(sourcesParam) {
  const all = ['yelp', 'google', 'tripadvisor'];
  const requested = sourcesParam ? sourcesParam.split(',').map(s => s.trim()) : all;

  return requested.filter(source => {
    switch (source) {
      case 'yelp':        return !!(process.env.YELP_API_KEY && process.env.YELP_API_KEY !== 'your_yelp_fusion_api_key_here');
      case 'google':      return !!(process.env.GOOGLE_PLACES_API_KEY && process.env.GOOGLE_PLACES_API_KEY !== 'your_google_places_api_key_here');
      case 'tripadvisor': return !!(process.env.TRIPADVISOR_API_KEY && process.env.TRIPADVISOR_API_KEY !== 'your_tripadvisor_api_key_here');
      default:            return false;
    }
  });
}

function categoryToGoogleKeyword(yelpCategory) {
  const map = {
    restaurants: 'restaurant',
    pizza: 'pizza',
    burgers: 'burger',
    mexican: 'mexican restaurant',
    seafood: 'seafood',
    italian: 'italian restaurant',
    bars: 'bar pub',
    breakfast_brunch: 'breakfast brunch',
    sandwiches: 'sandwich deli',
    newamerican: 'american restaurant',
    vietnamese: 'vietnamese restaurant',
    sushi: 'sushi',
    bbq: 'bbq barbecue',
    vegetarian: 'vegetarian vegan',
  };
  return map[yelpCategory] || yelpCategory;
}

module.exports = router;
