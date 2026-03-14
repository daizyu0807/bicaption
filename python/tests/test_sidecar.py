from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sidecar import FallbackTranslator, looks_like_garbage_text, make_segment_id, normalize_text


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


if __name__ == "__main__":
    unittest.main()
