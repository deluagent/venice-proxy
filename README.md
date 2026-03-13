# VeniceProxy

x402-gated proxy for Venice AI — privacy-preserving inference with no data retention.

Agents pay $0.001 USDC per call. No accounts. No API keys. Just sign and pay.

## OpenAI-compatible

```bash
# Without x402 (returns 402)
curl -X POST http://localhost:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"venice-uncensored","messages":[{"role":"user","content":"hello"}]}'

# → HTTP 402 Payment Required
# → Payment-Required header with EIP-3009 signing details

# With x402 payment header
curl -X POST http://localhost:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Payment: <base64-signed-usdc-transfer>" \
  -d '{"model":"venice-uncensored","messages":[{"role":"user","content":"hello"}]}'

# → HTTP 200 + Venice AI response
```

## Models
- `llama-3.3-70b`
- `mistral-31-24b`
- `venice-uncensored`
- `qwen-2.5-vl`

## Stack
- Venice AI — private inference upstream
- x402 — HTTP payment standard
- ServiceRegistry — onchain registration with staked ETH

Built for The Synthesis hackathon — github.com/deluagent
