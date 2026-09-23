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
import re
import sqlite3
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
    "gpt-6-astra": (10.00, 1.00, 50.00),
    "gpt-6-sol": (2.00, 0.20, 10.00),
    "gpt-6-luna": (0.10, 0.01, 0.50),
    "gpt-5.6-luna": (0.20, 0.02, 1.20),
    "gpt-5.6-sol": (5.00, 0.50, 30.00),
    "gpt-5.6-terra": (2.00, 0.20, 12.00),
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
    # Google Gemini Developer API paid tier, per 1M text/image/video tokens.
    "gemini-3.8-flash": (0.75, 0.075, 3.75),
    "gemini-3.7-flash": (0.75, 0.075, 3.75),
    "gemini-3.6-flash": (1.50, 0.15, 7.50),
    "gemini-embedding-001": (0.15, 0.00, 0.00),
    "gemini-3.1-pro-preview": (2.00, 0.20, 12.00),
    "gemini-3-pro-preview": (2.00, 0.20, 12.00),
    "gemini-3.5-flash": (1.50, 0.15, 9.00),
    "gemini-3-flash-preview": (0.50, 0.05, 3.00),
    "gemini-3-flash": (0.50, 0.05, 3.00),
    "gemini-3-flash-a": (0.50, 0.05, 3.00),
    "gemini-3-flash-b": (0.50, 0.05, 3.00),
    "gemini-3-flash-agent": (0.50, 0.05, 3.00),
    "gemini-2.5-pro": (1.25, 0.125, 10.00),
    "gemini-2.5-flash": (0.30, 0.03, 2.50),
    "gemini-2.0-flash": (0.10, 0.025, 0.40),
}

PRICE_NOTES = {
    "gpt-6-astra": "OpenAI standard short-context pricing ($10.00 / $1.00 / $50.00).",
    "gpt-6-sol": "OpenAI Standard short-context rate; >272K prompt tokens: 2x input/cache, 1.5x output. Cache writes: $2.50/1M (short).",
    "gpt-6-luna": "OpenAI Standard short-context rate; >272K prompt tokens: 2x input/cache, 1.5x output. Cache writes: $0.125/1M (short).",
    "gpt-5.6-luna": "OpenAI standard short-context pricing from July 30, 2026; earlier usage uses the prior $1.00 / $0.10 / $6.00 rate.",
    "gpt-5.6-sol": "OpenAI standard short-context pricing; unchanged on July 30, 2026.",
    "gpt-5.6-terra": "OpenAI standard short-context pricing from July 30, 2026; earlier usage uses the prior $2.50 / $0.25 / $15.00 rate.",
    "gpt-5.3-codex": "No public row supplied; priced as gpt-5.4-class estimate.",
    "claude-sonnet-4-6": "Best-effort Sonnet-class estimate, not from supplied OpenAI table.",
    "gemini-3.8-flash": "Google Gemini 3.8 Flash promotional API rate through 2026-12-31 ($0.75 / $0.075 / $3.75), then standard ($1.50 / $0.15 / $7.50).",
    "gemini-3.7-flash": "Google Gemini 3.7 Flash promotional rate through 2026-12-31 ($0.75 / $0.075 / $3.75), then standard ($1.50 / $0.15 / $7.50).",
    "gemini-3.6-flash": "Google Gemini API standard text/image/video rate.",
    "gemini-embedding-001": "Google Gemini API text embedding input rate.",
    "gemini-3.1-pro-preview": "Google Gemini API standard text/image/video rate; <=200K-context tier.",
    "gemini-3-pro-preview": "Mapped to current Gemini 3.1 Pro Preview standard text/image/video rate; <=200K-context tier.",
    "gemini-3.5-flash": "Google Gemini API standard text/image/video rate.",
    "gemini-3-flash-preview": "Google Gemini API standard text/image/video rate.",
    "gemini-3-flash": "Mapped to Gemini 3 Flash Preview standard text/image/video rate.",
    "gemini-3-flash-a": "Internal Antigravity model id mapped to Gemini 3 Flash Preview standard text/image/video rate.",
    "gemini-3-flash-b": "Internal Antigravity model id mapped to Gemini 3 Flash Preview standard text/image/video rate.",
    "gemini-3-flash-agent": "Internal Antigravity model id mapped to Gemini 3 Flash Preview standard text/image/video rate.",
    "gemini-2.5-pro": "Google Gemini API standard text/image/video rate; <=200K-context tier.",
    "gemini-2.5-flash": "Google Gemini API standard text/image/video rate.",
    "gemini-2.0-flash": "Google Gemini API standard text/image/video rate.",
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


def iter_text_lines(file: Path):
    with file.open("r", encoding="utf-8", errors="ignore") as stream:
        yield from stream


def iso_day(ts: str | None) -> str:
    if not ts:
        return "unknown"
    return ts[:10]


GPT_5_6_PRICE_CHANGE_DAY = "2026-07-30"
LEGACY_GPT_5_6_PRICES = {
    "gpt-5.6-luna": (1.00, 0.10, 6.00),
    "gpt-5.6-terra": (2.50, 0.25, 15.00),
}
RATE_SCHEDULES = {
    "gpt-5.6-luna": [
        {"until": "2026-07-30", "price": (1.00, 0.10, 6.00), "note": "Legacy OpenAI rate before 2026-07-30."},
        {"since": "2026-07-30", "price": (0.20, 0.02, 1.20), "note": "OpenAI standard short-context pricing from 2026-07-30."},
    ],
    "gpt-5.6-terra": [
        {"until": "2026-07-30", "price": (2.50, 0.25, 15.00), "note": "Legacy OpenAI rate before 2026-07-30."},
        {"since": "2026-07-30", "price": (2.00, 0.20, 12.00), "note": "OpenAI standard short-context pricing from 2026-07-30."},
    ],
    "gemini-3.8-flash": [
        {"until": "2027-01-01", "price": (0.75, 0.075, 3.75), "note": "Google Gemini 3.8 Flash promotional developer API rate through 2026-12-31."},
        {"since": "2027-01-01", "price": (1.50, 0.15, 7.50), "note": "Google Gemini 3.8 Flash standard developer API rate."},
    ],
    "gemini-3.7-flash": [
        {"until": "2027-01-01", "price": (0.75, 0.075, 3.75), "note": "Google Gemini 3.7 Flash promotional developer API rate through 2026-12-31."},
        {"since": "2027-01-01", "price": (1.50, 0.15, 7.50), "note": "Google Gemini 3.7 Flash standard developer API rate."},
    ],
}
MODEL_ALIASES = {
    "ar-gpt-5.6-luna": "gpt-5.6-luna",
    "ar-gpt-5.6-sol": "gpt-5.6-sol",
    "ar-gpt-5.6-terra": "gpt-5.6-terra",
    "gpt-6-astra": "gpt-6-astra",
    "gemini-3.8-flash": "gemini-3.8-flash",
    "gemini-3.7-flash": "gemini-3.7-flash",
    "gemini-3.8-flash-preview": "gemini-3.8-flash",
    "gemini-3.7-flash-preview": "gemini-3.7-flash",
    "gemini-3.8-flash-control": "gemini-3.8-flash",
    "gemini-3.8-flash-tiered": "gemini-3.8-flash",
    "gemini-3.8-flash-high": "gemini-3.8-flash",
    "gemini-3.8-flash-low": "gemini-3.8-flash",
    "gemini-3.7-flash-control": "gemini-3.7-flash",
    "gemini-3.7-flash-tiered": "gemini-3.7-flash",
    "gemini-3.7-flash-high": "gemini-3.7-flash",
    "gemini-3.7-flash-low": "gemini-3.7-flash",
    "gemini-default": "gemini-3.5-flash",
    "gemini-flash-latest": "gemini-3-flash-preview",
    "gemini-pro-d": "gemini-3.1-pro-preview",
    "gemini-3.5-pro": "gemini-3.1-pro-preview",
    "gemini-3.1-pro-low": "gemini-3.1-pro-preview",
    "gemini-3.1-pro-high": "gemini-3.1-pro-preview",
    "gemini-pro-default": "gemini-3.1-pro-preview",
    "gemini-3.6-flash-exp-b": "gemini-3.6-flash",
    "gemini-3.6-flash-high": "gemini-3.6-flash",
    "gemini-3.6-flash-low": "gemini-3.6-flash",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "gpt-5.1-codex-mini": "gpt-5-mini",
    "gpt-5.1-codex-max": "gpt-5.1",
    "gpt-5.3-codex-spark": "gpt-5.3-codex",
}


def canonical_model(model: str) -> str:
    normalized = (model or "unknown").lower()
    for prefix in ("openai-codex/", "openai/", "antigravity/", "google/", "anthropic/"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
    normalized = re.sub(r"\[(low|medium|high|xhigh|max|ultra)\]$", "", normalized)
    return MODEL_ALIASES.get(normalized, normalized)


def find_discount(discounts: list[dict] | None, model: str, timestamp: str | None) -> dict | None:
    if not discounts or not isinstance(discounts, list):
        return None
    day = iso_day(timestamp)
    month = day[:7] if len(day) >= 7 else ""
    c_model = canonical_model(model)
    for d in discounts:
        if not isinstance(d, dict):
            continue
        d_model = d.get("model")
        if d_model and d_model != "*":
            if canonical_model(d_model) != c_model and d_model.lower() != (model or "").lower():
                continue
        d_month = d.get("month")
        if d_month and d_month != month:
            continue
        start = d.get("start") or d.get("since")
        if start and day < start:
            continue
        end = d.get("end") or d.get("until")
        if end and day >= end:
            continue
        return d
    return None


def price_for_model(model: str, timestamp: str | None) -> tuple[tuple[float, float, float] | None, str | None]:
    priced_as = canonical_model(model)
    if priced_as.endswith(":free") or priced_as == "openrouter/free":
        return (0.0, 0.0, 0.0), "Provider designates this model as free."

    day = iso_day(timestamp)
    schedule = RATE_SCHEDULES.get(priced_as)
    if schedule:
        for entry in schedule:
            if "until" in entry and day < entry["until"]:
                return entry["price"], entry.get("note")
            if "since" in entry and day >= entry["since"]:
                if "until" in entry and day >= entry["until"]:
                    continue
                return entry["price"], entry.get("note")

    if priced_as in LEGACY_GPT_5_6_PRICES and day < GPT_5_6_PRICE_CHANGE_DAY:
        return LEGACY_GPT_5_6_PRICES[priced_as], f"Legacy OpenAI rate before {GPT_5_6_PRICE_CHANGE_DAY}."

    price = PRICES.get(priced_as)
    note = PRICE_NOTES.get(priced_as)
    return price, note


def calc_cost(
    model: str,
    input_tokens: int,
    cached_tokens: int,
    output_tokens: int,
    input_includes_cache: bool,
    timestamp: str | None,
    discounts: list[dict] | None = None,
    prompt_tokens: int | None = None,
    cache_write_tokens: int = 0,
) -> tuple[float | None, dict]:
    priced_as = canonical_model(model)
    price, note = price_for_model(model, timestamp)
    if priced_as != (model or "unknown").lower():
        mapping_note = f"Mapped from {model} to {priced_as}."
        note = f"{note} {mapping_note}" if note else mapping_note
    if not price:
        return None, {"known": False, "note": "Unknown price", "priced_as": priced_as}
    in_rate, cache_rate, out_rate = price
    cache_write_rate = None
    if priced_as in ("gpt-6-sol", "gpt-6-luna"):
        cache_write_rate = in_rate * 1.25
        if prompt_tokens is not None and prompt_tokens > 272_000:
            in_rate *= 2
            cache_rate *= 2
            cache_write_rate *= 2
            out_rate *= 1.5
            note = f"{note} Long-context rate applies to the full request."
    non_cached = max(input_tokens - cached_tokens, 0) if input_includes_cache else input_tokens
    cost_input = non_cached * in_rate / 1_000_000
    cost_cache = cached_tokens * cache_rate / 1_000_000
    cost_cache_write = cache_write_tokens * cache_write_rate / 1_000_000 if cache_write_rate is not None else 0.0
    cost_output = output_tokens * out_rate / 1_000_000
    base_cost = cost_input + cost_cache + cost_cache_write + cost_output

    discount = find_discount(discounts, priced_as, timestamp)
    discount_percent = 0.0
    discount_amount = 0.0
    discount_name = None
    final_cost = base_cost

    if discount:
        discount_percent = float(discount.get("percent", 0) or 0)
        discount_name = discount.get("name") or f"{discount_percent}% off"
        if discount_percent > 0:
            discount_amount = base_cost * (discount_percent / 100.0)
            final_cost = max(base_cost - discount_amount, 0.0)
            discount_note = f"Discount applied: {discount_name} (-${discount_amount:.4f})."
            note = f"{note} {discount_note}" if note else discount_note

    price_info = {
        "known": True,
        "input_rate": in_rate,
        "cached_rate": cache_rate,
        "cache_write_rate": cache_write_rate,
        "output_rate": out_rate,
        "non_cached_input_tokens": non_cached,
        "cost_input": cost_input,
        "cost_cache": cost_cache,
        "cost_cache_write": cost_cache_write,
        "cost_output": cost_output,
        "base_cost": base_cost,
        "discount_percent": discount_percent,
        "discount_amount": discount_amount,
        "discount_name": discount_name,
        "note": note,
        "priced_as": priced_as,
    }
    return final_cost, price_info


def event(
    source,
    file,
    timestamp,
    session_id,
    model,
    input_tokens,
    cached_tokens,
    output_tokens,
    reasoning_tokens,
    total_tokens,
    input_includes_cache,
    granularity,
    discounts: list[dict] | None = None,
    cache_write_tokens: int = 0,
):
    prompt_tokens = input_tokens + cached_tokens + cache_write_tokens if granularity == "model-call" and not input_includes_cache else None
    cost, price = calc_cost(
        model or "unknown", input_tokens, cached_tokens, output_tokens,
        input_includes_cache, timestamp, discounts, prompt_tokens, cache_write_tokens,
    )
    day = iso_day(timestamp)
    month = day[:7] if len(day) >= 7 else "unknown"
    return {
        "source": source,
        "file": str(file),
        "timestamp": timestamp,
        "day": day,
        "month": month,
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
        "base_cost_usd": price.get("base_cost", cost) if price.get("discount_amount", 0) > 0 else cost,
        "discount_amount_usd": price.get("discount_amount", 0.0),
        "discount_name": price.get("discount_name"),
        "price": price,
    }


def scan_codex(root: Path, discounts: list[dict] | None = None) -> tuple[list[dict], list[str]]:
    events, warnings = [], []
    usage_keys = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens")
    if not root.exists():
        return events, [f"Codex path missing: {root}"]
    for file in root.rglob("*.jsonl"):
        current_model, session_id = "unknown", file.stem
        previous_usage: dict[str, int] | None = None
        try:
            for line in iter_text_lines(file):
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
                    if not isinstance(info, dict) or not isinstance(info.get("total_token_usage"), dict):
                        continue
                    usage = {key: as_int(info["total_token_usage"].get(key)) for key in usage_keys}
                    if previous_usage is None:
                        delta = usage
                    elif any(usage[key] < previous_usage[key] for key in usage_keys):
                        warnings.append(f"Codex cumulative usage reset: {file}")
                        delta = usage
                    else:
                        delta = {key: usage[key] - previous_usage[key] for key in usage_keys}
                    previous_usage = usage
                    if not any(delta[key] for key in usage_keys):
                        continue
                    events.append(event(
                        "codex", file, obj.get("timestamp"), session_id, current_model,
                        delta["input_tokens"],
                        delta["cached_input_tokens"],
                        delta["output_tokens"],
                        delta["reasoning_output_tokens"],
                        delta["total_tokens"],
                        True,
                        "usage-delta",
                        discounts=discounts,
                    ))
        except Exception as e:
            warnings.append(f"Codex parse failed: {file}: {e}")
    return events, warnings


def scan_pi(root: Path, source_name: str = "pi", discounts: list[dict] | None = None) -> tuple[list[dict], list[str], set[str]]:
    events, warnings, cwds = [], [], set()
    if not root.exists():
        return events, [f"Pi sessions path missing: {root}"], cwds
    for file in root.rglob("*.jsonl"):
        provider, model, session_id, cwd = "unknown", "unknown", file.stem, ""
        try:
            for line in iter_text_lines(file):
                obj = safe_json(line)
                if not isinstance(obj, dict):
                    continue
                typ = obj.get("type")
                if typ == "session":
                    session_id = obj.get("id") or session_id
                    cwd = obj.get("cwd") or cwd
                    if cwd:
                        cwds.add(cwd)
                elif typ == "model_change":
                    provider = obj.get("provider") or provider
                    model = obj.get("modelId") or model
                elif typ == "message":
                    msg = obj.get("message") if isinstance(obj.get("message"), dict) else {}
                    provider = msg.get("provider") or msg.get("api") or provider
                    model = msg.get("model") or msg.get("modelId") or model
                    u = msg.get("usage") if isinstance(msg.get("usage"), dict) else None
                    if u:
                        # Pi usage has input + cacheRead as separate additive fields in observed logs.
                        events.append(event(
                            source_name, file, obj.get("timestamp"), session_id, model,
                            int(u.get("input", 0) or 0),
                            int(u.get("cacheRead", 0) or 0),
                            int(u.get("output", 0) or 0),
                            0,
                            int(u.get("totalTokens", 0) or 0),
                            False,
                            "model-call",
                            discounts=discounts,
                            cache_write_tokens=int(u.get("cacheWrite", 0) or 0),
                        ) | {"provider": provider, "cwd": cwd})
        except Exception as e:
            warnings.append(f"Pi parse failed: {file}: {e}")
    return events, warnings, cwds


def as_int(value) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def iter_gemini_chat_files(root: Path):
    """Yield Gemini CLI chat JSON/JSONL files without scanning browser caches or project snapshots."""
    base = root / "tmp"
    if not base.exists():
        return
    skip_dirs = {".git", "node_modules", "tool-outputs", "antigravity-browser-profile"}
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.endswith("Cache")]
        current = Path(dirpath)
        if current.name != "chats":
            continue
        for name in filenames:
            if Path(name).suffix.lower() in {".json", ".jsonl"}:
                yield current / name
        dirnames[:] = []


def read_gemini_chat_objects(file: Path) -> list[dict]:
    if file.suffix.lower() == ".jsonl":
        objects: list[dict] = []
        for line in iter_text_lines(file):
            obj = safe_json(line)
            if isinstance(obj, dict):
                objects.append(obj)
        return objects
    with file.open("r", encoding="utf-8", errors="ignore") as f:
        obj = json.load(f)
    if isinstance(obj, list):
        return [x for x in obj if isinstance(x, dict)]
    if isinstance(obj, dict):
        messages = obj.get("messages")
        if isinstance(messages, list):
            return [obj] + [x for x in messages if isinstance(x, dict)]
        return [obj]
    return []


def find_gemini_token_records(obj: dict, ancestors: list[dict] | None = None):
    ancestors = ancestors or []
    if not isinstance(obj, dict):
        return
    tokens = obj.get("tokens")
    if isinstance(tokens, dict) and any(k in tokens for k in ("input", "output", "cached", "total")):
        context: dict = {}
        # Prefer the innermost message fields, then fall back to file/session metadata.
        for src in [obj] + list(reversed(ancestors)):
            for key in ("id", "timestamp", "model", "type", "sessionId", "startTime", "lastUpdated", "kind"):
                if key in src and key not in context:
                    context[key] = src[key]
        yield context, tokens
    for value in obj.values():
        if isinstance(value, dict):
            yield from find_gemini_token_records(value, ancestors + [obj])
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    yield from find_gemini_token_records(item, ancestors + [obj])


def scan_gemini(root: Path, discounts: list[dict] | None = None) -> tuple[list[dict], list[str]]:
    """Scan local Gemini CLI chat histories for explicit token metadata.

    Gemini CLI stores token counts as message-level `tokens` dictionaries. In JSONL
    histories, a message may be rewritten as tool-call details arrive, so records are
    de-duplicated by file + message id and the latest copy wins.
    """
    events, warnings = [], []
    if not root.exists():
        return events, [f"Gemini path missing: {root}"]
    for file in iter_gemini_chat_files(root) or []:
        try:
            objects = read_gemini_chat_objects(file)
            session_meta: dict = {}
            per_message: dict[str, dict] = {}
            for obj in objects:
                if "sessionId" in obj or "startTime" in obj:
                    session_meta.update({k: obj.get(k) for k in ("sessionId", "startTime", "lastUpdated", "kind") if obj.get(k)})
                for context, tokens in find_gemini_token_records(obj):
                    merged = {**session_meta, **context}
                    message_id = str(merged.get("id") or f"{len(per_message)}")
                    session_id = str(merged.get("sessionId") or file.stem)
                    timestamp = merged.get("timestamp") or merged.get("lastUpdated") or merged.get("startTime")
                    model = str(merged.get("model") or "unknown")
                    ev = event(
                        "gemini-cli", file, timestamp, session_id, model,
                        as_int(tokens.get("input")),
                        as_int(tokens.get("cached")),
                        as_int(tokens.get("output")),
                        as_int(tokens.get("thoughts")),
                        as_int(tokens.get("total")),
                        True,
                        "model-call",
                        discounts=discounts,
                    ) | {
                        "provider": "google",
                        "message_id": message_id,
                        "gemini_tool_tokens": as_int(tokens.get("tool")),
                    }
                    per_message[message_id] = ev
            events.extend(per_message.values())
        except Exception as e:
            warnings.append(f"Gemini parse failed: {file}: {e}")
    return events, warnings


def proto_read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    value = 0
    shift = 0
    start = pos
    while pos < len(buf) and pos - start < 10:
        byte = buf[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, pos
        shift += 7
    raise ValueError("invalid varint")


def proto_len_fields(buf: bytes) -> dict[int, list[bytes]]:
    fields: dict[int, list[bytes]] = defaultdict(list)
    pos = 0
    while pos < len(buf):
        try:
            key, pos = proto_read_varint(buf, pos)
        except Exception:
            break
        field = key >> 3
        wire = key & 7
        if wire == 0:
            try:
                _value, pos = proto_read_varint(buf, pos)
            except Exception:
                break
        elif wire == 1:
            pos += 8
        elif wire == 2:
            try:
                size, pos = proto_read_varint(buf, pos)
            except Exception:
                break
            data = buf[pos:pos + size]
            pos += size
            fields[field].append(data)
        elif wire == 5:
            pos += 4
        else:
            break
    return fields


def proto_int_fields(buf: bytes) -> dict[int, list[int]]:
    fields: dict[int, list[int]] = defaultdict(list)
    pos = 0
    while pos < len(buf):
        try:
            key, pos = proto_read_varint(buf, pos)
        except Exception:
            break
        field = key >> 3
        wire = key & 7
        if wire == 0:
            try:
                value, pos = proto_read_varint(buf, pos)
            except Exception:
                break
            fields[field].append(value)
        elif wire == 1:
            pos += 8
        elif wire == 2:
            try:
                size, pos = proto_read_varint(buf, pos)
            except Exception:
                break
            pos += size
        elif wire == 5:
            pos += 4
        else:
            break
    return fields


def antigravity_model_from_blob(blob: bytes) -> str | None:
    matches = [m.decode("utf-8", "ignore") for m in __import__("re").findall(rb"gemini-[A-Za-z0-9_.-]+", blob)]
    matches = [
        model for model in matches
        if not model.endswith((".json", ".md", ".html"))
        and "companion" not in model
        and model not in {"gemini-cli", "gemini-cli-latest", "gemini-compatibility", "gemini-stats"}
    ]
    return matches[0] if matches else None


def antigravity_event_time(file: Path) -> str:
    return datetime.fromtimestamp(file.stat().st_mtime, timezone.utc).isoformat()


def extract_antigravity_usage(blob: bytes) -> tuple[str, dict] | None:
    """Best-effort decode of Antigravity sqlite gen_metadata protobuf blobs.

    The observed shape stores Gemini usage counters under top-level field 1,
    nested field 4. The mapping matches Google usage metadata layout used by
    Antigravity: field1 non-cached prompt, field2 cached prompt, field3 output,
    field9 thinking, and field10 tool-use prompt tokens.
    """
    top = proto_len_fields(blob)
    gen_parts = top.get(1) or []
    if not gen_parts:
        return None
    gen = gen_parts[0]
    model = antigravity_model_from_blob(gen) or antigravity_model_from_blob(blob) or "unknown"
    usage_parts = proto_len_fields(gen).get(4) or []
    if not usage_parts:
        return None
    ints = proto_int_fields(usage_parts[0])
    non_cached_input = (ints.get(1) or [0])[0]
    cached_input = (ints.get(2) or [0])[0]
    output = (ints.get(3) or [0])[0]
    thoughts = (ints.get(9) or [0])[0]
    tool = (ints.get(10) or [0])[0]
    # Ignore rows that do not look like usage. Internal counters can share the same protobuf encoding.
    if non_cached_input <= 0 and cached_input <= 0 and output <= 0 and thoughts <= 0 and tool <= 0:
        return None
    total = non_cached_input + cached_input + output + thoughts + tool
    return model, {
        "input": non_cached_input + cached_input,
        "cached": cached_input,
        "output": output,
        "thoughts": thoughts,
        "tool": tool,
        "total": total,
    }


def scan_antigravity_dbs(root: Path, discounts: list[dict] | None = None) -> tuple[list[dict], list[str], dict]:
    events, warnings = [], []
    stats = {"db_files": 0, "duplicate_rows_skipped": 0, "pb_files_not_decoded": 0}
    if not root.exists():
        return events, [f"Gemini path missing for Antigravity scan: {root}"], stats
    stores = [
        ("antigravity-cli", root / "antigravity-cli" / "conversations"),
        ("antigravity-ide", root / "antigravity-ide" / "conversations"),
        ("antigravity-app", root / "antigravity" / "conversations"),
    ]
    seen: set[tuple] = set()
    for source_name, conv_dir in stores:
        if not conv_dir.exists():
            continue
        stats["pb_files_not_decoded"] += len(list(conv_dir.glob("*.pb")))
        for file in conv_dir.glob("*.db"):
            if file.name.endswith(("-wal", "-shm")):
                continue
            stats["db_files"] += 1
            try:
                con = sqlite3.connect(f"file:{file}?mode=ro&immutable=1", uri=True)
                rows = con.execute("select idx, data from gen_metadata where data is not null").fetchall()
                con.close()
            except Exception as e:
                warnings.append(f"Antigravity DB parse failed: {file}: {e}")
                continue
            timestamp = antigravity_event_time(file)
            session_id = file.stem
            for idx, blob in rows:
                if not isinstance(blob, bytes):
                    continue
                decoded = extract_antigravity_usage(blob)
                if not decoded:
                    continue
                model, tokens = decoded
                dedupe_key = (session_id, idx, model, tokens["input"], tokens["cached"], tokens["output"], tokens["thoughts"], tokens["tool"])
                if dedupe_key in seen:
                    stats["duplicate_rows_skipped"] += 1
                    continue
                seen.add(dedupe_key)
                events.append(event(
                    source_name, file, timestamp, session_id, model,
                    tokens["input"], tokens["cached"], tokens["output"], tokens["thoughts"], tokens["total"],
                    True,
                    "antigravity-gen-metadata",
                    discounts=discounts,
                ) | {
                    "provider": "google",
                    "message_id": f"{session_id}:{idx}",
                    "gemini_tool_tokens": tokens["tool"],
                    "antigravity_usage_decode": "best-effort-sqlite-gen-metadata",
                })
    return events, warnings, stats


def source_group(source: str) -> str:
    if source == "codex":
        return "codex"
    if source.startswith("pi"):
        return "takomi/pi"
    if source.startswith("antigravity") or source == "gemini-cli":
        return "antigravity"
    return source


def normalize_source_groups(events: list[dict]) -> None:
    for e in events:
        detailed = e.get("source") or "unknown"
        e["source_detail"] = detailed
        e["source_group"] = source_group(detailed)


def add_project_pi_root(found: list[Path], seen: set[str], root: Path):
    key = str(root.resolve()).lower()
    if key not in seen:
        seen.add(key)
        found.append(root)


def discover_linked_project_pi_roots(cwds: set[str]) -> tuple[list[Path], list[str]]:
    """Follow global Pi session cwd metadata back to project-local Pi/Takomi histories."""
    found: list[Path] = []
    warnings: list[str] = []
    seen: set[str] = set()
    for raw in sorted(cwds or []):
        cwd = Path(raw)
        if not cwd.exists():
            continue
        for candidate in (cwd / ".pi" / "takomi", cwd / ".pi" / "agent" / "sessions"):
            if candidate.exists():
                add_project_pi_root(found, seen, candidate)
    return found, warnings


def discover_project_pi_roots(project_roots: list[str]) -> tuple[list[Path], list[str]]:
    """Fallback: find project-local Pi history folders under explicit roots."""
    found: list[Path] = []
    warnings: list[str] = []
    skip = {"node_modules", ".git", ".next", "dist", "build", "venv", ".venv", ".turbo"}
    seen: set[str] = set()
    for raw in project_roots or []:
        root = Path(raw)
        if not root.exists():
            warnings.append(f"Project root missing: {root}")
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in skip]
            p = Path(dirpath)
            # The common project-local Takomi history location.
            if p.name == "takomi" and p.parent.name == ".pi":
                add_project_pi_root(found, seen, p)
                dirnames[:] = []
            # A less common project-local session location, if present.
            elif p.name == "sessions" and p.parent.name == "agent" and p.parent.parent.name == ".pi":
                add_project_pi_root(found, seen, p)
                dirnames[:] = []
    return found, warnings


import functools

@functools.lru_cache(maxsize=8192)
def extract_project_info(file_path: str, cwd: str = "") -> tuple[str, str]:
    """Extract human-readable project name and directory from session file and cwd."""
    if cwd:
        p = Path(cwd)
        name = p.name or str(p)
        return name, str(p)
    f_str = str(file_path or "").replace("\\", "/")
    if "/.pi/" in f_str:
        before_pi = f_str.split("/.pi/")[0]
        proj_p = Path(before_pi)
        return proj_p.name or before_pi, str(proj_p)
    m = re.search(r"--[A-Za-z]--(.*?)--", f_str)
    if m:
        raw = m.group(1)
        match_folder = re.search(r"(\d{4}-\d{2}-\d{2}[^/\\]*)$", raw)
        if match_folder:
            return match_folder.group(1), raw
        parts = [part for part in raw.split("-") if part]
        return (parts[-1] if parts else raw), raw
    if "antigravity" in f_str.lower():
        return "Antigravity Workspace", str(Path(file_path).parent) if file_path else ""
    if "codex" in f_str.lower():
        return "Codex Session", str(Path(file_path).parent) if file_path else ""
    if "gemini" in f_str.lower():
        return "Gemini Session", str(Path(file_path).parent) if file_path else ""
    p = Path(file_path) if file_path else None
    return (p.stem if p else "General"), (str(p.parent) if p else "")


def aggregate(events: list[dict], warnings: list[str], started: float, discounts: list[dict] | None = None) -> dict:
    totals = Counter()
    by_model = defaultdict(Counter)
    by_source = defaultdict(Counter)
    by_source_detail = defaultdict(Counter)
    by_day = defaultdict(Counter)
    by_month = defaultdict(Counter)
    by_session = defaultdict(Counter)
    unknown_models = Counter()

    day_sources: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    day_source_tokens: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    month_sources: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    month_source_tokens: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    model_sources: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    session_models: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    session_meta: dict[str, dict] = {}
    session_activity: dict[str, list[dict]] = defaultdict(list)
    by_project_counter: dict[str, Counter] = defaultdict(Counter)
    project_sessions: dict[str, set[str]] = defaultdict(set)

    for e in events:
        keys = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]
        day = e.get("day") or "unknown"
        month = e.get("month") or (day[:7] if len(day) >= 7 else "unknown")
        sid = e["session_id"]
        src_group = e.get("source_group", e["source"])
        cost = e.get("estimated_cost_usd") or 0.0
        tokens = e.get("total_tokens") or 0
        proj_name, directory = extract_project_info(e.get("file", ""), e.get("cwd", ""))

        for k in keys:
            totals[k] += e[k]
            by_model[e["model"]][k] += e[k]
            by_source[src_group][k] += e[k]
            by_source_detail[e["source"]][k] += e[k]
            by_day[day][k] += e[k]
            by_month[month][k] += e[k]
            by_session[sid][k] += e[k]

        day_sources[day][src_group] += cost
        day_source_tokens[day][src_group] += tokens
        month_sources[month][src_group] += cost
        month_source_tokens[month][src_group] += tokens
        model_sources[e["model"]][src_group] += cost
        session_models[sid][e["model"]] += cost

        by_project_counter[proj_name]["total_tokens"] += tokens
        by_project_counter[proj_name]["cached_input_tokens"] += e.get("cached_input_tokens", 0)
        by_project_counter[proj_name]["output_tokens"] += e.get("output_tokens", 0)
        by_project_counter[proj_name]["events"] += 1
        project_sessions[proj_name].add(sid)
        if directory and not by_project_counter[proj_name].get("directory"):
            by_project_counter[proj_name]["directory"] = directory
        if day and (not by_project_counter[proj_name].get("last_day") or day > by_project_counter[proj_name]["last_day"]):
            by_project_counter[proj_name]["last_day"] = day

        if e["estimated_cost_usd"] is not None:
            totals["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_model[e["model"]]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_source[src_group]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_source_detail[e["source"]]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_day[day]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_month[month]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_session[sid]["estimated_cost_usd"] += e["estimated_cost_usd"]
            by_project_counter[proj_name]["estimated_cost_usd"] += e["estimated_cost_usd"]
            if e.get("discount_amount_usd"):
                totals["discount_amount_usd"] += e["discount_amount_usd"]
                by_month[month]["discount_amount_usd"] += e["discount_amount_usd"]
        else:
            unknown_models[e["model"]] += 1

        by_model[e["model"]]["events"] += 1
        by_source[src_group]["events"] += 1
        by_source_detail[e["source"]]["events"] += 1
        by_day[day]["events"] += 1
        by_month[month]["events"] += 1
        by_session[sid]["events"] += 1

        if sid not in session_meta:
            session_meta[sid] = {
                "project": proj_name,
                "directory": directory,
                "file": str(e.get("file") or ""),
                "source": src_group,
                "source_detail": e.get("source"),
                "first_day": day,
                "last_day": day,
                "first_ts": e.get("timestamp"),
                "last_ts": e.get("timestamp"),
            }
        else:
            sm = session_meta[sid]
            if day and (not sm["first_day"] or day < sm["first_day"]):
                sm["first_day"] = day
            if day and (not sm["last_day"] or day > sm["last_day"]):
                sm["last_day"] = day
            if e.get("timestamp") and (not sm["first_ts"] or e.get("timestamp") < sm["first_ts"]):
                sm["first_ts"] = e.get("timestamp")
            if e.get("timestamp") and (not sm["last_ts"] or e.get("timestamp") > sm["last_ts"]):
                sm["last_ts"] = e.get("timestamp")
            if not sm.get("directory") and directory:
                sm["directory"] = directory
            if sm.get("project") in ("General", "Codex Session", "Antigravity Workspace") and proj_name not in ("General", "Codex Session", "Antigravity Workspace"):
                sm["project"] = proj_name

        if len(session_activity[sid]) < 30:
            session_activity[sid].append({
                "ts": e.get("timestamp"),
                "cost": round(cost, 5),
                "tokens": tokens,
                "model": e.get("model") or "unknown",
            })

    def rows(d):
        return [{"key": k, **dict(v)} for k, v in sorted(d.items(), key=lambda kv: -kv[1].get("estimated_cost_usd", 0))]

    session_rows = []
    for sid, counts in sorted(by_session.items(), key=lambda kv: -kv[1].get("estimated_cost_usd", 0)):
        sm = session_meta.get(sid, {})
        m_dict = dict(session_models.get(sid, {}))
        top_model = max(m_dict.items(), key=lambda kv: kv[1])[0] if m_dict else "unknown"
        session_rows.append({
            "key": sid,
            "session_id": sid,
            "project": sm.get("project", "General"),
            "directory": sm.get("directory", ""),
            "file": sm.get("file", ""),
            "source": sm.get("source", "unknown"),
            "source_detail": sm.get("source_detail", "unknown"),
            "first_day": sm.get("first_day", ""),
            "last_day": sm.get("last_day", ""),
            "first_ts": sm.get("first_ts", ""),
            "last_ts": sm.get("last_ts", ""),
            "primary_model": top_model,
            "models": m_dict,
            "activity": session_activity.get(sid, []),
            **dict(counts),
        })

    day_rows = []
    for d, counts in sorted(by_day.items(), key=lambda kv: kv[0]):
        day_rows.append({
            "key": d,
            **dict(counts),
            "sources": dict(day_sources[d]),
            "source_tokens": dict(day_source_tokens[d]),
        })

    month_rows = []
    for m, counts in sorted(by_month.items(), key=lambda kv: kv[0]):
        month_rows.append({
            "key": m,
            **dict(counts),
            "sources": dict(month_sources[m]),
            "source_tokens": dict(month_source_tokens[m]),
        })

    model_rows = []
    for m, counts in sorted(by_model.items(), key=lambda kv: -kv[1].get("estimated_cost_usd", 0)):
        model_rows.append({
            "key": m,
            **dict(counts),
            "sources": dict(model_sources[m]),
        })

    project_rows = []
    for p, counts in sorted(by_project_counter.items(), key=lambda kv: -kv[1].get("estimated_cost_usd", 0)):
        project_rows.append({
            "key": p,
            "project": p,
            "directory": counts.get("directory", ""),
            "last_day": counts.get("last_day", ""),
            "sessions_count": len(project_sessions[p]),
            **{k: v for k, v in counts.items() if k not in ("directory", "last_day")},
        })

    high = sorted(events, key=lambda e: e.get("estimated_cost_usd") or 0, reverse=True)[:100]
    recent = sorted(events, key=lambda e: e.get("timestamp") or "", reverse=True)[:200]
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scan_seconds": round(time.time() - started, 2),
        "event_count": len(events),
        "session_count": len(set(e["session_id"] for e in events)),
        "file_count": len(set(e["file"] for e in events)),
        "totals": dict(totals),
        "by_model": model_rows,
        "by_source": rows(by_source),
        "by_source_detail": rows(by_source_detail),
        "by_day": day_rows,
        "by_month": month_rows,
        "by_project": project_rows,
        "discounts": discounts or [],
        "by_session": session_rows,
        "high_cost_events": high,
        "recent_events": recent,
        "unknown_price_models": dict(unknown_models),
        "price_table": {k: {"input": v[0], "cached": v[1], "output": v[2], "note": PRICE_NOTES.get(k)} for k, v in PRICES.items()},
        "warnings": warnings[:200],
        "caveats": [
            "Codex input_tokens include cached_input_tokens; dashboard subtracts cached before applying input rates and converts cumulative snapshots into timestamped deltas.",
            "Pi input/cacheRead are additive in observed logs; dashboard does not subtract cacheRead from input.",
            "Gemini/Antigravity cached tokens are treated as part of input, so dashboard subtracts cache before pricing.",
            "Antigravity sqlite gen_metadata usage is decoded best-effort; legacy .pb conversation blobs are counted as not decoded. SQLite metadata does not expose per-record timestamps, so its events use the database modification time.",
            "Only explicit runtime usage metadata is counted. Raw transcript text is not re-tokenized.",
            "Project-local Pi/Takomi histories are discovered by following cwd links from global Pi sessions by default; broad project root scans are opt-in.",
            "Gemini pricing uses current Google Gemini API paid text/image/video rates; Pro models use the <=200K-context tier and internal aliases are mapped to their public equivalents where available.",
            "GPT-5.6 Luna and Terra preserve the pre-July 30, 2026 OpenAI rates for earlier usage; Sol pricing is unchanged.",
            "GPT-6 Sol and Luna use OpenAI Standard rates. Pi model-call records above 272K prompt tokens use long-context rates for the entire call; Codex usage deltas do not expose reliable per-request prompt sizes, so they use short-context estimates. Pi cache writes are priced for these models when logged. Other service tiers, regional premiums, and tool fees are not inferred from usage logs.",
            "Pricing schedules support date-effective transitions (e.g. GPT-5.6 Luna and Terra cuts on July 30, 2026; Gemini 3.8 Flash promotional rates through 2026-12-31; GPT-6 Astra launch).",
            "Configurable promotional and period discounts can be defined in config.json under 'discounts' with optional model, date/month filters.",
            "Monthly usage rollups are available via by_month in the generated summary.",
            "gpt-5.3-codex has no supplied public price row and is estimated as gpt-5.4-class.",
        ],
    }


def refresh(config_path: Path = DEFAULT_CONFIG) -> dict:
    started = time.time()
    config = load_config(config_path)
    sources = config.get("sources", {})
    discounts = config.get("discounts", [])
    codex_events, codex_warn = scan_codex(Path(sources.get("codex", "")), discounts=discounts)
    pi_root = Path(sources.get("pi_sessions", ""))
    pi_events, pi_warn, pi_cwds = scan_pi(pi_root, "pi-global", discounts=discounts)
    gemini_root = Path(sources.get("gemini", ""))
    gemini_events, gemini_warn = scan_gemini(gemini_root, discounts=discounts) if sources.get("gemini") else ([], [])
    antigravity_events, antigravity_warn, antigravity_stats = scan_antigravity_dbs(gemini_root, discounts=discounts) if sources.get("gemini") else ([], [], {})
    project_pi_events: list[dict] = []
    project_pi_warn: list[str] = []

    # Default: linked discovery. Global Pi sessions already record cwd, so use
    # those cwd values as privacy-friendly pointers to project-local .pi history.
    discovery_mode = str(sources.get("project_discovery", "linked")).lower()
    project_pi_roots: list[Path] = []
    linked_roots, linked_warn = discover_linked_project_pi_roots(pi_cwds)
    excluded_roots = {str(pi_root.resolve()).lower()} if pi_root.exists() else set()
    linked_roots = [root for root in linked_roots if str(root.resolve()).lower() not in excluded_roots]
    project_pi_roots.extend(linked_roots)

    # Optional fallback for dashboards that intentionally want broad scanning.
    root_roots: list[Path] = []
    root_warn: list[str] = []
    if discovery_mode in {"roots", "both"}:
        root_roots, root_warn = discover_project_pi_roots(sources.get("project_roots", []))
        project_pi_roots.extend(root_roots)
    elif sources.get("project_roots"):
        root_warn.append("project_roots configured but skipped; set sources.project_discovery to 'roots' or 'both' to scan broad roots.")

    seen_roots: set[str] = set()
    unique_project_pi_roots = []
    for root in project_pi_roots:
        key = str(root.resolve()).lower()
        if key not in seen_roots:
            seen_roots.add(key)
            unique_project_pi_roots.append(root)

    for root in unique_project_pi_roots:
        ev, warn, _cwds = scan_pi(root, "pi-project-linked" if root in linked_roots else "pi-project", discounts=discounts)
        project_pi_events.extend(ev)
        project_pi_warn.extend(warn)
    events = codex_events + pi_events + gemini_events + antigravity_events + project_pi_events
    normalize_source_groups(events)
    warnings = codex_warn + pi_warn + gemini_warn + antigravity_warn + linked_warn + root_warn + project_pi_warn
    summary = aggregate(events, warnings, started, discounts=discounts)
    summary["config"] = config
    summary["discovered_project_pi_roots"] = [str(p) for p in unique_project_pi_roots]
    summary["project_discovery"] = {
        "mode": discovery_mode,
        "linked_roots": [str(p) for p in linked_roots],
        "broad_roots": [str(p) for p in root_roots],
        "global_session_cwds": len(pi_cwds),
    }
    summary["antigravity_scan"] = antigravity_stats

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
        parsed = urlparse(self.path).path
        if parsed == "/status":
            self.send_json(SCAN_STATE)
        elif parsed in ("/legacy", "/legacy/"):
            self.path = "/legacy.html"
            super().do_GET()
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
