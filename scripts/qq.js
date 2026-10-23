#!/usr/bin/env node
// NapCat OneBot11 CLI (DSH 接入层)
// 用法:
//   node scripts/qq.js <action> ['<json params>']      直接调任意 OneBot action
//   node scripts/qq.js send <user_id|group:gid> <文本>    发私聊/群消息
//   node scripts/qq.js moments <文本> [ugc_right]        发空间说说(默认1=所有人, 64=仅自己)
//   node scripts/qq.js moments-del <tid>                 删除说说
//   node scripts/qq.js profile [json]                    查/改资料(nickname/personal_note/sex)
//   node scripts/qq.js sign <签名>                        改个性签名
//   node scripts/qq.js avatar <文件路径|URL|base64>        改头像
//   node scripts/qq.js me                                自己的账号信息
//   node scripts/qq.js friends | groups | recent          好友/群/最近会话
const fs = require('fs');
const path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, 'ob11.token'), 'utf8').trim();
const BASE = process.env.OB11_BASE || 'http://127.0.0.1:3000';

async function call(action, params = {}) {
  const r = await fetch(BASE + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(params),
    // 没有超时的请求一旦挂住，会把「正在输入」永远挂在对方屏幕上，也会堵死发送队列
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(Number(process.env.OB11_TIMEOUT_MS) || 5000) : undefined
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { status: 'raw', raw: t }; }
}
function out(o) { console.log(JSON.stringify(o, null, 2)); }

module.exports = { call };

if (require.main === module) {
  const [cmd, a1, a2] = process.argv.slice(2);
  (async () => {
    if (!cmd) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).join('\n')); return; }
    switch (cmd) {
      case 'send': {
        const target = String(a1 || '');
        const msg = process.argv.slice(4).join(' ') || a2 || '';
        if (!target || !msg) return out({ error: 'need target and text' });
        const r = target.startsWith('group:')
          ? await call('send_group_msg', { group_id: Number(target.slice(6)), message: msg })
          : await call('send_private_msg', { user_id: Number(target), message: msg });
        return out(r);
      }
      case 'moments': {
        const right = Number(a2 || 1);
        return out(await call('send_qzone_msg', { content: a1 || '', images: [], ugc_right: right }));
      }
      case 'moments-del': return out(await call('delete_qzone_msg', { tid: a1 }));
      case 'profile': {
        if (a1) return out(await call('set_qq_profile', JSON.parse(a1)));
        return out(await call('get_stranger_info', { user_id: (await call('get_login_info')).data.user_id }));
      }
      case 'sign': return out(await call('set_self_longnick', { longNick: a1 || '' }));
      case 'avatar': return out(await call('set_qq_avatar', { file: a1 }));
      case 'me': return out(await call('get_login_info'));
      case 'friends':
        return out((((await call('get_friend_list')).data) || []).map(f => ({ uin: f.user_id, name: f.remark || f.nickname })));
      case 'groups':
        return out((((await call('get_group_list')).data) || []).map(g => ({ gid: g.group_id, name: g.group_name })));
      case 'recent': return out(await call('get_recent_contact', {}));
      case 'inbox': {
        const n = Number(a1 || 10);
        const f = path.join(__dirname, '..', 'logs', 'inbox.jsonl');
        if (!fs.existsSync(f)) return console.log('(无消息记录)');
        const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
        for (const l of lines) {
          try {
            const j = JSON.parse(l);
            const who = j.msg_type === 'group' ? `群${j.group}/${j.user}` : `${j.user}`;
            const t = new Date(j.t).toLocaleString('zh-CN', { hour12: false });
            console.log(`${t} [${j.type === 'message_sent' ? '发出' : '收到'}] ${who} ${j.nick || ''}: ${j.raw}`);
          } catch { console.log(l.slice(0, 120)); }
        }
        return;
      }
      default: {
        const params = a1 ? JSON.parse(a1) : {};
        return out(await call(cmd, params));
      }
    }
  })().catch(e => console.error('ERR', e.message));
}
