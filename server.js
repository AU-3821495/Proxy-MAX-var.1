import express from 'express';
import morgan from 'morgan';
import { request } from 'undici';
import { URL } from 'url';
import httpProxy from 'http-proxy';
import cheerio from 'cheerio';

const app = express();
const proxy = httpProxy.createProxyServer({ changeOrigin: true });

// ポート番号を固定
const PORT = 1837;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

// ランディング UI
app.get('/', (req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>Web Proxy — Lightweight & Fast</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body{font-family:system-ui; background:#0f172a; color:#e5e7eb; margin:0;}
  .wrap{max-width:880px; margin:40px auto; padding:0 16px;}
  .card{background:#111827; border-radius:12px; padding:24px;}
  h1{margin:0 0 8px; font-size:28px;}
  p{margin:8px 0 16px; color:#9ca3af;}
  .row{display:flex; gap:8px; margin:12px 0 20px;}
  input{flex:1; padding:12px; border-radius:10px; border:1px solid #334155; background:#0b1220; color:#e5e7eb;}
  button{padding:12px 18px; border-radius:10px; background:#3b82f6; color:white; cursor:pointer;}
  iframe{width:100%; height:72vh; border:1px solid #374151; border-radius:12px; margin-top:16px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>どこでも自由にブラウジング</h1>
    <p>職場・制限サイト、動画配信、ライブ配信に対応した軽量Webプロキシ</p>
    <div class="row">
      <input id="u" type="text" placeholder="URLを入力（例: https://youtube.com）" />
      <button id="go">アクセス</button>
    </div>
    <iframe id="f" src="about:blank"></iframe>
  </div>
</div>
<script>
  const input = document.getElementById('u');
  const frame = document.getElementById('f');
  document.getElementById('go').onclick = () => {
    const v = input.value.trim();
    if (!v) return;
    const u = v.startsWith('http') ? v : 'https://' + v;
    frame.src = '/proxy/' + encodeURIComponent(u);
  };
</script>
</body>
</html>
  `);
});

// ロギング
app.use(morgan('tiny'));

// CORS ヘッダー
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', '*, Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ターゲット URL 構築
function buildTarget(req) {
  const raw = decodeURIComponent(req.path.replace(/^\/proxy\//, ''));
  try {
    return new URL(raw);
  } catch {
    try {
      return new URL('https://' + raw);
    } catch {
      return null;
    }
  }
}

// セキュリティ緩和
function relaxSecurityHeaders(headers) {
  const h = { ...headers };
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'x-frame-options') delete h[k];
  }
  const cspKey = Object.keys(h).find(k => k.toLowerCase() === 'content-security-policy');
  if (cspKey) {
    const relaxed = h[cspKey]
      .split(';')
      .map(s => s.trim())
      .filter(s => !s.toLowerCase().startsWith('frame-ancestors'))
      .join('; ');
    h[cspKey] = relaxed;
  }
  h['Accept-Ranges'] = h['Accept-Ranges'] || 'bytes';
  return h;
}

// HTML リライト
function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const base = new URL(baseUrl);

  const rewriteAttr = (el, attr) => {
    const v = $(el).attr(attr);
    if (!v) return;
    try {
      const u = new URL(v, base);
      $(el).attr(attr, '/proxy/' + encodeURIComponent(u.toString()));
    } catch {}
  };

  $('a[href],link[href],script[src],img[src],source[src],video[src],audio[src],[poster]')
    .each((_, el) => {
      const attrs = ['href','src','poster'];
      attrs.forEach(attr => rewriteAttr(el, attr));
    });

  $('style').each((_, el) => {
    const css = $(el).html();
    const rewritten = css.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, url) => {
      try {
        const u = new URL(url, base);
        return `url(${q}/proxy/${encodeURIComponent(u.toString())}${q})`;
      } catch {
        return m;
      }
    });
    $(el).html(rewritten);
  });

  $('head').append(`<base href="/proxy/${encodeURIComponent(base.toString())}">`);
  return $.html();
}

// プロキシ処理
app.use('/proxy', async (req, res) => {
  const target = buildTarget(req);
  if (!target) return res.status(400).send('Invalid target URL');

  const forwardHeaders = { ...req.headers, host: target.host, origin: `${target.protocol}//${target.host}` };
  try {
    const { statusCode, headers, body } = await request(target.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: ['GET','HEAD'].includes(req.method) ? undefined : req,
      maxRedirections: 2
    });

    const safeHeaders = relaxSecurityHeaders(headers);
    for (const [k,v] of Object.entries(safeHeaders)) res.setHeader(k,v);

    res.status(statusCode);
    const ct = (headers['content-type'] || '').toLowerCase();

    if (ct.startsWith('text/html')) {
      let chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      const html = Buffer.concat(chunks).toString('utf8');
      const rewritten = rewriteHtml(html, target.toString());
      res.removeHeader('Content-Length');
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.send(rewritten);
    } else {
      body.pipe(res);
    }
  } catch (err) {
    console.error(err);
    res.status(502).send('Upstream error');
  }
});

// ヘルスチェック
app.get('/healthz', (_req,res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
});
