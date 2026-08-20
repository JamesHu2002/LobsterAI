# Quote Master API reference

Base URL: `http://127.0.0.1:8000/api` unless overridden.

## Authentication

- `POST /auth/login` with `username` and `password`.
- Response `data` contains `access_token`, `expires_in_seconds`, `user_id`, `username`, `display_name`, and `roles`.
- Send `Authorization: Bearer <access_token>` for all other endpoints.

## Envelope

Successful responses look like:

```json
{
  "success": true,
  "data": {},
  "error": null
}
```

The CLI returns only `data`.

## Quote-intake flow

| Action | Method | Path |
| --- | --- | --- |
| List intakes | GET | `/quote-intakes` |
| Create intake | POST | `/quote-intakes` |
| Upload/register document | POST | `/quote-intakes/{intake_id}/documents` |
| Classification review | GET | `/quote-intakes/{intake_id}/classification-review` |
| Confirm category | POST | `/quote-intakes/{intake_id}/documents/{source_doc_id}/confirm-category` |
| Progress | GET | `/quote-intakes/{intake_id}/progress` |
| Extract | POST | `/quote-intakes/{intake_id}/extract` |
| Persisted extractions | GET | `/quote-intakes/{intake_id}/extractions` |
| Test items | GET | `/quote-intakes/{intake_id}/test-items` |
| Non-standard items | GET | `/quote-intakes/{intake_id}/nonstandard-items` |
| Create draft | POST | `/quote-intakes/{intake_id}/draft-quotes` |

`ExtractRequest` requires `input_mode` (`TEXT_DOCUMENT`, `IMAGE_DOCUMENT`, or `MIXED`) and `persist`. `source_doc_ids` is optional; omit it or pass `null` to use eligible documents.

## Quote workflow

| Action | Method | Path |
| --- | --- | --- |
| Quote header | GET | `/quotes/{quote_id}` |
| Quote lines | GET | `/quotes/{quote_id}/lines` |
| Patch line | PATCH | `/quote-lines/{quote_line_id}` |
| Select customer | POST | `/quotes/{quote_id}/select-customer` |
| Confirm pricing | POST | `/quotes/{quote_id}/confirm-pricing` |
| Generate formal quote | POST | `/quotes/{quote_id}/generate` |
| Export pricing sheet | GET | `/quotes/{quote_id}/pricing-sheet.xlsx` |

Formal quote generation is state-gated. The backend requires an internally confirmed quote before it will generate a formal quote.

## Progress fields

Useful fields in the progress response:

- `current_status`
- `percent`
- `steps`
- `error_code`
- `error_message`
- `requires_classification_review`
- `next_poll_after_seconds`

The CLI `wait` command stops when `current_status` leaves the active processing set (`UNINPUT`, `INPUT_RECEIVED`, `EXTRACTING`, `RAG_RETRIEVING`) or when an error is present.
