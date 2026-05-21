/**
 * routes/specials.js
 * Uses Claude (claude-sonnet-4) to extract daily specials & highlights
 * from Yelp review text. Results are cached to conserve API quota.
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cache = require('../cache/store');

const router = express.Router();

// Cache specials extractions for 24 hours (they don't change that fast)
const SPECIALS_TTL = 24 * 60 * 60 * 1000;

// ─── POST /api/specials/extract ───────────────────────────────────
// Body: { businessId, businessName, reviews: [{ text, rating }] }
// Returns: { special: "...", confidence: "high|low|none" }
router.post('/extract', async (req, res) => {
  const { businessId, businessName, reviews = [] } = req.body;

  if (!businessId || !businessName) {
    return res.status(400).json({ error: 'businessId and businessName are required.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.startsWith('sk-ant-your_')) {
    return res.status(503).json({
      error: 'Anthropic API key not configured.',
      special: null,
      confidence: 'none',
    });
  }

  // Check cache first
  const cacheKey = `specials::${businessId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, fromCache: true });
  }

  if (reviews.length === 0) {
    return res.json({ special: null, confidence: 'none', fromCache: false });
  }

  try {
    const client = new Anthropic({ apiKey });

    const reviewBlock = reviews
      .map((r, i) => `Review ${i + 1} (${r.rating}★): ${r.text}`)
      .join('\n\n');

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: `You are extracting dining highlights from Yelp reviews for a Milwaukee restaurant app.

Restaurant: ${businessName}

Reviews:
${reviewBlock}

Task: In 1–2 concise sentences, extract any of the following if mentioned:
- Daily specials or rotating dishes
- Happy hour deals or drink specials  
- Signature must-order dishes
- Notable seasonal items

If none of these are mentioned, respond exactly: NO_SPECIALS_FOUND

Be specific (include dish names, prices if mentioned). Do not invent or assume anything not in the reviews.`,
        },
      ],
    });

    const text = message.content[0]?.text?.trim() || '';
    const isNone = text === 'NO_SPECIALS_FOUND' || text.length < 10;

    const result = {
      special: isNone ? null : text,
      confidence: isNone ? 'none' : reviews.length >= 3 ? 'high' : 'low',
      extractedAt: new Date().toISOString(),
      fromCache: false,
    };

    cache.set(cacheKey, result, SPECIALS_TTL);
    res.json(result);

  } catch (err) {
    console.error('[CLAUDE ERROR]', err.message);
    res.status(500).json({
      error: err.message,
      special: null,
      confidence: 'none',
    });
  }
});

// ─── POST /api/specials/batch ─────────────────────────────────────
// Extracts specials for multiple restaurants in one call.
// Body: { restaurants: [{ businessId, businessName, reviews }] }
// Processes sequentially to avoid hammering the Anthropic API.
router.post('/batch', async (req, res) => {
  const { restaurants = [] } = req.body;

  if (!Array.isArray(restaurants) || restaurants.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty "restaurants" array.' });
  }
  if (restaurants.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 restaurants per batch.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.startsWith('sk-ant-your_')) {
    return res.status(503).json({ error: 'Anthropic API key not configured.' });
  }

  const client = new Anthropic({ apiKey });
  const results = {};

  for (const { businessId, businessName, reviews = [] } of restaurants) {
    if (!businessId) continue;

    // Check cache
    const cacheKey = `specials::${businessId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      results[businessId] = { ...cached, fromCache: true };
      continue;
    }

    if (reviews.length === 0) {
      results[businessId] = { special: null, confidence: 'none' };
      continue;
    }

    try {
      await new Promise(r => setTimeout(r, 300)); // gentle pacing

      const reviewBlock = reviews
        .map((r, i) => `Review ${i + 1} (${r.rating}★): ${r.text}`)
        .join('\n\n');

      const message = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Restaurant: ${businessName}\n\nReviews:\n${reviewBlock}\n\nIn 1–2 sentences, extract daily specials, happy hour deals, or must-order signature dishes. If none: respond NO_SPECIALS_FOUND.`,
        }],
      });

      const text = message.content[0]?.text?.trim() || '';
      const isNone = text === 'NO_SPECIALS_FOUND' || text.length < 10;
      const result = {
        special: isNone ? null : text,
        confidence: isNone ? 'none' : 'high',
        extractedAt: new Date().toISOString(),
        fromCache: false,
      };

      cache.set(cacheKey, result, SPECIALS_TTL);
      results[businessId] = result;

    } catch (err) {
      results[businessId] = { error: err.message, special: null, confidence: 'none' };
    }
  }

  res.json({ results, processedAt: new Date().toISOString() });
});

module.exports = router;
