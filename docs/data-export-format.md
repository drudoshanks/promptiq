# Export formats (FR-008, FR-016)

## Single prompt exports (`GET /api/v1/prompts/{id}/export`, Studio and Library)

| Format | Content |
| --- | --- |
| `txt` | The prompt text verbatim with a trailing newline. Nothing else. |
| `md` | Title, category, version, tags and export time as a short list; the prompt inside a fenced block (`text` info string) whose fence is longer than any backtick run in the prompt; the version's change summary; a one-line note that token counts are estimates and the prompt has not been tested against its target model. `parseMarkdownExport` recovers the verbatim prompt. |
| `json` | The document below. Round-trips exactly with `parseJsonExport`. |

```json
{
  "format": "promptiq.prompt",
  "format_version": 1,
  "exported_at": "2026-10-30T09:05:00.000Z",
  "prompt": {
    "id": "uuid",
    "title": "Invoice follow-up",
    "category": "writing",
    "tags": ["email"],
    "created_at": "…",
    "updated_at": "…"
  },
  "version": {
    "id": "uuid",
    "version_number": 2,
    "provenance": "ai_optimised",
    "prompt_text": "…",
    "change_summary": ["…"],
    "created_at": "…",
    "token_estimate": 88,
    "token_estimate_method": "tokenizer:o200k_base"
  }
}
```

## Account export (`POST /api/v1/exports`)

Returns one JSON file (`promptiq-export-YYYY-MM-DD.json`):

```json
{
  "format": "promptiq.account",
  "format_version": 1,
  "exported_at": "…",
  "account": {
    "email": "…",
    "display_name": "…",
    "plan_code": "free",
    "history_enabled": true,
    "personalisation_enabled": true,
    "created_at": "…"
  },
  "preferences": [
    { "id": "uuid", "category": "writing", "preference_key": "tone", "preference_value": { "value": "formal" }, "value": "formal", "source": "user_entered", "confidence": 1, "enabled": true, "created_at": "…", "updated_at": "…" }
  ],
  "prompts": [
    { "id": "uuid", "title": "…", "category": "…", "tags": [], "archived_at": null, "created_at": "…", "updated_at": "…", "versions": [ { "id": "uuid", "prompt_id": "uuid", "version_number": 1, "parent_version_id": null, "provenance": "original", "prompt_text": "…", "change_summary": [], "token_estimate": 34, "token_estimate_method": "tokenizer:o200k_base", "created_at": "…" } ] }
  ],
  "feedback": [
    { "id": "uuid", "run_id": "uuid", "rating": 1, "reason_code": "CLEARER", "comment": null, "preference_suggestion": null, "created_at": "…", "updated_at": "…" }
  ]
}
```

Usage metadata is available in aggregate on the Usage screen and is not itemised
in the export. `format_version` increments on any breaking change; readers should
reject unknown major versions.
