from pathlib import Path
import sys
import unittest
import types

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
    FallbackTranslator,
    build_dictation_final_event,
    build_dictation_state_event,
    looks_like_garbage_text,
    make_segment_id,
    normalize_text,
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
        self.assertEqual(event["text"], "hello world")
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
        self.assertEqual(event["text"], "漢語 输入")


if __name__ == "__main__":
    unittest.main()
