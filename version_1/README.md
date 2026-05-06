# Token Ledger

Portable local dashboard for Codex and Pi token/cost usage.

## Run

```bash
cd C:/Users/johno/token-usage-dashboard
python scripts/refresh_usage.py --serve
```

Open: <http://127.0.0.1:8765>

The UI **Refresh scan** button works in server mode. If you open `index.html` directly, run this manually and reload:

```bash
python scripts/refresh_usage.py
```

## Configure

Edit `config.json` if you relocate the dashboard or want different sources:

```json
{
  "sources": {
    "codex": "C:/Users/johno/.codex",
    "pi_sessions": "C:/Users/johno/.pi/agent/sessions"
  }
}
```

## Notes

- Codex `input_tokens` include `cached_input_tokens`, so the cost calculator subtracts cache from input before pricing.
- Pi `input` and `cacheRead` are additive in observed logs, so cache is priced separately without subtraction.
- Only explicit runtime usage metadata is counted. The app does not estimate tokens from raw transcript text.
- `gpt-5.3-codex` has no supplied public price row; it is estimated as GPT-5.4-class.
- The history folders may contain sensitive prompts/secrets. Do not publish generated event data publicly.
