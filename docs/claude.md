# Claude (Anthropic)

PromptIQ can use Claude for analysing, rewriting, checking and breaking down
prompts. It uses the Anthropic Messages API with structured outputs, so every
answer is constrained to PromptIQ's JSON schemas and then validated on the
server like any other provider.

## 1. Get an API key

1. Sign in to the [Claude Console](https://platform.claude.com/).
2. Add credit under **Billing**. The API is prepaid, so requests fail with
   "credit balance is too low" until you do.
3. Open **API keys** and choose **Create key**. Copy it (it starts with
   `sk-ant-`). You can't view it again later.

The key is a server secret. Users never see or supply it.

## 2. Put the key in PromptIQ

**On your Mac (development):** open `~/Desktop/promptiq/.env.local` (create
it from `.env.example` if it doesn't exist) and set:

```
OPTIMISER_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...your key...
ANTHROPIC_MODEL=claude-sonnet-5-5
```

Restart `npm run dev`. `.env.local` is git-ignored, so the key is never
committed.

**In production (Vercel or any host):** add the same variables under the
project's **Settings → Environment Variables**, then redeploy. Never put the
key in code, in `.env.example`, or in a variable starting with `NEXT_PUBLIC_`.

**Check:** sign in as an admin and open `/admin`. It shows
`Provider: anthropic (claude-sonnet-5-5)`. Then run a prompt in the Studio.
If something is wrong, the server log says why (see [Errors](#errors)).

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (required) | Your Claude API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | `claude-sonnet-5-5` (best balance), `claude-haiku-5-5` (cheapest, fastest) or `claude-opus-5-5` (most capable) |
| `ANTHROPIC_EFFORT` | `low` | `low`, `medium` or `high`. How much work Claude puts in, thinking included. Prompt editing rarely needs more than `low`, and higher effort is slower and uses more output tokens. |
| `ANTHROPIC_TIMEOUT_MS` | `90000` | Per-request timeout |
| `OPTIMISER_FALLBACK` | `rules` | If Claude is unreachable or keeps returning unusable output, answer with the built-in rule-based engine (`none` shows an error instead) |

## How it works

- **Structured outputs.** Each request sends PromptIQ's schema as
  `output_config.format` (`json_schema`). Constraints Claude doesn't support,
  such as length and range limits, are removed from the schema sent to Claude,
  because the server validates every reply anyway. If Claude rejects a schema,
  PromptIQ switches to asking for plain JSON and keeps validating.
- **Thinking.** Current Claude models think adaptively. Thinking tokens count
  toward `max_tokens`, so each request gets 8,000 tokens of headroom on top of
  its answer budget. Only the final text is parsed.
- **Prompt caching.** The fixed instructions are marked for caching, so repeat
  requests of the same kind are billed at the much lower cache-read rate.
- **Retries.** A malformed answer gets one repair attempt. Overload (529),
  rate limits (429), timeouts and connection errors are retried once. Key,
  credit and model-name errors are not retried. A circuit breaker pauses calls
  after repeated failures.
- **Refusals** (`stop_reason: "refusal"`) are shown to the user. A truncated
  answer (`max_tokens`) is reported as incomplete.

## Cost

Migration `0007_claude_pricing.sql` records list prices (USD per million
tokens, verified 2026-11-14 from the
[models overview](https://platform.claude.com/docs/en/about-claude/models)):

| Model | Input | Cache read | Output |
| --- | --- | --- | --- |
| `claude-sonnet-5-5` | 2.00 | 0.10 | 10.00 |
| `claude-opus-5-5` | 4.00 | 0.20 | 20.00 |
| `claude-haiku-5-5` | from 0.10 | 0.01 | from 0.50 |

Usage records, cost figures and `GLOBAL_DAILY_SPEND_CAP_USD` use these
prices. Thinking is billed as output. Cache writes cost a little more than
normal input, and PromptIQ counts them at the input rate. When prices change:

```bash
DATABASE_URL=… npm run pricing:add -- --provider anthropic --model claude-sonnet-5-5 \
  --input 2 --cached 0.1 --output 10 --source https://platform.claude.com/docs/en/about-claude/pricing
```

## Errors

| Log message / reason | Fix |
| --- | --- |
| `Claude rejected the API key` (`auth_error`) | Check `ANTHROPIC_API_KEY`. Create a new key if it was revoked. |
| `Anthropic account has no credit` (`insufficient_credit`) | Add credit in the Claude Console under Billing |
| `Claude model not found` (`model_not_found`) | Fix `ANTHROPIC_MODEL` |
| `Claude is overloaded` (`upstream_overloaded`) | Temporary; retried once, then the rule-based fallback answers |
| `provider rate limited` (`upstream_rate_limited`) | Your organisation's rate limit; wait, or ask Anthropic for a higher tier |

## Evaluation

```bash
OPTIMISER_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:intelligence
```

This runs the golden dataset against Claude, without the fallback, and writes a report.

Code: `src/lib/providers/anthropic.ts`. Tests: `tests/unit/anthropic.test.ts`
run the real SDK against a local stand-in for the API.
