#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""avatar_prep.py —— 把任意图片处理成头像用的方形 PNG

用法：python avatar_prep.py <输入> <输出.png> [尺寸=512]

规则：
  1. 打开图片（JPEG/PNG/WEBP/GIF 首帧），转 RGB（去掉透明底，铺白）
  2. 居中裁成正方形
  3. 缩放到目标尺寸（LANCZOS）
  4. 存 PNG（去掉 EXIF/元数据）
  5. 太难看的（太小、纯色）直接报错退出，让上层换一张
"""
import sys
import os


def main():
    if len(sys.argv) < 3:
        print('用法: avatar_prep.py <输入> <输出.png> [尺寸]', file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 512

    from PIL import Image

    im = Image.open(src)
    try:
        im.seek(0)
    except Exception:
        pass
    im = im.convert('RGBA')
    # 透明底铺白（头像在 QQ 里是圆的，白底比黑底自然）
    bg = Image.new('RGB', im.size, (255, 255, 255))
    bg.paste(im, mask=im.split()[-1] if im.mode == 'RGBA' else None)
    im = bg

    w, h = im.size
    if w < 120 or h < 120:
        print('图片太小: %dx%d' % (w, h), file=sys.stderr)
        return 3

    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    im = im.crop((left, top, left + side, top + side))
    im = im.resize((size, size), Image.LANCZOS)

    # 纯色/极端单调的图当头像很难看，直接拒（标准差过低）
    small = im.resize((32, 32))
    px = list(small.getdata())
    n = len(px)
    means = [sum(p[i] for p in px) / n for i in range(3)]
    var = sum(((p[i] - means[i]) ** 2) for p in px for i in range(3)) / (n * 3)
    if var < 40:
        print('画面过于单调（方差 %.1f），换一张' % var, file=sys.stderr)
        return 4

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    im.save(dst, 'PNG', optimize=True)
    print('ok %dx%d -> %s %dB' % (w, h, dst, os.path.getsize(dst)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
