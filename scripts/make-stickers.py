#!/usr/bin/env python
"""生成 DSH 自己的一套表情包（月夜小月亮人设，纯本地绘制，无版权风险）。

输出 assets/stickers/made/*.png（512x512，透明底，QQ 里显示为图片表情）。
用法：python scripts/make-stickers.py [输出目录]
依赖：Pillow（DSH 自带 python 运行时里有）
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 512
FONT_PATH = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_PATH_ALT = r"C:\Windows\Fonts\msyh.ttc"


def font(size):
    for p in (FONT_PATH, FONT_PATH_ALT):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def radial_bg(base=(24, 30, 58), edge=(10, 13, 28)):
    im = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    px = im.load()
    cx = cy = SIZE / 2.0
    maxd = math.hypot(cx, cy)
    for y in range(SIZE):
        for x in range(SIZE):
            d = math.hypot(x - cx, y - cy) / maxd
            t = min(1.0, d * 1.05)
            r = int(base[0] * (1 - t) + edge[0] * t)
            g = int(base[1] * (1 - t) + edge[1] * t)
            b = int(base[2] * (1 - t) + edge[2] * t)
            px[x, y] = (r, g, b, 255)
    # 圆角裁切
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=64, fill=255)
    im.putalpha(mask)
    return im


def stars(draw, n=26, seed=7):
    rnd = seed
    for _ in range(n):
        rnd = (rnd * 1103515245 + 12345) % 2147483648
        x = 20 + rnd % (SIZE - 40)
        rnd = (rnd * 1103515245 + 12345) % 2147483648
        y = 16 + rnd % (SIZE - 120)
        rnd = (rnd * 1103515245 + 12345) % 2147483648
        r = 1 + rnd % 3
        a = 90 + rnd % 110
        draw.ellipse([x, y, x + r, y + r], fill=(255, 255, 235, a))


MOON = (255, 240, 198)
MOON_SHADE = (243, 224, 172)
INK = (60, 48, 40)
PINK = (255, 170, 170, 190)


def moon(draw, cx, cy, r):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=MOON + (255,))
    # 环形山
    for (dx, dy, rr) in [(-0.35, -0.25, 0.14), (0.3, 0.25, 0.1), (0.05, -0.45, 0.07), (-0.2, 0.4, 0.06)]:
        draw.ellipse(
            [cx + dx * r - rr * r, cy + dy * r - rr * r, cx + dx * r + rr * r, cy + dy * r + rr * r],
            fill=MOON_SHADE + (255,),
        )


def eyes_happy(d, cx, cy, r):
    for sx in (-1, 1):
        x = cx + sx * r * 0.38
        d.arc([x - r * 0.16, cy - r * 0.2, x + r * 0.16, cy + r * 0.08], 200, 340, fill=INK + (255,), width=7)


def eyes_dots(d, cx, cy, r, look=0):
    for sx in (-1, 1):
        x = cx + sx * r * 0.36 + look
        d.ellipse([x - r * 0.07, cy - r * 0.09, x + r * 0.07, cy + r * 0.09], fill=INK + (255,))


def eyes_sleep(d, cx, cy, r):
    for sx in (-1, 1):
        x = cx + sx * r * 0.38
        d.line([x - r * 0.16, cy, x + r * 0.16, cy], fill=INK + (255,), width=7)


def eyes_x(d, cx, cy, r):
    for sx in (-1, 1):
        x = cx + sx * r * 0.36
        s = r * 0.13
        d.line([x - s, cy - s, x + s, cy + s], fill=INK + (255,), width=7)
        d.line([x - s, cy + s, x + s, cy - s], fill=INK + (255,), width=7)


def cheeks(d, cx, cy, r):
    for sx in (-1, 1):
        x = cx + sx * r * 0.62
        d.ellipse([x - r * 0.13, cy + r * 0.16, x + r * 0.13, cy + r * 0.34], fill=PINK)


def mouth_smile(d, cx, cy, r, w=7):
    d.arc([cx - r * 0.22, cy + r * 0.05, cx + r * 0.22, cy + r * 0.35], 20, 160, fill=INK + (255,), width=w)


def mouth_flat(d, cx, cy, r, w=7):
    d.line([cx - r * 0.15, cy + r * 0.24, cx + r * 0.15, cy + r * 0.24], fill=INK + (255,), width=w)


def mouth_o(d, cx, cy, r):
    d.ellipse([cx - r * 0.09, cy + r * 0.14, cx + r * 0.09, cy + r * 0.34], fill=INK + (255,))


def bubble_text(d, text, fill=(255, 255, 255, 245), text_fill=INK + (255,)):
    f = font(64)
    tw = d.textlength(text, font=f)
    pad_x, pad_y = 34, 18
    w, h = tw + pad_x * 2, 64 + pad_y * 2
    x = (SIZE - w) / 2
    y = SIZE - h - 26
    d.rounded_rectangle([x, y, x + w, y + h], radius=h / 2, fill=fill)
    d.text((x + pad_x, y + pad_y - 4), text, font=f, fill=text_fill)


def make(name, painter):
    im = radial_bg()
    d = ImageDraw.Draw(im)
    stars(d)
    painter(d)
    return im


def p_happy(d):
    cx, cy, r = SIZE / 2, SIZE / 2 - 26, 132
    moon(d, cx, cy, r)
    eyes_happy(d, cx, cy, r)
    cheeks(d, cx, cy, r)
    mouth_smile(d, cx, cy, r)
    bubble_text(d, "开心")


def p_sleepy(d):
    cx, cy, r = SIZE / 2, SIZE / 2 - 26, 132
    moon(d, cx, cy, r)
    eyes_sleep(d, cx, cy, r)
    mouth_flat(d, cx, cy, r)
    fb = font(70)
    d.text((cx + r * 0.9, cy - r * 0.95), "z", font=fb, fill=(200, 215, 255, 230))
    d.text((cx + r * 1.2, cy - r * 1.35), "z", font=font(50), fill=(180, 200, 255, 200))
    bubble_text(d, "困了")


def p_question(d):
    cx, cy, r = SIZE / 2, SIZE / 2 - 26, 132
    moon(d, cx, cy, r)
    eyes_dots(d, cx, cy, r, look=8)
    mouth_o(d, cx, cy, r)
    d.text((cx + r * 0.75, cy - r * 1.05), "?", font=font(96), fill=(255, 236, 160, 255))
    bubble_text(d, "在吗？")


def p_speechless(d):
    cx, cy, r = SIZE / 2, SIZE / 2 - 26, 132
    moon(d, cx, cy, r)
    eyes_dots(d, cx, cy, r)
    mouth_flat(d, cx, cy, r)
    for i, xx in enumerate((-0.2, 0.0, 0.2)):
        d.ellipse([cx + xx * r - 8, cy + r * 0.3, cx + xx * r + 8, cy + r * 0.3 + 16], fill=INK + (255,))
    bubble_text(d, "……")


def p_love(d):
    cx, cy, r = SIZE / 2, SIZE / 2 - 26, 132
    moon(d, cx, cy, r)
    # 心动眼
    for sx in (-1, 1):
        x = cx + sx * r * 0.36
        y = cy - r * 0.02
        s = r * 0.13
        d.polygon([(x, y + s * 0.9), (x - s, y - s * 0.4), (x - s * 0.45, y - s * 0.9), (x, y - s * 0.35),
                   (x + s * 0.45, y - s * 0.9), (x + s, y - s * 0.4)], fill=(226, 82, 110, 255))
    cheeks(d, cx, cy, r)
    mouth_smile(d, cx, cy, r)
    bubble_text(d, "比心")


def p_cheer(d):
    cx, cy, r = SIZE / 2, SIZE / 2 - 26, 132
    moon(d, cx, cy, r)
    eyes_happy(d, cx, cy, r)
    mouth_smile(d, cx, cy, r)
    # 小拳头
    hx, hy = cx + r * 1.0, cy + r * 0.5
    d.rounded_rectangle([hx - 26, hy - 26, hx + 26, hy + 26], radius=14, fill=MOON + (255,))
    d.line([hx - 14, hy, hx + 14, hy], fill=(180, 160, 120, 200), width=5)
    bubble_text(d, "加油")


def p_busy(d):
    cx, cy, r = SIZE / 2, SIZE / 2 - 26, 132
    moon(d, cx, cy, r)
    eyes_dots(d, cx, cy, r, look=-6)
    mouth_flat(d, cx, cy, r)
    # 汗滴
    d.polygon([(cx + r * 0.95, cy - r * 0.3), (cx + r * 1.12, cy + r * 0.05), (cx + r * 0.8, cy + r * 0.05)],
              fill=(150, 205, 255, 235))
    bubble_text(d, "忙着")


def p_night(d):
    cx, cy, r = SIZE / 2, SIZE / 2 - 26, 132
    moon(d, cx, cy, r)
    eyes_sleep(d, cx, cy, r)
    mouth_smile(d, cx, cy, r)
    bubble_text(d, "晚安")


RECIPES = [
    ("happy", p_happy),
    ("sleepy", p_sleepy),
    ("question", p_question),
    ("speechless", p_speechless),
    ("love", p_love),
    ("cheer", p_cheer),
    ("busy", p_busy),
    ("night", p_night),
]


def main(argv):
    out = argv[1] if len(argv) > 1 else os.path.join("assets", "stickers", "made")
    os.makedirs(out, exist_ok=True)
    for name, painter in RECIPES:
        im = make(name, painter)
        # 轻微发光，避免边缘生硬
        glow = im.filter(ImageFilter.GaussianBlur(2))
        im = Image.alpha_composite(glow, im)
        path = os.path.join(out, "dsh-%s.png" % name)
        im.save(path, "PNG")
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
