from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sidecar import SimpleLocalTranslateProvider


class TranslationProviderTest(unittest.TestCase):
    def test_translates_known_phrase(self) -> None:
        provider = SimpleLocalTranslateProvider()
        self.assertEqual(provider.translate("hello", "en", "zh-TW"), "你好")

    def test_preserves_unknown_text(self) -> None:
        provider = SimpleLocalTranslateProvider()
        self.assertIn("Roadmap", provider.translate("Roadmap review", "en", "zh-TW"))


if __name__ == "__main__":
    unittest.main()
