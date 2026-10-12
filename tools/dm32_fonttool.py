#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dm32_fonttool.py  Ver 0.2.7  JA2IZU

DM-32UV フォント領域の 読み出し(read) / 書き込み(write) ツール(通常モード / CPS 互換手順)。

  * read  : フォント3領域を 4KiB ブロックで読み出す(実機で一致確認済み)。
  * 出力ファイル名(0.2.3): 保存するファイルは末尾に枝番 _0, _1, ... を付け、既存ファイルを上書きしない
            (実行のたびにリネームする必要なし)。ログ(--log)は従来どおり追記。
  * calread: (0.2.2 追加)校正データ(CD)ブロックの読み出し(読み出し専用)。CPS のテストモードと同じ方式:
            V の idx 0x0A の範囲で 4KiB ブロック末尾 1 バイト(種別)を走査し、種別 0x02 がちょうど 1 個なら
            そのブロックを 4096 バイト読む(2 回読んで一致確認)。0 個/2 個以上なら中止。
  * info  : (0.2.1 追加)V 問い合わせだけを行う読み出し専用。領域表(コードプラグ探索範囲・連絡先DB領域など)を表示。
  * write : 'W' フレーム(57 addr3 len2 + data)を送る。実機で書込と読み戻し照合を確認済み
            (USB-シリアル変換は CH340 / FTDI)。CPS のフォントダウンロード(任意DL)の通信を
            解析して再現したもので、CPS とは別の実装。

安全策(write):
  * 書き込める領域とファイルサイズを固定(下記 WRITE_LIMIT)。それ以外は拒否。
      HZK24T は 77,824 バイト(0x13000)まで。元の 101,520 バイトは
      0x278000 以降の連絡先データ(ContactList)を壊すため拒否する。
  * 書き込み前に、消去対象のセクタ(4KiB 単位)を自動バックアップ。失敗したら書かずに中止。
  * 書き込み後に読み戻して照合(読み戻せない場合は「未検証」と表示)。
  * 実行前に WRITE と入力して確認(--yes で省略)。
  * --dry-run でポートを開かず計画だけ表示。
  * 終了時に 'E' は送らない(CPS と同じ。read のみ従来どおり 'E' を送る)。

使い方:
  python3 dm32_fonttool.py info  --port COM11
  python3 dm32_fonttool.py read  --port COM11 --region all --out readback
  python3 dm32_fonttool.py write --dry-run \
        --item Radio_Y16=Radio_Y16_patched.bin --item HZK24S=HZK24S_patched.bin --item HZK24T=HZK24T_patched.bin
  python3 dm32_fonttool.py write --port COM11 --backup-dir backup \
        --item Radio_Y16=Radio_Y16_patched.bin --item HZK24S=HZK24S_patched.bin --item HZK24T=HZK24T_patched.bin
  (--item は複数指定可: Radio_Y16=… / HZK24S=… / HZK24T=…。パッチの作り方は dm32_fontpatch.py 参照)

実行前に本体の電源を入れ直してください(PC Programming モードへ入るため)。
必要: pip install pyserial
"""
import argparse
import hashlib
import os
import sys
import time

VERSION = "0.2.7"
BLOCK = 0x1000

# 読み出し用(0.1.9 と同じ)
REGIONS = {
    "Radio_Y16": (0x0C9000, 524288),
    "HZK24S": (0x180000, 498528),
    "HZK24T": (0x265000, 101520),
}
# 書き込み用の上限サイズ(ファイルサイズは  size  か  size を4KiBに切り上げた値  のみ許可)
# HZK24T は 0x278000 の連絡先 DB を避けるため 0x13000 に固定(切り上げても同値)
WRITE_LIMIT = {
    "Radio_Y16": 524288,
    "HZK24S": 498528,
    "HZK24T": 77824,
}


def unique_path(directory, stem, ext=".bin"):
    """directory/stem_N.ext の N を 0 から順に試し、まだ無い最初の名前を返す(上書きしない)。"""
    n = 0
    while True:
        p = os.path.join(directory, "%s_%d%s" % (stem, n, ext))
        if not os.path.exists(p):
            return p
        n += 1


def roundup(n, unit=BLOCK):
    return (n + unit - 1) // unit * unit


class ProtocolError(Exception):
    pass


class Link:
    """pyserial の薄いラッパ。全送受信を記録する。"""

    def __init__(self, ser, logf=None):
        self.ser = ser
        self.logf = logf
        self.last_rx = 0.0

    def _log(self, tag, data):
        if self.logf:
            t = time.time()
            self.logf.write("%s.%03d %s %d  %s\n" % (
                time.strftime("%H:%M:%S", time.localtime(t)), int((t % 1) * 1000), tag, len(data),
                data[:64].hex(" ") + (" ..." if len(data) > 64 else "")))
            self.logf.flush()

    def tx(self, data, delay=0.010):
        # CPS のキャプチャでは、受信完了から次の送信まで約10ms空いている
        wait = 0.012 - (time.time() - self.last_rx)
        if wait > 0:
            time.sleep(wait)
        self._log("TX", data)
        self.ser.write(data)
        self.ser.flush()
        time.sleep(delay)

    def rx(self, n, timeout=0.5):
        """最大 n バイト受信。timeout 内に届いた分を返す(不足でも例外にしない)。"""
        end = time.time() + timeout
        buf = bytearray()
        while len(buf) < n and time.time() < end:
            chunk = self.ser.read(n - len(buf))
            if chunk:
                buf += chunk
        self._log("RX", bytes(buf))
        self.last_rx = time.time()
        return bytes(buf)


def expect_ack(link, what, timeout=1.0):
    r = link.rx(1, timeout)
    if r != b"\x06":
        raise ProtocolError("%s: ACK(06) が来ません (受信=%s)" % (what, r.hex(" ") or "なし"))


def cps_prelude(link):
    """CPS の任意DL が SYSINFO のあと PROGRAM の前に行う手順(キャプチャで確認済み)。"""
    def v_query(frame):
        link.tx(frame)
        h = link.rx(3)
        if len(h) != 3 or h[0] != 0x56:
            raise ProtocolError("V 問い合わせ %s: 想定外の応答 %s" % (frame.hex(" "), h.hex(" ") or "なし"))
        n = h[2]
        body = link.rx(n) if n else b""
        if len(body) != n:
            raise ProtocolError("V 問い合わせ %s: 本体長 %d (期待 %d)" % (frame.hex(" "), len(body), n))
        print("  V %s -> %s %s" % (frame.hex(" "), h.hex(" "), body.hex(" ")))
    v_query(bytes([0x56, 0x00, 0x00, 0x40, 0x0D]))
    for i in (6, 7, 8):
        v_query(bytes([0x56, 0x00, 0x00, 0x00, i]))
    link.tx(bytes([0x47, 0x00, 0x00, 0x00, 0x00, 0x01]))
    g = link.rx(0x106)
    if len(g) != 0x106 or g[0] != 0x53:
        raise ProtocolError("G: 想定外の応答 (%d バイト, 先頭 %s)" % (len(g), g[:1].hex() or "なし"))
    print("  G -> %d バイト (先頭 53)" % len(g))
    link.tx(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x0C]))  # 返事は読まない(CPS と同じ)


def handshake(link, settle=0.0):
    """CPS と同じ手順(0.1.9 の --mode cps と同一)。"""
    link.tx(b"PSEARCH")
    r = link.rx(8)
    if len(r) != 8 or r[0] != 0x06:
        raise ProtocolError("PSEARCH: 想定外の応答 %s" % (r.hex(" ") or "なし"))
    link.tx(b"PASSSTA")
    r = link.rx(3)
    if len(r) != 3 or r[0] != 0x50:
        raise ProtocolError("PASSSTA: 想定外の応答 %s" % (r.hex(" ") or "なし"))
    print("PASSSTA 応答:", r.hex(" "), "(意味は未確認。パスワードは送っていません)")
    link.tx(b"SYSINFO")
    expect_ack(link, "SYSINFO")
    cps_prelude(link)
    link.tx(b"PROGRAM")
    expect_ack(link, "PROGRAM")
    if settle > 0:
        print("PROGRAM ACK 後 %.1f 秒待ちます" % settle)
        extra = link.rx(64, timeout=settle)
        if extra:
            print("  待機中に届いたバイト: %s" % extra.hex(" "))
    link.tx(b"\x02")
    r = link.rx(8, timeout=1.0)  # 8 バイト(ff×8)。受けたらすぐ 06 を送る(約0.5秒を超えると本体が再起動する)
    if len(r) != 8:
        raise ProtocolError("0x02 の応答が 8 バイトではありません (%d バイト: %s)" % (len(r), r.hex(" ")))
    print("機種情報応答(8 バイト): %s" % r.hex(" "))
    link.tx(b"\x06")
    expect_ack(link, "握手の最終ACK")


def addr_bytes(addr):
    return bytes([addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF])


def read_block(link, addr):
    frame = b"\x52" + addr_bytes(addr) + b"\x00\x10"
    link.tx(frame)
    r = link.rx(BLOCK + 6, timeout=2.0)
    if len(r) != BLOCK + 6:
        raise ProtocolError("0x%06X: 受信長 %d (期待 %d)" % (addr, len(r), BLOCK + 6))
    if r[0] != 0x57:
        raise ProtocolError("0x%06X: 先頭バイトが 0x57 ではありません (%02X)" % (addr, r[0]))
    if r[1:4] != frame[1:4] or r[4:6] != frame[4:6]:
        print("  注意: 0x%06X の応答ヘッダがアドレス/長さのエコーと一致しません: %s" % (addr, r[:6].hex(" ")))
    return r[6:]


def read_span(link, label, start, nbytes, nblocks_limit=0):
    """start から nbytes バイトを 4KiB ブロックで読む(最後のブロックは先頭 nbytes に切り詰め)。"""
    nblocks = (nbytes + BLOCK - 1) // BLOCK
    if nblocks_limit:
        nblocks = min(nblocks, nblocks_limit)
    out = bytearray()
    t0 = time.time()
    for i in range(nblocks):
        out += read_block(link, start + i * BLOCK)
        if i % 8 == 0 or i == nblocks - 1:
            print("  %s 読み出し %d/%d ブロック  (経過 %.1f 秒)" % (label, i + 1, nblocks, time.time() - t0))
    print("  %s 読み出し所要時間 %.1f 秒" % (label, time.time() - t0))
    if not nblocks_limit:
        out = out[:nbytes]
    return bytes(out)


def write_block(link, addr, chunk):
    frame = b"\x57" + addr_bytes(addr) + bytes([len(chunk) & 0xFF, (len(chunk) >> 8) & 0xFF]) + chunk
    link.tx(frame, delay=0.0)  # 1フレーム(ヘッダ+データ)を一括送信(キャプチャで確認)
    r = link.rx(1, timeout=5.0)
    if r != b"\x06":
        if r:
            r += link.rx(3, timeout=0.3)
        note = ""
        if r[:1] == b"\x90":
            note = " ※ 90 fe 98 fe は本体の拒否/時間切れの定型応答(これまでの観察)"
        raise ProtocolError("0x%06X への書き込み: ACK(06) が来ません (受信=%s)%s" % (addr, r.hex(" ") or "なし", note))


def write_span(link, label, start, data):
    nblocks = (len(data) + BLOCK - 1) // BLOCK
    t0 = time.time()
    for i in range(nblocks):
        write_block(link, start + i * BLOCK, data[i * BLOCK:(i + 1) * BLOCK])
        if i % 8 == 0 or i == nblocks - 1:
            print("  %s 書き込み %d/%d ブロック  (経過 %.1f 秒)" % (label, i + 1, nblocks, time.time() - t0))
    print("  %s 書き込み所要時間 %.1f 秒" % (label, time.time() - t0))


def first_diff(a, b):
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return None if len(a) == len(b) else n


def sha(b):
    return hashlib.sha256(b).hexdigest()


def open_port(a):
    try:
        import serial
    except ImportError:
        sys.exit("pyserial が必要です: pip install pyserial")
    ser = serial.Serial(a.port, a.baud, bytesize=8, parity="N", stopbits=1, timeout=0.05)
    ser.dtr = True
    ser.rts = (a.rts == "on")
    ser.reset_input_buffer()
    return ser


# ---------------------------------------------------------------- read
def cmd_read(a, ser_factory=open_port):
    names = list(REGIONS) if a.region == "all" else [a.region]
    for nm in names:
        if nm not in REGIONS:
            sys.exit("未知の領域: %s" % nm)
    refs = {}
    for c in a.compare:
        k, _, v = c.partition("=")
        refs[k] = v
    if a.dry_run:
        print("[dry-run] 送信予定: PSEARCH, PASSSTA, SYSINFO, V×4, G, FF FF FF FF 0C, PROGRAM, 02, 06")
        for nm in names:
            s, sz = REGIONS[nm]
            print("  %s: 0x%06X..0x%06X  先頭フレーム %s" % (nm, s, s + sz - 1, (b"\x52" + addr_bytes(s) + b"\x00\x10").hex(" ")))
        print("  45 ('E', --no-end で省略)   ※ read は 'W' を送りません")
        return 0
    if not a.port:
        sys.exit("--port が必要です")
    os.makedirs(a.out, exist_ok=True)
    ser = ser_factory(a)
    logf = open(a.log, "a", encoding="utf-8")
    link = Link(ser, logf)
    ok = False
    t_all = time.time()
    try:
        handshake(link, a.settle)
        for nm in names:
            s, sz = REGIONS[nm]
            print("%s を読み出し中 (0x%06X)" % (nm, s))
            data = read_span(link, nm, s, sz, 1 if a.probe else a.blocks)
            tag = "_probe" if (a.probe or a.blocks) else ""
            path = unique_path(a.out, "%s_read%s" % (nm, tag))
            with open(path, "wb") as f:
                f.write(data)
            print("  保存: %s  %d バイト  SHA-256 %s" % (path, len(data), sha(data)))
            if nm in refs:
                ref = open(refs[nm], "rb").read()
                n = min(len(ref), len(data))
                d = first_diff(data[:n], ref[:n])
                if d is None:
                    print("  比較 %s: 先頭 %d バイト一致 (参照 %d バイト)" % (nm, n, len(ref)))
                else:
                    print("  比較 %s: 不一致  最初の不一致 offset=0x%X" % (nm, d))
        ok = True
        print("全体の所要時間 %.1f 秒" % (time.time() - t_all))
    except ProtocolError as e:
        print("中断:", e)
        print("ログ:", a.log)
    finally:
        if not a.no_end:
            try:
                link.tx(b"E")
            except Exception:
                pass
        ser.close()
        logf.close()
    return 0 if ok else 1


# ---------------------------------------------------------------- info (読み出し専用)
INFO_IDX = [i for i in range(1, 0x11) if i != 0x0C]  # CPS のコードプラグ読み出しと同じ (idx 0x0C は CPS も送らない)


def le(b):
    return int.from_bytes(b, "little")


def info_session(link, settle=0.0):
    """CPS のコードプラグ読み出しと同じ順序で V を問い合わせる(静的解析による再現)。
    PSEARCH, PASSSTA, SYSINFO, V 0D, V idx(1..0x10, 0x0C 除く), G, FF FF FF FF 0C, PROGRAM, 02, 06"""
    link.tx(b"PSEARCH")
    r = link.rx(8)
    if len(r) != 8 or r[0] != 0x06:
        raise ProtocolError("PSEARCH: 想定外の応答 %s" % (r.hex(" ") or "なし"))
    link.tx(b"PASSSTA")
    r = link.rx(3)
    if len(r) != 3 or r[0] != 0x50:
        raise ProtocolError("PASSSTA: 想定外の応答 %s" % (r.hex(" ") or "なし"))
    link.tx(b"SYSINFO")
    expect_ack(link, "SYSINFO")
    res = {}

    def vq(frame, key):
        link.tx(frame)
        h = link.rx(3)
        if len(h) != 3 or h[0] != 0x56:
            print("  V %-17s 想定外の応答: %s" % (frame.hex(" "), h.hex(" ") or "なし"))
            raise ProtocolError("V 問い合わせ %s が想定外の応答" % frame.hex(" "))
        n = h[2]
        body = link.rx(n) if n else b""
        if len(body) != n:
            raise ProtocolError("V 問い合わせ %s: 本体長 %d (期待 %d)" % (frame.hex(" "), len(body), n))
        res[key] = body
        print("  V %-17s -> ヘッダ %s 本体(%d B) %s" % (frame.hex(" "), h.hex(" "), n, body.hex(" ")))
    vq(bytes([0x56, 0x00, 0x00, 0x40, 0x0D]), 0x100)
    for i in INFO_IDX:
        vq(bytes([0x56, 0x00, 0x00, 0x00, i]), i)
    link.tx(bytes([0x47, 0x00, 0x00, 0x00, 0x00, 0x01]))
    g = link.rx(0x106)
    if len(g) != 0x106 or g[0] != 0x53:
        raise ProtocolError("G: 想定外の応答 (%d バイト, 先頭 %s)" % (len(g), g[:1].hex() or "なし"))
    link.tx(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x0C]))
    link.tx(b"PROGRAM")
    expect_ack(link, "PROGRAM")
    if settle > 0:
        link.rx(64, timeout=settle)
    link.tx(b"\x02")
    r = link.rx(8, timeout=1.0)
    if len(r) != 8:
        raise ProtocolError("0x02 の応答が 8 バイトではありません (%d バイト: %s)" % (len(r), r.hex(" ")))
    link.tx(b"\x06")
    expect_ack(link, "握手の最終ACK")
    return res


def cmd_info(a, ser_factory=open_port):
    if a.dry_run:
        print("[dry-run] 送信予定: PSEARCH, PASSSTA, SYSINFO, V 56 00 00 40 0D,")
        for i in INFO_IDX:
            print("   V 56 00 00 00 %02x" % i)
        print("   G 47 00 00 00 00 01, FF FF FF FF 0C, PROGRAM, 02, 06, 45('E')   ※ 'R' / 'W' は送りません")
        return 0
    if not a.port:
        sys.exit("--port が必要です")
    ser = ser_factory(a)
    logf = open(a.log, "a", encoding="utf-8")
    link = Link(ser, logf)
    ok = False
    try:
        res = info_session(link, a.settle)
        print("\n解釈(★静的解析による推測。実機の値で確認してください):")
        for idx, label in ((0x0A, "コードプラグ探索範囲(開始/終了)"), (0x0F, "連絡先DB領域(開始/終了)")):
            b = res.get(idx, b"")
            if len(b) >= 8:
                s, e = le(b[0:4]), le(b[4:8])
                print("  idx 0x%02X %s: 0x%06X .. 0x%06X (%d バイト)" % (idx, label, s, e, e - s + 1 if e >= s else 0))
                if idx == 0x0F and e >= s:
                    print("            4KiBセクタ数 %d / 44件×セクタ = %d 件" % ((e - s + 1) // 0x1000, (e - s + 1) // 0x1000 * 44))
            else:
                print("  idx 0x%02X %s: 本体 %d バイトのため解釈できません" % (idx, label, len(b)))
        b = res.get(0x10, b"")
        if len(b) >= 3:
            print("  idx 0x10 連絡先の最大件数(LE24): %d" % le(b[0:3]))
        for idx in (6, 7, 8):
            b = res.get(idx, b"")
            if len(b) >= 8:
                s, e = le(b[0:4]), le(b[4:8])
                print("  idx 0x%02X (フォント/音声の領域表と推測): 0x%06X .. 0x%06X" % (idx, s, e))
        ok = True
    except ProtocolError as e:
        print("中断:", e)
        print("ログ:", a.log)
    finally:
        try:
            link.tx(b"E")
        except Exception:
            pass
        ser.close()
        logf.close()
    return 0 if ok else 1


# ---------------------------------------------------------------- calread (読み出し専用)
CD_TYPE = 0x02


def scan_types(link, start, end):
    """CPS のコードプラグ走査と同じ: start+0xFFF から 4KiB ごとに、ブロック末尾 1 バイト(種別)を読む。
    戻り値: [(ブロック先頭アドレス, 種別)]"""
    out = []
    addr = start + 0xFFF
    n = 0
    total = (end - addr) // BLOCK + 1 if end >= addr else 0
    t0 = time.time()
    while addr <= end:
        frame = b"\x52" + addr_bytes(addr) + b"\x01\x00"
        link.tx(frame)
        r = link.rx(7, timeout=1.0)
        if len(r) != 7 or r[0] != 0x57:
            raise ProtocolError("0x%06X の種別読み出し: 想定外の応答 %s" % (addr, r.hex(" ") or "なし"))
        out.append((addr - 0xFFF, r[6]))
        n += 1
        if n % 50 == 0 or n == total:
            print("  種別走査 %d/%d  (経過 %.1f 秒)" % (n, total, time.time() - t0))
        addr += BLOCK
    return out


def cmd_calread(a, ser_factory=open_port):
    if a.dry_run:
        print("[dry-run] 送信予定: info と同じ握手(V 含む) → idx 0x0A の範囲で 52 <ブロック末尾> 01 00 を走査")
        print("          → 種別 0x02 がちょうど 1 個ならそのブロックを 52 <先頭> 00 10 で 2 回読む → 保存   ※ 'W' は送りません")
        return 0
    if not a.port:
        sys.exit("--port が必要です")
    os.makedirs(a.out, exist_ok=True)
    ser = ser_factory(a)
    logf = open(a.log, "a", encoding="utf-8")
    link = Link(ser, logf)
    ok = False
    try:
        res = info_session(link, a.settle)
        b = res.get(0x0A, b"")
        if len(b) < 8:
            raise ProtocolError("V idx 0x0A の応答が 8 バイト未満です(%d バイト)" % len(b))
        start, end = le(b[0:4]), le(b[4:8])
        print("\nコードプラグ探索範囲: 0x%06X .. 0x%06X" % (start, end))
        types = scan_types(link, start, end)
        hist = {}
        for _, t in types:
            hist[t] = hist.get(t, 0) + 1
        print("  走査 %d ブロック。種別 0x02: %d 個" % (len(types), hist.get(CD_TYPE, 0)))
        cands = [ad for ad, t in types if t == CD_TYPE]
        if len(cands) != 1:
            raise ProtocolError("種別 0x%02X のブロックが %d 個です(1 個のときだけ進みます): %s" % (
                CD_TYPE, len(cands), ", ".join("0x%06X" % c for c in cands) or "なし"))
        cd_addr = cands[0]
        print("  校正ブロック(CD)候補: 0x%06X" % cd_addr)
        d1 = read_block(link, cd_addr)
        d2 = read_block(link, cd_addr)
        if d1 != d2:
            raise ProtocolError("同じブロックを 2 回読んだ結果が一致しません(通信エラーの疑い)。保存しません")
        if d1[0xFFF] != CD_TYPE:
            raise ProtocolError("読み出したブロック末尾が 0x%02X です(種別走査の結果と矛盾)。保存しません" % d1[0xFFF])
        sig_ok = d1[0:4] == bytes([0x00, 0x40, 0x00, 0x47])
        print("  先頭シグネチャ 00 40 00 47: %s" % ("一致" if sig_ok else "★不一致(別ファーム/別個体の可能性。内容は保存します)"))
        h = sha(d1)
        path = unique_path(a.out, "DM32_CD_%s" % h[:8])
        with open(path, "wb") as f:
            f.write(d1)
        print("  保存: %s  %d バイト  SHA-256 %s" % (path, len(d1), h))
        print("  ブロックの物理アドレス: 0x%06X (この値は個体で異なることがあります)" % cd_addr)
        ok = True
    except ProtocolError as e:
        print("中断:", e)
        print("ログ:", a.log)
    finally:
        try:
            link.tx(b"E")
        except Exception:
            pass
        ser.close()
        logf.close()
    return 0 if ok else 1


def load_items(a):
    items = []
    seen = set()
    for it in a.item:
        k, _, v = it.partition("=")
        if k not in WRITE_LIMIT:
            sys.exit("未知の領域: %s (許可: %s)" % (k, ", ".join(WRITE_LIMIT)))
        if k in seen:
            sys.exit("領域 %s が重複しています" % k)
        seen.add(k)
        if not os.path.isfile(v):
            sys.exit("ファイルがありません: %s" % v)
        data = open(v, "rb").read()
        lim = WRITE_LIMIT[k]
        if len(data) not in (lim, roundup(lim)):
            msg = "%s: ファイルサイズ %d バイトは許可されていません(許可: %d%s)" % (
                k, len(data), lim, "" if roundup(lim) == lim else " または %d" % roundup(lim))
            if k == "HZK24T" and len(data) == 101520:
                msg += "\n  101,520 バイト版は 0x278000 以降の連絡先データ(ContactList)を壊すため拒否します。" \
                       "\n  dm32_fontpatch.py apply は、HZK24T を先頭 0x13000(77,824)バイトに切って出力します。それを使ってください。"
            sys.exit(msg)
        items.append((k, v, data))
    if not items:
        sys.exit("--item NAME=FILE が必要です")
    return items


def cmd_write(a, ser_factory=open_port):
    items = load_items(a)
    print("書き込み計画:")
    for k, v, data in items:
        s = REGIONS[k][0]
        nb = (len(data) + BLOCK - 1) // BLOCK
        print("  %-9s 0x%06X..0x%06X  %7d バイト %3d ブロック  %s" % (k, s, s + roundup(len(data)) - 1, len(data), nb, v))
        print("            SHA-256 %s" % sha(data))
        print("            先頭フレーム %s" % (b"\x57" + addr_bytes(s) + bytes([len(data[:BLOCK]) & 0xFF, len(data[:BLOCK]) >> 8])).hex(" ") + " + データ")
    if a.dry_run:
        print("[dry-run] 手順: 握手(CPS と同じ) → バックアップ読み出し → W ブロック書き込み(各 ACK 06) → 読み戻し照合。ポートは開きません。")
        return 0
    if not a.port:
        sys.exit("--port が必要です")
    if not a.yes:
        if input("本体のフォント領域を書き換えます。続行するには WRITE と入力: ").strip() != "WRITE":
            print("中止しました")
            return 1
    os.makedirs(a.backup_dir, exist_ok=True)
    ser = ser_factory(a)
    logf = open(a.log, "a", encoding="utf-8")
    link = Link(ser, logf)
    wrote = False
    ok = False
    t_all = time.time()
    try:
        handshake(link, a.settle)
        # 1) バックアップ(失敗したら書かない)
        backups = {}
        for k, v, data in items:
            s = REGIONS[k][0]
            n = roundup(len(data))
            print("%s のバックアップを読み出し中 (0x%06X, %d バイト)" % (k, s, n))
            old = read_span(link, k, s, n)
            bp = unique_path(a.backup_dir, "backup_%s" % k)
            with open(bp, "wb") as f:
                f.write(old)
            backups[k] = bp
            print("  バックアップ保存: %s  SHA-256 %s" % (bp, sha(old)))
        # 2) 書き込み
        for k, v, data in items:
            s = REGIONS[k][0]
            print("%s を書き込み中 (0x%06X)" % (k, s))
            wrote = True
            write_span(link, k, s, data)
        # 3) 読み戻し照合
        if a.no_verify:
            print("--no-verify: 照合を省略しました(未検証)")
            ok = True
        else:
            allgood = True
            try:
                for k, v, data in items:
                    s = REGIONS[k][0]
                    back = read_span(link, k, s, len(data))
                    d = first_diff(back, data)
                    if d is None:
                        print("  照合 %s: 一致 (%d バイト)" % (k, len(data)))
                    else:
                        allgood = False
                        print("  照合 %s: 不一致  最初の不一致 offset=0x%X" % (k, d))
            except ProtocolError as e:
                print("読み戻しできませんでした(%s)。書込み直後の同一セッションで R が使えるかは未確認です。" % e)
                print("→ 本体を再起動して  read --compare で別途確認してください。")
                allgood = None
            ok = bool(allgood)
            if allgood is None:
                ok = False
        print("書き込み処理 完了。照合結果: %s" % ("一致" if ok else "要確認"))
        print("全体の所要時間 %.1f 秒 (接続から照合まで)" % (time.time() - t_all))
        print("バックアップ:", ", ".join(backups.values()))
    except ProtocolError as e:
        print("中断:", e)
        if wrote:
            print("★書き込み途中で止まりました。領域が中途半端な状態の可能性があります。")
            print("  バックアップ(元の内容)で書き戻すか、同じファイルで write をやり直してください。")
        else:
            print("書き込みは始めていません(本体は無変更のはずです)。")
        print("ログ:", a.log)
    finally:
        # CPS は終了時に 'E' を送らず、ポートを閉じるだけ
        ser.close()
        logf.close()
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="DM-32UV フォント read/write ツール Ver " + VERSION)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--port", help="シリアルポート (例: COM11, /dev/ttyUSB0)")
        p.add_argument("--baud", type=int, default=115200)
        p.add_argument("--log", default="dm32_fonttool.log", help="送受信ログ")
        p.add_argument("--rts", choices=["on", "off"], default="on")
        p.add_argument("--settle", type=float, default=0.0, help="PROGRAM ACK 後の待機秒数(通常 0)")
        p.add_argument("--dry-run", action="store_true")
        p.add_argument("--adapter", default="", help="使用した USB-シリアル変換の名前(記録用。例: FTDI, CH340)")

    pr = sub.add_parser("read", help="読み出し")
    common(pr)
    pr.add_argument("--region", default="all", help="Radio_Y16 / HZK24S / HZK24T / all")
    pr.add_argument("--probe", action="store_true", help="各領域の先頭4KiBだけ")
    pr.add_argument("--blocks", type=int, default=0, help="各領域のブロック数上限")
    pr.add_argument("--out", default=".")
    pr.add_argument("--no-end", action="store_true", help="終了時の 'E' を送らない")
    pr.add_argument("--compare", action="append", default=[], metavar="NAME=FILE")

    pi = sub.add_parser("info", help="V 問い合わせの結果を表示(読み出し専用)")
    common(pi)

    pc = sub.add_parser("calread", help="校正データ(CD)ブロックを読み出す(読み出し専用)")
    common(pc)
    pc.add_argument("--out", default=".", help="出力ディレクトリ")

    pw = sub.add_parser("write", help="書き込み")
    common(pw)
    pw.add_argument("--item", action="append", default=[], metavar="NAME=FILE",
                    help="書き込む領域=ファイル (複数可)")
    pw.add_argument("--backup-dir", default="backup")
    pw.add_argument("--yes", action="store_true", help="確認入力を省略")
    pw.add_argument("--no-verify", action="store_true", help="読み戻し照合を省略")

    a = ap.parse_args()
    print("dm32_fonttool Ver %s  JA2IZU" % VERSION)
    if getattr(a, "adapter", ""):
        print("アダプタ(記録用): %s" % a.adapter)
    sys.exit({"read": cmd_read, "info": cmd_info, "calread": cmd_calread, "write": cmd_write}[a.cmd](a))


if __name__ == "__main__":
    main()
