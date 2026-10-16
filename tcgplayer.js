/* TCGplayer prices and pictures, from TCGCSV (https://tcgcsv.com): a free daily
 * copy of TCGplayer's catalog. Used when the card database (TCGdex) has no price
 * or picture for a card: Trainer Gallery, Galarian Gallery, Shiny Vault, promos,
 * brand-new sets, and the Japanese line.
 *
 * Polite by design: checks last-updated.txt, syncs at most once a day, one request
 * at a time with a pause, and an identifiable User-Agent, as TCGCSV asks.
 * The index is a few MB in data/cache/tcgcsv and works offline once synced.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const API = (process.env.TCGCSV_API || 'https://tcgcsv.com').replace(/\/$/, '');
const UA = 'CardFairBooth/1.2.0';
const POKEMON = 3;
const PAUSE = Number(process.env.TCGCSV_PAUSE_MS || 100);

// TCGplayer printing names → our finishes
function finishOf(sub) {
  const s = String(sub || '').toLowerCase();
  if (s.includes('1st edition')) return 'first';
  if (s.includes('reverse')) return 'reverse';
  if (s.includes('holo')) return 'holo';
  return 'normal';
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// "TG01/TG30" → "TG1", "199/165" → "199", "SWSH001" → "SWSH1", "SVP 085" → "SVP85"
const numKey = s => String(s || '').split('/')[0].replace(/\s+/g, '').toUpperCase().replace(/^([A-Z-]*)0*(\d)/, '$1$2');
const digits = s => (String(s || '').split('/')[0].match(/\d+/) || [''])[0].replace(/^0+(?=\d)/, '');

module.exports = function makeTcgplayer(DATA) {
  const DIR = path.join(DATA, 'cache', 'tcgcsv');
  const FILE = path.join(DIR, 'index.json');
  let idx = null;
  try { idx = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  if (!idx || idx.v !== 1) idx = { v: 1, updated: '', syncedAt: 0, groups: {}, p: {}, pr: {}, s: {} };
  let byNum = null; // numKey → [productId]
  const rebuild = () => { byNum = new Map(); for (const id in idx.p) { const k = numKey(idx.p[id][3]); if (!byNum.has(k)) byNum.set(k, []); byNum.get(k).push(id); } };
  rebuild();
  let syncing = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function get(p, asText = false) {
    for (let i = 0; ; i++) {
      let res;
      try { res = await fetch(API + p, { headers: { 'User-Agent': UA, Accept: asText ? 'text/plain' : 'application/json' }, signal: AbortSignal.timeout(20000) }); }
      catch (e) { if (i >= 3) throw e; await sleep(1000 * 2 ** i); continue; }
      if (res.status === 429 || res.status >= 500) { if (i >= 3) throw new Error('TCGCSV busy ' + res.status); await sleep(2000 * 2 ** i); continue; }
      if (!res.ok) throw new Error('TCGCSV ' + res.status + ' ' + p);
      return asText ? res.text() : res.json();
    }
  }
  const results = j => (j && Array.isArray(j.results) ? j.results : []);

  /* Refresh Pokémon and Pokémon Japan when TCGCSV has new data.
     Newest sets first, a few at a time, saved as it goes: prices are usable within
     a minute, and a restart picks up where it stopped instead of starting over. */
  const prog = { done: 0, total: 0, lastError: '', lastErrorAt: 0, startedAt: 0 };
  let dirty = 0;
  const save = () => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(idx)); fs.renameSync(FILE + '.tmp', FILE); dirty = 0; } catch {} };
  async function syncGroup(cat, g, next) {
    const prods = results(await get(`/tcgplayer/${cat}/${g.groupId}/products`)); await sleep(PAUSE);
    const keep = new Set();
    for (const p of prods) {
      const ext = Object.fromEntries((p.extendedData || []).map(e => [e.name, e.value]));
      if (!ext.Number) {   // sealed product: boxes, ETBs, bundles, tins, packs, collections
        const nm = String(p.name || p.cleanName || '').trim();
        if (!nm || /code card|online code|digital|empty box|case of|\bcase\b/i.test(nm)) continue;
        next.s[p.productId] = [nm, g.groupId, cat, p.imageUrl || ''];
        keep.add(String(p.productId)); continue;
      }
      next.p[p.productId] = [String(p.name || p.cleanName || '').replace(/\s+-\s+[\w/ .]+$/, '').trim(), g.groupId, cat, ext.Number, ext.Rarity || '', p.imageUrl || ''];
      keep.add(String(p.productId));
    }
    if (keep.size) {
      const prices = results(await get(`/tcgplayer/${cat}/${g.groupId}/prices`)); await sleep(PAUSE);
      for (const r of prices) {
        if (!keep.has(String(r.productId))) continue;
        const m = r.marketPrice ?? r.midPrice;
        if (m == null || !(m > 0)) continue;
        (next.pr[r.productId] = next.pr[r.productId] || {})[finishOf(r.subTypeName)] = Math.round(m * 100);
      }
    }
  }
  async function sync({ force = false } = {}) {
    if (syncing) return syncing;
    syncing = (async () => {
      const stamp = String(await get('/last-updated.txt', true)).trim();
      if (!force && stamp && stamp === idx.updated && !idx.partial && Object.keys(idx.p).length && idx.s) { idx.syncedAt = Date.now(); return { fresh: false }; }
      if (!idx.s) { idx.s = {}; idx.partial = null; }   // first time with sealed products: one full pass
      let cats = [POKEMON];
      try { const c = results(await get('/tcgplayer/categories')).find(x => /pok[eé]mon\s*japan/i.test(x.name || x.displayName || '')); if (c) cats.push(c.categoryId); } catch {}
      // resume a sync of the same data; otherwise refresh in place (old prices stay until each set is redone)
      const resume = idx.partial && idx.partial.stamp === stamp ? new Set(idx.partial.done) : new Set();
      const all = [];
      for (const cat of cats) for (const g of results(await get(`/tcgplayer/${cat}/groups`))) { idx.groups[g.groupId] = [g.name, cat, g.abbreviation || '', g.publishedOn || '']; all.push([cat, g]); }
      // English before Japanese, newest sets first: what you're most likely to be selling
      all.sort((x, y) => (x[0] === POKEMON ? 0 : 1) - (y[0] === POKEMON ? 0 : 1) || String(y[1].publishedOn || '').localeCompare(String(x[1].publishedOn || '')));
      const todo = all.filter(([, g]) => !resume.has(g.groupId));
      idx.partial = { stamp, done: [...resume] };
      Object.assign(prog, { done: resume.size, total: all.length, startedAt: Date.now() });
      console.log(`  Downloading TCGplayer prices: ${todo.length} sets to go, newest first. Lookups work meanwhile.`);
      const tick = setInterval(() => console.log(`  TCGplayer prices: ${prog.done} of ${prog.total} sets (${Object.keys(idx.p).length} cards ready)`), 30000);
      let i = 0, fails = 0;
      const worker = async () => {
        while (i < todo.length) {
          const [cat, g] = todo[i++];
          try { await syncGroup(cat, g, idx); idx.partial.done.push(g.groupId); prog.done++; dirty++; }
          catch (e) { fails++; prog.lastError = e.message; prog.lastErrorAt = Date.now(); }
          if (dirty >= 12) { rebuild(); save(); }
        }
      };
      await Promise.all([worker(), worker(), worker()]).finally(() => clearInterval(tick));
      if (!fails) { idx.partial = null; idx.updated = stamp; }
      idx.syncedAt = Date.now(); rebuild(); save();
      if (fails) console.warn(`  TCGplayer prices: ${fails} sets didn't download (${prog.lastError}). Trying again later.`);
      return { fresh: true, cards: Object.keys(idx.p).length };
    })().catch(e => { prog.lastError = e.message; prog.lastErrorAt = Date.now(); throw e; }).finally(() => { syncing = null; });
    return syncing;
  }
  /* Keep it fresh in the background: on start, then every 6 hours (TCGCSV updates daily).
     An unfinished download retries after 15 minutes. */
  function start() {
    const run = () => sync().then(r => { if (r.fresh) console.log(`  TCGplayer prices updated (${r.cards} cards).`); if (idx.partial) setTimeout(run, 15 * 60e3); })
      .catch(e => { console.warn('  TCGplayer prices: ' + e.message + '. Using the saved copy, trying again in 15 minutes.'); setTimeout(run, 15 * 60e3); });
    setTimeout(run, 3000); setInterval(run, 6 * 3600e3).unref();
  }
  function product(id) {
    const p = idx.p[id]; if (!p) return null;
    const [name, gid, cat, number, rarity, img] = p, g = idx.groups[gid] || [];
    const prices = idx.pr[id] || {};
    return { productId: String(id), name, number, rarity, groupId: gid, groupName: g[0] || '', japanese: cat !== POKEMON, image: img, prices,
      at: idx.updated ? Date.parse(idx.updated) || idx.syncedAt : idx.syncedAt };
  }
  /* Prices for a card from its TCGplayer product ids (one per printing). */
  function forProducts(ids) {
    const out = { productId: '', image: '', prices: {}, at: 0 };
    for (const id of ids) {
      const p = product(id); if (!p) continue;
      if (!out.productId) { out.productId = p.productId; out.image = p.image; out.at = p.at; }
      for (const k in p.prices) if (out.prices[k] == null) out.prices[k] = p.prices[k];
    }
    return out.productId ? out : null;
  }
  /* Best product for a name + number (+ set name to break ties). */
  function find({ name, number, setName, japanese = false }) {
    if (!number) return null;
    let ids = byNum.get(numKey(number)) || [];
    if (!ids.length) { const d = digits(number); ids = d ? (byNum.get(d) || []) : []; }
    const nn = norm(name).split(' ')[0], sn = norm(setName).split(' ').filter(w => w.length > 2);
    let best = null, bestScore = -1;
    for (const id of ids) {
      const p = idx.p[id], g = idx.groups[p[1]] || [];
      if ((p[2] !== POKEMON) !== japanese) continue;
      const pn = norm(p[0]);
      if (nn && !pn.split(' ').includes(nn) && !pn.startsWith(nn)) continue;
      const gn = norm(g[0]);
      let score = sn.filter(w => gn.includes(w)).length * 2 + (norm(p[3]).startsWith(norm(number)) ? 3 : 0) - (/[([]/.test(p[0]) ? 4 : 0);   // "(Master Ball Pattern)", "(Staff)": not the plain card
      if (/gallery|vault/.test(norm(number + ' ' + setName)) || /^[a-z]{2}\d/i.test(String(number))) score += /gallery|vault|promo/.test(gn) ? 1 : 0;
      if (score > bestScore) { best = id; bestScore = score; }
    }
    return best ? product(best) : null;
  }
  /* Search for the Add cards / trade-in box when the card database has nothing. */
  function search(q, { japanese = false, limit = 12 } = {}) {
    const toks = norm(q).split(' ').filter(Boolean); if (!toks.length) return [];
    const num = toks.find(t => /\d/.test(t)), words = toks.filter(t => t !== num);
    let ids = num ? (byNum.get(numKey(num)) || byNum.get(digits(num)) || []) : Object.keys(idx.p);
    const out = [];
    for (const id of ids) {
      const p = idx.p[id]; if ((p[2] !== POKEMON) !== japanese) continue;
      const hay = norm(p[0] + ' ' + (idx.groups[p[1]] || [''])[0]);
      if (words.every(w => hay.includes(w))) { out.push(id); if (out.length >= 400) break; }
    }
    out.sort((a, b) => String((idx.groups[idx.p[b][1]] || [])[3]).localeCompare(String((idx.groups[idx.p[a][1]] || [])[3])));
    return out.slice(0, limit).map(product);
  }
  /* Sealed products for trade-ins: "prismatic etb", "151 booster bundle", "surging sparks bb". */
  const SEALED_ALIAS = { etb: ['elite', 'trainer', 'box'], pcetb: ['pokemon', 'center', 'elite', 'trainer', 'box'], bb: ['booster', 'box'], bundle: ['booster', 'bundle'], upc: ['ultra', 'premium', 'collection'],
    spc: ['super', 'premium', 'collection'], pack: ['booster', 'pack'], blister: ['blister'], tin: ['tin'], pc: ['pokemon', 'center'], sleeved: ['sleeved', 'booster'] };
  function searchSealed(q, { japanese = false, limit = 12 } = {}) {
    const S = idx.s || {};
    let toks = norm(q).split(' ').filter(Boolean); if (!toks.length) return [];
    if (toks.join(' ').includes('pc etb')) toks = toks.filter(t => t !== 'pc' && t !== 'etb').concat('pcetb');
    const groups = toks.map(t => SEALED_ALIAS[t] ? SEALED_ALIAS[t] : [t]);
    const out = [];
    for (const id in S) {
      const [name, gid, cat, img] = S[id]; if ((cat !== POKEMON) !== japanese) continue;
      const g = idx.groups[gid] || [], hay = norm(name + ' ' + (g[0] || '') + ' ' + (g[2] || ''));
      const words = hay.split(' ');
      let score = 0, ok = true;
      for (const alts of groups) {
        const hit = alts.every(w => words.some(x => x.startsWith(w)));
        if (!hit) { ok = false; break; }
        score += alts.length;
      }
      if (!ok) continue;
      const pr = idx.pr[id] || {}, cents = pr.normal ?? pr.holo ?? Object.values(pr)[0] ?? null;
      out.push({ productId: String(id), name, groupName: g[0] || '', image: img, cents, date: g[3] || '', score: score - name.length / 200 });
    }
    out.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)) || (b.cents || 0) - (a.cents || 0));
    return out.slice(0, limit).map(({ score, ...r }) => ({ ...r, at: idx.updated ? Date.parse(idx.updated) || idx.syncedAt : idx.syncedAt }));
  }
  /* What a whole set is worth at TCGplayer market: every card in the set, every printing
     (normal or holo, reverse holo, and the ball patterns, which TCGplayer lists as their own products).
     Best-matching sets first, so you can pick the right one. Promos outside the set aren't counted. */
  function setValue(q, { japanese = false, limit = 4 } = {}) {
    const want = norm(q); if (!want) return [];
    const toks = want.split(' ');
    const cand = [];
    for (const gid in idx.groups) {
      const [name, cat, abbr, date] = idx.groups[gid]; if ((cat !== POKEMON) !== japanese) continue;
      const n = norm(name), a = norm(abbr);
      let score = 0;
      if (n === want || a === want) score = 100;
      else if (toks.every(t => n.split(' ').some(w => w.startsWith(t)))) score = 50 - Math.abs(n.length - want.length) / 10;
      else continue;
      if (/\b(promo|trainer kit|jumbo|league|world championship|code card|deck)\b/.test(n) && !/promo|kit|jumbo|league|world|code|deck/.test(want)) score -= 30;
      cand.push({ gid, name, date, score });
    }
    cand.sort((x, y) => y.score - x.score || String(y.date).localeCompare(String(x.date)));
    return cand.slice(0, limit).map(c => {
      let cards = 0, printings = 0, cents = 0, unpriced = 0;
      for (const id in idx.p) {
        const p = idx.p[id]; if (String(p[1]) !== String(c.gid) || !p[3]) continue;
        cards++;
        const pr = idx.pr[id] || {}, vals = Object.values(pr).filter(v => v > 0);
        if (!vals.length) { unpriced++; continue; }
        printings += vals.length; cents += vals.reduce((x, v) => x + v, 0);
      }
      return { groupId: String(c.gid), name: c.name, date: c.date, cards, printings, cents, unpriced, at: idx.updated ? Date.parse(idx.updated) || idx.syncedAt : idx.syncedAt };
    }).filter(r => r.cards);
  }
  const status = () => ({ cards: Object.keys(idx.p).length, sealed: Object.keys(idx.s || {}).length, updated: idx.updated, syncedAt: idx.syncedAt, syncing: !!syncing, partial: !!idx.partial, done: prog.done, total: prog.total, lastError: prog.lastError, lastErrorAt: prog.lastErrorAt });
  return { sync, start, product, forProducts, find, search, searchSealed, setValue, status, numKey };
};
