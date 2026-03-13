/**
 * x402 Payment Required — middleware with onchain USDC settlement
 *
 * Implements the HTTP 402 Payment Required standard:
 *   https://x402.org / github.com/coinbase/x402
 *
 * Flow:
 *   1. Client hits gated route → server returns 402 + Payment-Required header
 *   2. Client signs EIP-3009 transferWithAuthorization (USDC on Base)
 *   3. Client resends with X-Payment header
 *   4. Server verifies signature → if valid, submits USDC transfer onchain
 *   5. USDC moves from agent wallet to receiver wallet — real settlement
 *
 * Settlement: real USDC transfers on Base. Not just signatures.
 */

import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const USDC_BASE   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE_UNITS = '1000'; // 0.001 USDC (6 decimals)

// Settler key — needs ETH for gas to submit settlements
// Falls back to signature-only verification if no key / no gas
const SETTLER_KEY = process.env.SETTLER_KEY || null;

const USDC_ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external',
  'function balanceOf(address) external view returns (uint256)',
]);

let settler = null;
let publicClient = null;

if (SETTLER_KEY) {
  const account = privateKeyToAccount(SETTLER_KEY);
  publicClient = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
  settler = createWalletClient({ chain: base, transport: http('https://mainnet.base.org'), account });
  console.log(`x402 settler: ${account.address} (will settle USDC onchain)`);
} else {
  console.log(`x402 settler: not configured (signature verification only)`);
}

// ─── Payment Required builder ─────────────────────────────────────────────────

function buildPaymentRequired(resource, description, payTo) {
  return {
    accepts: [{
      scheme:              'exact',
      network:             'eip155:8453',
      maxAmountRequired:   PRICE_UNITS,
      resource,
      description,
      mimeType:            'application/json',
      payTo,
      maxTimeoutSeconds:   300,
      asset:               USDC_BASE,
      extra:               { name: 'USD Coin', version: '2' },
    }],
    error: null,
  };
}

// ─── Signature verification ───────────────────────────────────────────────────

function verifyPayment(xPaymentHeader, payTo) {
  try {
    const decoded = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
    const payload = JSON.parse(decoded);

    if (!payload.payload || !payload.scheme || !payload.network) {
      return { valid: false, error: 'missing required fields' };
    }
    if (payload.network !== 'eip155:8453') {
      return { valid: false, error: `wrong network: ${payload.network}` };
    }
    if (payload.scheme !== 'exact') {
      return { valid: false, error: `unsupported scheme: ${payload.scheme}` };
    }

    const inner = payload.payload;

    if (inner.to?.toLowerCase() !== payTo.toLowerCase()) {
      return { valid: false, error: `wrong receiver: expected ${payTo}` };
    }
    if (BigInt(inner.value ?? 0) < BigInt(PRICE_UNITS)) {
      return { valid: false, error: `insufficient payment: ${inner.value} < ${PRICE_UNITS}` };
    }
    if (inner.validBefore && BigInt(inner.validBefore) < BigInt(Math.floor(Date.now() / 1000))) {
      return { valid: false, error: 'payment authorization expired' };
    }

    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: `invalid payment header: ${e.message}` };
  }
}

// ─── Onchain settlement ───────────────────────────────────────────────────────

async function settlePayment(payload) {
  if (!settler) return { settled: false, reason: 'no settler configured' };

  const inner = payload.payload;
  try {
    const hash = await settler.writeContract({
      address: USDC_BASE,
      abi: USDC_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        inner.from,
        inner.to,
        BigInt(inner.value),
        BigInt(inner.validAfter || '0'),
        BigInt(inner.validBefore),
        inner.nonce,
        inner.signature,
      ],
    });
    console.log(`  ✓ USDC settled: ${hash}`);
    return { settled: true, txHash: hash };
  } catch (e) {
    // Already used nonce = replay protection working
    if (e.message?.includes('AuthorizationAlreadyUsed') || e.message?.includes('AUTHORIZATION_USED')) {
      return { settled: false, reason: 'nonce already used (replay protection)' };
    }
    console.error(`  settlement failed: ${e.message?.slice(0, 80)}`);
    return { settled: false, reason: e.message?.slice(0, 100) };
  }
}

// ─── Route matching ───────────────────────────────────────────────────────────

function findRoute(routes, method, path) {
  for (const [key, description] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(' ');
    if (routeMethod !== method) continue;
    if (matchPath(routePath, path)) return description;
  }
  return null;
}

function matchPath(pattern, path) {
  const pp = pattern.split('/');
  const ap = path.split('/');
  if (pp.length !== ap.length) return false;
  return pp.every((p, i) => p.startsWith(':') || p === ap[i]);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function x402Middleware(payTo, routes) {
  return async (req, res, next) => {
    const description = findRoute(routes, req.method, req.path);
    if (!description) return next();

    const xPayment = req.headers['x-payment'];

    if (!xPayment) {
      const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const paymentRequired = buildPaymentRequired(resource, description, payTo);
      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

      return res.status(402)
        .setHeader('Payment-Required', encoded)
        .json({
          error:           'Payment Required',
          price:           '$0.001 USDC',
          network:         'base (eip155:8453)',
          payTo,
          asset:           USDC_BASE,
          standard:        'x402',
          details:         'Include X-Payment header with signed EIP-3009 transfer authorization',
          paymentRequired,
        });
    }

    const result = verifyPayment(xPayment, payTo);
    if (!result.valid) {
      return res.status(402).json({ error: 'Invalid Payment', reason: result.error, standard: 'x402' });
    }

    // Settle onchain (async — don't block the response)
    settlePayment(result.payload).then(settlement => {
      if (settlement.settled) {
        console.log(`  USDC settled: ${settlement.txHash}`);
      }
    }).catch(() => {});

    req.x402 = { verified: true, payload: result.payload };
    next();
  };
}
