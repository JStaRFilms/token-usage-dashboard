#!/usr/bin/env python3
"""Refresh token/cost usage data for Codex and Pi histories.

Usage:
  python scripts/refresh_usage.py
  python scripts/refresh_usage.py --serve
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import threading
from collections import Counter, defaultdict
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config.json"

# USD per 1M tokens: input, cached input/cache read, output.
# Reasoning output is included in output_tokens by Codex totals; kept separately for reporting only.
PRICES = {
    "gpt-5.5": (5.00, 0.50, 30.00),
    "gpt-5.4": (2.50, 0.25, 15.00),
    "gpt-5.4-mini": (0.75, 0.075, 4.50),
    "gpt-5.4-nano": (0.20, 0.02, 1.25),
    "gpt-5.2": (1.75, 0.175, 14.00),
    "gpt-5.1": (1.25, 0.125, 10.00),
    "gpt-5": (1.25, 0.125, 10.00),
    "gpt-5-mini": (0.25, 0.025, 2.00),
    "gpt-4.1": (2.00, 0.50, 8.00),
    "gpt-4o": (2.50, 1.25, 10.00),
    "o4-mini": (1.10, 0.275, 4.40),
    # Aliases/constituents observed in Codex history.
    "gpt-5.2-codex": (1.75, 0.175, 14.00),
    "gpt-5.3-codex": (2.50, 0.25, 15.00),  # no public row; assumed 5.4-class
    "gpt-5-codex": (1.25, 0.125, 10.00),
    # Anthropic best-effort, used only when present in Pi logs.
    "claude-sonnet-4-6": (3.00, 0.30, 15.00),
}

PRICE_NOTES = {
    "gpt-5.3-codex": "No public row supplied; priced as gpt-5.4-class estimate.",
    "claude-sonnet-4-6": "Best-effort Sonnet-class estimate, not from supplied OpenAI table.",
}

SCAN_STATE = {"running": False, "last_started": None, "last_finished": None, "error": None}


def load_config(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Config not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def safe_json(line: str):
    try:
        return json.loads(line)
    except Exception:
        return None


def iso_day(ts: str | None) -> str:
    if not ts:
        return "unknown"
    return ts[:10]


def calc_cost(model: str, input_tokens: int, cached_tokens: int, output_tokens: int, input_includes_cache: bool) -> tuple[float | None, dict]:
    price = PRICES.get(model)
    if not price:
        return None, {"known": False, "note": "Unknown price"}
    in_rate, cache_rate, out_rate = price
    non_cached = max(input_tokens - cached_tokens, 0) if input_includes_cache else input_tokens
    cost_input = non_cached * in_rate / 1_000_000
    cost_cache = cached_tokens * cache_rate / 1_000_000
    cost_output = output_tokens * out_rate / 1_000_000
    return cost_input + cost_cache + cost_output, {
        "known": True,
        "input_rate": in_rate,
        "cached_rate": cache_rate,
        "output_rate": out_rate,
        "non_cached_input_tokens": non_cached,
        "cost_input": cost_input,
        "cost_cache": cost_cache,
        "cost_output": cost_output,
        "note": PRICE_NOTES.get(model),
    }


def event(source, file, timestamp, session_id, model, input_tokens, cached_tokens, output_tokens, reasoning_tokens, total_tokens, input_includes_cache, granularity):
    cost, price = calc_cost(model or "unknown", input_tokens, cached_tokens, output_tokens, input_includes_cache)
    return {
        "source": source,
        "file": str(file),
        "timestamp": timestamp,
        "day": iso_day(timestamp),
        "session_id": session_id,
        "model": model or "unknown",
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_tokens,
        "output_tokens": output_tokens,
        "reasoning_output_tokens": reasoning_tokens,
        "total_tokens": total_tokens,
        "input_includes_cache": input_includes_cache,
        "granularity": granularity,
        "estimated_cost_usd": cost,
        "price": price,
    }


def scan_codex(root: Path) -> tuple[list[dict], list[str]]:
    events, warnings = [], []
    if not root.exists():
        return events, [f"Codex path missing: {root}"]
    for file in root.rglob("*.jsonl"):
        current_model, session_id = "unknown", file.stem
        last_total = None
        try:
            for line in file.open("r", encoding="utf-8", errors="ignore"):
                obj = safe_json(line)
                if not isinstance(obj, dict):
                    continue
                payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
                typ = obj.get("type")
                if typ == "session_meta":
                    session_id = payload.get("id") or session_id
                    current_model = payload.get("model") or current_model
                elif typ == "turn_context":
                    current_model = payload.get("model") or current_model
                elif typ == "event_msg" and payload.get("type") == "token_count":
                    info = payload.get("info")
                    if isinstance(info, dict) and isinstance(info.get("total_token_usage"), dict):
                        last_total = (obj.get("timestamp"), session_id, current_model, info["total_token_usage"])
        except Exception as e:
            warnings.append(f"Codex parse failed: {file}: {e}")
        if last_total:
            ts, sid, model, u = last_total
            events.append(event(
                "codex", file, ts, sid, model,
                int(u.get("input_tokens", 0) or 0),
                int(u.get("cached_input_tokens", 0) or 0),
                int(u.get("output_tokens", 0) or 0),
                int(u.get("reasoning_output_tokens", 0) or 0),
                int(u.get("total_tokens", 0) or 0),
                True,
                "session-final-cumulative",
            ))
    return events, warnings


def scan_pi(root: Path) -> tuple[list[dict], list[str]]:
    events, warnings = [], []
    if not root.exists():
        return events, [f"Pi sessions path missing: {root}"]
    for file in root.rglob("*.jsonl"):
        provider, model, session_id = "unknown", "unknown", file.stem
        try:
            for line in file.open("r", encoding="utf-8", errors="ignore"):
                obj = safe_json(line)
                if not isinstance(obj, dict):
                    continue
                typ = obj.get("type")
                if typ == "session":
                    session_id = obj.get("id") or session_id
                elif typ == "model_change":
                    provider = obj.get("provider") or provider
                    model = obj.get("modelId") or model
                elif typ == "message":
                    msg = obj.get("message") if isinstance(obj.get("message"), dict) else {}
                    u = msg.get("usage") if isinstance(msg.get("usage"), dict) else None
                    if u:
                        # Pi usage has input + cacheRead as separate additive fields in observed logs.
                        events.append(event(
                            "pi", file, obj.get("timestamp"), session_id, model,
                            int(u.get("input", 0) or 0),
                            int(u.get("cacheRead", 0) or 0),
                            int(u.get("output", 0) or 0),
                            0,
                            int(u.get("totalTokens", 0) or 0),
                            False,
                            "model-call",
                        ) | {"provider": provider})
        except Exception as e:
            warnings.append(f"Pi parse failed: {file}: {e}")
    return events, warnings


def aggregate(events: list[dict], warnings: list[str], started: float) -> dict:
    totals = Counter()
    by_model = defaultdict(Counter)
    by_source = defaultdict(Counter)
    by_day = defaultdict(Counter)
    by_session = defaultdict(Counter)
    unknown_models = Counter()

    for e in events:
        keys = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]
        for k in keys:
            totals[k] += e[k]
            by_model[e["model"]][k] += e[k]
            by_source[e["source"]][k] += e[k]
            by_day[e["day"]][k] += e[k]
            by_session[e["session_id"]][k] += e[k]
        if e["estimated_cost_usd"] is not None:
            totals["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_model[e["model"]]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_source[e["source"]]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_day[e["day"]]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_session[e["session_id"]]["estimated_cost_usd"] += e["estimated_cost_usd"]
        else:
            unknown_models[e["model"]] += 1
        by_model[e["model"]]["events"] += 1
        by_source[e["source"]]["events"] += 1
        by_day[e["day"]]["events"] += 1
        by_session[e["session_id"]]["events"] += 1

    def rows(d):
        return [{"key": k, **dict(v)} for k, v in sorted(d.items(), key=lambda kv: -kv[1].get("estimated_cost_usd", 0))]

    high = sorted(events, key=lambda e: e.get("estimated_cost_usd") or 0, reverse=True)[:100]
    recent = sorted(events, key=lambda e: e.get("timestamp") or "", reverse=True)[:200]
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scan_seconds": round(time.time() - started, 2),
        "event_count": len(events),
        "session_count": len(set(e["session_id"] for e in events)),
        "file_count": len(set(e["file"] for e in events)),
        "totals": dict(totals),
        "by_model": rows(by_model),
        "by_source": rows(by_source),
        "by_day": sorted(rows(by_day), key=lambda r: r["key"]),
        "by_session": rows(by_session)[:250],
        "high_cost_events": high,
        "recent_events": recent,
        "unknown_price_models": dict(unknown_models),
        "price_table": {k: {"input": v[0], "cached": v[1], "output": v[2], "note": PRICE_NOTES.get(k)} for k, v in PRICES.items()},
        "warnings": warnings[:200],
        "caveats": [
            "Codex input_tokens include cached_input_tokens; dashboard subtracts cached before applying input rates.",
            "Pi input/cacheRead are additive in observed logs; dashboard does not subtract cacheRead from input.",
            "Only explicit runtime usage metadata is counted. Raw transcript text is not re-tokenized.",
            "gpt-5.3-codex has no supplied public price row and is estimated as gpt-5.4-class.",
        ],
    }


def refresh(config_path: Path = DEFAULT_CONFIG) -> dict:
    started = time.time()
    config = load_config(config_path)
    sources = config.get("sources", {})
    codex_events, codex_warn = scan_codex(Path(sources.get("codex", "")))
    pi_events, pi_warn = scan_pi(Path(sources.get("pi_sessions", "")))
    events = codex_events + pi_events
    warnings = codex_warn + pi_warn
    summary = aggregate(events, warnings, started)
    summary["config"] = config

    out_summary = ROOT / config.get("output", {}).get("summary", "data/usage-summary.json")
    out_events = ROOT / config.get("output", {}).get("events", "data/usage-events.json")
    out_summary.parent.mkdir(parents=True, exist_ok=True)
    out_events.parent.mkdir(parents=True, exist_ok=True)
    out_summary.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    out_events.write_text(json.dumps(events, indent=2), encoding="utf-8")
    return summary


def refresh_background():
    if SCAN_STATE["running"]:
        return
    def run():
        SCAN_STATE.update({"running": True, "last_started": datetime.now(timezone.utc).isoformat(), "error": None})
        try:
            refresh(DEFAULT_CONFIG)
        except Exception as e:
            SCAN_STATE["error"] = str(e)
        finally:
            SCAN_STATE.update({"running": False, "last_finished": datetime.now(timezone.utc).isoformat()})
    threading.Thread(target=run, daemon=True).start()


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if urlparse(self.path).path == "/refresh":
            refresh_background()
            self.send_json({"ok": True, **SCAN_STATE})
        else:
            self.send_error(404)

    def do_GET(self):
        if urlparse(self.path).path == "/status":
            self.send_json(SCAN_STATE)
        else:
            super().do_GET()

    def send_json(self, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def serve(config_path: Path):
    config = load_config(config_path)
    host = config.get("server", {}).get("host", "127.0.0.1")
    port = int(config.get("server", {}).get("port", 8765))
    os.chdir(ROOT)
    if not (ROOT / "data" / "usage-summary.json").exists():
        refresh(config_path)
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Dashboard: http://{host}:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    config_path = Path(args.config).resolve()
    if args.serve:
        serve(config_path)
    else:
        summary = refresh(config_path)
        print(f"Wrote dashboard data: {summary['event_count']} events, ${summary['totals'].get('estimated_cost_usd', 0):,.2f} estimated")

if __name__ == "__main__":
    main()
