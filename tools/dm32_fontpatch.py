#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dm32_fontpatch.py Ver 0.2.1  JA2IZU

DM-32UV 日本語化フォントの「差分パッチ」を作る / 適用する。

パッチには、自作部分(JIS X0208 の字形)と、未割当スロットの枠(□に×)だけを入れる。
Baofeng 純正のデータは一切含まない。適用するときは、利用者自身の無線機から読み出した
フォント(純正、または日本語化済み)に重ねる。

サブコマンド:
  make   master_1990.json と jiskan BDF からパッチを作る(開発者用。build_font.py を import するだけで改変しない)
  apply  ベースのフォントにパッチを重ねて出力する
  info   パッチの内容を表示する

パッチ形式(リトルエンディアン):
  "DMFP" + u8 版(1) + u8 領域数
  領域ごと: u8 名前長 + 名前(ASCII) + u32 領域サイズ + u32 run数
    run ごと: u32 offset + u32 長さ + データ
  末尾: SHA-256(それまでの全バイト) 32 バイト
"""

import argparse
import hashlib
import json
import os
import struct
import sys

VERSION = "0.2.1"
MAGIC = b"DMFP"
HZK24T_READ_SIZE = 101520   # dm32_fonttool.py read が保存する HZK24T のサイズ

# 領域(名前: (サイズ, グリフバイト数, 幅, 高さ, 漢字域の範囲(枠にするスロット) または None))
REGIONS = {
    "Radio_Y16": dict(size=524288, gbytes=32, w=16, h=16, box=(846, 7613)),
    "HZK24S":    dict(size=498528, gbytes=72, w=24, h=24, box=(0, 6767)),
    "HZK24T":    dict(size=77824,  gbytes=72, w=24, h=24, box=None),
}


def box_x_rows(w, h):
    """全周1pxの枠 + 両対角線(□に×)。"""
    rows = []
    for y in range(h):
        row = [0] * w
        if y == 0 or y == h - 1:
            row = [1] * w
        else:
            row[0] = 1
            row[w - 1] = 1
        # 対角線(幅と高さが同じ前提)
        row[y * (w - 1) // (h - 1)] = 1
        row[(h - 1 - y) * (w - 1) // (h - 1)] = 1
        rows.append(row)
    return rows


def load_build_font(path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_font_mod", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def make_runs(bf, master, bdf24, bdf16, low_jis=False):
    """各領域について {offset: bytes} を作る。"""
    glyph24, bw24, bh24 = bf.load_bdf(bdf24)
    glyph16, bw16, bh16 = bf.load_bdf(bdf16)
    cfg = {
        "Radio_Y16": (glyph16, bf.y16_index, bf.pack_y16),
        "HZK24S":    (glyph24, bf.hzk24_index, bf.pack_hzk24),
        "HZK24T":    (glyph24, bf.hzk24t_index, bf.pack_hzk24),
    }
    out = {}
    stats = {}
    for name, (glyphs, index_fn, pack_fn) in cfg.items():
        r = REGIONS[name]
        nglyph = (r["size"] + r["gbytes"] - 1) // r["gbytes"]   # 末尾の途中までのグリフも対象
        slots = {}
        missing = 0
        for e in master["entries"]:
            idx = index_fn(e["ku"], e["ten"])
            if idx is None or idx >= nglyph:
                continue
            rows = bf.glyph_rows(glyphs, e["char"], r["w"], r["h"])
            if rows is None:
                missing += 1
                continue
            slots[idx] = pack_fn(rows)
        nreal = len(slots)
        nbox = 0
        if r["box"] is not None:
            box = pack_fn(box_x_rows(r["w"], r["h"]))
            for idx in range(r["box"][0], r["box"][1] + 1):
                if idx not in slots:
                    slots[idx] = box
                    nbox += 1
        nlow = 0
        if low_jis and name == "Radio_Y16":
            # 低域(区1-9相当, idx 0..845): GB2312 の字に直して、JISKAN に同じ字があれば置換する(推測: 並びは GB2312 の区点)
            for ku in range(1, 10):
                for ten in range(1, 95):
                    try:
                        ch = bytes([0xA0 + ku, 0xA0 + ten]).decode("gb2312")
                    except Exception:
                        continue
                    rows = bf.glyph_rows(glyphs, ch, r["w"], r["h"])
                    if rows is None:
                        continue
                    slots[(ku - 1) * 94 + (ten - 1)] = pack_fn(rows)
                    nlow += 1
        # バイト列にして、領域サイズでクリップ
        data = {}
        for idx, g in slots.items():
            off = idx * r["gbytes"]
            g = g[:max(0, r["size"] - off)]
            if g:
                data[off] = g
        out[name] = data
        stats[name] = (nreal, nbox, missing, nlow)
    return out, stats


def merge_runs(data):
    """隣り合うオフセットの塊を 1 つの run にまとめる。"""
    runs = []
    for off in sorted(data):
        g = data[off]
        if runs and runs[-1][0] + len(runs[-1][1]) == off:
            runs[-1][1] += g
        else:
            runs.append([off, bytearray(g)])
    return [(o, bytes(b)) for o, b in runs]


def pack_patch(region_runs):
    body = bytearray(MAGIC)
    body += struct.pack("<BB", 1, len(region_runs))
    for name, runs in region_runs.items():
        nb = name.encode("ascii")
        body += struct.pack("<B", len(nb)) + nb
        body += struct.pack("<II", REGIONS[name]["size"], len(runs))
        for off, data in runs:
            body += struct.pack("<II", off, len(data)) + data
    body += hashlib.sha256(bytes(body)).digest()
    return bytes(body)


def parse_patch(blob):
    if blob[:4] != MAGIC:
        raise SystemExit("パッチ形式が違います")
    if hashlib.sha256(blob[:-32]).digest() != blob[-32:]:
        raise SystemExit("パッチの SHA-256 が一致しません(壊れています)")
    ver, n = struct.unpack_from("<BB", blob, 4)
    if ver != 1:
        raise SystemExit("未対応の版です: %d" % ver)
    p = 6
    regions = {}
    for _ in range(n):
        ln = blob[p]; p += 1
        name = blob[p:p + ln].decode("ascii"); p += ln
        size, nruns = struct.unpack_from("<II", blob, p); p += 8
        runs = []
        for _ in range(nruns):
            off, ln2 = struct.unpack_from("<II", blob, p); p += 8
            runs.append((off, blob[p:p + ln2])); p += ln2
        regions[name] = (size, runs)
    if p != len(blob) - 32:
        raise SystemExit("パッチの長さが合いません")
    return regions


def apply_patch(regions, name, base):
    size, runs = regions[name]
    if name == "HZK24T" and len(base) == HZK24T_READ_SIZE:
        # dm32_fonttool.py read が保存する 101,520 バイトのうち、後ろの部分は連絡先データ
        # (0x278000 以降)なので、領域の大きさ(77,824 バイト)に切って使う。
        print("  %s: 読み出しファイル %d バイトの先頭 %d バイトだけを使います" % (name, len(base), size))
        base = base[:size]
    if len(base) not in (size, ((size + 4095) // 4096) * 4096):
        raise SystemExit("%s のベースのサイズが違います: %d" % (name, len(base)))
    out = bytearray(base)
    for off, data in runs:
        if off + len(data) > size:
            raise SystemExit("run が領域外です")
        out[off:off + len(data)] = data
    return bytes(out)


def cmd_make(a):
    bf = load_build_font(a.build_font)
    master = json.load(open(a.master, encoding="utf-8"))
    data, stats = make_runs(bf, master, a.bdf24, a.bdf16, a.low_jis)
    region_runs = {n: merge_runs(d) for n, d in data.items()}
    blob = pack_patch(region_runs)
    with open(a.out, "wb") as f:
        f.write(blob)
    print("dm32_fontpatch Ver %s  JA2IZU" % VERSION)
    for n in region_runs:
        nreal, nbox, missing, nlow = stats[n]
        nb = sum(len(d) for _, d in region_runs[n])
        print("  %-9s 実グリフ %5d  枠(□×) %4d  低域JISKAN %4d  BDFなし %d  run %5d  データ %8d B" % (n, nreal, nbox, nlow, missing, len(region_runs[n]), nb))
    print("書き出し: %s  %d バイト  SHA-256 %s" % (a.out, len(blob), hashlib.sha256(blob).hexdigest()))
    return 0


def cmd_apply(a):
    regions = parse_patch(open(a.patch, "rb").read())
    for item in a.item:
        name, _, path = item.partition("=")
        if name not in regions:
            sys.exit("パッチに領域がありません: %s" % name)
        base = open(path, "rb").read()
        res = apply_patch(regions, name, base)
        outp = os.path.join(a.out_dir, "%s_patched.bin" % name)
        os.makedirs(a.out_dir, exist_ok=True)
        with open(outp, "wb") as f:
            f.write(res)
        print("%s: %d バイト  SHA-256 %s  → %s" % (name, len(res), hashlib.sha256(res).hexdigest(), outp))
    return 0


def cmd_info(a):
    blob = open(a.patch, "rb").read()
    regions = parse_patch(blob)
    print("パッチ %d バイト  SHA-256 %s" % (len(blob), hashlib.sha256(blob).hexdigest()))
    for n, (size, runs) in regions.items():
        print("  %-9s 領域 %d B  run %d  データ %d B" % (n, size, len(runs), sum(len(d) for _, d in runs)))
    return 0


def main():
    ap = argparse.ArgumentParser(description="DM-32UV フォント差分パッチ Ver " + VERSION)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pm = sub.add_parser("make", help="パッチを作る(開発者用)")
    pm.add_argument("--build-font", default="build_font.py")
    pm.add_argument("--master", default="master_1990.json")
    pm.add_argument("--bdf24", default="jiskan24_1990.bdf")
    pm.add_argument("--bdf16", default="jiskan16_1990.bdf")
    pm.add_argument("--out", default="DM32UV_ModFont.patch")
    pm.add_argument("--low-jis", action="store_true", help="Radio_Y16 の低域(区1-9相当)を JISKAN の字形に置換する(試験用)")
    pa = sub.add_parser("apply", help="ベースにパッチを重ねる")
    pa.add_argument("--patch", required=True)
    pa.add_argument("--item", action="append", default=[], metavar="NAME=BASEFILE")
    pa.add_argument("--out-dir", default=".")
    pi = sub.add_parser("info", help="パッチの内容を表示")
    pi.add_argument("--patch", required=True)
    a = ap.parse_args()
    sys.exit({"make": cmd_make, "apply": cmd_apply, "info": cmd_info}[a.cmd](a))


if __name__ == "__main__":
    main()
