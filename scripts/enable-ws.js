const crypto = require('crypto');
const fs = require('fs');
const TOKEN = '10b2cada41e9';
const hash = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex');
const BASE = 'http://127.0.0.1:6099';
const auth = c => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + c });
(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash }) })).json();
  const cred = login.data.Credential;
  const cur = await (await fetch(BASE + '/api/OB11Config/GetConfig', { method: 'POST', headers: auth(cred), body: '{}' })).json();
  const cfg = typeof cur.data === 'string' ? JSON.parse(cur.data) : cur.data;
  const token = fs.readFileSync('scripts/ob11.token', 'utf8').trim();
  cfg.network = cfg.network || {};
  cfg.network.websocketServers = [{
    name: 'dsh-ws', enable: true, host: '127.0.0.1', port: 3001,
    messagePostFormat: 'array', reportSelfMessage: true,
    token, debug: false, enableForcePushEvent: true, heartInterval: 30000
  }];
  const res = await (await fetch(BASE + '/api/OB11Config/SetConfig', { method: 'POST', headers: auth(cred), body: JSON.stringify({ config: JSON.stringify(cfg, null, 2) }) })).json();
  console.log('SET:', JSON.stringify(res));
})();
