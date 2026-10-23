#!/usr/bin/env node
// 列出自己空间说说（走 QZone 旧版 feed 接口，用 get_cookies 拿到的 cookies + bkn）
// 用法: node scripts/qzone-feed.js [条数]
const { call } = require('./qq.js');

(async () => {
  const num = Number(process.argv[2] || 5);
  const d = (await call('get_cookies', { domain: 'qzone.qq.com' })).data || {};
  const bkn = d.bkn || (() => {
    const p = ((d.cookies || '').match(/p_skey=([^;]+)/) || [])[1] || '';
    let h = 5381;
    for (const ch of p) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    return h & 0x7fffffff;
  })();
  const url =
    'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6' +
    `?uin=123456789&ftype=0&sort=0&pos=0&num=${num}&g_tk=${bkn}&format=json&inCharset=utf-8&outCharset=utf-8`;
  const t = await (await fetch(url, { headers: { Cookie: d.cookies, Referer: 'https://user.qzone.qq.com/123456789' } })).text();
  let j;
  try {
    j = JSON.parse(t.replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, ''));
  } catch (e) {
    console.log('原始返回：', t.slice(0, 400));
    process.exit(1);
  }
  if (j.code !== 0) {
    console.log('接口失败:', JSON.stringify(j).slice(0, 300));
    process.exit(1);
  }
  console.log('total =', j.total);
  for (const m of j.msglist || []) {
    console.log(JSON.stringify({
      tid: m.tid,
      time: m.createTime,
      content: (m.content || '').slice(0, 80),
      pics: (m.pic || []).length,
      comments: m.cmtnum,
      likes: m.likenum
    }));
  }
})();
