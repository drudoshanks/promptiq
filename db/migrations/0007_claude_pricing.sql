-- Claude (Anthropic) list prices, so usage records, cost figures and the daily
-- spend cap work when OPTIMISER_PROVIDER=anthropic. USD per million tokens,
-- standard (non-batch) rates from the Claude models overview, verified
-- 2026-11-14. Cache reads are 5% of the input price on Opus 5.5 and Sonnet 5.5,
-- and 10% on Haiku 5.5. Cache writes are billed at a premium that is not
-- modelled here: PromptIQ counts them at the input rate, so costs can be
-- slightly under-reported on the first request of each kind. Update with
-- `npm run pricing:add -- --provider anthropic ...` when prices change.
INSERT INTO model_pricing
  (provider, model_id, pricing_version, input_per_million, cached_input_per_million, output_per_million, effective_from, source, verified_at, notes)
VALUES
  ('anthropic', 'claude-sonnet-5-5', 'anthropic:claude-sonnet-5-5:2026-11-14', 2.00, 0.10, 10.00, '2026-09-28T00:00:00Z', 'https://platform.claude.com/docs/en/about-claude/models', '2026-11-14T00:00:00Z', 'Standard rate from the Claude models overview. Thinking tokens are billed as output.'),
  ('anthropic', 'claude-opus-5-5',   'anthropic:claude-opus-5-5:2026-11-14',   4.00, 0.20, 20.00, '2026-09-22T00:00:00Z', 'https://platform.claude.com/docs/en/about-claude/models', '2026-11-14T00:00:00Z', 'Standard rate from the Claude models overview. Thinking tokens are billed as output.'),
  ('anthropic', 'claude-haiku-5-5',  'anthropic:claude-haiku-5-5:2026-11-14',  0.10, 0.01, 0.50,  '2026-10-07T00:00:00Z', 'https://platform.claude.com/docs/en/about-claude/models', '2026-11-14T00:00:00Z', 'Lowest tier ("from" price), which applies to shorter prompts such as PromptIQ''s; longer prompts are billed at a higher tier.')
ON CONFLICT (pricing_version) DO NOTHING;
