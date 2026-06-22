#!/usr/bin/env python3
"""
gen_icons.py — generate PWA icons + iOS splash screens with zero dependencies.

Draws a simple FX candlestick mark on the dashboard's dark palette and writes
PNGs into ../icons/. Re-run any time the brand changes:

    python3 fx-macro-app/scripts/gen_icons.py

Pure stdlib (zlib + struct) — no PIL / no SVG tooling required.
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.normpath(os.path.join(HERE, "..", "icons"))
os.makedirs(ICONS, exist_ok=True)

# Palette (matches Forex_Dashboard/index.html)
BG = (11, 15, 23)          # #0b0f17
PANEL = (19, 26, 38)       # #131a26
LINE = (31, 42, 58)        # #1f2a3a
GREEN = (31, 174, 106)     # #1fae6a  (long / strength)
RED = (226, 87, 92)        # #e2575c  (short / weak)
ACCENT = (76, 141, 255)    # #4c8dff
TXT = (230, 237, 246)      # #e6edf6


def new_canvas(w, h, color):
    r, g, b = color
    row = bytes((r, g, b, 255)) * w
    return [bytearray(row) for _ in range(h)], w, h


def fill_rect(buf, w, h, x0, y0, x1, y1, color, alpha=255):
    r, g, b = color
    x0 = max(0, int(x0)); y0 = max(0, int(y0))
    x1 = min(w, int(x1)); y1 = min(h, int(y1))
    for y in range(y0, y1):
        rowdata = buf[y]
        for x in range(x0, x1):
            i = x * 4
            if alpha == 255:
                rowdata[i] = r; rowdata[i + 1] = g; rowdata[i + 2] = b; rowdata[i + 3] = 255
            else:
                br = rowdata[i]; bg = rowdata[i + 1]; bb = rowdata[i + 2]
                rowdata[i] = (r * alpha + br * (255 - alpha)) // 255
                rowdata[i + 1] = (g * alpha + bg * (255 - alpha)) // 255
                rowdata[i + 2] = (b * alpha + bb * (255 - alpha)) // 255
                rowdata[i + 3] = 255


def write_png(path, buf, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)            # filter type 0 (None)
        raw.extend(buf[y])
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def draw_mark(buf, w, h, cx, cy, scale, padded=False):
    """Draw the candlestick logo centred at (cx, cy). scale ~ full mark width."""
    # On maskable icons keep everything inside the central safe zone.
    unit = scale / 7.0
    body_w = unit * 1.15
    gap = unit * 1.25
    # three candles: green up, red down, green up
    candles = [
        (-gap, GREEN, -2.1, 1.7, -2.9, 2.6),   # (x_off, color, body_top, body_bot, wick_top, wick_bot) in units
        (0.0, RED, -1.1, 2.4, -1.9, 3.1),
        (gap, GREEN, -2.7, 0.9, -3.4, 1.8),
    ]
    for x_off, color, bt, bb, wt, wb in candles:
        x = cx + x_off
        # wick
        fill_rect(buf, w, h, x - unit * 0.12, cy + wt * unit, x + unit * 0.12, cy + wb * unit, color)
        # body
        fill_rect(buf, w, h, x - body_w / 2, cy + bt * unit, x + body_w / 2, cy + bb * unit, color)
    # accent baseline
    fill_rect(buf, w, h, cx - scale * 0.62, cy + scale * 0.52, cx + scale * 0.62, cy + scale * 0.52 + unit * 0.30, ACCENT)


def make_icon(size, name, maskable=False, rounded=True):
    buf, w, h = new_canvas(size, size, BG)
    # subtle rounded panel background for a card feel (skipped on maskable so the
    # safe zone stays solid for adaptive masks)
    if not maskable and rounded:
        inset = size * 0.06
        fill_rect(buf, w, h, inset, inset, size - inset, size - inset, PANEL)
        # thin border
        b = size * 0.012
        fill_rect(buf, w, h, inset, inset, size - inset, inset + b, LINE)
        fill_rect(buf, w, h, inset, size - inset - b, size - inset, size - inset, LINE)
        fill_rect(buf, w, h, inset, inset, inset + b, size - inset, LINE)
        fill_rect(buf, w, h, size - inset - b, inset, size - inset, size - inset, LINE)
    scale = size * (0.40 if maskable else 0.46)
    draw_mark(buf, w, h, size / 2, size / 2, scale, padded=maskable)
    write_png(os.path.join(ICONS, name), buf, w, h)
    print("wrote", name, f"{size}x{size}")


def make_splash(w, h, name):
    buf, _, _ = new_canvas(w, h, BG)
    scale = min(w, h) * 0.22
    draw_mark(buf, w, h, w / 2, h / 2, scale)
    write_png(os.path.join(ICONS, name), buf, w, h)
    print("wrote", name, f"{w}x{h}")


if __name__ == "__main__":
    # App + Apple touch icons
    make_icon(192, "icon-192.png")
    make_icon(512, "icon-512.png")
    make_icon(512, "icon-maskable-512.png", maskable=True)
    make_icon(180, "apple-touch-icon.png")          # iOS home-screen
    make_icon(32, "favicon-32.png")

    # iOS launch images for current iPhone / iPad families (portrait).
    # device CSS pt * DPR = px. Generic; iOS picks the closest by media query.
    splashes = [
        (1170, 2532, "splash-iphone-13-14.png"),     # iPhone 12/13/14 @3x
        (1179, 2556, "splash-iphone-15-16.png"),     # iPhone 14 Pro/15/16
        (1290, 2796, "splash-iphone-pro-max.png"),   # Pro Max
        (1125, 2436, "splash-iphone-x.png"),         # X/XS/11 Pro
        (1640, 2360, "splash-ipad-air.png"),         # iPad Air 11"
        (2048, 2732, "splash-ipad-pro.png"),         # iPad Pro 12.9"
    ]
    for w, h, n in splashes:
        make_splash(w, h, n)
    print("done")
