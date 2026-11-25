"""Focused tests for prompt-audit registry parsing."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from prompt_audit import AuditError, _registry_ids


class NumberedMarkdownRegistryTests(unittest.TestCase):
    def test_reads_numbered_markdown_ids_in_source_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "registry.md").write_text(
                "1. **First**\n2. **Second**\n", encoding="utf-8"
            )

            ids, source, duplicates, source_order = _registry_ids(
                root,
                {
                    "name": "sample",
                    "kind": "numbered_markdown",
                    "source": "registry.md",
                    "entry_pattern": r"^(?P<id>\d+)\.\s+\*\*",
                },
            )

        self.assertEqual(ids, {"1", "2"})
        self.assertEqual(source, "registry.md")
        self.assertEqual(duplicates, [])
        self.assertEqual(source_order, ["1", "2"])

    def test_reports_duplicate_numbered_markdown_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "registry.md").write_text(
                "1. **First**\n1. **Duplicate**\n", encoding="utf-8"
            )

            ids, _, duplicates, source_order = _registry_ids(
                root,
                {
                    "name": "sample",
                    "kind": "numbered_markdown",
                    "source": "registry.md",
                    "entry_pattern": r"^(?P<id>\d+)\.\s+\*\*",
                },
            )

        self.assertEqual(ids, {"1"})
        self.assertEqual(duplicates, ["1"])
        self.assertEqual(source_order, ["1", "1"])

    def test_requires_an_entry_pattern(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "registry.md").write_text("1. **First**\n", encoding="utf-8")

            with self.assertRaisesRegex(AuditError, "needs entry_pattern"):
                _registry_ids(
                    root,
                    {
                        "name": "sample",
                        "kind": "numbered_markdown",
                        "source": "registry.md",
                    },
                )


if __name__ == "__main__":
    unittest.main()
