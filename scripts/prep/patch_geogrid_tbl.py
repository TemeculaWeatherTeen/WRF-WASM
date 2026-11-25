#!/usr/bin/env python3
"""Drop the sub-grid orographic gravity-wave-drag fields from GEOGRID.TBL.

They need extra static datasets (varsso, orogwd_*), they are only used when gwd_opt=1, and our
namelist uses gwd_opt=0. Removing them keeps the one-off geogrid download to the nine core datasets.
"""
import re
import sys

SKIP = {"VAR_SSO", "CON", "VAR", "OA1", "OA2", "OA3", "OA4", "OL1", "OL2", "OL3", "OL4"}
path = sys.argv[1]
text = open(path).read()
blocks = re.split(r"(?m)^(={10,}\s*)$", text)
out, dropped = [], []
i = 0
# re.split with a capture group alternates [content, separator, content, separator, ...]
while i < len(blocks):
    chunk = blocks[i]
    m = re.search(r"(?m)^\s*name\s*=\s*(\w+)", chunk)
    if m and m.group(1) in SKIP:
        dropped.append(m.group(1))
        i += 1
        if i < len(blocks):
            i += 1  # drop its trailing separator too
        continue
    out.append(chunk)
    i += 1
open(path, "w").write("".join(out))
print("removed GEOGRID.TBL entries:", ", ".join(dropped) or "(none found)")
