"""Parsing regressions for optional real-process startup resource evidence."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import benchmark_startup as benchmark


class ResourceParserTests(unittest.TestCase):
    def test_proc_stat_uses_final_comm_parenthesis(self):
        fields = ["0"] * 22
        fields[0] = "S"
        for index, value in {7: 12, 9: 3, 11: 150, 12: 50, 17: 8, 19: 1234, 21: 16}.items():
            fields[index] = str(value)
        text = "42 (a (name) with spaces) " + " ".join(fields)
        with (
            patch.object(Path, "read_text", return_value=text),
            patch.object(benchmark.os, "sysconf", side_effect=[100, 4096]),
        ):
            result = benchmark.root_process_stat(42)
        self.assertEqual(result["rss_bytes"], 65536)
        self.assertEqual(result["cpu_total_seconds"], 2)
        self.assertEqual(result["process_start_ticks_since_boot"], 1234)
        self.assertEqual(result["minor_faults"], 12)
        self.assertEqual(result["major_faults"], 3)
        self.assertEqual(result["threads"], 8)

    def test_smaps_separates_file_brk_and_anonymous_residence(self):
        text = (
            "1000-2000 rw-p 00000000 00:00 0 [heap]\n"
            "Size: 4 kB\nRss: 2 kB\nAnonymous: 2 kB\n"
            "2000-6000 rw-p 00000000 00:00 0\n"
            "Size: 16 kB\nRss: 12 kB\nAnonymous: 12 kB\n"
            "6000-8000 r-xp 00000000 08:01 1 /a/chud binary\n"
            "Size: 8 kB\nRss: 8 kB\nAnonymous: 0 kB\n"
            "8000-9000 rw-p 00000000 00:00 0 [anon:allocator]\n"
            "Size: 4 kB\nRss: 4 kB\nAnonymous: 4 kB\n"
            "9000-a000 r-xp 00000000 08:01 2 /a/addon.node\n"
            "Size: 4 kB\nRss: 4 kB\nAnonymous: 0 kB\n"
        )
        with patch.object(Path, "read_text", return_value=text):
            result = benchmark.mapping_snapshot(42, Path("/a/chud binary"))
        categories = result["categories"]
        self.assertEqual(categories["brk_heap"]["Rss_bytes"], 2048)
        self.assertEqual(categories["anonymous_mapping"]["Rss_bytes"], 16384)
        self.assertEqual(categories["anonymous_mapping"]["mapping_count"], 2)
        self.assertEqual(categories["executable_file"]["Rss_bytes"], 8192)
        self.assertEqual(categories["other_file_mapping"]["Rss_bytes"], 4096)
        self.assertEqual(result["largest_resident_mappings"][0]["address"], "2000-6000")



if __name__ == "__main__":
    unittest.main()
