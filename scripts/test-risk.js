#!/usr/bin/env node
'use strict';
// risk.js 离线自检（全部用注入的 now，不依赖真实时钟；状态目录隔离到 logs/risk-test）
const path = require('path');
process.env.QQRISK_DIR = path.join(__dirname, '..', 'logs', 'risk-test');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-risk-test';
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-risk-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-risk-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-risk-test';
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-risk-' + process.pid + '.json';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

const fs = require('fs');
const risk = require('./risk.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '   [' + JSON.stringify(detail) + ']' : '')); }
}
function reset() {
  try { fs.rmSync(risk.dirOf(), { recursive: true, force: true }); } catch (e) { }
  // 显式回到「最保守」默认：不依赖 config/risk.json 里被用户改过的开关
  risk.configure({ allowProactiveOnClient: false, requirePhoneChannelForProactive: true, allowReplyWhileCooling: false });
}
const T0 = new Date('2026-10-24T10:00:00+08:00').getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

console.log('§1 初始状态与基础闸门');
reset();
ok('初始等级 normal', risk.status(T0).level === 'normal', risk.status(T0));
ok('read 放行', risk.gate('read', { now: T0 }).ok === true);
ok('reply 放行', risk.gate('reply', { now: T0 }).ok === true);
ok('proactive 默认必须走手机通道（被禁）', risk.gate('proactive', { now: T0 }).ok === false, risk.gate('proactive', { now: T0 }));
ok('qzone 默认被禁', risk.gate('qzone', { now: T0 }).ok === false);
ok('profile 默认被禁', risk.gate('profile', { now: T0 }).ok === false);
ok('未知动作被拒', risk.gate('nonsense', { now: T0 }).ok === false);

console.log('§2 登录额度');
reset();
ok('首次可登录', risk.canLogin(T0).ok === true);
risk.recordLogin(T0);
ok('刚登录立刻再登被间隔挡住', risk.canLogin(T0 + 2 * MIN).ok === false, risk.canLogin(T0 + 2 * MIN));
ok('10 分钟后可再登', risk.canLogin(T0 + 11 * MIN).ok === true);
risk.recordLogin(T0 + 11 * MIN);
risk.recordLogin(T0 + 30 * MIN);
ok('第 4 次被每日上限挡住', risk.canLogin(T0 + 60 * MIN).ok === false, risk.canLogin(T0 + 60 * MIN));
ok('等级升到 caution', risk.status(T0 + 60 * MIN).level === 'caution', risk.status(T0 + 60 * MIN).level);
ok('跨天后计数归零', (() => {
  const next = new Date('2026-10-25T09:00:00+08:00').getTime();
  return risk.status(next).today.login === 0 && risk.canLogin(next).ok === true;
})());

console.log('§3 掉线熔断');
reset();
const d1 = risk.noteDrop('探活失败', T0);
ok('第一次掉线不熔断', d1.cooled === false);
ok('仍然 normal', d1.level === 'normal', d1.level);
const d2 = risk.noteDrop('探活失败', T0 + 5 * MIN);
ok('30 分钟内第二次掉线 → 熔断', d2.cooled === true, d2);
ok('等级变 cooling', risk.status(T0 + 5 * MIN).level === 'cooling');
ok('冷却期 reply 被拒', risk.gate('reply', { now: T0 + 6 * MIN }).ok === false, risk.gate('reply', { now: T0 + 6 * MIN }));
ok('冷却期 restart 被拒', risk.canRestart(T0 + 6 * MIN).ok === false);
ok('冷却期 login 被拒', risk.canLogin(T0 + 6 * MIN).ok === false);
ok('冷却剩余约 6 小时', risk.status(T0 + 6 * MIN).coolingLeftMin > 300, risk.status(T0 + 6 * MIN).coolingLeftMin);
ok('冷却结束后恢复', risk.status(T0 + 7 * HOUR).level !== 'cooling', risk.status(T0 + 7 * HOUR).level);
ok('冷却结束后 reply 放行', risk.gate('reply', { now: T0 + 7 * HOUR }).ok === true);

console.log('§4 冷却期允许被动回复（可配置）');
reset();
risk.configure({ allowReplyWhileCooling: true });
risk.noteDrop('a', T0);
risk.noteDrop('b', T0 + MIN);
ok('配了 allowReplyWhileCooling 后 reply 放行', risk.gate('reply', { now: T0 + 2 * MIN }).ok === true, risk.gate('reply', { now: T0 + 2 * MIN }));
ok('但 proactive 仍然被拒', risk.gate('proactive', { now: T0 + 2 * MIN }).ok === false);

console.log('§5 重启额度');
reset();
ok('首次可重启', risk.canRestart(T0).ok === true);
risk.recordRestart(T0);
risk.recordRestart(T0 + HOUR);
ok('第 3 次被每日上限挡住', risk.canRestart(T0 + 2 * HOUR).ok === false, risk.canRestart(T0 + 2 * HOUR));
ok('等级 caution', risk.status(T0 + 2 * HOUR).level === 'caution');

console.log('§6 登录失败 → 长冷却');
reset();
risk.loginFailed('需要扫码', T0);
ok('登录失败后 cooling', risk.status(T0).level === 'cooling');
ok('冷却约 12 小时', risk.status(T0).coolingLeftMin > 700, risk.status(T0).coolingLeftMin);
ok('12 小时后恢复', risk.status(T0 + 13 * HOUR).level !== 'cooling');

console.log('§7 clear 与坏文件');
reset();
risk.noteDrop('x', T0);
risk.noteDrop('y', T0 + MIN);
ok('确实进入冷却', risk.status(T0 + MIN).level === 'cooling');
risk.clear(T0 + 2 * MIN);
ok('clear 后 normal', risk.status(T0 + 2 * MIN).level === 'normal');
ok('clear 后计数归零', risk.status(T0 + 2 * MIN).today.login === 0 && risk.status(T0 + 2 * MIN).today.restart === 0);
fs.writeFileSync(risk.fileOf(), '{ 这不是 JSON');
const after = risk.load();
ok('坏文件不会崩，返回空状态', after.level === 'normal' && after.drops.length === 0);
ok('坏文件被改名留证', fs.readdirSync(risk.dirOf()).some((f) => f.includes('.bad-')));

console.log('§8 主动通道开关（想临时放开时）');
reset();
risk.configure({ allowProactiveOnClient: true });
ok('放开后 proactive 放行', risk.gate('proactive', { now: T0 }).ok === true);
risk.configure({ allowProactiveOnClient: false, requirePhoneChannelForProactive: false });
ok('两个开关都关时 caution 仍拦主动', (() => {
  risk.recordLogin(T0); risk.recordLogin(T0 + 11 * MIN); risk.recordLogin(T0 + 30 * MIN);
  return risk.gate('proactive', { now: T0 + 60 * MIN }).ok === false;
})());

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(risk.dirOf(), { recursive: true, force: true }); } catch (e) { }
process.exit(fail ? 1 : 0);
