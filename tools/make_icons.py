"""Orbit Sound のアイコン（PNG）を作る。追加のライブラリは不要。

使い方:  python3 tools/make_icons.py
出力先:  icons/icon16.png, icon32.png, icon48.png, icon128.png
"""
import math
import os
import struct
import zlib

BG = (123, 92, 240)      # 紫
FG = (255, 255, 255)     # 白
DOT = (255, 196, 92)     # 山吹色
SS = 4                   # なめらかにするための細分化の数


def inside(px, py):
    """座標 (0〜1) の色を返す。何も描かないところは None。"""
    # 角の丸い四角（背景）
    r = 0.22
    qx = max(abs(px - 0.5) - (0.5 - r), 0)
    qy = max(abs(py - 0.5) - (0.5 - r), 0)
    if qx * qx + qy * qy > r * r:
        return None
    color = BG
    dx, dy = px - 0.5, py - 0.5
    # 傾けた楕円の軌道
    a = math.radians(-25)
    ux = dx * math.cos(a) + dy * math.sin(a)
    uy = -dx * math.sin(a) + dy * math.cos(a)
    e = math.sqrt((ux / 0.36) ** 2 + (uy / 0.17) ** 2)
    if abs(e - 1) < 0.1:
        color = FG
    # 中心の円（聴く人の頭）
    if dx * dx + dy * dy < 0.13 ** 2:
        color = FG
    # 軌道上を回る音の粒
    t = math.radians(-20)
    ox, oy = 0.36 * math.cos(t), 0.17 * math.sin(t)
    sx = ox * math.cos(a) - oy * math.sin(a)
    sy = ox * math.sin(a) + oy * math.cos(a)
    if (dx - sx) ** 2 + (dy - sy) ** 2 < 0.085 ** 2:
        color = DOT
    return color


def render(size):
    rows = []
    for y in range(size):
        row = bytearray([0])  # 行ごとのフィルタ種別（なし）
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = inside((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = SS * SS
            alpha = acc[3] / n
            if alpha:
                cover = acc[3] / 255
                row += bytes([round(acc[0] / cover), round(acc[1] / cover), round(acc[2] / cover), round(alpha)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(render(size))
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
