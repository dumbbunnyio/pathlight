#!/usr/bin/env python3
"""Render `tmux capture-pane -e -p` output (truecolor SGR) to a PNG, for visual checks of the viewer.

usage: tmux capture-pane -e -p -t PANE | ansi2png.py out.png [--cols N]
"""
import re, sys
from PIL import Image, ImageDraw, ImageFont

FONT = "/home/david/.local/share/fonts/JetBrainsMonoNerdFont-Regular.ttf"
BOLD = "/home/david/.local/share/fonts/JetBrainsMonoNerdFont-Bold.ttf"
SIZE = 18
DEFAULT_FG, DEFAULT_BG = (231, 239, 247), (15, 20, 27)

def parse(text):
    rows, fg, bg, bold = [], DEFAULT_FG, DEFAULT_BG, False
    for line in text.split("\n"):
        row, i = [], 0
        while i < len(line):
            if line[i] == "\x1b" and line[i + 1:i + 2] == "[":
                m = re.match(r"\x1b\[([0-9;:]*)m", line[i:])
                if m:
                    p = [int(x) if x else 0 for x in re.split(r"[;:]", m.group(1))] or [0]
                    j = 0
                    while j < len(p):
                        c = p[j]
                        if c == 0: fg, bg, bold = DEFAULT_FG, DEFAULT_BG, False
                        elif c == 1: bold = True
                        elif c == 22: bold = False
                        elif c == 39: fg = DEFAULT_FG
                        elif c == 49: bg = DEFAULT_BG
                        elif c in (38, 48) and j + 4 < len(p) + 0 and p[j + 1] == 2:
                            col = tuple(p[j + 2:j + 5]);
                            if c == 38: fg = col
                            else: bg = col
                            j += 4
                        j += 1
                    i += m.end(); continue
                m = re.match(r"\x1b\[[0-9;?]*[A-Za-z]", line[i:])
                i += m.end() if m else 1; continue
            row.append((line[i], fg, bg, bold)); i += 1
        rows.append(row)
    return rows

def main():
    out = sys.argv[1]
    rows = parse(sys.stdin.read().rstrip("\n"))
    font, bold = ImageFont.truetype(FONT, SIZE), ImageFont.truetype(BOLD, SIZE)
    cw = round(font.getlength("M")); ch = round(SIZE * 1.45)
    width = max(len(r) for r in rows)
    img = Image.new("RGB", (width * cw, len(rows) * ch), DEFAULT_BG)
    d = ImageDraw.Draw(img)
    for y, row in enumerate(rows):
        for x, (c, fg, bg, b) in enumerate(row):
            x0, y0 = x * cw, y * ch
            if bg != DEFAULT_BG: d.rectangle([x0, y0, x0 + cw, y0 + ch], fill=bg)
            if c == " ": continue
            cp = ord(c)
            if 0x2580 <= cp <= 0x259f:   # block elements: draw exactly
                quad = {0x2580:"TL TR",0x2584:"BL BR",0x258c:"TL BL",0x2590:"TR BR",0x2588:"TL TR BL BR",
                        0x259b:"TL TR BL",0x259c:"TL TR BR",0x2599:"TL BL BR",0x259f:"TR BL BR",
                        0x2596:"BL",0x2597:"BR",0x2598:"TL",0x259d:"TR"}.get(cp)
                if quad:
                    for q in quad.split():
                        qx = x0 + (cw // 2 if q.endswith("R") else 0); qy = y0 + (ch // 2 if q.startswith("B") else 0)
                        d.rectangle([qx, qy, qx + cw // 2, qy + ch // 2], fill=fg)
                    continue
            if 0x2800 <= cp <= 0x28ff:   # braille: draw the dots
                mask = cp - 0x2800
                for bit, (col, row_) in {1:(0,0),2:(0,1),4:(0,2),8:(1,0),16:(1,1),32:(1,2),64:(0,3),128:(1,3)}.items():
                    if mask & bit:
                        cx = x0 + cw * (0.3 + 0.4 * col); cy = y0 + ch * (0.14 + 0.24 * row_) + 1
                        r = max(1.6, cw * 0.12)
                        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fg)
                continue
            d.text((x0, y0 + (ch - SIZE) // 2 - 2), c, font=bold if b else font, fill=fg)
    img.save(out)

main()
