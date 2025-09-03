# ILP Extraction Server (Gemini 2.5 Flash-Lite)

Minimal Node/Express server that:
- Caches a reusable ILP extraction prompt (context cache)
- Accepts a PDF upload
- Calls Gemini 2.5 Flash-Lite with strict JSON schema
- Returns only the JSON your calculator needs

## Quickstart

```bash
# 1) Setup
cd ilp_extractor_server
cp .env.example .env
# put your GEMINI_API_KEY into .env

# 2) Install deps (Node 20+ recommended)
npm install

# 3) Run
npm run start
# or: npm run dev
```

Server will attempt to create a cache from `ilp_extraction_prompt.txt` on boot.
- GET `/health` — health check & cache status
- POST `/cache/rebuild` — rebuild the cache (no body)
- POST `/extract` — upload a PDF (multipart form-data, field name `pdf`)

### cURL
```bash
curl -X POST http://localhost:8080/extract   -H "Accept: application/json"   -F "pdf=@/path/to/brochure.pdf;type=application/pdf"
```

### Env
- `GEMINI_API_KEY` — required
- `PORT` — default 8080
- `MODEL` — default `gemini-2.5-flash-lite`
- `CACHE_TTL_SECONDS` — default 30 days

### Files
- `server.js` — Express app
- `schema.json` — strict JSON Schema (kept minimal for your calculator)
- `ilp_extraction_prompt.txt` — the long, reusable prompt and few-shot examples
- `.env.example` — sample env

### Notes
- If cache creation fails (e.g., quota/latency), the server falls back to sending the full prompt inline for that request.
- For PDFs < 20 MB, inline upload is cheapest and simplest.
- The response is validated to be JSON; if the model returns non-JSON, you’ll get a 502 with the raw text to debug.
