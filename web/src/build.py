#!/usr/bin/env python3
# Web版を単一HTMLに組み立てる: python3 build.py <patch> <out.html>
import base64, hashlib, sys
patch_path, out_path = sys.argv[1], sys.argv[2]
blob = open(patch_path, "rb").read()
sha = hashlib.sha256(blob).hexdigest()
core = open("core.js", encoding="utf-8").read()
ui = open("ui.js", encoding="utf-8").read()
html = open("template.html", encoding="utf-8").read()
for name, s in (("core", core), ("ui", ui)):
    assert "</script" not in s.lower(), name
b64 = base64.b64encode(blob).decode("ascii")
html = html.replace("__PATCH_B64__", b64).replace("__PATCH_SHA__", sha).replace("__CORE__", core).replace("__UI__", ui)
assert "__" not in html.replace("__dm32", "").replace("__DM32_TEST__", ""), [l for l in html.split("\n") if "__" in l][:3]
open(out_path, "w", encoding="utf-8", newline="\n").write(html)
print(out_path, len(html.encode("utf-8")), "bytes  patch sha", sha)
