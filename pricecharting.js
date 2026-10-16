/* Optional: graded and other prices from PriceCharting (paid subscription).
 * Set PRICECHARTING_TOKEN in .env to turn it on. Prices come back in cents.
 * Results are cached on disk for 12 hours so a busy show day stays cheap.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const API = (process.env.PRICECHARTING_API || 'https://www.pricecharting.com').replace(/\/$/, '');
const TTL = 12 * 3600e3;

module.exports = function makePriceCharting(DATA) {
  const token = (process.env.PRICECHARTING_TOKEN || '').trim();
  const CACHE = path.join(DATA, 'cache', 'pricecharting');
  const key = s => String(s).toLowerCase().replace(/[^\w]+/g, '_').slice(0, 120);
  const read = f => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return Date.now() - v.at < TTL ? v.v : null; } catch { return null; } };
  const write = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: Date.now(), v })); } catch {} };
  async function get(p) {
    let res;
    try { res = await fetch(`${API}${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, { headers: { Accept: 'application/json', 'User-Agent': 'CardFairBooth/1.0' }, signal: AbortSignal.timeout(15000) }); }
    catch { throw Object.assign(new Error('PriceCharting unreachable'), { code: 'unreachable' }); }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('PriceCharting token was not accepted'), { code: 'http' });
    if (!res.ok) throw Object.assign(new Error('PriceCharting error ' + res.status), { code: res.status >= 500 ? 'busy' : 'http' });
    const j = await res.json();
    if (j && j.status === 'error') throw Object.assign(new Error(j['error-message'] || 'PriceCharting error'), { code: 'http' });
    return j;
  }
  // card grades → PriceCharting fields (documented for cards: loose = ungraded, cib = 7, new = 8, graded = 9, box-only = 9.5, manual-only = PSA 10)
  const shape = p => {
    const c = k => Number.isFinite(p[k]) && p[k] > 0 ? p[k] : null;
    return { loose: c('loose-price'), g7: c('cib-price'), g8: c('new-price'), g9: c('graded-price'), g95: c('box-only-price'), psa10: c('manual-only-price'), bgs10: c('bgs-10-price'), cgc10: c('condition-17-price'), sgc10: c('condition-18-price') };
  };
  /* Best product for a search, with its prices. */
  async function price(q) {
    if (!token) throw Object.assign(new Error('PriceCharting is not set up'), { code: 'off' });
    q = String(q || '').trim().slice(0, 160); if (!q) return null;
    const f = path.join(CACHE, key(q) + '.json'); const c = read(f); if (c) return c;
    const list = await get('/api/products?q=' + encodeURIComponent(q));
    const products = (list && list.products) || [];
    // best match: Pokémon, same card number, same language, most words in common
    const words = q.toLowerCase().split(/\s+/).filter(w => w && w !== 'pokemon');
    const num = words.find(w => /^\d+$/.test(w)), jp = /japanese/i.test(q);
    const score = p => {
      const n = String(p['product-name'] || '').toLowerCase(), c = String(p['console-name'] || '').toLowerCase();
      return (/pokemon/.test(c) ? 2 : -5) + (num && new RegExp('#0*' + +num + '\\b').test(n) ? 6 : 0) + (jp === /japanese/.test(c) ? 2 : -2)
        + words.filter(w => !/^\d+$/.test(w) && (n + ' ' + c).includes(w)).length;
    };
    const pick = products.slice().sort((a, b) => score(b) - score(a))[0];
    if (!pick) { write(f, null); return null; }
    const p = Number.isFinite(pick['loose-price']) ? pick : await get('/api/product?id=' + encodeURIComponent(pick.id));
    const out = { id: String(pick.id), name: p['product-name'] || pick['product-name'] || '', set: p['console-name'] || pick['console-name'] || '', prices: shape(p),
      url: `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(q)}` };
    write(f, out);
    return out;
  }
  return { enabled: !!token, price };
};
