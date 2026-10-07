#!/usr/bin/env python3
"""Myserycord: "Fluxer" -> "Myserycord" in the translated strings (msgstr) of every
.po catalogue. msgid stays untouched, so message IDs do not change. Idempotent:
run after every upstream merge (tools/myserycord/sync-upstream.sh does)."""

import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
changed = 0
for po in sorted(root.glob("fluxer_app/src/features/i18n/locales/*/messages.po")):
    lines = po.read_text(encoding="utf-8").splitlines(keepends=True)
    in_msgstr = False
    for i, line in enumerate(lines):
        if line.startswith("msgstr"):
            in_msgstr = True
        elif not line.startswith('"'):
            in_msgstr = False
        if in_msgstr and "Fluxer" in line:
            # {placeholders} are code names and must stay as they are.
            new = re.sub(r"(\{[^}]*\})|Fluxer", lambda m: m.group(1) or "Myserycord", line)
            if new != line:
                lines[i] = new
                changed += 1
    po.write_text("".join(lines), encoding="utf-8")
print(f"rebrand_po: {changed} line(s) changed")
