const crypto = require('crypto');
const fs = require('fs');
const TOKEN = '10b2cada41e9';
const WEBUI_TOKEN = process.env.OB11_TOKEN || crypto.randomBytes(16).toString('hex');
const hash = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex');
const BASE = 'http://127.0.0.1:6099';
const auth = c => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + c });
(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash }) })).json();
  const cred = login.data.Credential;
  const cur = await (await fetch(BASE + '/api/OB11Config/GetConfig', { method: 'POST', headers: auth(cred), body: '{}' })).json();
  const cfg = typeof cur.data === 'string' ? JSON.parse(cur.data) : cur.data;
  cfg.network = cfg.network || {};
  cfg.network.httpServers = [{
    name: 'dsh-http', enable: true, host: '127.0.0.1', port: 3000,
    enableCors: true, enableWebsocket: false, messagePostFormat: 'array',
    token: WEBUI_TOKEN, debug: false, reportSelfMessage: true
  }];
  cfg.network.httpSseServers = cfg.network.httpSseServers || [];
  cfg.network.httpClients = cfg.network.httpClients || [];
  cfg.network.websocketServers = cfg.network.websocketServers || [];
  cfg.network.websocketClients = cfg.network.websocketClients || [];
  cfg.network.plugins = cfg.network.plugins || [];
  const res = await (await fetch(BASE + '/api/OB11Config/SetConfig', { method: 'POST', headers: auth(cred), body: JSON.stringify({ config: JSON.stringify(cfg, null, 2) }) })).json();
  console.log('SET:', JSON.stringify(res));
  if (res.code === 0) {
    fs.writeFileSync('scripts/ob11.token', WEBUI_TOKEN, { mode: 0o600 });
    console.log('OB11 http server -> 127.0.0.1:3000 token written to scripts/ob11.token');
  }
})();
