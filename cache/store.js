/**
 * cache/store.js
 * Simple in-memory key-value cache with TTL (time-to-live).
 * In production, swap this out for Redis for multi-instance support.
 */

const DEFAULT_TTL = parseInt(process.env.CACHE_TTL_MS) || 3_600_000; // 1 hour

const store = new Map(); // key → { value, expiresAt }

/**
 * Get a cached value. Returns null if missing or expired.
 */
function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Set a cached value with optional custom TTL in ms.
 */
function set(key, value, ttl = DEFAULT_TTL) {
  store.set(key, { value, expiresAt: Date.now() + ttl });
}

/**
 * Delete a specific cache entry.
 */
function del(key) {
  store.delete(key);
}

/**
 * Clear ALL cache entries (useful for forced daily refresh).
 */
function flush() {
  const count = store.size;
  store.clear();
  return count;
}

/**
 * Return cache stats for the /health endpoint.
 */
function stats() {
  const now = Date.now();
  let active = 0;
  let expired = 0;
  for (const [, entry] of store) {
    if (now > entry.expiresAt) expired++;
    else active++;
  }
  return { totalKeys: store.size, activeKeys: active, expiredKeys: expired };
}

module.exports = { get, set, del, flush, stats };
