/**
 * x402 Payment Required — custom middleware
 *
 * Implements the HTTP 402 Payment Required standard:
 *   https://x402.org / github.com/coinbase/x402
 *
 * Flow:
 *   1. Client hits gated route → server returns 402 + Payment-Required header
 *   2. Client reads PaymentRequired, creates EIP-712 signed transfer authorization
 *   3. Client resends with X-Payment header (base64 PaymentPayload)
 *   4. Server verifies signature → grants access or returns 402 again
 *
 * The PaymentRequired header is base64-encoded JSON:
 *   {
 *     "accepts": [{
 *       "scheme": "exact",
 *       "network": "eip155:8453",
 *       "maxAmountRequired": "1000",   // USDC units (6 decimals)
 *       "resource": "https://...",
 *       "description": "...",
 *       "mimeType": "application/json",
 *       "payTo": "0x...",
 *       "maxTimeoutSeconds": 60,
 *       "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC Base
 *       "extra": { "name": "USDC", "version": "2" }
 *     }],
 *     "error": null
 *   }
 */

const USDC_BASE   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE_UNITS = '1000'; // 0.001 USDC (6 decimals)

/**
 * Build the PaymentRequired object for a route.
 */
function buildPaymentRequired(resource, description, payTo) {
  return {
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      maxAmountRequired: PRICE_UNITS,
      resource,
      description,
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: 300,
      asset: USDC_BASE,
      extra: { name: 'USD Coin', version: '2' },
    }],
    error: null,
  };
}

/**
 * Verify an X-Payment header.
 * In production: POST to facilitator /verify endpoint.
 * Here: structural verification + amount/receiver check.
 *
 * Returns { valid: bool, error?: string, payload?: object }
 */
function verifyPayment(xPaymentHeader, payTo) {
  try {
    const decoded = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
    const payload = JSON.parse(decoded);

    // Check required fields exist
    if (!payload.payload || !payload.scheme || !payload.network) {
      return { valid: false, error: 'missing required fields in payment payload' };
    }

    if (payload.network !== 'eip155:8453') {
      return { valid: false, error: `wrong network: ${payload.network}` };
    }

    if (payload.scheme !== 'exact') {
      return { valid: false, error: `unsupported scheme: ${payload.scheme}` };
    }

    // Check the inner payload
    const inner = payload.payload;

    // Verify receiver
    if (inner.to?.toLowerCase() !== payTo.toLowerCase()) {
      return { valid: false, error: `wrong receiver: expected ${payTo}, got ${inner.to}` };
    }

    // Verify amount >= required
    if (BigInt(inner.value ?? 0) < BigInt(PRICE_UNITS)) {
      return { valid: false, error: `insufficient payment: ${inner.value} < ${PRICE_UNITS}` };
    }

    // Verify not expired
    if (inner.validBefore && BigInt(inner.validBefore) < BigInt(Math.floor(Date.now() / 1000))) {
      return { valid: false, error: 'payment authorization expired' };
    }

    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: `invalid payment header: ${e.message}` };
  }
}

/**
 * x402 middleware factory.
 * @param {string} payTo - Address that receives payment
 * @param {Record<string, string>} routes - Map of "METHOD /path" to description
 */
export function x402Middleware(payTo, routes) {
  return (req, res, next) => {
    const routeKey = `${req.method} ${req.route?.path ?? req.path}`;

    // Check if this route requires payment
    const description = findRoute(routes, req.method, req.path);
    if (!description) return next(); // not a paid route

    const xPayment = req.headers['x-payment'];

    if (!xPayment) {
      // No payment — return 402 with PaymentRequired header
      const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const paymentRequired = buildPaymentRequired(resource, description, payTo);
      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

      return res
        .status(402)
        .setHeader('Payment-Required', encoded)
        .setHeader('Content-Type', 'application/json')
        .json({
          error: 'Payment Required',
          price: '$0.001 USDC',
          network: 'base (eip155:8453)',
          payTo,
          asset: USDC_BASE,
          standard: 'x402',
          details: 'Include X-Payment header with signed EIP-3009 transfer authorization',
          paymentRequired: paymentRequired,
        });
    }

    // Verify payment
    const result = verifyPayment(xPayment, payTo);
    if (!result.valid) {
      return res.status(402).json({
        error: 'Invalid Payment',
        reason: result.error,
        standard: 'x402',
      });
    }

    // Payment verified — attach to request for logging
    req.x402 = { verified: true, payload: result.payload };
    next();
  };
}

/**
 * Match a route pattern to a method + path.
 * Supports :param wildcards.
 */
function findRoute(routes, method, path) {
  for (const [key, description] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(' ');
    if (routeMethod !== method) continue;
    if (matchPath(routePath, path)) return description;
  }
  return null;
}

function matchPath(pattern, path) {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((p, i) => p.startsWith(':') || p === pathParts[i]);
}
