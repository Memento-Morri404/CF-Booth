/* Optional: real prices per condition (NM, LP, MP, HP, DMG) from JustTCG (justtcg.com),
 * which tracks TCGplayer by printing and condition. Free tier available.
 * Set JUSTTCG_API_KEY in .env to turn it on. Without it, lower conditions are
 * priced from NM using your condition ladder in Setup.
 * Looked up one card at a time when you pick it, and cached on disk for 12 hours.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const API = (process.env.JUSTTCG_API || 'https://api.justtcg.com').replace(/\/$/, '');
const TTL = 12 * 3600e3;
const COND = { 'near mint': 'NM', 'lightly played': 'LP', 'moderately played': 'MP', 'heavily played': 'HP', damaged: 'DMG', nm: 'NM', lp: 'LP', mp: 'MP', hp: 'HP', dmg: 'DMG' };
// JustTCG printing names → our finish keys (the same ones tcgPrices uses)
function printingKey(s) {
  const p = String(s || '').toLowerCase();
  if (p.includes('1st')) return 'first';
  if (p.includes('reverse')) return 'reverse';
  if (p.includes('holo') || p.includes('foil')) return 'holo';
  return 'normal';
}

module.exports = function makeJustTcg(DATA) {
  const key = (process.env.JUSTTCG_API_KEY || '').trim();
  const CACHE = path.join(DATA, 'cache', 'justtcg');
  const read = f => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return Date.now() - v.at < TTL ? v.v : undefined; } catch { return undefined; } };
  const write = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: Date.now(), v })); } catch {} };
  let pausedUntil = 0;   // after a rate limit, stop asking for a while

  /* { normal: {NM, LP, MP, HP, DMG}, holo: {...}, reverse: {...}, first: {...}, at } in cents, for a TCGplayer product. */
  async function byProduct(productId) {
    if (!key) throw Object.assign(new Error('JustTCG is not set up'), { code: 'off' });
    productId = String(productId || '').replace(/\D/g, ''); if (!productId) return null;
    const f = path.join(CACHE, productId + '.json'); const c = read(f); if (c !== undefined) return c;
    if (Date.now() < pausedUntil) throw Object.assign(new Error('JustTCG limit reached, try later'), { code: 'busy' });
    let res;
    try { res = await fetch(`${API}/v1/cards?tcgplayerId=${productId}`, { headers: { 'x-api-key': key, Accept: 'application/json', 'User-Agent': 'CardFairBooth/1.3' }, signal: AbortSignal.timeout(12000) }); }
    catch { throw Object.assign(new Error('JustTCG unreachable'), { code: 'unreachable' }); }
    if (res.status === 429) { pausedUntil = Date.now() + 10 * 60e3; throw Object.assign(new Error('JustTCG limit reached, try later'), { code: 'busy' }); }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('JustTCG key was not accepted'), { code: 'http' });
    if (!res.ok) throw Object.assign(new Error('JustTCG error ' + res.status), { code: 'http' });
    const j = await res.json();
    const card = (Array.isArray(j && j.data) ? j.data : [])[0];
    let out = null;
    if (card && Array.isArray(card.variants)) {
      out = { at: 0 };
      for (const v of card.variants) {
        const c = COND[String(v.condition || '').toLowerCase()];
        if (!c || !(v.price > 0)) continue;
        if (v.language && !/english/i.test(v.language) && !/japanese/i.test(v.language)) continue;
        const k = printingKey(v.printing);
        (out[k] = out[k] || {})[c] = Math.round(v.price * 100);
        out.at = Math.max(out.at, (v.lastUpdated || 0) * 1000);
      }
      if (Object.keys(out).length === 1) out = null;
    }
    write(f, out);
    return out;
  }
  return { enabled: !!key, byProduct };
};
