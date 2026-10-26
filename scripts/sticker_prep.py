#!/usr/bin/env python
"""把表情包（gif/webp/apng/jpg/png）转成视觉模型能吃的 PNG。

用法：
  python scripts/sticker_prep.py <输入> [输出.png]        # 静态/4 帧拼图（老行为）
  python scripts/sticker_prep.py <输入> --anim [输出前缀]  # 动图：帧差统计 + 最多两张 2x2 拼图
  python scripts/sticker_prep.py <输入> --meta            # 只打印帧差统计（JSON）

--anim 模式做的事（2026-10-25「观看分析动图表情包」需求）：
  1. 逐帧算与上一帧的差异，得到「动得多大、在哪里动」的量化指标；
  2. 选最多 6 帧（首帧、末帧、变化最大的 3 帧、中间帧），分装进两张 2x2 拼图
     （每格标 #序号 与相对首帧的毫秒数），让视觉模型既看到「过程」也看到「细节」；
  3. stdout 只打一行 JSON：{ok,n_frames,picked,interval_ms,changed_ratio,loops,sheets}
"""
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageSequence  # noqa: F401

MAX_SIDE = 512
ANIM_MAX_SIDE = 320          # 动图一格小一点，两张拼图才不会太大
MAX_PICK = 6                 # 最多选 6 帧（两张 2x2）
DIFF_THRESHOLD = 12          # 像素差判定阈值（0-255）


def _fit(im, side=MAX_SIDE):
    im = im.convert("RGBA")
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


def _frames_of(im, limit=240):
    """把动图帧读进内存（太多就均匀抽），返回 ([(idx, RGBA小图, 相对首帧毫秒)], 原始帧数, 总时长)。"""
    n = getattr(im, "n_frames", 1)
    out = []
    acc = 0
    step = max(1, int(n // limit)) if n > limit else 1
    for i in range(0, n, step):
        im.seek(i)
        dur = int(im.info.get("duration", 80) or 80)
        out.append((i, _fit(im.copy(), ANIM_MAX_SIDE), acc))
        acc += dur
    return out, n, acc


def anim_stats(path):
    """帧差统计：动得多大、动在哪、大概是不是循环。"""
    im = Image.open(path)
    frames, n, total_ms = _frames_of(im)
    if len(frames) < 2:
        return {"ok": True, "n_frames": 1, "changed_ratio": 0.0, "interval_ms": 0,
                "loops": False, "picked": [0] if frames else [], "frames": frames,
                "diffs": [], "total_ms": 0}
    base = frames[0][1].convert("RGB")
    diffs = []
    for i in range(1, len(frames)):
        cur = frames[i][1].convert("RGB")
        if cur.size != base.size:
            cur = cur.resize(base.size)
        d = ImageChops.difference(base, cur).convert("L")
        hist = d.histogram()
        moved = sum(hist[DIFF_THRESHOLD:])
        ratio = moved / float(base.size[0] * base.size[1])
        mask = d.point(lambda v: 255 if v >= DIFF_THRESHOLD else 0)
        bbox = list(mask.getbbox()) if mask.getbbox() else None
        diffs.append({"i": i, "ratio": round(ratio, 4), "bbox": bbox})
    ratios = sorted(diffs, key=lambda x: x["ratio"], reverse=True)
    best = [d for d in ratios if d["ratio"] > 0.002][:3]
    picked = [0]
    for d in best:
        if d["i"] not in picked:
            picked.append(d["i"])
    mid = len(frames) // 2
    if mid not in picked:
        picked.append(mid)
    last = len(frames) - 1
    if last not in picked:
        picked.append(last)
    picked = sorted(picked)[:MAX_PICK]
    last_ratio = diffs[-1]["ratio"]
    mid_max = max((d["ratio"] for d in diffs[:-1]), default=0)
    loops = bool(last_ratio < 0.02 and mid_max > 0.02)
    interval = int(round(total_ms / max(1, len(frames))))
    return {
        "ok": True,
        "n_frames": n,
        "changed_ratio": round(max((d["ratio"] for d in diffs), default=0), 4),
        "interval_ms": interval,
        "loops": loops,
        "picked": picked,
        "frames": frames,
        "diffs": diffs[:40],
        "total_ms": total_ms,
    }


def build_anim_sheets(path):
    st = anim_stats(path)
    frames = st["frames"]
    picked = st["picked"] or [0]
    groups = [picked[i:i + 4] for i in range(0, len(picked), 4)]
    sheets = []
    for group in groups[:2]:
        ims = [frames[k] for k in group]
        cw = max(f.size[0] for _, f, _ in ims)
        ch = max(f.size[1] for _, f, _ in ims)
        pad = 6
        sheet = Image.new("RGB", (cw * 2 + pad * 3, ch * 2 + pad * 3), (255, 255, 255))
        d = ImageDraw.Draw(sheet)
        for ci, (idx, f, ms) in enumerate(ims):
            x = pad + (ci % 2) * (cw + pad)
            y = pad + (ci // 2) * (ch + pad)
            flat = _flatten(f)
            sheet.paste(flat, (x, y))
            d.rectangle([x - 1, y - 1, x + flat.size[0], y + flat.size[1]], outline=(200, 200, 200))
            d.text((x + 3, y + 2), "#%d  %dms" % (idx + 1, ms), fill=(255, 60, 60))
        sheets.append(sheet)
    return st, sheets


def main(argv):
    if len(argv) < 2:
        print("usage: sticker_prep.py <input> [output.png] | --anim [prefix] | --meta", file=sys.stderr)
        return 2
    src = argv[1]
    if "--meta" in argv:
        st = anim_stats(src)
        print(json.dumps({k: st[k] for k in ("ok", "n_frames", "changed_ratio", "interval_ms", "loops", "picked")}, ensure_ascii=False))
        return 0
    if "--anim" in argv:
        i = argv.index("--anim")
        prefix = None
        if len(argv) > i + 1 and not argv[i + 1].startswith("--"):
            prefix = argv[i + 1]
        if not prefix:
            prefix = os.path.splitext(src)[0] + ".anim"
        st, sheets = build_anim_sheets(src)
        paths = []
        for n, sh in enumerate(sheets):
            p = "%s.%d.png" % (prefix, n + 1)
            sh.save(p, "PNG")
            paths.append(p)
        if not paths:
            p = "%s.0.png" % prefix
            _flatten(Image.open(src).convert("RGBA")).save(p, "PNG")
            paths.append(p)
        print(json.dumps({
            "ok": True, "n_frames": st["n_frames"], "picked": st["picked"],
            "interval_ms": st["interval_ms"], "changed_ratio": st["changed_ratio"],
            "loops": st["loops"], "sheets": paths,
        }, ensure_ascii=False))
        return 0
    out = argv[2] if len(argv) > 2 else os.path.splitext(src)[0] + ".sheet.png"
    sheet, used = build_sheet(src)
    sheet.save(out, "PNG")
    print(out)
    print("frames_used=%d size=%dx%d" % (used, sheet.size[0], sheet.size[1]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
