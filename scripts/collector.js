// 采集 NapCat WS 事件 → logs/inbox.jsonl（后台常驻，自动重连）
const fs = require('fs');
const path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, 'ob11.token'), 'utf8').trim();
const OUT = path.join(__dirname, '..', 'logs', 'inbox.jsonl');
const URL = `ws://127.0.0.1:3001/?access_token=${encodeURIComponent(TOKEN)}`;
function log(o) { fs.appendFileSync(OUT, JSON.stringify(o) + '\n'); }
function connect() {
  const ws = new WebSocket(URL);
  ws.onopen = () => console.log(new Date().toISOString(), 'ws connected');
  ws.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.post_type === 'message' || d.post_type === 'message_sent' || d.post_type === 'notice') {
        log({ t: Date.now(), type: d.post_type, msg_type: d.message_type, user: d.user_id, group: d.group_id, nick: d.sender?.nickname, raw: d.raw_message, message: d.message, self: d.self_id });
        console.log(new Date().toISOString(), d.post_type, d.message_type, d.user_id, String(d.raw_message || '').slice(0, 80));
      }
    } catch (e) { }
  };
  ws.onclose = () => { console.log(new Date().toISOString(), 'ws closed, retry in 5s'); setTimeout(connect, 5000); };
  ws.onerror = () => { try { ws.close(); } catch (e) { } };
}
connect();
