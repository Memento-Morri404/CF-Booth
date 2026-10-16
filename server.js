#!/usr/bin/env node
/* Card Fair Booth — self-hosted server. No dependencies: needs only Node 18+.
 *
 *   BOOTH_PASSWORD=your-password node server.js
 *
 *   /            public storefront (what the QR code opens)
 *   /booth       your register, behind the password
 *   /storefront.json   the public in-stock list (no costs, notes or sales)
 *
 * Data lives in ./data as plain JSON files, with a daily backup copy.
 * Options (environment variables, or lines in a .env file next to this one):
 *   BOOTH_PASSWORD           required. The password for /booth.
 *   PORT                     default 8080
 *   HOST                     default 0.0.0.0 (reachable on your network)
 *   DATA_DIR                 default ./data
 *   SECURE_COOKIE            1 forces secure cookies (automatic behind https)
 *   CLOUDFLARE_TUNNEL_TOKEN  starts a Cloudflare Tunnel with the server
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
/* .env file: KEY=value lines, so you don't have to type them each time */
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.BOOTH_PASSWORD || '';
const FORCE_SECURE = process.env.SECURE_COOKIE === '1';
const viaHttps = req => FORCE_SECURE || req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');
const TYPES = ['items', 'events', 'sales', 'receipts', 'meta'];

if (!PASSWORD || PASSWORD.length < 6) {
  console.error('\n  Set a password first (6+ characters). Either run:\n\n    BOOTH_PASSWORD=choose-a-password node server.js\n\n  or put this line in a file named .env next to server.js:\n\n    BOOTH_PASSWORD=choose-a-password\n');
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });
const tcgplayer = require('./tcgplayer.js')(DATA);
const tcg = require('./tcg.js')(DATA, tcgplayer);
const pc = require('./pricecharting.js')(DATA);
const jt = require('./justtcg.js')(DATA);

/* ---------- storage: one JSON file, written atomically ---------- */
const DB_FILE = path.join(DATA, 'booth.json');
const SHOP_FILE = path.join(DATA, 'storefront.json');
const PHOTOS = path.join(DATA, 'photos');   // product photos you upload
// which build of the booth page this server started with; the page warns when they differ (server not restarted after an update)
const BUILD = (() => { try { return (/CF_BUILD = "(\w+)"/.exec(fs.readFileSync(path.join(PUBLIC, 'booth.html'), 'utf8')) || [])[1] || ''; } catch { return ''; } })();
const SECRET_FILE = path.join(DATA, '.secret');
let db = { seq: 0, recs: {} };          // recs[type][id] = { r: record, s: seq }
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
for (const t of TYPES) db.recs[t] = db.recs[t] || {};
let secret;
try { secret = fs.readFileSync(SECRET_FILE, 'utf8'); } catch { secret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 }); }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
    const day = new Date().toISOString().slice(0, 10);
    const bk = path.join(DATA, 'backups', `booth-${day}.json`);
    if (!fs.existsSync(bk)) fs.copyFileSync(DB_FILE, bk);
  }, 250);
}
function writeAtomic(file, text) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }

/* ---------- login: password → signed cookie, slow down guessing ---------- */
const SESSION_DAYS = 30;
function sign(v) { return crypto.createHmac('sha256', secret + PASSWORD).update(v).digest('base64url'); }
function makeSession() { const exp = Date.now() + SESSION_DAYS * 864e5; const v = 'v1.' + exp; return v + '.' + sign(v); }
function validSession(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf('.'); if (i < 0) return false;
  const v = tok.slice(0, i), sig = tok.slice(i + 1), good = sign(v);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return +v.split('.')[1] > Date.now();
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
const authed = req => validSession(cookies(req).cf_session);
const tries = new Map();
function tooMany(ip) { const t = tries.get(ip) || { n: 0, at: 0 }; if (Date.now() - t.at > 15 * 60e3) { t.n = 0; } return t.n >= 10; }
function failed(ip) { const t = tries.get(ip) || { n: 0, at: 0 }; if (Date.now() - t.at > 15 * 60e3) t.n = 0; t.n++; t.at = Date.now(); tries.set(ip, t); }
function samePassword(p) { const a = crypto.createHash('sha256').update(String(p)).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest(); return crypto.timingSafeEqual(a, b); }

/* ---------- helpers ---------- */
const MIME = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.webmanifest': 'application/manifest+json', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };
function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(body);
}
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), MIME['.json'], extra);
function serveFile(res, file, { cache = 'no-cache' } = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache, ...SEC_HEADERS });
    res.end(buf);
  });
}
function readBuf(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 'big' })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/* What kind of picture the bytes are, by their first bytes (not the file name). */
function pictureKind(b) {
  if (b.length < 12) return '';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.slice(0, 4).toString('hex') === '89504e47') return 'png';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (b.slice(0, 4).toString() === 'GIF8') return 'gif';
  if (b.slice(4, 8).toString() === 'ftyp') { const brand = b.slice(8, 12).toString(); return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand) ? 'heic' : /^avi[fs]$/.test(brand) ? 'avif' : ''; }
  return '';
}
/* iPhone photos (HEIC) to JPEG with whatever this computer has: sips on a Mac, ImageMagick or libheif elsewhere. */
function heicToJpeg(buf) {
  const { execFile } = require('child_process'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpic-')), src = path.join(dir, 'in.heic'), out = path.join(dir, 'out.jpg');
  fs.writeFileSync(src, buf);
  const tries = process.platform === 'darwin' ? [['sips', ['-s', 'format', 'jpeg', '-Z', '1600', src, '--out', out]]] : [];
  tries.push(['magick', [src, '-resize', '1600x1600>', '-quality', '85', out]], ['convert', [src, '-resize', '1600x1600>', '-quality', '85', out]], ['heif-convert', [src, out]]);
  const run = i => new Promise(res => {
    if (i >= tries.length) return res(null);
    execFile(tries[i][0], tries[i][1], { timeout: 20000 }, err => { if (!err && fs.existsSync(out)) return res(fs.readFileSync(out)); run(i + 1).then(res); });
  });
  return run(0).finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
}
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function clientIp(req) { return req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || ''; }

/* The public list carries only shopper fields. Anything else is dropped here
   too, so a mistake in the browser can never publish private data. */
const SHOP_ITEM_KEYS = ['i', 'n', 'k', 's', 'no', 'r', 'lg', 'f', 'e', 'g', 'c', 'st', 'ca', 'va', 'mk', 'p', 'q', 't', 'im', 'iu', 'ia', 'lo', 'la', 'd', 'dc', 'di', 'gp', 'ph', 'ds', 'ms'];
const PHOTO_URL_RE = /^\/photos\/[\w-]{6,40}\.(jpg|png|webp|gif)$/;
const IMG_URL_RE = /^https:\/\/(images\.pokemontcg\.io|assets\.tcgdex\.net|product-images\.tcgplayer\.com|tcgplayer-cdn\.tcgplayer\.com)\/[\w\-./%]+$/;
function cleanStorefront(s) {
  const str = v => typeof v === 'string' ? v.slice(0, 200) : '';
  const num = v => Number.isFinite(v) ? v : 0;
  const items = Array.isArray(s && s.items) ? s.items.filter(x => x && num(x.q) > 0 && Number.isFinite(x.p)).slice(0, 20000).map(x => {
    const o = {}; for (const k of SHOP_ITEM_KEYS) o[k] = ['p', 'q', 't'].includes(k) ? num(x[k]) : str(x[k]);
    if (o.im && !/^https:\/\/assets\.tcgdex\.net\/[\w\-./]+$/.test(o.im)) o.im = '';
    if (o.iu && !IMG_URL_RE.test(o.iu)) o.iu = '';
    if (o.ia && !IMG_URL_RE.test(o.ia)) o.ia = '';
    if (o.ph && !PHOTO_URL_RE.test(o.ph)) o.ph = '';
    o.gp = o.gp.replace(/[^\w-]/g, '').slice(0, 24); o.ds = o.ds.slice(0, 200);
    o.lo = o.lo.slice(0, 60); o.la = o.lo && o.la === '1' ? '1' : '';
    if (o.dc && !/^#[0-9a-f]{6}$/i.test(o.dc)) o.dc = '';
    if (o.di && !/^#[0-9a-f]{6}$/i.test(o.di)) o.di = '';
    return o;
  }) : [];
  const show = s && s.show || {};
  const bins = Array.isArray(s && s.bins) ? s.bins.slice(0, 24).map(b => ({ l: str(b.l), h: str(b.h), s: str(b.s), c: /^#[0-9a-f]{6}$/i.test(b.c) ? b.c : '#FE6C04', ink: /^#[0-9a-f]{6}$/i.test(b.ink) ? b.ink : '#ffffff' })) : [];
  const locs = Array.isArray(s && s.locs) ? s.locs.slice(0, 80).map(l => ({ n: str(l.n).slice(0, 60), a: l.a ? 1 : 0, t: ['binder', 'case', 'box', 'other'].includes(l.t) ? l.t : 'binder' })).filter(l => l.n) : [];
  return { v: 1, at: Date.now(), show: { name: str(show.name), table: str(show.table), venue: str(show.venue) }, bins, locs, items };
}

/* ---------- pages ---------- */
function loginPage(msg = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Card Fair Booth · Sign in</title>
<link rel="icon" href="/icon.svg"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@600;800;900&display=swap">
<style>
*{box-sizing:border-box}html,body{height:100%}body{margin:0;font:600 15px/1.4 Figtree,system-ui,sans-serif;color:#141519;background:#32AAFF;display:grid;grid-template-columns:minmax(0,1fr);align-content:center;justify-items:center;gap:22px;padding:20px;position:relative;overflow:hidden}
.logo{position:relative;width:min(260px,70%);height:auto;display:block}
svg.tiles{position:fixed;inset:0;width:100%;height:100%}
form{position:relative;width:min(380px,calc(100% - 6px));grid-template-columns:minmax(0,1fr);background:#fff;border:2px solid #151515;border-radius:18px;box-shadow:6px 6px 0 #151515;padding:26px 24px 24px;display:grid;gap:14px}
h1{margin:0;font-size:26px;font-weight:900;letter-spacing:-.03em}p{margin:0;color:#4F5868;font-weight:600}
label{display:grid;gap:6px;font-size:13px;color:#4F5868}
input{width:100%;min-width:0;height:48px;border-radius:11px;border:2px solid #151515;padding:0 14px;font:800 18px Figtree,system-ui,sans-serif}
input:focus{outline:none;box-shadow:0 0 0 4px rgba(50,170,255,.35)}
button{height:50px;border-radius:12px;border:2px solid #151515;box-shadow:3px 3px 0 #151515;background:#32AAFF;color:#fff;font:900 17px Figtree,system-ui,sans-serif;cursor:pointer}
button:active{transform:translate(2px,2px);box-shadow:none}.err{color:#B8222A;font-weight:800}
</style></head><body>
<svg class="tiles" aria-hidden="true"><defs><pattern id="t" width="64" height="82" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)"><rect x="7" y="7" width="50" height="68" rx="9" fill="#fff" fill-opacity=".08" stroke="#fff" stroke-opacity=".2" stroke-width="2"/><rect x="15" y="15" width="34" height="24" rx="4" fill="#fff" fill-opacity=".1"/></pattern></defs><rect width="100%" height="100%" fill="url(#t)"/></svg>
<img class="logo" src="/logo.svg" alt="Card Fair">
<form method="post" action="/login">
<h1>Card Fair Booth</h1><p>Sign in to open your register.</p>
${msg ? `<p class="err">${msg}</p>` : ''}
<label>Password<input type="password" name="password" autocomplete="current-password" autofocus required></label>
<button type="submit">Open the booth</button>
</form></body></html>`;
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // public storefront
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (req.method === 'GET' && p === '/storefront.json') {
      if (!fs.existsSync(SHOP_FILE)) return json(res, 200, { v: 1, at: 0, show: {}, bins: [], items: [] });
      return serveFile(res, SHOP_FILE);
    }
    if (req.method === 'GET' && ['/icon.svg', '/logo.svg', '/manifest.webmanifest', '/sw.js'].includes(p)) return serveFile(res, path.join(PUBLIC, p.slice(1)));
    // your own product photos (stickers, accessories, art): public, so the storefront can show them
    if (req.method === 'GET' && PHOTO_URL_RE.test(p)) return serveFile(res, path.join(PHOTOS, path.basename(p)), { cache: 'public, max-age=31536000, immutable' });

    // login
    if (p === '/login' && req.method === 'GET') return send(res, 200, loginPage(), MIME['.html']);
    if (p === '/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (tooMany(ip)) return send(res, 429, loginPage('Too many tries. Wait 15 minutes and try again.'), MIME['.html']);
      const body = new URLSearchParams(await readBody(req, 10000));
      if (!samePassword(body.get('password') || '')) { failed(ip); await new Promise(r => setTimeout(r, 600)); return send(res, 401, loginPage('That password isn’t right.'), MIME['.html']); }
      tries.delete(ip);
      return send(res, 303, '', 'text/plain', { Location: '/booth', 'Set-Cookie': `cf_session=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${viaHttps(req) ? '; Secure' : ''}` });
    }
    if (p === '/logout') return send(res, 303, '', 'text/plain', { Location: '/login', 'Set-Cookie': 'cf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });

    // everything below needs the password
    if (!authed(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'signed_out' });
      if (p === '/booth' || p === '/booth/' || p === '/booth.html') return send(res, 303, '', 'text/plain', { Location: '/login' });
      return send(res, 404, 'Not found');
    }
    if (req.method === 'GET' && (p === '/booth' || p === '/booth/' || p === '/booth.html')) return serveFile(res, path.join(PUBLIC, 'booth.html'));

    if (p === '/api/ping') return json(res, 200, { ok: true, seq: db.seq, pricecharting: pc.enabled, justtcg: jt.enabled, build: BUILD });
    if (p === '/api/photos' && req.method === 'POST') {   // the picture's bytes (or { data: 'data:image/…;base64,…' }) → { url: '/photos/abc.jpg' }
      let buf;
      try { buf = await readBuf(req, 30 * 1024 * 1024); }
      catch (e) { return json(res, 413, { error: 'That picture is over 30 MB.' }); }
      if (/json/.test(req.headers['content-type'] || '')) {
        let b; try { b = JSON.parse(buf.toString('utf8')); } catch { return json(res, 400, { error: 'That picture didn’t come through. Try again.' }); }
        const m = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(b && b.data || ''));
        buf = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0);
      }
      let kind = pictureKind(buf);
      if (kind === 'heic' || kind === 'avif') {
        const jpg = await heicToJpeg(buf);
        if (!jpg) return json(res, 415, { error: process.platform === 'win32' ? 'iPhone photos (HEIC) can’t be read on this computer. On the iPhone, set Settings → Camera → Formats → Most Compatible, or open the photo and save it as JPEG.' : 'This computer can’t convert iPhone photos (HEIC). Save the photo as JPEG and try again.' });
        buf = jpg; kind = 'jpg';
      }
      if (!kind) return json(res, 415, { error: 'That file isn’t a picture we can use. Use JPEG, PNG, WebP or an iPhone photo.' });
      // restoring a backup keeps each photo's name, so items still point at it
      const want = String(req.headers['x-photo-name'] || ''), keep = PHOTO_URL_RE.test('/photos/' + want) && want.endsWith('.' + kind) && !fs.existsSync(path.join(PHOTOS, want));
      const name = keep ? want : crypto.randomBytes(9).toString('hex') + '.' + kind;
      try { fs.mkdirSync(PHOTOS, { recursive: true }); fs.writeFileSync(path.join(PHOTOS, name), buf); }
      catch (e) { return json(res, 500, { error: 'Couldn’t save the picture: ' + (e.code === 'ENOSPC' ? 'the disk is full.' : e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission to write to the data/photos folder.' : e.message) }); }
      return json(res, 200, { url: '/photos/' + name });
    }
    if (p === '/api/cond' && req.method === 'GET') {   // prices by condition for one TCGplayer product
      if (!jt.enabled) return json(res, 404, { error: 'off' });
      try { return json(res, 200, { result: await jt.byProduct(url.searchParams.get('tcgplayer') || '') }); }
      catch (e) { return json(res, 200, { result: null, error: e.message }); }
    }
    if (p === '/api/pc/price' && req.method === 'GET') {
      if (!pc.enabled) return json(res, 404, { error: 'off' });
      return json(res, 200, { result: await pc.price(url.searchParams.get('q') || '') });
    }
    if (p === '/api/records' && req.method === 'GET') {
      const since = +url.searchParams.get('since') || 0;
      const out = {};
      for (const t of TYPES) for (const id in db.recs[t]) { const e = db.recs[t][id]; if (e.s > since) (out[t] = out[t] || []).push(e.r); }
      return json(res, 200, { seq: db.seq, recs: out });
    }
    if (p === '/api/records' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      let n = 0;
      for (const t of TYPES) for (const r of (body[t] || [])) {
        if (!r || typeof r.id !== 'string' || r.id.length > 80) continue;
        const cur = db.recs[t][r.id];
        // events never change; everything else is last-writer-wins by updatedAt
        if (cur && (t === 'events' || (cur.r.updatedAt || 0) >= (r.updatedAt || 0))) continue;
        db.recs[t][r.id] = { r, s: ++db.seq }; n++;
      }
      if (n) save();
      return json(res, 200, { ok: true, seq: db.seq, applied: n });
    }
    if (p === '/api/storefront' && req.method === 'POST') {
      const clean = cleanStorefront(JSON.parse(await readBody(req, 8 * 1024 * 1024)));
      writeAtomic(SHOP_FILE, JSON.stringify(clean));
      return json(res, 200, { ok: true, at: clean.at, items: clean.items.length });
    }
    /* card lookup and market prices (TCGdex) */
    if (p === '/api/tcg/status' && req.method === 'GET') {   // where prices come from, and whether each source is working
      return json(res, 200, { tcgdex: tcg.health(), tcgplayer: process.env.TCGPLAYER_PRICES === 'off' ? { off: true } : tcgplayer.status(), justtcg: jt.enabled, pricecharting: pc.enabled });
    }
    if (p === '/api/tcg/search' && req.method === 'GET') {
      const cards = await tcg.search(url.searchParams.get('lang') || 'en', url.searchParams.get('q') || '', { set: (url.searchParams.get('set') || '').slice(0, 40) });
      return json(res, 200, { cards });
    }
    if (p === '/api/setvalue' && req.method === 'GET') return json(res, 200, { sets: tcgplayer.setValue(url.searchParams.get('q') || '', { japanese: url.searchParams.get('lang') === 'ja' }) });
    if (p === '/api/sealed' && req.method === 'GET') return json(res, 200, { products: tcgplayer.searchSealed(url.searchParams.get('q') || '', { japanese: url.searchParams.get('lang') === 'ja' }) });
    if (p === '/api/tcg/setlist' && req.method === 'GET') return json(res, 200, { sets: await tcg.setList(url.searchParams.get('lang') || 'en') });
    if (p.startsWith('/api/tcg/card/') && req.method === 'GET') {
      const c = await tcg.card(url.searchParams.get('lang') || 'en', decodeURIComponent(p.slice(14)), { fresh: url.searchParams.get('fresh') === '1' });
      return c ? json(res, 200, { card: c }) : json(res, 404, { error: 'not_found' });
    }
    if (p === '/api/tcg/match' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 2 * 1024 * 1024));
      const results = await tcg.match(body.lang || 'en', Array.isArray(body.items) ? body.items : [], { fresh: !!body.fresh });
      return json(res, 200, { results });
    }
    if (p === '/api/backup' && req.method === 'GET') {
      const out = { format: 'card-fair-booth', version: 1, exportedAt: new Date().toISOString() };
      for (const t of TYPES) out[t] = Object.values(db.recs[t]).map(e => e.r);
      return send(res, 200, JSON.stringify(out), MIME['.json'], { 'Content-Disposition': `attachment; filename="card-fair-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    }
    return send(res, 404, 'Not found');
  } catch (e) {
    if (e && ['unreachable', 'busy', 'http'].includes(e.code)) { if (!res.headersSent) json(res, 502, { error: e.code, message: e.message }); return; }
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server_error' });
  }
});
server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log(`\n  Card Fair Booth is running\n`);
  console.log(`  Storefront   http://localhost:${PORT}/`);
  console.log(`  Your booth   http://localhost:${PORT}/booth`);
  for (const ip of lan) console.log(`  On your Wi-Fi http://${ip}:${PORT}/booth`);
  console.log(`  Data folder  ${DATA}\n`);
  startTunnel();
  if (process.env.TCGPLAYER_PRICES !== 'off') tcgplayer.start();
  tcg.warm('en').then(r => console.log(`  Card search ready (${r.cards.toLocaleString()} cards).`)).catch(e => console.warn('  Card search: ' + e.message + '. It will retry on the first search.'));
});

/* ---------- Cloudflare Tunnel (optional) ----------
   With CLOUDFLARE_TUNNEL_TOKEN set and cloudflared installed, the tunnel starts
   and stops with the server, and restarts itself if it drops. */
let tunnel = null, tunnelTries = 0;
function startTunnel() {
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  if (!token) return;
  const { spawn } = require('child_process');
  const bin = process.env.CLOUDFLARED || 'cloudflared';
  tunnel = spawn(bin, ['tunnel', '--no-autoupdate', 'run', '--token', token], { stdio: ['ignore', 'pipe', 'pipe'] });
  let said = false;
  const watch = buf => { const t = String(buf); if (!said && /Registered tunnel connection|Connection .* registered/i.test(t)) { said = true; tunnelTries = 0; console.log('  Cloudflare Tunnel connected. Your public address is live.\n'); } };
  tunnel.stdout.on('data', watch); tunnel.stderr.on('data', watch);
  tunnel.on('error', e => { if (e.code === 'ENOENT') { console.error('  Cloudflare Tunnel: cloudflared is not installed. See README, step 4 "Share the storefront with Cloudflare Tunnel".'); tunnel = null; } });
  tunnel.on('exit', code => {
    if (!tunnel) return; tunnel = null;
    const wait = Math.min(60, 5 * 2 ** tunnelTries++);
    console.error(`  Cloudflare Tunnel stopped (code ${code}). Retrying in ${wait}s.`);
    setTimeout(startTunnel, wait * 1000);
  });
}
function stopTunnel() { if (tunnel) { const t = tunnel; tunnel = null; try { t.kill(); } catch {} } }
process.on('SIGINT', () => { stopTunnel(); clearTimeout(saveTimer); try { writeAtomic(DB_FILE, JSON.stringify(db)); } catch {} process.exit(0); });
process.on('SIGTERM', () => { stopTunnel(); clearTimeout(saveTimer); try { writeAtomic(DB_FILE, JSON.stringify(db)); } catch {} process.exit(0); });
