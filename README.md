# Token Ledger

Portable local dashboard for Takomi/Pi, Codex, and Antigravity/Gemini token/cost usage.

## Run

```bash
cd C:/Users/johno/token-usage-dashboard
python scripts/refresh_usage.py --serve
```

Open: <http://127.0.0.1:8765>

The UI **Refresh scan** button works in server mode. If you open `index.html` directly, run this manually and reload:

```bash
python scripts/refresh_usage.py
python scripts\refresh_usage.py --serve
```

## Configure

Edit `config.json` if you relocate the dashboard or want different sources:

```json
{
  "sources": {
    "codex": "C:/Users/johno/.codex",
    "pi_sessions": "C:/Users/johno/.pi/agent/sessions",
    "gemini": "C:/Users/johno/.gemini",
    "project_discovery": "linked",
    "project_roots": []
  }
}
```

## Notes

- Codex `input_tokens` include `cached_input_tokens`, so the cost calculator subtracts cache from input before pricing and converts cumulative snapshots into timestamped deltas.
- Pi `input` and `cacheRead` are additive in observed logs, so cache is priced separately without subtraction.
- Gemini/Antigravity cached tokens are treated as part of input, so the cost calculator subtracts cache before pricing.
- Project-local Pi/Takomi histories are discovered by following `cwd` links from global Pi sessions.
- The dashboard shows both highest-cost sessions and largest raw usage records, so Codex cumulative sessions and Pi per-call rows are easier to compare fairly.
- Broad `project_roots` scanning is opt-in: set `project_discovery` to `"roots"` or `"both"` if you intentionally want it.
- Logs are not copied into the dashboard; generated data contains metadata-derived usage events.
- Only explicit runtime usage metadata is counted. The app does not estimate tokens from raw transcript text.
- Gemini CLI support scans local `.gemini/tmp/**/chats/*.json[l]` histories.
- Antigravity support scans `.gemini/antigravity-cli`, `.gemini/antigravity-ide`, and `.gemini/antigravity` sqlite `gen_metadata` rows. Legacy `.pb` blobs are reported but not decoded yet.
- Source distribution groups detailed sources into `takomi/pi`, `codex`, and `antigravity`; event rows keep detailed source names in hover text.
- Gemini pricing uses current Google Gemini API paid text/image/video rates; Pro models use the <=200K-context tier, and observed internal aliases are mapped to their public equivalents where available.
- GPT-5.6 Luna and Terra use the OpenAI rates effective July 30, 2026; earlier usage retains the prior rates. Sol pricing is unchanged.
- Antigravity sqlite `gen_metadata` rows carry no per-record timestamps, so their events use the database modification time.
- `gpt-5.3-codex` has no supplied public price row; it is estimated as GPT-5.4-class.
- The history folders may contain sensitive prompts/secrets. Do not publish generated event data publicly.
