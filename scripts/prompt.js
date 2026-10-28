'use strict';
/**
 * 上下文装配层（prompt.js）
 *
 * 目的：把「塞给模型的一大堆规则」改造成**有预算、有顺序、有取舍**的思维链。
 *  - 顺序固定成四段：此刻 → 这件事 → 我记得的 → 怎么回（+ 思维链脚手架 + 收尾指令）
 *  - 每段有权重与字数上限；总预算超了就按优先级丢「可选段」，不会无脑堆到几千字
 *  - 去重：长期记忆 / 浮现的旧事 / 自己笔记 里重复的条目只留一条
 *  - 产出统计（每段多少字、丢了哪些），供日志与调参
 */

const MAX_TOTAL = 4200;      // 总预算（字符），超过就丢低优先级段
const MAX_SECTION = 520;     // 单段上限（字符）

const clip = (s, n) => String(s == null ? '' : s).slice(0, n == null ? MAX_SECTION : n).trim();

/** 粗去重：同一条内容（包含关系或 bigram 重合 >= .8）只留一次 */
function uniq(list, seen) {
  const out = [];
  const norm = (s) => String(s || '').replace(/[\s，。！？、：；"'"'（）()]/g, '');
  const big = (s) => {
    const t = norm(s);
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  for (const raw of list) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const n = norm(s);
    let dup = false;
    for (const done of seen) {
      const d = norm(done);
      if (d === n || d.includes(n) || n.includes(d) && n.length > 6) { dup = true; break; }
      const a = big(s); const b = big(done);
      if (a.size && b.size) {
        let hit = 0;
        for (const x of a) if (b.has(x)) hit += 1;
        if (hit / Math.min(a.size, b.size) >= 0.8) { dup = true; break; }
      }
    }
    if (!dup) { out.push(s); seen.push(s); }
  }
  return out;
}

/**
 * 段的定义。pri：1=必须 2=高 3=中 4=低（超预算先丢 4 再丢 3，1/2 永不丢）
 * group：此刻 | 这件事 | 我记得 | 怎么回（决定排版顺序与小标题）
 */
const SECTIONS = [
  { id: 'time', group: '此刻', pri: 1, build: (c) => (c.timeLine ? c.timeLine : '') },

  // ── 这件事 ──
  { id: 'situation', group: '这件事', pri: 1, build: (c) => (c.situation ? c.situation : '') },
  { id: 'history', group: '这件事', pri: 2, budget: 1100, build: (c) => (c.historyBlock || '') },
  { id: 'summary', group: '这件事', pri: 3, build: (c) => (c.summary ? `更早之前的对话（摘要，供你了解前情，别照着念）：${clip(c.summary, 400)}` : '') },
  { id: 'themState', group: '这件事', pri: 2, build: (c) => (c.themState ? `【别和这个矛盾】${clip(c.themState, 220)}` : '') },
  { id: 'timeline', group: '这件事', pri: 3, build: (c) => (c.timelineNote ? clip(c.timelineNote, 500) : '') },
  { id: 'gap', group: '此刻', pri: 3, build: (c) => (c.gapNote ? `时间提示：${clip(c.gapNote, 120)}` : '') },
  { id: 'note', group: '这件事', pri: 2, build: (c) => (c.note ? `补充：${clip(c.note, 420)}` : '') },

  // ── 我记得的 ──
  { id: 'facts', group: '我记得的', pri: 2, build: (c) => (Array.isArray(c.facts) && c.facts.length
    ? `你记得关于${c.nick}的事（长期记忆，自然一些，别硬提）：\n` + uniq(c.facts.slice(0, 6), c._seen).map((f) => '- ' + clip(f, 80)).join('\n') : '') },
  { id: 'reminded', group: '我记得的', pri: 2, build: (c) => (Array.isArray(c.reminded) && c.reminded.length
    ? '（下面这几条你平时不主动提，是 TA 自己这次提到才想起来的，可以顺口接一句，别强调"我记起来了"）\n'
      + uniq(c.reminded.map((r) => r && r.text), c._seen).slice(0, 2).map((t) => '- ' + clip(t, 100)).join('\n') : '') },
  { id: 'memories', group: '我记得的', pri: 2, build: (c) => (Array.isArray(c.memories) && c.memories.length
    ? '说到这个，你脑子里顺带浮现的旧事（有合适的就自然提一句，没有合适的就完全别提；别逐条复述、别说"我记得"）：\n'
      + uniq(c.memories.slice(0, 5), c._seen).map((m) => '- ' + clip(m, 120)).join('\n') : '') },
  { id: 'selfNotes', group: '我记得的', pri: 3, build: (c) => (Array.isArray(c.selfNotes) && c.selfNotes.length
    ? '你自己之前记下的（不是对方说的，别当成 TA 说过的话）：\n'
      + c.selfNotes.slice(0, 3).map((it) => `- ${clip(it.label, 20)}：${clip(it.text, 60)}`).join('\n') : '') },
  // 我自己发过的话也要在视野里：别重复、别自相矛盾、别把刚说过的再许一遍
  { id: 'myRecent', group: '我记得的', pri: 2, build: (c) => {
    const list = Array.isArray(c.myRecent) ? c.myRecent.filter((x) => x && x.text) : [];
    if (!list.length) return '';
    const hm = (t) => {
      if (!t) return '';
      const d = new Date(Number(t));
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} `;
    };
    const rows = list.slice(-3).map((x) => `- ${hm(x.t)}你：${clip(x.text, 90)}`);
    return '你刚说过的话（别重复、别打自己的脸；除非 TA 追问，不用再讲一遍）：\n' + rows.join('\n');
  } },
  { id: 'bond', group: '我记得的', pri: 3, build: (c) => (c.bond ? `你跟${c.nick}的关系：${clip(c.bond, 200)}` : '') },
  { id: 'tie', group: '我记得的', pri: 3, build: (c) => (c.tieNote ? `你们的关系（别直接说出来）：${clip(c.tieNote, 180)}` : '') },

  // ── 怎么回 ──
  { id: 'mood', group: '怎么回', pri: 3, build: (c) => (c.mood ? `你此刻的状态（只是底色，别直接说出来）：${clip(c.mood, 160)}` : '') },
  { id: 'style', group: '怎么回', pri: 2, build: (c) => (c.style ? `说话的尺度（照做，但别把这些规则说出来）：${clip(c.style, 240)}` : '') },
  { id: 'charter', group: '怎么回', pri: 2, build: (c) => (c.charterNote ? `我自己定的规矩（我自己写的，照做；与下面的风格建议冲突时以这里为准）：\n${clip(c.charterNote, 1200)}` : '') },
  { id: 'persona', group: '怎么回', pri: 3, build: (c) => (c.personaNote ? `说话风格（倾向，不是模板）：${clip(c.personaNote, 460)}` : '') },
  { id: 'habits', group: '怎么回', pri: 4, build: (c) => (c.habits ? clip(c.habits, 200) : '') },
  { id: 'mode', group: '怎么回', pri: 2, build: (c) => (c.modeNote ? `这轮怎么想（照做，别把这段说出来）：${clip(c.modeNote, 260)}` : '') },
  { id: 'stickers', group: '怎么回', pri: 3, budget: 900, build: (c) => (c.stickerBlock || '') }
];

const GROUP_TITLES = { 此刻: '此刻', 这件事: '现在这件事', 我记得的: '你记得的', 怎么回: '怎么回' };

/** 思维链脚手架：让模型按固定顺序想一遍，再开口（比堆规则更省 token 也更稳） */
function chainOfThought(c) {
  const lines = [];
  lines.push('');
  lines.push('开口之前，先在心里过一遍（不要写出来）：');
  lines.push('1) TA 现在是什么状态、这句话在要什么（要人接情绪 / 要个主意 / 只是顺口聊 / 在闹脾气）；');
  lines.push('2) 你想怎么接：先接情绪，还是给个能落地的说法，还是就一句顺口的；');
  lines.push(`3) 有没有该顺带提的东西${c && c.hasPending ? '（说好的事、没回的那句、刚想到的旧事）' : '（刚想到的旧事、对方刚提到的事）'}；`);
  lines.push('想清楚只输出最后那句话本身。');
  return lines.join('\n');
}

/**
 * 装配 prompt 正文（不含 SYSTEM，也不含收尾指令）
 * @returns {{ lines: string[], stats: { total: number, sections: Array<{id,group,chars,kept}>, dropped: string[] } }}
 */
function assemble(ctx, opts = {}) {
  const c = { ...(ctx || {}), _seen: [] };
  const budget = Number(opts.maxChars || c.ctxBudget) || MAX_TOTAL;
  const built = [];
  for (const def of SECTIONS) {
    let body = '';
    try { body = clip(def.build(c) || '', def.budget || MAX_SECTION); } catch (e) { body = ''; }
    if (!body) { built.push({ def, body: '', kept: false }); continue; }
    built.push({ def, body, kept: true });
  }
  // 超预算：按 pri 从低到高丢（4 → 3），1/2 永不丢
  let total = built.reduce((n, x) => n + (x.kept ? x.body.length : 0), 0);
  const dropped = [];
  for (const pri of [4, 3]) {
    if (total <= budget) break;
    for (const x of built) {
      if (total <= budget) break;
      if (!x.kept || x.def.pri !== pri) continue;
      total -= x.body.length;
      x.kept = false;
      dropped.push(x.def.id);
    }
  }
  // 仍然超（pri<=2 的段不整段丢）：把低优先级的大段按需截短，保证总长可控
  if (total > budget) {
    const order = built.filter((x) => x.kept).sort((a, b) => (b.def.pri - a.def.pri) || (b.body.length - a.body.length));
    for (const x of order) {
      if (total <= budget) break;
      if (x.def.pri <= 1) continue;                        // 最必须的段不动
      const room = Math.max(120, x.body.length - (total - budget));
      if (room < x.body.length) {
        total -= (x.body.length - room);
        x.body = x.body.slice(0, room).replace(/\s+$/, '') + '…';
      }
    }
  }
  // 排版：按 group 聚合，组内固定顺序；只有一组里多于一条才写小标题
  const lines = [];
  let cur = null;
  const groups = [];
  for (const x of built) {
    if (!x.kept) continue;
    if (!groups.length || groups[groups.length - 1][0] !== x.def.group) groups.push([x.def.group, []]);
    groups[groups.length - 1][1].push(x.body);
  }
  for (const [g, bodies] of groups) {
    if (cur !== null) lines.push('');
    cur = g;
    if (bodies.length > 1 && GROUP_TITLES[g]) lines.push(`【${GROUP_TITLES[g]}】`);
    for (const b of bodies) { lines.push(b); }
  }
  const stats = {
    total: lines.join('\n').length,
    sections: built.map((x) => ({ id: x.def.id, group: x.def.group, chars: x.kept ? x.body.length : 0, kept: x.kept })),
    dropped
  };
  return { lines, stats };
}

module.exports = { SECTIONS, GROUP_TITLES, MAX_TOTAL, MAX_SECTION, chainOfThought, assemble, uniq, clip };
