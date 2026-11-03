# Open-source models

PromptIQ can analyse and rewrite prompts with open-source models (Qwen, Llama,
Gemma, Mistral, gpt-oss, DeepSeek and others) instead of OpenAI. It talks to
them through the OpenAI-compatible Chat Completions API that almost every model
server offers, so the same setting works on a laptop and in production.

```
OPTIMISER_PROVIDER=open
OPEN_MODEL_BASE_URL=http://localhost:11434/v1   # Ollama (default)
OPEN_MODEL=qwen2.5:7b
```

Nothing else changes: the instructions, output schemas, requirement checks,
token and cost reporting, retries and the circuit breaker are the same as for
OpenAI. Prompt text is never logged.

## Where the model runs

| Option | Good for | Settings |
| --- | --- | --- |
| **Ollama** on your Mac | Development, privacy, zero cost | `OPEN_MODEL_BASE_URL=http://localhost:11434/v1`, no key |
| **LM Studio** | Same, with a desktop UI | `OPEN_MODEL_BASE_URL=http://localhost:1234/v1` |
| **vLLM / llama.cpp server** on a GPU server | Production you control | `OPEN_MODEL_BASE_URL=http://<server>:8000/v1` |
| **Groq** | Production without servers; fast | `OPEN_MODEL_BASE_URL=https://api.groq.com/openai/v1`, `OPEN_MODEL_API_KEY`, e.g. `OPEN_MODEL=openai/gpt-oss-20b` |
| **OpenRouter** | One key, many open models | `OPEN_MODEL_BASE_URL=https://openrouter.ai/api/v1`, `OPEN_MODEL_API_KEY` |
| **Together** | Hosted open models | `OPEN_MODEL_BASE_URL=https://api.together.xyz/v1`, `OPEN_MODEL_API_KEY` |

A serverless host such as Vercel cannot run a model itself. For a public
deployment, use a hosted service from the table or point
`OPEN_MODEL_BASE_URL` at your own GPU server.

## Ollama on a Mac

```bash
brew install ollama
OLLAMA_CONTEXT_LENGTH=16384 ollama serve      # leave running in its own tab
ollama pull qwen2.5:7b                        # ~4.7 GB download
```

Then in `.env.local`:

```
OPTIMISER_PROVIDER=open
OPEN_MODEL=qwen2.5:7b
```

and restart `npm run dev`.

PromptIQ's instructions and outputs can be several thousand tokens. Raise
Ollama's context length (above, or under **Settings** in the Ollama app). If it
is too small, the model silently loses the start of the instructions.

Choosing a model: a 7–8B instruction model (for example `qwen2.5:7b` or
`llama3.1:8b`) runs on a 16 GB Apple Silicon Mac. Larger models (for example
`gpt-oss:20b` or `qwen2.5:14b`) give noticeably better rewrites if you have the
memory. Reasoning models that print `<think>` blocks also work, because the
reasoning is stripped before parsing. Measure before you switch (see
[Evaluation](#evaluation)).

## How output is kept valid

1. Requests use `response_format: json_schema` with the same strict schemas as
   the OpenAI adapter, so the model server constrains the output to the
   expected shape. Ollama, vLLM, llama.cpp and Groq (on supported models)
   implement this.
2. If a host rejects `json_schema` (HTTP 400), PromptIQ switches to
   `json_object` for the rest of the process and puts the schema in the system
   prompt. To start in that mode, set `OPEN_MODEL_OUTPUT=json_object`.
3. Replies are tolerated with a ```` ```json ```` fence, a sentence around the
   JSON, or `<think>…</think>` reasoning.
4. Every reply is still validated server-side. Invalid output gets one repair
   attempt. A truncated reply (`finish_reason: length`) is reported as
   incomplete.

## Rule-based fallback

With `OPEN_MODEL_FALLBACK=rules` (the default), the user still gets a result
when the model server is down, the model is missing, or the model keeps
returning unusable output. In those cases PromptIQ answers with the built-in
rule-based engine. Refusals are never overridden. The failed model attempts and
the fallback attempt are both recorded, with model ID `mock-optimiser` for the
fallback, so usage history and the admin page show which engine answered. The
server log line is `primary provider unavailable; using rule-based engine`.
Set `OPEN_MODEL_FALLBACK=none` to return an error instead.

## Errors

| Log / reason | Meaning | Fix |
| --- | --- | --- |
| `connection_error` | Nothing is listening at `OPEN_MODEL_BASE_URL` | Start `ollama serve`, check the URL |
| `model_not_found` | The server doesn't have `OPEN_MODEL` | `ollama pull <model>` or fix the name (`ollama list`) |
| `timeout` | Slower than `OPEN_MODEL_TIMEOUT_MS` (default 120 s) | Use a smaller model or raise the timeout |
| `upstream_rate_limited` | A hosted service's rate limit or quota | Wait, or upgrade the plan |
| `structured output invalid` | The model returned the wrong shape twice | Use a larger model, or leave the fallback on |

## Cost

Self-hosted models have no per-token price. Usage records show the tokens with
"pricing unavailable", and the daily spend cap doesn't count them. For a hosted
service, record its price so the cost figures and the spend cap work:

```bash
DATABASE_URL=… npm run pricing:add -- --provider open --model openai/gpt-oss-20b --input <usd/1M> \
  --output <usd/1M> --source <pricing page URL> --effective-from YYYY-MM-DD
```

The **Target model** selector in the Studio is separate from this setting. It
chooses which tokenizer counts the prompt for the model you will send it to.

## Evaluation

Compare a model against the rule-based engine on the golden dataset before
using it:

```bash
npm run eval:intelligence                                           # rule-based baseline
OPTIMISER_PROVIDER=open OPEN_MODEL=qwen2.5:7b npm run eval:intelligence
```

The evaluation never uses the fallback, so the report reflects the model alone.

## Code

- `src/lib/providers/open-model.ts`: the adapter.
- `src/lib/providers/fallback.ts`: the rule-based fallback.
- `src/lib/providers/index.ts`: selection from the environment.
- `tests/unit/open-model.test.ts`: tests through the real SDK against a local
  OpenAI-compatible test server.
