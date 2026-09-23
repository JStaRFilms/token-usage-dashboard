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

    def test_gpt_6_sol_and_luna_standard_and_long_context_rates(self):
        for model, short_rates, long_rates in (
            ("gpt-6-sol", (2.0, 0.2, 2.5, 10.0), (4.0, 0.4, 5.0, 15.0)),
            ("gpt-6-luna", (0.1, 0.01, 0.125, 0.5), (0.2, 0.02, 0.25, 0.75)),
        ):
            with self.subTest(model=model):
                short, short_price = refresh_usage.calc_cost(
                    f"openai-codex/{model}[high]", 99_000, 172_000, 50_000,
                    False, "2026-09-23T00:00:00Z", prompt_tokens=272_000, cache_write_tokens=1_000,
                )
                long, long_price = refresh_usage.calc_cost(
                    model, 99_001, 172_000, 50_000,
                    False, "2026-09-23T00:00:00Z", prompt_tokens=272_001, cache_write_tokens=1_000,
                )
                self.assertEqual(short_price["priced_as"], model)
                self.assertEqual(
                    tuple(short_price[k] for k in ("input_rate", "cached_rate", "cache_write_rate", "output_rate")),
                    short_rates,
                )
                self.assertEqual(
                    tuple(long_price[k] for k in ("input_rate", "cached_rate", "cache_write_rate", "output_rate")),
                    long_rates,
                )
                self.assertAlmostEqual(short, (
                    99_000 * short_rates[0] + 172_000 * short_rates[1]
                    + 1_000 * short_rates[2] + 50_000 * short_rates[3]
                ) / 1_000_000)
                self.assertAlmostEqual(long, (
                    99_001 * long_rates[0] + 172_000 * long_rates[1]
                    + 1_000 * long_rates[2] + 50_000 * long_rates[3]
                ) / 1_000_000)

    def test_pi_gpt_6_model_call_prices_cache_writes_and_long_context(self):
        with tempfile.TemporaryDirectory() as directory:
            history = Path(directory) / "session.jsonl"
            history.write_text("\n".join([
                json.dumps({"type": "model_change", "modelId": "gpt-6-sol"}),
                json.dumps({"type": "message", "timestamp": "2026-09-23T00:00:00Z", "message": {
                    "model": "gpt-6-sol", "usage": {
                        "input": 100_000, "cacheRead": 172_000, "cacheWrite": 1,
                        "output": 10_000, "totalTokens": 282_001,
                    },
                }}),
            ]), encoding="utf-8")
            events, warnings, _ = refresh_usage.scan_pi(Path(directory))

        self.assertEqual(warnings, [])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["price"]["input_rate"], 4.0)
        self.assertEqual(events[0]["price"]["cache_write_rate"], 5.0)
        self.assertAlmostEqual(
            events[0]["estimated_cost_usd"],
            (100_000 * 4 + 172_000 * 0.4 + 5 + 10_000 * 15) / 1_000_000,
        )
        delta = refresh_usage.event(
            "codex", "session.jsonl", "2026-09-23T00:00:00Z", "session", "gpt-6-sol",
            300_000, 0, 10_000, 0, 310_000, True, "usage-delta",
        )
        self.assertEqual(delta["price"]["input_rate"], 2.0)

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

    def test_extract_project_info(self):
        name, directory = refresh_usage.extract_project_info(
            r"C:\Users\johno\.pi\agent\sessions\--C--CreativeOS-01_Projects-Code-Personal_Stuff-2026-03-14_School_Management_System--\01a06f61.jsonl",
            r"C:\CreativeOS\01_Projects\Code\Personal_Stuff\2026-03-14_School_Management_System"
        )
        self.assertEqual(name, "2026-03-14_School_Management_System")
        self.assertIn("School_Management_System", directory)

        name2, _ = refresh_usage.extract_project_info(
            r"C:\CreativeOS\01_Projects\Code\Personal_Stuff\2025-12-02_VibeCode-Protocol-Suite\.pi\agent\sessions\test.jsonl"
        )
        self.assertEqual(name2, "2025-12-02_VibeCode-Protocol-Suite")

        name3, _ = refresh_usage.extract_project_info(
            r"C:\Users\johno\.gemini\antigravity\conversations\conv.db"
        )
        self.assertEqual(name3, "Antigravity Workspace")

    def test_aggregate_by_project_and_session_meta(self):
        e1 = refresh_usage.event(
            "pi", r"C:\CreativeOS\Projects\Alpha\.pi\agent\sessions\s1.jsonl",
            "2026-09-01T12:00:00Z", "s1", "gpt-6-astra",
            1_000_000, 0, 0, 0, 1_000_000, False, "model-call"
        )
        e1["cwd"] = r"C:\CreativeOS\Projects\Alpha"
        summary = refresh_usage.aggregate([e1], [], 0.0)
        self.assertEqual(summary["by_project"][0]["project"], "Alpha")
        self.assertEqual(summary["by_session"][0]["project"], "Alpha")
        self.assertEqual(summary["by_session"][0]["primary_model"], "gpt-6-astra")
        self.assertIn("sources", summary["by_day"][0])
        self.assertIn("activity", summary["by_session"][0])


if __name__ == "__main__":
    unittest.main()
