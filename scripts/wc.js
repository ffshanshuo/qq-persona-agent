const crypto = require('crypto');
const TOKEN = process.argv[2] || '10b2cada41e9';
const BASE = 'http://127.0.0.1:6099';
const hash = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex');
function clean(p) { return String(p).replace(/^[/]+/, ''); }
(async () => {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash })
  });
  const j = await r.json();
  if (!j.data || !j.data.Credential) { console.log('LOGIN FAIL', JSON.stringify(j)); return; }
  const cred = j.data.Credential;
  console.log('LOGIN OK');
  for (const c of process.argv.slice(3)) {
    const parts = c.split('::');
    const path = clean(parts[0]);
    const res = await fetch(BASE + '/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cred },
      body: parts[1] || '{}'
    });
    const txt = await res.text();
    console.log('== ' + path + ' ==\n' + txt.slice(0, 900));
  }
})();
