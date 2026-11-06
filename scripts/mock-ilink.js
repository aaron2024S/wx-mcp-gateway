// 本地假 iLink 网关：只用于开发时看界面、验证绑定流程，不参与生产。
// 三秒后自动"确认扫码"，方便看从「等待扫码」到「在线」的整段状态变化。
import http from 'node:http';

const PORT = Number(process.env.MOCK_ILINK_PORT || 7788);
let polls = 0;
const sends = [];

const server = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const json = (o) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };

    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      const code = 'QR-' + Date.now();
      console.log('二维码已发出');
      return json({
        qrcode: code,
        qrcode_img_content: `https://login.weixin.qq.com/l/${code}`,
      });
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      polls++;
      // 前 6 次都保持"等待"，留出看界面的时间；第 7 次才确认（约 18 秒）
      if (polls % 7 !== 0) return json({ status: 'wait' });
      console.log('模拟扫码确认');
      return json({
        status: 'confirmed',
        bot_token: 'MOCK-BOT-TOKEN',
        baseurl: `http://127.0.0.1:${PORT}`,
        ilink_bot_id: 'bot_mock_01',
      });
    }
    if (url.pathname === '/ilink/bot/msg/notifystart') return json({ ret: 0 });
    if (url.pathname === '/ilink/bot/msg/notifystop') return json({ ret: 0 });
    if (url.pathname === '/ilink/bot/getupdates') {
      return setTimeout(() => json({ ret: 0, get_updates_buf: 'BUF-' + Date.now(), msgs: [] }), 400);
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      sends.push(JSON.parse(buf).msg);
      console.log('发送消息：', JSON.parse(buf).msg?.item_list?.[0]?.text_item?.text?.slice(0, 40));
      return json({ ret: 0 });
    }
    res.writeHead(404).end('{}');
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock ilink on http://127.0.0.1:${PORT}`));
