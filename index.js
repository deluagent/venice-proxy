/**
 * Venice Proxy — x402-gated private AI inference
 *
 * Wraps Venice AI (privacy-preserving, no data retention) behind
 * an x402 payment gate. Agents pay $0.001 USDC per inference call.
 *
 * Venice API is OpenAI-compatible:
 *   https://api.venice.ai/api/v1
 *
 * Flow:
 *   1. Agent sends chat completion request
 *   2. Server returns 402 if no X-Payment header
 *   3. Agent signs EIP-3009 USDC transfer, resends
 *   4. Proxy verifies payment, forwards to Venice, returns response
 *
 * Registered in ServiceRegistry as service id=2, category=AI.
 */

import express from 'express';
import { x402Middleware } from './x402.js';

const RECEIVER     = '0xed2ceca9de162c4f2337d7c1ab44ee9c427709da';
const VENICE_URL   = 'https://api.venice.ai/api/v1';
const VENICE_KEY   = process.env.VENICE_API_KEY ?? '';
const PORT         = process.env.PORT || 4010;

const app = express();
app.use(express.json({ limit: '1mb' }));

// x402 gates all inference routes
app.use(x402Middleware(RECEIVER, {
  'POST /v1/chat/completions':  'Private AI inference via Venice — no data retention',
  'POST /v1/completions':       'Private AI completion via Venice — no data retention',
  'GET /v1/models':             'List available Venice AI models',
}));

// ─── Free routes ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  service:  'VeniceProxy',
  version:  '1.0.0',
  x402:     true,
  price:    '$0.001 USDC per inference call',
  receiver: RECEIVER,
  network:  'base (eip155:8453)',
  upstream: VENICE_URL,
  privacy:  'no data retention, on-device inference',
  apiKeyConfigured: !!VENICE_KEY,
}));

app.get('/.well-known/capabilities', (req, res) => res.json({
  name:            'VeniceProxy',
  description:     'Privacy-preserving AI inference. $0.001 USDC per call. No data retention.',
  version:         '1.0.0',
  paymentStandard: 'x402',
  pricePerCall:    '$0.001 USDC',
  network:         'base',
  chainId:         8453,
  receiver:        RECEIVER,
  serviceRegistryId: 2,
  category:        'AI',
  upstream:        'Venice AI (venice.ai)',
  models:          ['llama-3.3-70b', 'mistral-31-24b', 'venice-uncensored'],
  endpoints: [
    { path: '/v1/chat/completions', method: 'POST', description: 'Chat completion (OpenAI-compatible)', price: '$0.001' },
    { path: '/v1/completions',      method: 'POST', description: 'Text completion', price: '$0.001' },
    { path: '/v1/models',           method: 'GET',  description: 'List models', price: '$0.001' },
    { path: '/health',              method: 'GET',  description: 'Health check', price: 'free' },
  ],
}));

// ─── Paid proxy routes ────────────────────────────────────────────────────────

async function proxyToVenice(req, res, method = 'POST') {
  if (!VENICE_KEY) {
    // No API key — return a mock that still demonstrates the x402 flow
    console.log('  [mock] No VENICE_API_KEY set — returning mock response');
    return res.json({
      id: 'chatcmpl-mock-venice',
      object: 'chat.completion',
      model: req.body?.model ?? 'venice-uncensored',
      x402: { paid: true, amount: '$0.001', network: 'base' },
      mock: true,
      note: 'Set VENICE_API_KEY env var to enable live Venice inference',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: `[VeniceProxy demo] Payment received via x402. ` +
                   `In production, this request would route to Venice AI ` +
                   `for private inference with no data retention. ` +
                   `Your prompt: "${req.body?.messages?.slice(-1)[0]?.content ?? ''}"`
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  const path = req.originalUrl;
  const upstream = `${VENICE_URL}${path.replace(/^\/v1/, '')}`;

  console.log(`  → proxying to Venice: ${upstream}`);

  const body = method === 'POST' ? JSON.stringify(req.body) : undefined;
  const veniceRes = await fetch(upstream, {
    method,
    headers: {
      'Authorization': `Bearer ${VENICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  const data = await veniceRes.json();

  // Inject payment metadata
  if (data && typeof data === 'object') {
    data.x402 = { paid: true, amount: '$0.001', network: 'base' };
  }

  res.status(veniceRes.status).json(data);
}

app.post('/v1/chat/completions', (req, res) => proxyToVenice(req, res, 'POST'));
app.post('/v1/completions',      (req, res) => proxyToVenice(req, res, 'POST'));

app.get('/v1/models', async (req, res) => {
  if (!VENICE_KEY) {
    return res.json({
      object: 'list',
      x402: { paid: true, amount: '$0.001', network: 'base' },
      mock: true,
      data: [
        { id: 'llama-3.3-70b',    object: 'model', owned_by: 'venice' },
        { id: 'mistral-31-24b',   object: 'model', owned_by: 'venice' },
        { id: 'venice-uncensored', object: 'model', owned_by: 'venice' },
        { id: 'qwen-2.5-vl',      object: 'model', owned_by: 'venice' },
      ],
    });
  }
  proxyToVenice(req, res, 'GET');
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`VeniceProxy :${PORT}`);
  console.log(`x402 — $0.001/call → ${RECEIVER}`);
  console.log(`Venice API key: ${VENICE_KEY ? '✓ configured' : '✗ not set (mock mode)'}`);
});
