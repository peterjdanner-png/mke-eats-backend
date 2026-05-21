/**
 * middleware/dailyRefresh.js
 * Cron job that pre-warms the cache every day at 6 AM (Milwaukee local time).
 * This means users always get fast, fresh data without waiting for Yelp calls.
 */

const cron = require('node-cron');
const axios = require('axios');
const cache = require('../cache/store');

const MKE_LAT = parseFloat(process.env.MKE_LATITUDE) || 43.0389;
const MKE_LON = parseFloat(process.env.MKE_LONGITUDE) || -87.9065;
const MKE_RADIUS = parseInt(process.env.MKE_RADIUS_METERS) || 25000;

const TOP_CATEGORIES = [
  'restaurants',
  'pizza',
  'burgers',
  'mexican',
  'breakfast_brunch',
  'bars',
];

async function warmCache() {
  const apiKey = process.env.YELP_API_KEY;
  if (!apiKey || apiKey === 'your_yelp_fusion_api_key_here') {
    console.warn('[CRON] Skipping cache warm — YELP_API_KEY not set.');
    return;
  }

  console.log('[CRON] Starting daily cache warm-up...');
  const yelp = axios.create({
    baseURL: 'https://api.yelp.com/v3',
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 10_000,
  });

  let fetched = 0;
  let errors = 0;

  for (const category of TOP_CATEGORIES) {
    try {
      await new Promise(r => setTimeout(r, 500)); // pace requests

      const { data } = await yelp.get('/businesses/search', {
        params: {
          latitude: MKE_LAT,
          longitude: MKE_LON,
          radius: MKE_RADIUS,
          categories: category,
          sort_by: 'rating',
          limit: 20,
          locale: 'en_US',
        },
      });

      const cacheKey = `restaurants::${category}::rating::20::0::undefined`;
      cache.set(cacheKey, {
        businesses: data.businesses,
        total: data.total,
        fetchedAt: new Date().toISOString(),
        region: 'Milwaukee County, WI',
      });

      fetched++;
      console.log(`[CRON]  ✓ Warmed category: ${category} (${data.businesses.length} results)`);
    } catch (err) {
      errors++;
      console.error(`[CRON]  ✗ Failed category: ${category} — ${err.response?.data?.error?.description || err.message}`);
    }
  }

  console.log(`[CRON] Cache warm complete. Fetched: ${fetched}, Errors: ${errors}`);
}

function startDailyRefresh() {
  // Run at 6:00 AM every day (America/Chicago = Milwaukee timezone)
  cron.schedule('0 6 * * *', () => {
    console.log('[CRON] Triggering daily 6 AM cache refresh...');
    warmCache().catch(err => console.error('[CRON] Unhandled error:', err));
  }, {
    timezone: 'America/Chicago',
  });

  console.log('[CRON] Daily refresh scheduled for 6:00 AM CT');

  // Also warm cache immediately on startup (if not already cached)
  const stats = cache.stats();
  if (stats.activeKeys === 0) {
    console.log('[CRON] Empty cache on startup — running initial warm-up...');
    warmCache().catch(err => console.error('[CRON] Startup warm error:', err));
  }
}

module.exports = { startDailyRefresh, warmCache };
