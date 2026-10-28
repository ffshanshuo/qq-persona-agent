# 语音：三种做法，以及「自己弄一个音色」的完整流程（VOICE）

> 这个仓库**不带任何音色模型与语料**（那是别人的声音，不能随代码分发）。这里给的是机制与流程：你想让它说话，按 §3 或 §4 自己接一个。
>
> 代码里 `config/voice.json` 的 `provider` 决定走哪条路：`edge`（默认）/`sapi`/`gpt-sovits`/`rvc`。失败会自动回落（`fellBack` 字段写明从哪落到哪），不会把整条回复卡死。

---

## 1. 先想清楚：你要的是「能说话」还是「像某个人」

| 目标 | 用什么 | 本机 CPU 可行 | 需要准备 | 代价 |
| --- | --- | --- | --- | --- |
| 能发语音出去 | **edge-tts**（`provider: edge`） | ✅ | Python + `pip install edge-tts` | 音色是微软的，不像特定人 |
| 让系统 TTS 的声音像某人 | **RVC 换声**（`provider: rvc`） | ✅ | 目标音色的 `.pth` + `.index`，一个 RVC 服务端 | 只有音色，语气/停顿仍来自底稿 |
| 让「某人」说出新内容（零样本） | **GPT-SoVITS**（`provider: gpt-sovits`） | ✅（慢） | 3–10 秒干净参考音频 + 同名文本 | 0.3–0.5 s/字，长句很慢 |
| 让「某人」的克隆更稳更像 | GPT-SoVITS **微调 s1/s2** | ✅（数十分钟～数小时） | 10–60 分钟同人干净语料 + 标注 | 会引入毛刺，需人耳 A/B |

---

## 2. 路线一：edge-tts（5 分钟能跑）

```bash
# 任意 Python（3.9+）都行，装一次就好
python -m pip install edge-tts
python -m edge_tts --list-voices | grep zh-CN      # 挑一个音色
```

`config/voice.json`：

```json
{
  "provider": "edge",
  "voice": "zh-CN-XiaoxiaoNeural",
  "rate": "+8%",
  "pitch": "+0Hz",
  "maxChars": 0
}
```

`maxChars: 0` = 不限长度（长语音会很慢，聊天里建议 40–80）。
`scripts/voice.js` 的 `prosody.js` 会在八档语气（温柔/安慰/俏皮/撒娇/困/认真/兴奋/中性）之间调整 rate/pitch/volume——这是 edge-tts 唯一能控制的三轴，微软**不允许**自定义 SSML 的 style。

验证：

```bash
node scripts/voice.js say "在呢，刚忙完，怎么啦？" --to <你的QQ> --keep
node scripts/voice.js voices                     # 列出本机可用音色
```

---

## 3. 路线二：RVC 换声（音色替换，不改语气）

RVC 是「变声器」：先由 TTS 念出来，再把这段音频换成目标音色，**停顿与语调保留**。

你需要：

1. 目标音色的 RVC 模型：`xxx.pth`（+ 同名 `.index` 提升相似度）
2. 一个 RVC 推理服务端。可以用 [Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) 的 `api_240604.py`，或自己写一个薄服务

`scripts/rvc.js` 期望的服务端契约：

```
GET  /models                      -> ["你的模型名", ...]          （不含 .pth）
POST /voice2voice  (multipart)
     files=<wav>  model_name=<名字>  index_rate=0.75  f0_up_key=0
     protect=0.33  method=rmvpe  format=wav
  -> {"status":"success","path":"<输出 wav 绝对路径>", ...}
```

本机 CPU 装 `infer-rvc-python` 的注意点（都是踩过的）：

- 它硬依赖 `pyworld==0.3.4`，Windows + py3.10/3.12 都没有轮子 → 写一个 `pyworld.py` 桩（只有 harvest 算法用，实际用 rmvpe 就够）
- 需要 ffmpeg，可 `pip install imageio-ffmpeg` 后把二进制放进 PATH
- hubert 权重走 `HF_ENDPOINT=https://hf-mirror.com`；`rmvpe.pt` 在包内写死 huggingface.co，慢得离谱时手动去镜像下
- 服务端必须把输入 **复制** 一份再返回（infer-rvc 是就地改写输入，上传的临时文件会被吃掉）

`config/rvc.json` 让 `provider: rvc` 生效后，`voice.js` 会先 edge-tts 出 wav → POST 服务端 → 拿回换声 wav → 发送。失败自动回落（`fellBack: "rvc->edge"`，原因在 `rvcWhy`）。

---

## 4. 路线三：GPT-SoVITS（零样本 + 自己微调）

这是唯一能做到「像某个人说出新话」的开源方案。CPU 可跑，慢。

### 4.1 环境（Windows，纯 CPU）

```bash
# 1) Python 3.10（官方 installer，不要用 3.12：fairseq 系生态在 3.10 最省事）
# 2) 独立 venv
python -m venv vendor/gsv310
vendor/gsv310/Scripts/python.exe -m pip install -U pip
vendor/gsv310/Scripts/python.exe -m pip install "torch==2.6.*" torchaudio --index-url https://download.pytorch.org/whl/cpu
# 3) 依赖子集（推理够用；gradio/funasr/modelscope 可以不要）
vendor/gsv310/Scripts/python.exe -m pip install numpy\<2 scipy librosa==0.10.2 numba "transformers>=4.51,<5" peft\<0.18 sentencepiece cn2an pypinyin jieba split-lang wordsegment rotary_embedding_torch ToJyutping omegaconf psutil PyYAML chardet "pydantic<=2.10.6" fastapi\[standard\] onnxruntime pytorch-lightning matplotlib nltk resampy
```

**必须注意的三件事**：

- `torch` 必须 **≥2.6**：2.5 会因 CVE-2025-32434 拒绝 `torch.load` 你的 `.pth`
- `jieba_fast` 在 Windows 没有轮子 → 写桩包（`jieba_fast/__init__.py` 内 `from jieba import *`，再补 `posseg.py`、`analyse.py`）
- 权重全走镜像：`HF_ENDPOINT=https://hf-mirror.com`；`modelscope` 在很多网络下不通，G2PW 模型手动从 HF 镜像取

### 4.2 权重清单（GPT-SoVITS v2）

| 文件 | 大小 | 来源 |
| --- | --- | --- |
| `s2G2333k.pth`（音色/音质） | ~101MB | `lj1995/GPT-SoVITS` → `gsv-v2final-pretrained/` |
| `s1bert25hz-…ckpt`（断句/读音/语调） | ~148MB | 同上 |
| `chinese-hubert-base/pytorch_model.bin` | ~181MB | 同上 |
| `chinese-roberta-wwm-ext-large/pytorch_model.bin` | ~622MB | 同上（另需 `vocab.txt`，从 `hfl/chinese-roberta-wwm-ext-large` 取） |
| `sv/pretrained_eres2netv2*.ckpt` | ~103MB | 同上 |
| `text/G2PWModel/*`（多音字） | ~608MB | HF 镜像 `iqt-voice/G2PWModel` |
| `pretrained_models/fast_langdetect/lid.176.bin` | ~126MB | 官方包内提供 |

文本里出现英文词还会走英文 G2P，需要 nltk 的 `cmudict` 与 `averaged_perceptron_tagger`——nltk 官方下载器常连不上，去 `raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/` 手工解压到 `%USERPROFILE%\nltk_data`。

### 4.3 零样本：3–10 秒参考 + 一句转写

参考音频要求：单人、干净、**3–10 秒**（超了服务端直接拒绝），且最好配一句**逐字转写**（`prompt_text`，对还原度影响很大）。

```
vendor/voices/mansui.wav      ← 你的参考音频
vendor/voices/mansui.txt      ← 这 9 秒里说的原话（简体、无标点歧义）
```

`config/voice.json`：

```json
{
  "provider": "gpt-sovits",
  "gsv": {
    "baseUrl": "http://127.0.0.1:7899",
    "voice": "mansui",
    "timeoutMs": 60000,
    "refByTone": {
      "comfort": "mansui-soft", "sleepy": "mansui-soft", "clingy": "mansui-soft",
      "serious": "mansui-normal", "warm": "mansui", "neutral": "mansui",
      "playful": "mansui-quick", "excited": "mansui-quick"
    }
  }
}
```

`refByTone` 是「不同语气用不同参考音频」：同一个人的**慢版/正常/快版**各挑一条，安慰时用慢的、兴奋时用快的。做法见 §4.5。

服务端契约（想自己实现就照这个）：

```
GET  /health   -> {"ok":true}
GET  /voices   -> ["mansui","mansui-soft", ...]
POST /tts      {"text":"…","voice":"mansui","speed":1.0}
     -> {"status":"success","path":"<wav 路径>","ms":1234}
```

### 4.4 自己微调（让它更稳）

**语料要求**：同一个人、干净、10–60 分钟（少于 10 分钟几乎必然带来毛刺）。有剧本最好——标注直接用剧本原文，别用 ASR 猜出来的字。

流程（命令细节见 `tools/` 下的脚本，都是可改的）：

1. **清洗**：剔除 <2s / >12s；30ms 内能量骤变 >25dB 的硬切点去掉；削波软限幅 + 峰值 −1 dBFS；首尾 60ms 淡入淡出；`loudnorm` 统一到 −16 LUFS；重采样统一 32kHz
2. **打标**：有剧本 → 逐条对齐剧本原文；没剧本 → faster-whisper 转写**只用来定位**，标签仍以人工校对为准
3. **预处理**：官方 `1-get-text.py` / `2-get-hubert-wav32k.py` / `3-get-semantic.py`
4. **训练**：
   - s2（音色）3–8 epoch；CPU 215 条 batch4 约 5.5s/it
   - s1（断句/读音）12 epoch 左右；CPU 数十分钟
   - **自建实验目录必须先 `mkdir -p <exp_dir>/logs_s2_v2`**，否则 `s2_train.py` 保存 checkpoint 时相对路径 rename 失败、epoch1 末直接 rc=1
   - 训练建议用 `schtasks` 或后台跑，别挂在前台命令行里
5. **评测**（三条都要，缺一不可）：
   - 客观：同一批句子的语速/时长波动（微调前常见 8–10%，好的是 4–5%）、人名读音对不对
   - 主观：**人耳 A/B**，同一句话分别用「官方权重」「微调权重」「清洗后重训的权重」合成，盲听
   - 结论要写进你自己的报告：**客观指标好 ≠ 听感好**，本仓库的经验是最终以耳朵为准

启用微调权重：起服务端时用环境变量指向你的权重，别改代码。

```
GSV_S1=<你的 s1.ckpt>  GSV_S2G=<你的 s2.pth>  python api_v2.py ...
```

回滚＝不设这两个变量重启。

### 4.5 参考音频怎么挑（3–10 秒硬限）

```bash
ffmpeg -hide_banner -i a.wav 2>&1 | grep Duration        # 时长
ffmpeg -hide_banner -i a.wav -af astats -f null - 2>&1 | grep -E "Peak level|RMS level|Flat factor"
```

规则：时长 3.0–9.9s；峰值不要顶 0dBFS（削波）、RMS 不要低于 −22dB（太轻）；再转写看**有效字数**（字数/秒 最高的那条通常最清楚）。
要三档语速就各挑一条：慢（≈2.7 字/秒）、正常（≈3.5）、快（≈4.5），分别对应 `comfort` / `neutral` / `playful`。

### 4.6 版权与红线（别踩）

- **不要**用别人的声音做克隆并公开发布——这是人格权/肖像权问题，与本项目无关但责任在你
- **不要**把音色权重、语料、转写随仓库或分发包一起给人
- 用自己或已获授权的声音；商用前查 GPT-SoVITS 与所用底模的许可

---

## 5. 排查清单（语音不出声 / 声音不对）

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 完全没语音，日志 `tts-error` | 模型没让用（`voice.choice` 是 `model`，模型这次没写 `[[语音]]`） | 手工验证：`node scripts/voice.js say "测试" --to <QQ> --keep` |
| `参考音频在3~10秒范围外` | 参考 wav 超限 | 剪到 3–10 秒，或改服务端读取 `GSV_REF_MIN_SEC/GSV_REF_MAX_SEC` |
| 换了参考仍「还是旧声音」 | 合成缓存命中旧 key | 缓存 key 必须包含参考 wav/txt 的 size+mtime；清 `logs/voice-gsv/` |
| 声音沙哑/有电音 | 微调过头（语料少 + epoch 多） | 回退官方 s2；或洗数据重训 3 epoch 取第 1 个 |
| `No module named 'ERes2NetV2'` | 没在 GPT-SoVITS 根目录运行（sv.py 用相对路径） | 服务端先 `os.chdir` 到源码目录 |
| `ProxyError 10061` | 系统代理（Clash 等）被关/被拦 | 子进程设 `NO_PROXY=*`，pip 加 `--proxy ""`，curl 用 `--noproxy "*"` |
| 端口 7899 起了 4 个实例 | Windows `SO_REUSEADDR` 让多个进程同时 listen | 服务端 `allow_reuse_address = False`；按命令行杀干净再起 |
