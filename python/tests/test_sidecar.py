from pathlib import Path
import subprocess
import sys
import unittest
import types
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

for module_name, attrs in {
    "numpy": {},
    "sounddevice": {},
    "sherpa_onnx": {},
    "deep_translator": {
        "GoogleTranslator": type(
            "GoogleTranslator",
            (),
            {
                "__init__": lambda self, *args, **kwargs: None,
                "translate": lambda self, text: "你好" if text.strip().lower() == "hello" else text,
            },
        ),
    },
    "opencc": {
        "OpenCC": type(
            "OpenCC",
            (),
            {
                "__init__": lambda self, *args, **kwargs: None,
                "convert": lambda self, text: text,
            },
        ),
    },
}.items():
    if module_name not in sys.modules:
        module = types.ModuleType(module_name)
        for attr_name, attr_value in attrs.items():
            setattr(module, attr_name, attr_value)
        sys.modules[module_name] = module

from sidecar import (
    apply_dictation_dictionary,
    apply_dictation_rules_rewrite,
    build_local_llm_rewrite_prompt,
    get_local_llm_python_bin,
    LocalLlmRewriteProvider,
    FallbackTranslator,
    build_dictation_final_event,
    build_dictation_state_event,
    looks_like_garbage_text,
    make_segment_id,
    normalize_text,
    parse_dictation_dictionary,
)


class TranslationProviderTest(unittest.TestCase):
    def test_translates_known_phrase(self) -> None:
        provider = FallbackTranslator()
        self.assertEqual(provider.translate("hello", "en", "zh-TW"), "你好")

    def test_preserves_unknown_text(self) -> None:
        provider = FallbackTranslator()
        self.assertIn("Roadmap", provider.translate("Roadmap review", "en", "zh-TW"))

    def test_normalizes_whitespace(self) -> None:
        self.assertEqual(normalize_text("  hello   world "), "hello world")

    def test_segment_id_is_stable(self) -> None:
        self.assertEqual(make_segment_id(1049, 2899), "seg-10-29")

    def test_filters_repeated_garbage_text(self) -> None:
        self.assertTrue(looks_like_garbage_text("M-M-M-M-M-M-M-M-"))

    def test_allows_normal_sentence(self) -> None:
        self.assertFalse(looks_like_garbage_text("People dream high in the quiet of the night"))

    def test_dictation_state_event_includes_state(self) -> None:
        event = build_dictation_state_event("recording", "Dictation session started")
        self.assertEqual(event["type"], "dictation_state")
        self.assertEqual(event["state"], "recording")
        self.assertEqual(event["detail"], "Dictation session started")

    def test_dictation_final_event_normalizes_buffered_text(self) -> None:
        event = build_dictation_final_event("session-1", ["  hello", "world  "], 10, 40)
        self.assertEqual(event["type"], "dictation_final")
        self.assertEqual(event["sessionId"], "session-1")
        self.assertEqual(event["literalTranscript"], "hello world")
        self.assertEqual(event["dictionaryText"], "hello world")
        self.assertEqual(event["finalText"], "hello world")
        self.assertEqual(event["rewriteBackend"], "disabled")
        self.assertFalse(event["rewriteApplied"])
        self.assertEqual(event["chunkCount"], 2)
        self.assertEqual(event["latencyMs"], 30)

    def test_dictation_final_event_converts_to_traditional_chinese(self) -> None:
        converter = types.SimpleNamespace(convert=lambda text: text.replace("汉", "漢").replace("语", "語"))
        event = build_dictation_final_event(
            "session-2",
            ["汉语", "  输入 "],
            10,
            40,
            convert_s2t=True,
            opencc_s2t=converter,
        )
        self.assertEqual(event["literalTranscript"], "漢語 输入")
        self.assertEqual(event["finalText"], "漢語 输入")

    def test_parse_dictation_dictionary_ignores_invalid_lines(self) -> None:
        entries = parse_dictation_dictionary("""
        # comment
        chat g p t => ChatGPT
        invalid line
        bicaption => BiCaption
        """)
        self.assertEqual(entries, [("chat g p t", "ChatGPT"), ("bicaption", "BiCaption")])

    def test_apply_dictation_dictionary_replaces_known_terms(self) -> None:
        replaced = apply_dictation_dictionary(
            "chat g p t works with bicaption",
            [("chat g p t", "ChatGPT"), ("bicaption", "BiCaption")],
        )
        self.assertEqual(replaced, "ChatGPT works with BiCaption")

    def test_apply_dictation_rules_rewrite_removes_fillers_and_duplicates(self) -> None:
        rewritten = apply_dictation_rules_rewrite("um um hello hello 那個 world")
        self.assertEqual(rewritten, "hello world")

    def test_apply_dictation_rules_rewrite_cleans_traditional_chinese_fillers_and_common_stt_typos(self) -> None:
        rewritten = apply_dictation_rules_rewrite(
            "對，現在來測試繁體中文的斷句，看是不是有變得比較正常了。那這一句話就會稍微長一點。哎，這麼說的話也會有蠻多的罪字的哈"
        )
        self.assertEqual(
            rewritten,
            "對，現在來測試繁體中文的斷句，看是不是有變得比較正常了。那這一句話就會稍微長一點。這麼說的話也會有蠻多的贅字的",
        )

    def test_dictation_final_event_applies_dictionary_and_rules(self) -> None:
        event = build_dictation_final_event(
            "session-3",
            ["um chat g p t", "works works"],
            10,
            80,
            rewrite_mode="rules",
            dictionary_enabled=True,
            dictionary_text="chat g p t => ChatGPT",
        )
        self.assertEqual(event["literalTranscript"], "um chat g p t works works")
        self.assertEqual(event["dictionaryText"], "um ChatGPT works works")
        self.assertEqual(event["finalText"], "ChatGPT works")
        self.assertEqual(event["rewriteBackend"], "rules")
        self.assertTrue(event["rewriteApplied"])

    def test_dictation_final_event_sets_fallback_reason_for_cloud_mode(self) -> None:
        event = build_dictation_final_event(
            "session-4",
            ["hello world"],
            10,
            80,
            rewrite_mode="rules-and-cloud",
        )
        self.assertEqual(event["finalText"], "hello world")
        self.assertEqual(event["rewriteBackend"], "cloud-llm")
        self.assertEqual(event["fallbackReason"], "cloud_rewrite_unavailable")

    def test_dictation_final_event_sets_fallback_reason_for_local_llm_mode(self) -> None:
        event = build_dictation_final_event(
            "session-5",
            ["hello world"],
            10,
            80,
            rewrite_mode="rules-and-local-llm",
        )
        self.assertEqual(event["finalText"], "hello world")
        self.assertEqual(event["rewriteBackend"], "local-llm")
        self.assertEqual(event["fallbackReason"], "local_llm_model_missing")

    def test_local_llm_prompt_preserves_sayit_style_constraints(self) -> None:
        prompt = build_local_llm_rewrite_prompt(
            literal_transcript="um chat g p t works",
            dictionary_text="ChatGPT works",
            source_lang="zh",
            output_style="polished",
            protected_terms=["ChatGPT", "BiCaption"],
        )
        self.assertIn("deterministic dictation cleanup engine", prompt)
        self.assertIn("Do not add facts", prompt)
        self.assertIn("Do not expand fragments into complete ideas", prompt)
        self.assertIn("Preserve protected terms exactly", prompt)
        self.assertIn("ChatGPT", prompt)
        self.assertIn("BiCaption", prompt)

    @patch.dict("sidecar.os.environ", {"BICAPTION_LOCAL_LLM_PYTHON": "/custom/python"}, clear=False)
    def test_local_llm_python_bin_prefers_env(self) -> None:
        self.assertEqual(get_local_llm_python_bin(), "/custom/python")

    @patch.dict("sidecar.os.environ", {}, clear=True)
    @patch("sidecar.os.path.exists")
    @patch("sidecar.sys.executable", "/Users/test/.venv/bin/python")
    def test_local_llm_python_bin_uses_current_python_when_available(self, exists_mock) -> None:
        exists_mock.return_value = False
        self.assertEqual(get_local_llm_python_bin(), "/Users/test/.venv/bin/python")

    @patch.dict("sidecar.os.environ", {}, clear=True)
    @patch("sidecar.os.path.exists")
    @patch("sidecar.sys.executable", "/Applications/BiCaption.app/Contents/MacOS/bicaption-sidecar")
    def test_local_llm_python_bin_falls_back_to_project_venv(self, exists_mock) -> None:
        exists_mock.side_effect = lambda path: path.endswith(".venv/bin/python")
        self.assertTrue(get_local_llm_python_bin().endswith(".venv/bin/python"))

    def test_local_llm_provider_reports_missing_script(self) -> None:
        provider = LocalLlmRewriteProvider("/tmp/non-existent-rewriter.py")
        result = provider.rewrite("hello", "hello", "zh", "polished", 1.3, [])
        self.assertFalse(result.applied)
        self.assertEqual(result.backend, "local-llm")
        self.assertEqual(result.fallback_reason, "local_llm_provider_missing")

    @patch("sidecar.os.path.exists", return_value=True)
    @patch("sidecar.subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="rewriter", timeout=2.5))
    def test_local_llm_provider_reports_timeout(self, _run, _exists) -> None:
        provider = LocalLlmRewriteProvider("/tmp/rewriter.py")
        result = provider.rewrite("hello", "hello", "zh", "polished", 1.3, [])
        self.assertFalse(result.applied)
        self.assertEqual(result.fallback_reason, "local_llm_timeout")

    @patch("sidecar.os.path.exists", return_value=True)
    @patch("sidecar.subprocess.run")
    def test_local_llm_provider_accepts_valid_response(self, run_mock, _exists) -> None:
        run_mock.return_value = types.SimpleNamespace(
            returncode=0,
            stdout='{"text":"ChatGPT works"}',
            stderr="",
        )
        provider = LocalLlmRewriteProvider("/tmp/rewriter.py")
        result = provider.rewrite("um chat g p t works", "ChatGPT works", "zh", "polished", 1.3, ["ChatGPT"])
        self.assertEqual(result.text, "ChatGPT works")
        self.assertEqual(result.backend, "local-llm")


if __name__ == "__main__":
    unittest.main()
