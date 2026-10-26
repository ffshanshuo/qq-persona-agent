#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""本地轻量「变声」：只改音高/语速（等比例重采样），不换音色身份。

用途：RVC 服务端不可用时的临时占位，让语音听起来和默认音色有差别。
真正换音色仍然需要 RVC（torch + 目标音色模型）。

用法：
  python local_vc.py --pitch 1.12 in.wav out.wav
  python local_vc.py --pitch 0.9 in.mp3 out.wav   # 输入 mp3 需要 ffmpeg，本机没有 → 只收 wav

--pitch 1.12 ≈ 音高 +2 半音（同时语速快 12%）；0.9 ≈ 低 2 半音。
"""
import argparse
import sys
import wave

import numpy as np


def read_wav(path):
    with wave.open(path, "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        fr = w.getframerate()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise SystemExit("只支持 16bit PCM wav（当前 %d bit）" % (sw * 8))
    data = np.frombuffer(raw, dtype="<i2")
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1).astype("<i2")
    return data, fr


def write_wav(path, data, fr):
    data = np.clip(data, -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fr)
        w.writeframes(data.tobytes())
    return int(data.size)


def resample(data, pitch):
    """等比例重采样：pitch>1 → 音高升高、时长变短（语速变快）。"""
    n = data.size
    if abs(pitch - 1.0) < 1e-3 or n < 2:
        return data
    out_n = max(1, int(round(n / pitch)))
    idx = np.linspace(0, n - 1, out_n, dtype=np.float64)
    lo = np.floor(idx).astype(np.int64)
    hi = np.minimum(lo + 1, n - 1)
    frac = (idx - lo).astype(np.float64)
    a = data.astype(np.float64)
    out = a[lo] * (1.0 - frac) + a[hi] * frac
    return out


def normalize(data, headroom=0.98):
    a = data.astype(np.float64)
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    if peak <= 0:
        return data
    limit = 32767.0 * headroom
    if peak > limit:
        a = a * (limit / peak)
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pitch", type=float, default=1.12)
    ap.add_argument("infile")
    ap.add_argument("outfile")
    args = ap.parse_args()

    data, fr = read_wav(args.infile)
    out = normalize(resample(data, args.pitch))
    n = write_wav(args.outfile, out, fr)
    sys.stdout.write(
        '{"ok":true,"pitch":%.3f,"inFrames":%d,"outFrames":%d,"rate":%d,"seconds":%.2f}'
        % (args.pitch, data.size, n, fr, n / float(fr))
    )


if __name__ == "__main__":
    main()
