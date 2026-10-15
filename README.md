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
- GPT-6 Astra is supported at standard API rates ($10.00 input, $1.00 cached input, $50.00 output).
- GPT-6 Sol and Luna use [OpenAI Standard rates](https://platform.openai.com/docs/pricing) per 1M tokens: [Sol](https://platform.openai.com/docs/models/gpt-6-sol) $2.00 input, $0.20 cached, $2.50 cache write, $10.00 output; [Luna](https://platform.openai.com/docs/models/gpt-6-luna) $0.10 input, $0.01 cached, $0.125 cache write, $0.50 output. For Pi calls with more than 272K prompt tokens, input and cache rates double and output rates rise by 50% for the entire call. Codex cumulative deltas lack reliable per-request prompt sizes, so their GPT-6 Sol/Luna costs use short-context rates. Pi cache writes are priced for these two models when logged. Other service tiers, regional premiums, and tool fees are not inferred from the logs.
- Gemini 3.8 Flash and Gemini 3.7 Flash use the promotional rate ($0.75 / $0.075 / $3.75) through 2026-12-31, and standard rates ($1.50 / $0.15 / $7.50) from 2027-01-01.
- The current dashboard at `/` and the legacy dashboard at `/legacy` share `scripts/refresh_usage.py` and `data/usage-*.json`. One scan updates both. The `version_1` and `version_2` folders are archived copies.
- Additional public rates verified on 2026-10-15, in USD per 1M input / cached input / output tokens:
  - GPT-6.1 Sol: $2.00 / $0.10 / $10.00 from [OpenAI](https://platform.openai.com/docs/pricing). Cache writes cost $2.50. The same >272K prompt-token multipliers and Codex short-context limitation described above apply.
  - Claude Opus 4.6 and Opus 5: $5.00 / $0.50 / $25.00 from [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing). Thinking output uses the output rate. Logged cache writes use the $6.25 five-minute rate because the histories do not identify cache TTL.
  - GLM-5.3: $1.40 / $0.26 / $4.40 from [Z.ai](https://docs.z.ai/guides/overview/pricing). Proxy calls use these public rates as estimates, not actual proxy charges.
- Observed `ar-gpt-6-astra`, `ar-gpt-6.1-sol`, `ar-claude-opus-5`, `ar-glm-5.3`, and Opus 4.6 thinking/dotted aliases map to the public models. Ambiguous internal names and local models without a public API rate remain unpriced. Local hardware costs are not estimated.
- Configurable discounts can be declared in `config.json` under `"discounts"` with optional `model`, `month`, `start`, `end`, and `percent`.
- Monthly usage trends and breakdowns are aggregated across all sources in both chart and table views.
- Antigravity sqlite `gen_metadata` rows carry no per-record timestamps, so their events use the database modification time.
- `gpt-5.3-codex` has no supplied public price row; it is estimated as GPT-5.4-class.
- The history folders may contain sensitive prompts/secrets. Do not publish generated event data publicly.
