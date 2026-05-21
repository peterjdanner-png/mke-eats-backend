# 🍺 MKE Eats — Milwaukee Restaurant Daily Digest

A full-stack app that pulls top-rated Milwaukee County restaurants from Yelp daily,
surfaces the best reviews, and uses Claude AI to extract specials and highlights.

---

## Project Structure

```
mke-eats-backend/
├── server.js                  ← Express app entry point
├── package.json
├── .env.example               ← Copy this to .env and fill in your keys
├── milwaukee-eats.html        ← Frontend (open in browser)
│
├── routes/
│   ├── yelp.js                ← All Yelp Fusion API routes
│   └── specials.js            ← Claude AI specials extraction routes
│
├── middleware/
│   └── dailyRefresh.js        ← Cron job: warms cache at 6 AM daily
│
└── cache/
    └── store.js               ← In-memory cache with TTL
```

---

## Quick Start

### 1. Get your API keys

**Yelp Fusion API (required)**
1. Go to https://www.yelp.com/developers and log in
2. Click **Create App**
3. Fill in app name ("MKE Eats"), industry (Food), short description
4. Your API key appears immediately — copy it

**Anthropic API (optional — powers AI specials extraction)**
1. Go to https://console.anthropic.com
2. Create an account and add a payment method (pay-per-use, very cheap)
3. Generate an API key under "API Keys"

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
```
YELP_API_KEY=your_actual_yelp_key
ANTHROPIC_API_KEY=sk-ant-your_actual_anthropic_key
```

### 3. Install and run

```bash
npm install
npm start
```

You should see:
```
🍺 MKE Eats API running at http://localhost:3001
   Health check: http://localhost:3001/health
```

### 4. Open the frontend

Open `milwaukee-eats.html` in your browser (double-click it, or use Live Server in VS Code).

The Backend URL field should already say `http://localhost:3001`. Click **Load Today's Digest**.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server status, cache stats, config check |
| GET | `/api/restaurants` | Search Milwaukee restaurants |
| GET | `/api/restaurants/:id` | Single restaurant details |
| GET | `/api/restaurants/:id/reviews` | Top 3 Yelp reviews |
| POST | `/api/restaurants/batch-reviews` | Reviews for multiple restaurants |
| GET | `/api/categories` | Available food category filters |
| POST | `/api/specials/extract` | AI extract specials (single restaurant) |
| POST | `/api/specials/batch` | AI extract specials (up to 10 restaurants) |
| POST | `/api/cache/flush` | Clear all cached data |

### Example requests

```bash
# Health check
curl http://localhost:3001/health

# Top-rated restaurants
curl "http://localhost:3001/api/restaurants?sort_by=rating&limit=10"

# Pizza places, open now
curl "http://localhost:3001/api/restaurants?category=pizza&open_now=true"

# Reviews for a restaurant
curl http://localhost:3001/api/restaurants/BUSINESS_ID/reviews

# Batch reviews
curl -X POST http://localhost:3001/api/restaurants/batch-reviews \
  -H "Content-Type: application/json" \
  -d '{"ids": ["id1", "id2", "id3"]}'

# AI specials extraction
curl -X POST http://localhost:3001/api/specials/extract \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "abc123",
    "businessName": "Oak & Ivy",
    "reviews": [
      {"text": "Their Tuesday fish fry is incredible!", "rating": 5}
    ]
  }'
```

---

## Caching

- **Yelp results** are cached for 1 hour by default (configurable via `CACHE_TTL_MS`)
- **AI specials** are cached for 24 hours (they don't change much)
- Yelp's terms require you not to cache responses longer than 24 hours
- Cache auto-warms at **6:00 AM CT every day** via cron job
- Force-clear with: `curl -X POST http://localhost:3001/api/cache/flush`

Milwaukee County has ~2,000+ restaurants. The free Yelp tier gives 500 calls/day.
The daily cron warms 6 categories × 20 results = 120 calls, leaving ~380 for live requests.

---

## Rate Limits

| Tier | Calls/day | Reviews per restaurant |
|------|-----------|----------------------|
| Free | 500 | 3 |
| Partner | Custom | Up to 7 |

The backend enforces:
- 200 requests per IP per 15 minutes (general)
- 20 requests per IP per minute for AI endpoints

---

## Deploying to Production

### Option A: Railway (easiest, free tier available)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```
Set your env vars in the Railway dashboard.

### Option B: Render
1. Push this folder to GitHub
2. Create a new Web Service on render.com pointing to your repo
3. Set `npm start` as the start command
4. Add your env vars in the Render dashboard

### Option C: Traditional VPS (DigitalOcean, Linode, etc.)
```bash
# On your server
npm install pm2 -g
pm2 start server.js --name mke-eats
pm2 save
pm2 startup
```

In production, lock down CORS:
```
ALLOWED_ORIGINS=https://yourdomain.com
```

---

## Upgrading the cache to Redis (production-ready)

Replace `cache/store.js` imports with:

```javascript
const redis = require('redis');
const client = redis.createClient({ url: process.env.REDIS_URL });

async function get(key) {
  const val = await client.get(key);
  return val ? JSON.parse(val) : null;
}

async function set(key, value, ttlMs = 3_600_000) {
  await client.setEx(key, Math.floor(ttlMs / 1000), JSON.stringify(value));
}
```

---

## License
MIT — build freely, sell freely, just don't blame us for cold fish fries.
