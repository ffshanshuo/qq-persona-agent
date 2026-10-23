/**
 * clock.js —— 历法感：知道今天是哪天、周几、什么时段、有没有节日
 *
 * 之前模型永远「飘在时间之外」：说「周末约爬山」不知道现在周几，说「明天有课」不知道明天是周六。
 * 这一层只给一句人话（日期+周几+时段+节日），并明确要求「别报日期，只用作判断」。
 *
 * 节日用固定日期表（农历节日按当年公历日期写死，见 config/clock.json），
 * 需要跨年时补表；查不到就当没有节日，不乱猜。
 *
 * 纯本地、零 token。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'clock.json');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DEFAULTS = {
  enabled: true,
  // 只给一句「现在大概什么时候」，不带年份
  includeDate: true,
  // 提示里固定强调别把日期念出来
  forbidReadOut: true,
  // 节日表：'MM-DD': '节日名'（按年份分组，农历节日取当年公历日期）
  holidays: {
    2026: {
      '01-01': '元旦', '02-17': '春节', '04-05': '清明节', '05-01': '劳动节',
      '06-19': '端午节', '09-25': '中秋节', '10-01': '国庆节'
    },
    2027: {
      '01-01': '元旦', '02-06': '春节', '04-05': '清明节', '05-01': '劳动节',
      '06-09': '端午节', '09-15': '中秋节', '10-01': '国庆节'
    }
  }
};

function loadCfg(force) {
  if (!force && loadCfg._c) return loadCfg._c;
  let o = { ...DEFAULTS, holidays: { ...DEFAULTS.holidays } };
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    for (const k of Object.keys(j)) {
      if (k.startsWith('_')) continue;
      if (k === 'holidays') o.holidays = { ...DEFAULTS.holidays, ...j.holidays };
      else o[k] = j[k];
    }
  } catch (e) { /* 用默认 */ }
  loadCfg._c = o;
  return o;
}
function configure(over) { loadCfg._c = { ...loadCfg(true), ...(over || {}) }; return loadCfg._c; }

const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function weekdayOf(d) { return d.getDay(); }
function isWeekend(d) { const w = d.getDay(); return w === 0 || w === 6; }

/** 时段：深夜 / 早上 / 上午 / 中午 / 下午 / 傍晚 / 晚上 */
function phaseOf(d) {
  const h = d.getHours();
  if (h < 5) return '深夜';
  if (h < 9) return '早上';
  if (h < 11) return '上午';
  if (h < 13) return '中午';
  if (h < 17) return '下午';
  if (h < 19) return '傍晚';
  if (h < 23) return '晚上';
  return '深夜';
}

/** 今天是不是节日（含前一天/后一天的话术，比如「明天国庆」） */
function holidayOf(d, cfg) {
  const o = cfg || loadCfg();
  const y = d.getFullYear();
  const table = (o.holidays && o.holidays[y]) || {};
  const name = table[dateKey(d)] || '';
  return { name, isHoliday: !!name, tomorrow: isHolidayOn(d, 1, o), yesterday: isHolidayOn(d, -1, o) };
}

function isHolidayOn(d, offset, cfg) {
  const o = cfg || loadCfg();
  const t = new Date(d.getTime() + offset * 864e5);
  const table = (o.holidays && o.holidays[t.getFullYear()]) || {};
  return table[dateKey(t)] || '';
}

/** 相对某天：前天/昨天/今天/明天/后天 */
function dayWordFor(ts, now, tz = 0) {
  const a = new Date(Number(now) || Date.now());
  const b = new Date(Number(ts) || 0);
  const dayA = Math.floor((a.getTime() - tz) / 864e5);
  const dayB = Math.floor((b.getTime() - tz) / 864e5);
  const diff = dayB - dayA;
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  if (diff === -2) return '前天';
  return `${b.getMonth() + 1} 月 ${b.getDate()} 日`;
}

/**
 * 给 brain 的一句时间提示。
 * @returns {{note:string, info:object}}
 */
let _noteCache = { key: '', at: 0, value: null };
const NOTE_CACHE_MS = 60000;

function noteFor(input = {}) {
  const o = input.cfg || loadCfg();
  const now = Number(input.now) || Date.now();
  // 一分钟内同样的（时间点 + facts）直接复用：这层必须是零成本，不能拖慢回复
  const ck = String(input.cfg ? 'x' : 'd') + '|' + String(Math.floor(now / NOTE_CACHE_MS)) + '|' + String((input.facts || []).join(','));
  if (_noteCache.value && _noteCache.key === ck && (Date.now() - _noteCache.at) < NOTE_CACHE_MS) return _noteCache.value;
  const v = noteForUncached(input, o, now);
  _noteCache = { key: ck, at: Date.now(), value: v };
  return v;
}

function noteForUncached(input, o, now) {
  const d = new Date(now);
  const info = {
    iso: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    weekday: WEEK[weekdayOf(d)],
    weekdayIndex: weekdayOf(d),
    weekend: isWeekend(d),
    phase: phaseOf(d),
    hour: d.getHours(),
    holiday: holidayOf(d, o),
    tomorrowWeekday: WEEK[(weekdayOf(d) + 1) % 7]
  };
  if (o.enabled === false) return { note: '', info };

  const bits = [];
  if (o.includeDate !== false) bits.push(`现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${info.weekday}${info.phase === '深夜' ? '深夜' : '，' + info.phase}`);
  else bits.push(`现在是${info.weekday}${info.phase}`);
  const h = info.holiday;
  if (h.name) bits.push(`今天是${h.name}`);
  else if (h.tomorrow) bits.push(`明天是${h.tomorrow}`);
  if (info.weekend) bits.push('是周末');
  else if (info.weekdayIndex === 5) bits.push('明天就周末了');
  if (input.facts && Array.isArray(input.facts)) {
    const joined = input.facts.join(' ');
    if (/学生|上课|口腔|大学|期末|考试|复习/.test(joined)) {
      const schoolHours = !info.weekend && ((info.hour >= 8 && info.hour < 12) || (info.hour >= 14 && info.hour < 18));
      if (schoolHours) bits.push('TA 是学生，这会儿可能在上课/自习；别断言，只能顺着问');
    }
  }
  bits.push('这些只是让你知道「现在是什么时候」，别报日期、别念周几，除非对方问');
  return { note: bits.join('，'), info };
}

module.exports = { DEFAULTS, CFG_PATH, WEEK, loadCfg, configure, weekdayOf, isWeekend, phaseOf, holidayOf, isHolidayOn, dayWordFor, noteFor, dateKey };

if (require.main === module) {
  const r = noteFor({});
  console.log(`[clock] ${r.info.iso} ${r.info.weekday} ${r.info.phase}${r.info.holiday.name ? ' · ' + r.info.holiday.name : ''}`);
  console.log('提示:', r.note);
}
