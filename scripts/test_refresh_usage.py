#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("refresh_usage.py")
spec = importlib.util.spec_from_file_location("refresh_usage", SCRIPT)
refresh_usage = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(refresh_usage)


class RefreshUsageTests(unittest.TestCase):
    def test_gpt_5_6_prices_respect_the_effective_date(self):
        legacy_cost, legacy_price = refresh_usage.calc_cost(
            "gpt-5.6-terra", 1_000_000, 0, 0, True, "2026-07-29T23:59:59Z"
        )
        current_cost, current_price = refresh_usage.calc_cost(
            "gpt-5.6-terra", 1_000_000, 0, 0, True, "2026-07-30T00:00:00Z"
        )

        self.assertEqual(legacy_cost, 2.5)
        self.assertEqual(current_cost, 2.0)
        self.assertEqual(legacy_price["input_rate"], 2.5)
        self.assertEqual(current_price["input_rate"], 2.0)

    def test_internal_gemini_alias_uses_the_public_model_rate(self):
        cost, price = refresh_usage.calc_cost(
            "gemini-3.6-flash-exp-b", 1_000_000, 0, 1_000_000, True, "2026-08-08T00:00:00Z"
        )

        self.assertEqual(cost, 9.0)
        self.assertEqual(price["priced_as"], "gemini-3.6-flash")
        self.assertIn("Mapped from gemini-3.6-flash-exp-b", price["note"])

    def test_codex_cumulative_snapshots_become_timestamped_deltas(self):
        with tempfile.TemporaryDirectory() as directory:
            history = Path(directory) / "session.jsonl"
            history.write_text("\n".join([
                json.dumps({"type": "session_meta", "payload": {"id": "session", "model": "gpt-5.6-luna"}}),
                json.dumps({"type": "event_msg", "timestamp": "2026-07-29T23:59:59Z", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 1_000_000}}}}),
                json.dumps({"type": "event_msg", "timestamp": "2026-07-30T00:00:00Z", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 1_500_000}}}}),
            ]), encoding="utf-8")

            events, warnings = refresh_usage.scan_codex(Path(directory))

        self.assertEqual(warnings, [])
        self.assertEqual([event["estimated_cost_usd"] for event in events], [1.0, 0.1])
        self.assertEqual([event["granularity"] for event in events], ["usage-delta", "usage-delta"])

    def test_antigravity_model_search_rejects_filename_matches(self):
        model = refresh_usage.antigravity_model_from_blob(
            b"gemini-compatibility gemini-compatibility.html other text gemini-3.6-flash"
        )
        self.assertEqual(model, "gemini-3.6-flash")


if __name__ == "__main__":
    unittest.main()
