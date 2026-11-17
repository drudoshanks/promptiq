# Prompt library (public catalogue)

**Prompt library** (`/app/prompt-library`) is a searchable catalogue of
ready-to-use prompts for everyday work. It is shared by everyone and separate
from **My prompts** (`/app/library`), which is each user's private collection.

Each prompt can be:

- **filled in**: `{{field}}` blanks become a small form, and the preview shows
  filled blanks in green and empty ones in orange;
- **copied** with the blanks filled;
- **opened in the Studio** (`/app/studio?template=<slug>`) to score it, improve
  it or break it down. The filled text is handed over through `sessionStorage`
  (key `piq:library:<slug>`) and read once; without it, the Studio opens the
  plain template;
- **saved to My prompts** as the user's own copy (provenance `imported`, tags
  `library` and the category). The catalogue entry is never changed.

Copies, Studio opens and saves count as a use; "Most used" sorts by that.

## Where the prompts come from

We do not scrape prompts from websites: most published prompts are copyrighted.
The seed contains only:

| Source | Licence | Count |
| --- | --- | --- |
| Written for PromptIQ by iMarwar (`db/seed/prompt-library-original.ts`) | PromptIQ original | 82 |
| [awesome-chatgpt-prompts](https://github.com/f/awesome-chatgpt-prompts) `prompts.csv`, the classic rows | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain) | 182 |

Every row stores `source`, `source_url`, `license` and `author`, and the prompt
page shows the attribution. The categories follow published studies of what
people actually use AI assistants for (writing and editing, coding, research,
learning, business, everyday advice).

### Curation of the CC0 prompts

`scripts/build-prompt-library.ts` reads `prompts.csv` and keeps a row only if:

- it is one of the first 276 "classic" rows (later rows are mostly long agent
  and image prompts), is a text prompt, and is 200–4,000 characters;
- it is not about jailbreaks, adult content, gambling, crypto trading, medical,
  legal, therapy, religious or political advice, hacking or dating
  (`EXCLUDE`), and was not removed by hand (`OVERRIDES` → `null`);
- it is not a duplicate.

Categories come from rules on the title and opening text, with hand-set
`OVERRIDES` for the ones the rules get wrong.

## Rebuilding the seed

```bash
git clone --depth 1 https://github.com/f/awesome-chatgpt-prompts /tmp/acp
npx tsx scripts/build-prompt-library.ts /tmp/acp/prompts.csv
```

This rewrites `db/seed/prompt-library.json` (originals first, then CC0). To add
or edit an original prompt, change `db/seed/prompt-library-original.ts` and
rebuild. Review the diff before committing.

## How it gets into the database

`npm run db:migrate` applies `0008_prompt_templates.sql` and then syncs the
seed into `prompt_templates`:

- new slugs are inserted, changed ones updated (by content hash), and slugs no
  longer in the seed are hidden (`is_active = false`), not deleted;
- use counts are kept; running it twice changes nothing.

Run it locally and against production (Neon: use the **direct** connection
string with `DATABASE_SSL=true`).

## Search

A generated `tsvector` column weights the title (A), description and tags (B)
and prompt text (C). A query matches full-text (`websearch_to_tsquery`, so
quotes and `-word` work) or a substring of the title or tags (so "SEO" and
"regex" match). Results rank title matches first, then by text rank.

## API

All routes need a signed-in user.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/v1/prompt-library?q=&category=&sort=relevant\|popular\|az&page=&page_size=` | Search; returns items, totals and category counts |
| GET | `/api/v1/prompt-library/{slug}` | Full prompt with `related` |
| POST | `/api/v1/prompt-library/{slug}/use` | Count a copy or Studio open (204) |
| POST | `/api/v1/prompt-library/{slug}/save` | Body `{ "values": { "field": "text" } }`; copies into My prompts (201) |
