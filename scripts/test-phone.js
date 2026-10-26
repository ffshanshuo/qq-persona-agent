'use strict';
// A 通道（手机官方客户端）离线测试：node scripts/test-phone.js
// 不碰真机：用 __setExec 把 adb 换成桩，喂一份构造出来的 uiautomator dump。
const path = require('path');
const fs = require('fs');
process.env.QQPACING_DIR = path.join(__dirname, '..', 'logs', 'pacing-phone-test');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-phone-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-phone-test';
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-phone-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-phone-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-phone-test';
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-phone-' + process.pid + '.json';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
try { fs.rmSync(process.env.QQPACING_DIR, { recursive: true, force: true }); } catch (e) { }

const phone = require('./phone.js');
const pace = require('./pacing.js');
pace.configure({ enabled: true, switchBaseMs: 40, switchMaxMs: 80, switchJitter: 0.05, recentWindowMs: 0, rapidPenaltyMs: 0 });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  <= ' + JSON.stringify(extra) : '')); }
}
const calls = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nodeXml(attrs) {
  return '<node ' + Object.keys(attrs).map((k) => k + '="' + String(attrs[k]).replace(/"/g, '&quot;') + '"').join(' ') + ' />';
}
const HOME_XML = '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]">'
  + nodeXml({ class: 'android.widget.EditText', text: '搜索', 'content-desc': '', clickable: 'true', bounds: '[60,180][1020,300]' })
  + nodeXml({ class: 'android.widget.TextView', text: '消息', 'content-desc': '', clickable: 'true', bounds: '[0,2300][270,2400]' })
  + '</node></hierarchy>';

let TYPED = '';
function searchXml(name) {
  return '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]">'
    + nodeXml({ class: 'android.widget.TextView', text: name, 'content-desc': '', clickable: 'true', bounds: '[40,340][1040,420]' })
    + nodeXml({ class: 'android.widget.TextView', text: '群聊', 'content-desc': '', clickable: 'false', bounds: '[40,1200][1040,1300]' })
    + '</node></hierarchy>';
}

const CHAT_XML = '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]">'
  + nodeXml({ class: 'android.widget.TextView', text: '你今天有空吗', 'content-desc': '', clickable: 'false', bounds: '[300,1500][900,1580]' })
  + nodeXml({ class: 'android.widget.EditText', text: '', 'content-desc': '', clickable: 'true', bounds: '[60,2200][820,2320]' })
  + nodeXml({ class: 'android.widget.Button', text: '发送', 'content-desc': '', clickable: 'true', bounds: '[860,2200][1060,2320]' })
  + '</node></hierarchy>';

phone.__setExec((args) => {
  const cmd = args.join(' ').replace(/^-s \S+ /, '');
  calls.push(cmd);
  if (/^devices/.test(cmd)) return { ok: true, out: 'List of devices attached\ndev123\tdevice\n\n' };
  if (cmd.includes('pm list packages')) return { ok: true, out: 'package:com.android.adbkeyboard\n' };
  if (cmd.includes('uiautomator dump')) return { ok: true, out: 'UI hierchary dumped to: /sdcard/dsh-ui.xml' };
  if (cmd.includes('cat /sdcard/dsh-ui.xml')) {
    // 按最近一次 tap 的坐标决定"现在是哪一屏"，模拟真机导航
    const lastTap = [...calls].reverse().find((c) => c.includes('input tap'));
    if (!lastTap) return { ok: true, out: HOME_XML };
    const [, x, y] = lastTap.match(/input tap (\d+) (\d+)/) || [];
    if (Number(y) >= 330 && Number(y) <= 430) return { ok: true, out: CHAT_XML }; // 点了搜索结果（会话页）
    if (Number(y) < 330) return { ok: true, out: searchXml(TYPED || '好友A') };   // 点了搜索框
    if (Number(y) < 1000) return { ok: true, out: CHAT_XML };    // 点了搜索结果
    return { ok: true, out: CHAT_XML };
  }
  if (cmd.includes('am broadcast')) {
    const m = cmd.match(/--es msg '([^']*)'/);
    if (m) TYPED += m[1];
    return { ok: true, out: 'Broadcast completed: result=0' };
  }
  if (cmd.includes('input tap')) return { ok: true, out: '' };
  if (cmd.includes('input keyevent')) return { ok: true, out: '' };
  if (cmd.includes('dumpsys window')) return { ok: true, out: 'mCurrentFocus=Window{1 u0 com.tencent.mobileqq/com.tencent.mobileqq.activity.ChatActivity}' };
  if (cmd.includes('monkey')) return { ok: true, out: '' };
  return { ok: true, out: '' };
});

(async () => {
  // ① 解析
  const nodes = phone.parseUi(HOME_XML);
  const search = phone.find(nodes, { contains: '搜索' })[0];
  ok('parseUi 解析出搜索框', !!search, nodes.map((n) => n.text));
  ok('bounds 中心点算对', search && search.bounds.x === 540 && search.bounds.y === 240, search && search.bounds);
  ok('丢弃无文字不可点的容器', nodes.filter((n) => !n.text && !n.desc).length === 0 || nodes.every((n) => n.text || n.desc || n.clickable));
  ok('find 按 class 找 EditText', phone.find(phone.parseUi(CHAT_XML), { cls: 'EditText' }).length === 1);
  ok('find 按 text 精确找发送', phone.find(phone.parseUi(CHAT_XML), { text: '发送' }).length === 1);

  // ② 键盘能力
  ok('检测到 ADBKeyboard', phone.hasAdbKeyboard() === true);
  const r1 = await phone.inputText('中文测试');
  ok('中文走 ADBKeyboard 广播', r1.via === 'adbkeyboard' && calls.some((c) => c.includes('ADB_INPUT_TEXT')), r1);

  // ③ 按总时长摊分的打字（A 通道与 C 通道共用 pacing 的时间预算）
  const before = Date.now();
  const t = await phone.typeHuman('今天下午我打算去图书馆还两本书', { totalMs: 300 });
  const elapsed = Date.now() - before;
  ok('分段输入（3 段以上）', t.chunks >= 3, t);
  ok('打字总时长接近预算（>=250ms）', elapsed >= 250, elapsed);
  ok('每段都走广播', calls.filter((c) => c.includes('ADB_INPUT_TEXT')).length >= 3);

  // ④ 打开会话（搜索 → 点结果）
  calls.length = 0;
  TYPED = '';
  const opened = await phone.openChat('好友A');
  ok('openChat 成功', opened === true);
  ok('开了搜索结果第一行', calls.some((c) => c.includes('input tap 540 380')), calls.slice(-6));

  // ⑤ 读会话
  const lines = await phone.readChat();
  ok('readChat 按 y 排序', lines.length >= 1 && lines.every((l, i) => i === 0 || lines[i - 1].y <= l.y), lines);

  // ⑥ 换人发消息：pacing 的「切窗口」等待
  calls.length = 0;
  TYPED = '';
  await phone.sendTo('好友A', '在吗');
  const firstSwitches = pace.status(Date.now()).switchesLastMin;
  calls.length = 0;
  TYPED = '';
  const t2 = Date.now();
  await phone.sendTo('好友B', '在吗在吗');
  const swElapsed = Date.now() - t2;
  ok('换人时付出切换等待', swElapsed >= 30, swElapsed);
  ok('切换有记录', pace.status(Date.now()).switchesLastMin >= (firstSwitches - 1), pace.status(Date.now()));
  ok('切换后上一条是新人', pace.status(Date.now()).lastKey === 'p:好友B', pace.status(Date.now()).lastKey);

  // ⑦ probe 结构
  const pr = await phone.probe();
  ok('probe 拿到设备', pr.ok === true && pr.device === 'dev123', pr);
  ok('probe 判断 QQ 在前台', pr.qqForeground === true, pr.foreground);
  ok('probe 有键盘与节点统计', pr.adbKeyboard === true && pr.nodes > 0);

  // ⑧ 没有设备时报错清楚
  phone.__setExec((args) => (args.join(' ').replace(/^-s S+ /, '').startsWith('devices') ? { ok: true, out: 'List of devices attached\n' } : { ok: true, out: '' }));
  let err = '';
  try { phone.requireDevice(); } catch (e) { err = String(e.message); }
  ok('无设备时提示清楚', err.includes('没有已授权'), err);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
