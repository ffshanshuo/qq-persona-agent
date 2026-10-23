#!/usr/bin/env python
"""把表情包（gif/webp/apng/jpg/png）转成视觉模型能吃的 PNG。

- 静态图：等比缩放，最长边 <= MAX_SIDE
- 动图：取最多 4 帧做 2x2 拼图（每格带帧序号），保留"动画在表达什么"的信息
用法：
  python scripts/sticker_prep.py <输入> [输出.png]
不传输出时打印到 stdout 的路径（与输入同目录，文件名加 .sheet.png 后缀）。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageSequence

MAX_SIDE = 512


def _fit(im, side=MAX_SIDE):
    im = im.convert("RGBA") if im.mode not in ("RGB", "RGBA") else im.convert("RGBA")
    w, h = im.size
    if max(w, h) <= side:
        return im
    k = side / float(max(w, h))
    return im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)


def _flatten(im):
    bg = Image.new("RGB", im.size, (255, 255, 255))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg.paste(im, mask=im.split()[-1])
    else:
        bg.paste(im.convert("RGB"))
    return bg


def build_sheet(path):
    im = Image.open(path)
    n = getattr(im, "n_frames", 1)
    frames = []
    if n <= 1:
        frames = [_fit(im)]
    else:
        idxs = sorted(set(int(round(i * (n - 1) / 3.0)) for i in range(4))) if n >= 4 else list(range(n))
        for i in idxs:
            im.seek(i)
            frames.append(_fit(im.copy()))
    if len(frames) == 1:
        return _flatten(frames[0]), 1
    cells = frames + [None] * (4 - len(frames))
    cw = max(f.size[0] for f in frames)
    ch = max(f.size[1] for f in frames)
    pad = 6
    sheet = Image.new("RGB", (cw * 2 + pad * 3, ch * 2 + pad * 3), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(cells):
        if f is None:
            continue
        x = pad + (i % 2) * (cw + pad)
        y = pad + (i // 2) * (ch + pad)
        flat = _flatten(f)
        sheet.paste(flat, (x, y))
        d.rectangle([x - 1, y - 1, x + flat.size[0], y + flat.size[1]], outline=(200, 200, 200))
        d.text((x + 3, y + 2), "#%d" % (i + 1), fill=(255, 60, 60))
    return sheet, len(frames)


def main(argv):
    if len(argv) < 2:
        print("usage: sticker_prep.py <input> [output.png]", file=sys.stderr)
        return 2
    src = argv[1]
    out = argv[2] if len(argv) > 2 else os.path.splitext(src)[0] + ".sheet.png"
    sheet, used = build_sheet(src)
    sheet.save(out, "PNG")
    print(out)
    print("frames_used=%d size=%dx%d" % (used, sheet.size[0], sheet.size[1]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
