'use strict';
/**
 * test-selfwrite.js —— 模型自主写文件（关系 / 记下）自检（全离线，不出网、不碰生产）
 *
 * 覆盖：标记解析（宽容括号 / 多标记 / 擦除）、别名映射、白名单、dry 只审计不落盘、
 *       关系三守卫（恋爱凭据 / 恋人唯一 / 同类型）、随手记落盘与日额、undo 回滚、状态计数、
 *       以及 handle 端到端（模型回 writes → 关系真变 + 日志 selfwrite；dry → 不变）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'selfwrite-test-'));
// 全套隔离：默认写生产 logs/，漏一个就会污染真实状态
const DIRS = ['QQSELFWRITE_DIR', 'QQTIES_DIR', 'QQMIND_DIR', 'QQCTX_DIR', 'QQTRACE_DIR', 'QQBOND_DIR', 'QQECHO_DIR', 'QQMODE_DIR', 'QQTHEM_DIR', 'QQFOLLOW_DIR', 'QQNICK_DIR', 'QQPROMISE_DIR', 'QQQUOTE_DIR', 'QQFORWARD_DIR', 'QQGROUP_DIR', 'QQSELF_DIR', 'QQPACING_DIR', 'QQRISK_DIR', 'QQLONGING_DIR', 'QQMURMUR_DIR', 'QQTIMELINE_DIR', 'QQAVATAR_DIR', 'QQSTICKER_BAN'];
for (const d of DIRS) process.env[d] = path.join(TMP, d.toLowerCase());
process.env.QQSELFWRITE_LOG = path.join(TMP, 'selfwrite.jsonl');
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.test.json');
process.env.AUTOREPLY_LOG = path.join(TMP, 'autoreply.log');
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
process.env.AUTOREPLY_DRY = '1';

const selfwrite = require('./selfwrite.js');
const ties = require('./ties.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 220))); } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const K1 = 'p:100000001', K2 = 'p:100000002';

(async function main() {
  // ============ 一、标记解析 ============
  {
    const a = selfwrite.parse('知道啦 [[关系:好朋友]] 还有 [[记下:她下周三考试]]');
    ok('方括号双括号能解析', a.writes.length === 2, a.writes);
    ok('标记从正文里剥掉', a.text === '知道啦 还有', a.text);
    ok('关系词解析成 kind=ties', a.writes[0].kind === 'ties' && a.writes[0].value === '好朋友', a.writes);
    ok('记下解析成 kind=note', a.writes[1].kind === 'note' && a.writes[1].value === '她下周三考试', a.writes);

    const b = selfwrite.parse('【关系:恋人】');
    ok('全角方头括号也认', b.writes.length === 1 && b.writes[0].value === '恋人', b.writes);

    const c = selfwrite.parse('[关系:熟人]');
    ok('单方括号也认', c.writes.length === 1 && c.writes[0].value === '熟人', c.writes);

    const d = selfwrite.parse('今天天气不错，聊点别的');
    ok('没有标记就不产生写入', d.writes.length === 0 && d.text === '今天天气不错，聊点别的', d);

    const e = selfwrite.parse('[[记下:她喜欢喝冰美式]] 好');
    ok('只有记下也能解析', e.writes.length === 1 && e.writes[0].kind === 'note', e.writes);

    ok('typeOf 别名：女朋友 → lover', selfwrite.typeOf('女朋友') === 'lover');
    ok('typeOf 别名：很熟 → close', selfwrite.typeOf('很熟') === 'close');
    ok('typeOf 未知词 → null', selfwrite.typeOf('仇人') === null);
  }

  // ============ 二、白名单与 dry ============
  {
    const r1 = selfwrite.apply([{ kind: 'avatar', value: 'x' }], { key: K1, dry: true });
    ok('不在白名单里的 kind 被拒', r1.skipped.length === 1 && r1.skipped[0].why === 'not-allowed', r1);

    const before = selfwrite.load(now).count;
    const r2 = selfwrite.apply([{ kind: 'ties', value: '朋友' }, { kind: 'note', value: 'dry 不该落盘' }], { key: K1, dry: true });
    ok('dry 记为 applied 但不写盘', r2.applied.length === 2 && selfwrite.load(now).count === before, { applied: r2.applied.length, count: selfwrite.load(now).count });
    const auditLines = fs.readFileSync(path.join(TMP, 'selfwrite.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    ok('dry 也写审计且标记 dry:true', auditLines.some((x) => x.dry === true));
    ok('dry 不改变关系类型', (ties.load(K1, '100000001').type || 'stranger') === 'stranger', ties.load(K1, '100000001'));
  }

  // ============ 三、关系写入三守卫 ============
  {
    const bad = selfwrite.apply([{ kind: 'ties', value: '仇人' }], { key: K1, uin: '100000001' });
    ok('未知关系词被拒', bad.skipped.length === 1 && bad.skipped[0].why === 'bad-relation-word', bad);

    const noEv = selfwrite.apply([{ kind: 'ties', value: '恋人' }], { key: K1, uin: '100000001', text: '在吗' });
    ok('没凭据不许升恋人', noEv.applied.length === 0 || noEv.applied[0].ok === false, noEv);

    const good = selfwrite.apply([{ kind: 'ties', value: '恋人' }], { key: K1, uin: '100000001', text: '我也喜欢你' });
    ok('对方明确表达后可升恋人', good.applied.length === 1 && good.applied[0].ok === true, good);
    ok('关系真的变成 lover', ties.load(K1, '100000001').type === 'lover', ties.load(K1, '100000001'));

    const other = selfwrite.apply([{ kind: 'ties', value: '恋人' }], { key: K2, uin: '100000002', text: '我喜欢你' });
    ok('唯一位被占时不抢（lover-taken）', other.skipped.some((x) => x.why === 'lover-taken'), other);
    ok('第二个人的关系没被改', (ties.load(K2, '100000002').type || 'stranger') !== 'lover', ties.load(K2, '100000002'));

    const back = selfwrite.apply([{ kind: 'ties', value: '陌生人' }], { key: K1, uin: '100000001' });
    ok('降档不需要凭据', back.applied.length === 1 && back.applied[0].ok === true, back);
  }

  // ============ 四、随手记与额度 ============
  {
    const r = selfwrite.apply([{ kind: 'note', value: '她下周三考试' }], { key: K1, uin: '100000001' });
    ok('随手记能落盘', r.applied.length === 1 && r.applied[0].ok === true, r);
    const notesFile = path.join(TMP, 'qqselfwrite_dir', 'notes.jsonl');
    ok('notes.jsonl 里有内容', fs.existsSync(notesFile) && fs.readFileSync(notesFile, 'utf8').includes('下周三考试'));
    const st = selfwrite.load(now);
    ok('状态里 notes 计数 +1', st.notes >= 1, st.notes);
    ok('状态里总写入计数增加', st.count >= 1, st.count);

    const cfg = selfwrite.loadCfg();
    const many = [];
    for (let i = 0; i < cfg.maxNotesPerDay + 3; i++) many.push({ kind: 'note', value: 'n' + i });
    const capped = selfwrite.apply(many, { key: K1, uin: '100000001' });
    ok('超出每日随手记额度会被拦', capped.skipped.some((x) => x.why === 'notes-cap'), capped.skipped.slice(0, 3));
  }

  // ============ 五、undo 回滚 ============
  {
    selfwrite.apply([{ kind: 'ties', value: '朋友' }], { key: K1, uin: '100000001', reason: 'ship-test' });
    const after = ties.load(K1, '100000001').type;
    const u = selfwrite.undo(now);
    ok('undo 能执行', u.ok === true, u);
    ok('undo 把关系改回上一档', ties.load(K1, '100000001').type !== after || after === 'stranger', { after, now: ties.load(K1, '100000001').type });
    ok('undo 后 recent 里少一条', !selfwrite.load(now).recent.some((x) => x.why === 'ship-test'));
  }

  // ============ 五之二、心情 / 印象 / 想做 ============
  {
    const a = selfwrite.parse('[[心情:今天有点累但挺好的]] [[印象:嘴硬心软]] [[想做:周末去看海]]');
    ok('心情能解析', a.writes.some((w) => w.kind === 'mood' && w.value === '今天有点累但挺好的'), a.writes);
    ok('印象能解析', a.writes.some((w) => w.kind === 'tag' && w.value === '嘴硬心软'), a.writes);
    ok('想做能解析', a.writes.some((w) => w.kind === 'want' && w.value === '周末去看海'), a.writes);
    ok('三类标记都从正文剥掉', a.text === '', JSON.stringify(a.text));

    const r = selfwrite.apply(a.writes, { key: K1, uin: '100000001' });
    ok('三种新写入都能落盘', r.applied.length === 3 && r.applied.every((x) => x.ok), r);
    const dir = path.join(TMP, 'qqselfwrite_dir');
    ok('mood.jsonl 有内容', fs.readFileSync(path.join(dir, 'mood.jsonl'), 'utf8').includes('有点累'));
    ok('tags.jsonl 有内容', fs.readFileSync(path.join(dir, 'tags.jsonl'), 'utf8').includes('嘴硬心软'));
    ok('wants.jsonl 有内容', fs.readFileSync(path.join(dir, 'wants.jsonl'), 'utf8').includes('看海'));
    const st = selfwrite.load(now);
    ok('状态按类型计数', st.byKind && st.byKind.mood >= 1 && st.byKind.tag >= 1 && st.byKind.want >= 1, st.byKind);

    const notes = selfwrite.selfNotes(K1, { max: 3 });
    ok('selfNotes 能读回来', notes.length === 3, notes);
    ok('selfNotes 带人话标签', notes.every((x) => x.label && x.text), notes);
    ok('selfNotes 只给这个会话的', selfwrite.selfNotes(K2, { max: 3 }).length === 0, selfwrite.selfNotes(K2, { max: 3 }));

    // 自己定的小规矩（pref）+ 想做的事读回
    const p = selfwrite.parse('[[偏好:跟这个人少开玩笑]]');
    ok('偏好能解析', p.writes.length === 1 && p.writes[0].kind === 'pref', p.writes);
    const pr = selfwrite.apply(p.writes, { key: K1, uin: '100000001' });
    ok('偏好能落盘', pr.applied.length === 1 && pr.applied[0].ok, pr);
    ok('prefs.jsonl 有内容', fs.readFileSync(path.join(dir, 'prefs.jsonl'), 'utf8').includes('少开玩笑'));
    const notes2 = selfwrite.selfNotes(K1, { max: 6 });
    ok('selfNotes 会带回小规矩', notes2.some((x) => String(x.label).includes('规矩')), notes2);
    const wf = selfwrite.wantsFor(K1, { max: 1, maxAgeDays: 30 });
    ok('wantsFor 能取到想做的事', wf.length === 1 && wf[0].text === '周末去看海', wf);
    ok('wantsFor 别的会话取不到', selfwrite.wantsFor(K2, { max: 1 }).length === 0);
  }

  // ============ 六、status ============
  {
    const s = selfwrite.status(now);
    ok('status 有计数与额度', typeof s.count === 'number' && s.caps && s.caps.dailyMax > 0, s);
    ok('status 带最近写入列表', Array.isArray(s.recent));
  }

  // ============ 七、handle 端到端（桩模型） ============
  {
    // auto-reply 在 require 时就把 qq.js 的 call 解构走了，所以要先把桩打上再 require 它
    const qq = require('./qq.js');
    const origCall = qq.call;
    qq.call = async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } });
    delete process.env.AUTOREPLY_DRY;   // 这一节要验证「真的写盘」，不能是演练模式
    const ar = require('./auto-reply.js');
    ar.loadCfg(true);
    const brain = require('./brain.js');
    const origThink = brain.think;
    // 注意：config/autoreply.test.json 的 private.allowList 是 100000001，
    // 假事件的 user_id 必须落在白名单里，否则 decide() 直接 skip，handle 里什么都不会发生。
    const U3 = 123456789;
    const K3 = 'p:' + U3;
    brain.think = async () => ({ reply: '好呀，那就这样', stickerKey: null, voice: false, skip: false, slow: false, fast: false, quote: false, writes: [{ kind: 'ties', value: '好朋友' }], model: 'stub', ms: 1 });
    const evt = {
      post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 0,
      user_id: U3, time: Math.floor(Date.now() / 1000), message_id: 990001,
      message: [{ type: 'text', data: { text: '那我们算好朋友了吧' } }], raw_message: '那我们算好朋友了吧'
    };
    await ar.handle(evt);
    await sleep(120);
    ok('handle 走完后关系真的变了', ties.load(K3, String(U3)).type === 'close', ties.load(K3, String(U3)));
    const logTxt = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
    ok('日志里有 selfwrite', logTxt.includes('"selfwrite"'));
    ok('日志里记了写入结果', /selfwrite.*close/.test(logTxt) || logTxt.includes('ties:close'), logTxt.split(String.fromCharCode(10)).filter((x) => x.includes('selfwrite')).slice(-2));
    ok('发出去的话里没有标记', !logTxt.includes('[[关系'));

    // dry 演练：状态不变，只审计
    const K4 = K3;
    const before4 = ties.load(K4, String(U3)).type;
    const evt2 = { ...evt, user_id: U3, message_id: 990002, message: [{ type: 'text', data: { text: '我们做朋友吧' } }], raw_message: '我们做朋友吧' };
    process.env.AUTOREPLY_DRY = '1';   // 第二次走演练：只审计不落盘
    brain.think = async () => ({ reply: '行', writes: [{ kind: 'ties', value: '朋友' }], model: 'stub', ms: 1 });
    await ar.handle(evt2);
    await sleep(120);
    ok('dry 演练不改真实关系', ties.load(K4, String(U3)).type === before4, ties.load(K4, String(U3)).type);
    brain.think = origThink;
    qq.call = origCall;
  }

  console.log('test-selfwrite: ' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('test-selfwrite 崩了: ' + (e && e.stack || e)); process.exit(1); });
