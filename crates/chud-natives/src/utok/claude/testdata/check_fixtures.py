"""Check or regenerate the Claude reference counts against pinned Python ctok.

Run via `uv run --no-project --python 3.13 --with ctok==1.0.0 python
crates/chud-natives/src/utok/claude/testdata/check_fixtures.py [--write]`.
The checked-in text is the corpus; never reconstruct it from mutable source files.
"""

import importlib.metadata
import json
import sys
from pathlib import Path

import ctok


VERSIONS = (("v3", "3.0"), ("v4_7", "4.7"), ("v5", "5.0"))
FIXTURES = Path(__file__).with_name("fixtures.json")


def main() -> int:
    if sys.argv[1:] not in ([], ["--write"]):
        raise SystemExit("usage: check_fixtures.py [--write]")
    if importlib.metadata.version("ctok") != "1.0.0":
        raise SystemExit("ctok 1.0.0 is required by the vendored vocabulary")

    rows = json.loads(FIXTURES.read_text(encoding="utf-8"))
    differences = []
    for index, row in enumerate(rows):
        for field, version in VERSIONS:
            expected = ctok.token_count(row["text"], version)
            if row[field] != expected:
                differences.append((index, field, row[field], expected))
                if sys.argv[1:] == ["--write"]:
                    row[field] = expected

    if differences and sys.argv[1:] == ["--write"]:
        FIXTURES.write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for index, field, old, expected in differences:
        print(f"row {index} {field}: recorded {old}, ctok 1.0.0 {expected}")
    print(f"checked {len(rows)} texts x {len(VERSIONS)} families; {len(differences)} mismatches")
    return int(bool(differences) and sys.argv[1:] != ["--write"])


if __name__ == "__main__":
    raise SystemExit(main())
