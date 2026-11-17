-- Prompt library: a public, read-only catalogue of ready-to-use prompts
-- (original PromptIQ prompts and curated CC0 prompts). Content is loaded and
-- kept in sync from db/seed/prompt-library.json by `npm run db:migrate`
-- (see src/lib/services/prompt-library.ts). No user data lives here, so no
-- row-level security; saving a template copies it into the user's own prompts.
CREATE TABLE prompt_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description  text NOT NULL,
  category     text NOT NULL CHECK (category IN ('writing','marketing','business','coding','data','education','research','productivity','career','customer_support','personal','creative','roles')),
  tags         text[] NOT NULL DEFAULT '{}',
  -- Tags as plain text, so the generated search vector stays immutable.
  tags_text    text NOT NULL DEFAULT '',
  prompt_text  text NOT NULL CHECK (length(prompt_text) BETWEEN 1 AND 20000),
  variables    text[] NOT NULL DEFAULT '{}',
  source       text NOT NULL CHECK (source IN ('promptiq','awesome-chatgpt-prompts')),
  source_url   text,
  license      text NOT NULL CHECK (license IN ('PromptIQ original','CC0-1.0')),
  author       text,
  featured     boolean NOT NULL DEFAULT false,
  sort_rank    integer NOT NULL DEFAULT 1000,
  use_count    integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  content_hash text NOT NULL,
  -- Hidden instead of deleted when an entry leaves the seed, so saved links don't 500.
  is_active    boolean NOT NULL DEFAULT true,
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english', title), 'A') ||
                 setweight(to_tsvector('english', description || ' ' || tags_text), 'B') ||
                 setweight(to_tsvector('english', prompt_text), 'C')
               ) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_prompt_templates_search ON prompt_templates USING gin (search);
CREATE INDEX idx_prompt_templates_category ON prompt_templates (category, sort_rank) WHERE is_active;
CREATE INDEX idx_prompt_templates_popular ON prompt_templates (use_count DESC, sort_rank) WHERE is_active;
