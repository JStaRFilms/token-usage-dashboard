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

    def test_gpt_6_astra_pricing_and_aliases(self):
        cost, price = refresh_usage.calc_cost(
            "openai-codex/gpt-6-astra[high]", 1_000_000, 500_000, 100_000, True, "2026-09-04T00:00:00Z"
        )
        self.assertEqual(price["priced_as"], "gpt-6-astra")
        self.assertEqual(price["input_rate"], 10.0)
        self.assertEqual(price["cached_rate"], 1.0)
        self.assertEqual(price["output_rate"], 50.0)
        # 500k uncached ($5) + 500k cached ($0.5) + 100k output ($5) = $10.50
        self.assertAlmostEqual(cost, 10.50)

    def test_gemini_3_8_flash_schedule_and_aliases(self):
        promo_cost, promo_price = refresh_usage.calc_cost(
            "antigravity/gemini-3.8-flash[low]", 1_000_000, 0, 1_000_000, True, "2026-10-01T00:00:00Z"
        )
        self.assertEqual(promo_price["priced_as"], "gemini-3.8-flash")
        self.assertEqual(promo_price["input_rate"], 0.75)
        self.assertEqual(promo_price["output_rate"], 3.75)
        self.assertAlmostEqual(promo_cost, 4.50)

        std_cost, std_price = refresh_usage.calc_cost(
            "gemini-3.8-flash", 1_000_000, 0, 1_000_000, True, "2027-01-02T00:00:00Z"
        )
        self.assertEqual(std_price["input_rate"], 1.50)
        self.assertEqual(std_price["output_rate"], 7.50)
        self.assertAlmostEqual(std_cost, 9.00)

    def test_discount_by_month_and_model(self):
        discounts = [
            {"month": "2026-09", "model": "gpt-6-astra", "percent": 20, "name": "Sep Promo"}
        ]
        # Discount applies in September to gpt-6-astra
        cost_sep, price_sep = refresh_usage.calc_cost(
            "gpt-6-astra", 1_000_000, 0, 0, True, "2026-09-05T00:00:00Z", discounts=discounts
        )
        self.assertAlmostEqual(price_sep["base_cost"], 10.00)
        self.assertAlmostEqual(cost_sep, 8.00)
        self.assertEqual(price_sep["discount_percent"], 20.0)

        # Discount does not apply in August
        cost_aug, price_aug = refresh_usage.calc_cost(
            "gpt-6-astra", 1_000_000, 0, 0, True, "2026-08-25T00:00:00Z", discounts=discounts
        )
        self.assertAlmostEqual(cost_aug, 10.00)
        self.assertEqual(price_aug["discount_percent"], 0.0)

    def test_aggregate_by_month(self):
        e1 = refresh_usage.event(
            "codex", "f1.jsonl", "2026-08-15T12:00:00Z", "s1", "gpt-5.6-luna",
            1_000_000, 0, 0, 0, 1_000_000, True, "usage-delta"
        )
        e2 = refresh_usage.event(
            "codex", "f2.jsonl", "2026-09-05T12:00:00Z", "s2", "gpt-6-astra",
            1_000_000, 0, 0, 0, 1_000_000, True, "usage-delta"
        )
        summary = refresh_usage.aggregate([e1, e2], [], 0.0)
        by_month = {row["key"]: row for row in summary["by_month"]}
        self.assertIn("2026-08", by_month)
        self.assertIn("2026-09", by_month)
        self.assertEqual(by_month["2026-08"]["events"], 1)
        self.assertEqual(by_month["2026-09"]["events"], 1)
        self.assertAlmostEqual(by_month["2026-08"]["estimated_cost_usd"], 0.20)
        self.assertAlmostEqual(by_month["2026-09"]["estimated_cost_usd"], 10.00)


if __name__ == "__main__":
    unittest.main()
