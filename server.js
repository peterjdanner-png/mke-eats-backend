/**
 * server.js
 * MKE Eats — Milwaukee Restaurant Daily Digest Backend
 *
 * Routes:
 *   GET  /health                                    → Server status + cache stats
 *
 *   Yelp:
 *   GET  /api/restaurants                          → Search Milwaukee restaurants (Yelp)
 *   GET  /api/restaurants/:id                      → Single restaurant details
 *   GET  /api/restaurants/:id/reviews              → Top reviews for a restaurant
 *   POST /api/restaurants/batch-reviews            → Reviews for multiple restaurants
 *   GET  /api/categories                           → Available food categories
 *
 *   Google Places:
 *   GET  /api/google/restaurants                   → Search via Google Places
 *   GET  /api/google/restaurants/:placeId          → Single place details
 *   GET  /api/google/restaurants/:placeId/reviews  → Google reviews
 *
 *   TripAdvisor:
 *   GET  /api/tripadvisor/restaurants              → Search via TripAdvisor
 *   GET  /api/tripadvisor/restaurants/:id          → Single location details
 *   GET  /api/tripadvisor/restaurants/:id/reviews  → TripAdvisor reviews
 *   GET  /api/tripadvisor/restaurants/:id/photos   → TripAdvisor photos
 *
 *   Aggregated (all sources merged):
 *   GET  /api/aggregate/restaurants                → Unified results from all sources
 *   GET  /api/aggregate/restaurants/:name/reviews  → Merged reviews from all sources
 *
 *   AI:
 *   POST /api/specials/extract                     → AI specials from reviews (single)
 *   POST /api/specials/batch                       → AI specials from reviews (batch)
 *
 *   Cache:
 *   POST /api/cache/flush                          → Force-clear all cached data
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const yelpRoutes = require('./routes/yelp');
const googleRoutes = require('./routes/google');
const tripadvisorRoutes = require('./routes/tripadvisor');
const aggregatorRoutes = require('./routes/aggregator');
const specialsRoutes = require('./routes/specials');
const cache = require('./cache/store');
const { startDailyRefresh } = require('./middleware/dailyRefresh');

const app = express();
const PORT = parseInt(process.env.PORT) || 3001;

// ─── CORS ─────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, Postman, same-origin)
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: Origin "${origin}" not allowed.`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Body parsing ─────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));const path = require('path');
app.use(express.static(path.join(__dirname)));

// ─── Global rate limiter ──────────────────────────────────────────
// Protects against accidental hammering from the frontend
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,                  // max 200 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});
app.use('/api', limiter);

// ─── Stricter limiter for AI endpoints (costs money per call) ─────
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: { error: 'AI endpoint rate limit reached. Wait a moment and try again.' },
});
app.use('/api/specials', aiLimiter);

// ─── Routes ───────────────────────────────────────────────────────
app.use('/api', yelpRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/tripadvisor', tripadvisorRoutes);
app.use('/api/aggregate', aggregatorRoutes);
app.use('/api/specials', specialsRoutes);

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const yelpConfigured = !!(process.env.YELP_API_KEY && process.env.YELP_API_KEY !== 'your_yelp_fusion_api_key_here');
  const googleConfigured = !!(process.env.GOOGLE_PLACES_API_KEY && process.env.GOOGLE_PLACES_API_KEY !== 'your_google_places_api_key_here');
  const tripadvisorConfigured = !!(process.env.TRIPADVISOR_API_KEY && process.env.TRIPADVISOR_API_KEY !== 'your_tripadvisor_api_key_here');
  const claudeConfigured = !!(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-your_'));

  const sourcesReady = [
    yelpConfigured && 'yelp',
    googleConfigured && 'google',
    tripadvisorConfigured && 'tripadvisor',
  ].filter(Boolean);

  res.json({
    status: 'ok',
    service: 'MKE Eats API',
    timestamp: new Date().toISOString(),
    config: {
      sourcesConfigured: sourcesReady,
      yelpApiConfigured: yelpConfigured,
      googleApiConfigured: googleConfigured,
      tripadvisorApiConfigured: tripadvisorConfigured,
      claudeApiConfigured: claudeConfigured,
      region: 'Milwaukee County, WI',
      cacheEnabled: true,
      cacheTtlMs: parseInt(process.env.CACHE_TTL_MS) || 3_600_000,
    },
    cache: cache.stats(),
  });
});

// ─── Cache management ─────────────────────────────────────────────
app.post('/api/cache/flush', (req, res) => {
  const count = cache.flush();
  res.json({ cleared: count, message: `Flushed ${count} cache entries.` });
});

// ─── 404 handler ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─── Global error handler ─────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[SERVER ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍺 MKE Eats API running at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Restaurants:  http://localhost:${PORT}/api/restaurants\n`);

  // Start the daily 6 AM cache refresh cron
  startDailyRefresh();
});

module.exports = app;
