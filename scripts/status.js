const fs = require('fs');
const path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, 'ob11.token'), 'utf8').trim();
const BASE = 'http://127.0.0.1:3000';
const call = async (a, p = {}) => {
  const r = await fetch(BASE + '/' + a, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(p)
  });
  return r.json();
};
(async () => {
  try {
    const s = await call('get_status');
    const me = await call('get_login_info');
    const gl = await call('get_group_list');
    console.log(`[status] online=${s.data.online} uin=${me.data.user_id} nick=${me.data.nickname} groups=${(gl.data || []).length}`);
  } catch (e) {
    console.log('[status] 未连接：' + e.message);
    process.exit(2);
  }
})();
