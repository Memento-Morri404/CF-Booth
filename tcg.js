/* Card data and market prices from TCGdex (https://tcgdex.dev): free, no key.
 * Card details are cached on disk for good; prices are refreshed after PRICE_TTL.
 * Everything here runs on your server, so the booth never talks to TCGdex directly.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const API = (process.env.TCGDEX_API || 'https://api.tcgdex.net/v2').replace(/\/$/, '');
const PRICE_TTL = 6 * 3600e3;      // card (with prices) re-fetched after 6 hours
const SETS_TTL = 24 * 3600e3;
const LANGS = new Set(['en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'th', 'id', 'fr', 'de', 'it', 'es', 'es-mx', 'pt', 'pt-br', 'pt-pt', 'nl', 'pl', 'ru']);

module.exports = function makeTcg(DATA, tp = null) {
  const CACHE = path.join(DATA, 'cache', 'tcgdex');
  const mem = new Map();
  const lang = l => LANGS.has(l) ? l : 'en';
  const file = (l, kind, id) => path.join(CACHE, l, kind, String(id).replace(/[^\w.\-]/g, '_') + '.json');
  function readCache(f) { if (mem.has(f)) return mem.get(f); try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); mem.set(f, v); return v; } catch { return null; } }
  function writeCache(f, v) { mem.set(f, v); try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); } catch {} }

  /* polite fetching: a few at a time, retry on rate limits and hiccups.
     Two lanes, so background warm-up (every set's details) never makes a lookup wait. */
  const lanes = { fg: { max: 6, active: 0, waiting: [] }, bg: { max: 2, active: 0, waiting: [] } };
  const slot = ln => new Promise(r => { if (ln.active < ln.max) { ln.active++; r(); } else ln.waiting.push(r); });
  const release = ln => { const n = ln.waiting.shift(); if (n) n(); else ln.active--; };
  const health = { ok: 0, fail: 0, lastOk: 0, lastError: '', lastErrorAt: 0 };
  async function get(url, { tries = 4, bg = false } = {}) {
    const ln = bg ? lanes.bg : lanes.fg;
    await slot(ln);
    try {
      for (let i = 0; ; i++) {
        let res;
        try { res = await fetch(url, { headers: { 'User-Agent': 'CardFairBooth/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(bg ? 30000 : 15000) }); }
        catch (e) {
          if (i >= tries) { const err = Object.assign(new Error('Card database unreachable (' + ((e && e.cause && e.cause.code) || (e && e.name) || 'network') + ')'), { code: 'unreachable' }); noteFail(err); throw err; }
          await sleep(600 * 2 ** i); continue;
        }
        if (res.status === 404) { noteOk(); return null; }
        if (res.status === 429 || res.status >= 500) { if (i >= tries) { const err = Object.assign(new Error('Card database busy (' + res.status + ')'), { code: 'busy' }); noteFail(err); throw err; } await sleep(800 * 2 ** i); continue; }
        if (!res.ok) { const err = Object.assign(new Error('Card database error ' + res.status), { code: 'http' }); noteFail(err); throw err; }
        const j = await res.json(); noteOk(); return j;
      }
    } finally { release(ln); }
  }
  function noteOk() { health.ok++; health.lastOk = Date.now(); }
  let lastLogged = 0;
  function noteFail(e) {
    health.fail++; health.lastError = e.message; health.lastErrorAt = Date.now();
    if (Date.now() - lastLogged > 60000) { lastLogged = Date.now(); console.warn('  Card database: ' + e.message); }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function sets(l) {
    l = lang(l);
    const f = file(l, 'meta', 'sets'); const c = readCache(f);
    if (c && Date.now() - c.at < SETS_TTL) return c.v;
    try { const v = await get(`${API}/${l}/sets`); if (v) { writeCache(f, { at: Date.now(), v }); return v; } } catch (e) { if (c) return c.v; throw e; }
    return c ? c.v : [];
  }
  async function set(l, id, bg = false) {
    l = lang(l);
    const f = file(l, 'sets', id); const c = readCache(f);
    if (c && Date.now() - c.at < SETS_TTL) return c.v;
    try { const v = await get(`${API}/${l}/sets/${encodeURIComponent(id)}`, { bg }); if (v) writeCache(f, { at: Date.now(), v }); return v || (c && c.v) || null; }
    catch (e) { if (c) return c.v; throw e; }
  }
  /* TCGplayer prices/picture for a card, from its product ids (per printing),
     or by name + number when the card database has no ids for it. */
  function enrich(v) {
    if (!tp || !v) return v;
    const vd = Array.isArray(v.variants_detailed) ? v.variants_detailed : [];
    const special = d => !!(d.foil || (Array.isArray(d.stamp) && d.stamp.length) || d.size);
    // the plain printing's product: its price is the card's price (pattern/stamped products are priced on their own)
    const ids = vd.filter(d => d && !special(d) && d.thirdParty && d.thirdParty.tcgplayer).map(d => d.thirdParty.tcgplayer);
    if (v.thirdParty && v.thirdParty.tcgplayer) ids.unshift(v.thirdParty.tcgplayer);
    let t = ids.length ? tp.forProducts([...new Set(ids)]) : null;
    if (!t && (v._lang === 'en' || v._lang === 'ja')) {
      const off = v._set && v._set.cardCount && v._set.cardCount.official;
      const p = tp.find({ name: v._lang === 'en' ? v.name : '', number: v.localId + (off && /^\d+$/.test(v.localId) ? '/' + off : ''), setName: v._set && v._set.name, japanese: v._lang === 'ja' });
      if (p && (v._lang === 'en' || p.number)) t = { productId: p.productId, image: p.image, prices: p.prices, at: p.at };
    }
    // each printing (Poké Ball / Master Ball pattern, cosmos, stamps…) gets its own TCGplayer price
    const vd2 = vd.map(d => { const id = d && d.thirdParty && d.thirdParty.tcgplayer; const x = id ? tp.product(id) : null; return x ? { ...d, _tp: { productId: x.productId, prices: x.prices, image: x.image } } : d; });
    const out = { ...v };
    if (vd.length) out.variants_detailed = vd2;
    if (t) out._tp = t;
    return out;
  }
  /* A card the card database doesn't have, built from TCGplayer's catalog. */
  function pseudo(p, l) {
    if (!p) return null;
    const pr = p.prices || {};
    return { id: 'tcgp-' + p.productId, localId: p.number, name: p.name.replace(/\s+-\s+[\w/ ]+$/, ''), rarity: p.rarity, category: 'Pokemon',
      set: { id: 'tcgp-g' + p.groupId, name: p.groupName }, _set: { id: 'tcgp-g' + p.groupId, name: p.groupName, serie: null, releaseDate: '', abbreviation: null, tcgOnline: '', cardCount: null },
      variants: { normal: pr.normal != null, holo: pr.holo != null || (pr.normal == null && pr.reverse == null), reverse: pr.reverse != null, firstEdition: pr.first != null },
      image: null, _tp: { productId: p.productId, image: p.image, prices: pr, at: p.at }, _lang: p.japanese ? 'ja' : l, _src: 'tcgplayer' };
  }
  /* A full card, plus the facts about its set we need (series, release date, code). */
  async function card(l, id, opts) {
    const v = await cardRaw(l, id, opts); if (!v || v._src) return v;
    const e = enrich(v);
    // every picture we could use, best first: the card database's scan, TCGplayer's photo, pokemontcg.io
    if (e._lang === 'en' && e.set && e.set.id) e._alt = ptcgioImg(e.set.id, e.localId);
    const pid = firstPid(e) || (e._tp && e._tp.productId); if (pid) e._pimg = pidImg(pid);
    return e;
  }
  async function cardRaw(l, id, { fresh = false } = {}) {
    l = lang(l);
    if (/^tcgp-\d+$/.test(id)) return tp ? pseudo(tp.product(id.slice(5)), l) : null;
    const f = file(l, 'cards', id); const c = readCache(f);
    if (c && !fresh && Date.now() - c.at < PRICE_TTL) return c.v;
    let v;
    try { v = await get(`${API}/${l}/cards/${encodeURIComponent(id)}`); }
    catch (e) { if (c) return { ...c.v, _stale: true }; throw e; }
    if (!v) return null;
    let s = null;
    try { s = v.set && v.set.id ? await set(l, v.set.id) : null; } catch {}
    v._set = s ? { id: s.id, name: s.name, serie: s.serie || null, releaseDate: s.releaseDate || '', abbreviation: s.abbreviation || null, tcgOnline: s.tcgOnline || '', cardCount: s.cardCount || (v.set && v.set.cardCount) || null } : null;
    v._lang = l; v._fetched = Date.now();
    writeCache(f, { at: Date.now(), v });
    return v;
  }

  /* Set codes (MEW, PRE…) only live on each set's own page: learn them once, then cache. */
  async function codeMap(l) {
    const f = file(l, 'meta', 'codes'); const c = readCache(f);
    if (c && Date.now() - c.at < 7 * SETS_TTL) return c.v;
    const all = await sets(l), v = {};
    await Promise.all(all.map(async b => { try { const d = await set(l, b.id, true); if (d) for (const k of [d.tcgOnline, d.abbreviation && d.abbreviation.official]) if (k && (!v[norm(k)] || d.id.length < v[norm(k)].length)) v[norm(k)] = d.id; } catch {} }));
    writeCache(f, { at: Date.now(), v });
    return v;
  }
  // keeps Japanese, Chinese and Korean; drops accents (Pokémon → pokemon) and punctuation
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const numKey = s => String(s || '').split('/')[0].replace(/\s+/g, '').toUpperCase().replace(/^([A-Z-]*)0*(\d)/, '$1$2');
  const digitsKey = s => (String(s || '').split('/')[0].match(/\d+/) || [''])[0].replace(/^0+(?=\d)/, '');

  /* ---------- search: the whole card list, searched and ranked here ----------
     TCGdex's own name filter returns cards in storage order (oldest sets first) with no
     ranking, so we keep the full list locally (one download a day) and rank it ourselves. */
  async function catalog(l) {
    l = lang(l);
    const f = file(l, 'meta', 'catalog'); const c = readCache(f);
    if (c && Date.now() - c.at < SETS_TTL && c.v.length) return c.v;
    try {
      const v = await get(`${API}/${l}/cards`, { bg: true, tries: 6 });
      if (Array.isArray(v) && v.length) { const slim = v.map(b => [b.id, b.localId, b.name, b.image || '']); writeCache(f, { at: Date.now(), v: slim }); return slim; }
    } catch (e) { if (c) return c.v; throw e; }
    return c ? c.v : [];
  }
  /* Facts about every set (release date, era, official count, codes), refreshed weekly. */
  async function setIndex(l) {
    l = lang(l);
    const f = file(l, 'meta', 'setindex'); const c = readCache(f);
    if (c && Date.now() - c.at < 7 * SETS_TTL && Object.keys(c.v).length) return c.v;
    const all = await sets(l), v = {};
    let i = 0;
    const work = async () => { while (i < all.length) { const b = all[i++]; try { const d = await set(l, b.id, true); if (d) v[d.id] = { name: d.name, date: d.releaseDate || '', serie: (d.serie && d.serie.name) || '', off: (d.cardCount && d.cardCount.official) || null, code: d.tcgOnline || (d.abbreviation && d.abbreviation.official) || '' }; } catch {} } };
    await Promise.all([work(), work(), work()]);
    if (Object.keys(v).length) writeCache(f, { at: Date.now(), v });
    return Object.keys(v).length ? v : (c ? c.v : {});
  }
  /* Get both ready in the background when the server starts, so the first search is instant. */
  function warm(l = 'en') { return Promise.all([catalog(l), setIndex(l)]).then(([cat, si]) => ({ cards: cat.length, sets: Object.keys(si).length })); }

  const ALIASES = {   // collector nicknames
    moonbreon: { words: ['umbreon', 'vmax'], num: '215', set: 'swsh7' },
    sunbreon: { words: ['umbreon', 'ex'], num: '161', set: 'sv08.5' },
  };
  const STYLE = { alt: 1, sir: 1, sar: 1, ir: 1, secret: 1, gold: 1, rainbow: 1, hr: 1, fa: 1, 'full': 1, art: 1, special: 1, illustration: 1, rare: 1 };
  // a card numbered past the set's official count is a secret / alt art / SIR
  const isChase = (localId, off) => { const n = parseInt(String(localId).replace(/^\D+/, ''), 10); return !!off && /^\d+$/.test(String(localId)) && n > off; };
  // pokemontcg.io keeps scans of almost every English card: a picture when TCGdex has none
  // TCGdex set id → pokemontcg.io set id (their image CDN): most match after a little reshaping, these don't
  const PTCGIO = { 'swsh4.5': 'swsh45', 'swsh4.5sv': 'swsh45sv', 'swsh3.5': 'swsh35', 'swsh10.5': 'pgo', 'sm7.5': 'sm75', 'sm3.5': 'sm35', cel25cc: 'cel25c', rc: 'bw11',
    '2011bw': 'mcd11', '2012bw': 'mcd12', '2014xy': 'mcd14', '2015xy': 'mcd15', '2016xy': 'mcd16', '2017sm': 'mcd17', '2018sm': 'mcd18', '2019sm': 'mcd19', '2021swsh': 'mcd21', '2022swsh': 'mcd22' };
  const ptcgioId = sid => PTCGIO[sid] || String(sid).replace(/^sv0(\d)/, 'sv$1').replace(/^swsh0(\d)/, 'swsh$1').replace(/\.5/, 'pt5');
  // TCGplayer's own product photo, from the product id the card database lists for each printing
  const pidImg = id => id ? `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_1000x1000.jpg` : '';
  const firstPid = v => { if (!v) return ''; if (v.thirdParty && v.thirdParty.tcgplayer) return String(v.thirdParty.tcgplayer); for (const d of Array.isArray(v.variants_detailed) ? v.variants_detailed : []) if (d && d.thirdParty && d.thirdParty.tcgplayer && !d.foil) return String(d.thirdParty.tcgplayer); return ''; };
  const ptcgioImg = (sid, localId) => `https://images.pokemontcg.io/${ptcgioId(sid)}/${String(localId).replace(/^0+(?=\d)/, '')}_hires.png`;

  async function search(l, q, { limit = 40, full = 12, set: setF = '' } = {}) {
    l = lang(l);
    let toks = norm(q).split(' ').filter(Boolean);
    if (!toks.length && !setF) return [];
    // one set (and its Trainer Gallery / Galarian Gallery / Shiny Vault): swsh9 → swsh9, swsh9tg
    const inSet = sid => !setF || sid === setF || (sid.startsWith(setF) && /^[a-z]{1,3}$/i.test(sid.slice(setF.length)));
    if (setF && !toks.length) { limit = 600; full = 8; }
    // nicknames
    let pin = null;
    for (const t of toks) if (ALIASES[t]) { pin = ALIASES[t]; toks = toks.filter(x => x !== t).concat(pin.words); }
    // a year ("pikachu 2021") is about the set, not a card number
    const year = String(q).split(/\s+/).find(t => /^(199\d|20[0-3]\d)$/.test(t)) || '';
    if (year) toks = toks.filter(t => t !== year);
    const numTok = String(q).split(/\s+/).find(t => t !== year && /\d/.test(t) && /^[A-Za-z-]{0,6}\d+[a-z]?(\/[A-Za-z]*\d+)?$/.test(t)) || (pin && pin.num) || '';
    const want = numTok ? numKey(numTok) : '';
    let prefix = (/^([A-Za-z]{2,5})\d/.exec(numTok) || [])[1];
    const gal = toks.find(t => t === 'tg' || t === 'gg' || t === 'rc');   // "eevee tg", "charizard rc": Trainer / Galarian Gallery, Radiant Collection
    toks = toks.map(t => t === 'mcd' || t === 'mcdonald' ? 'mcdonalds' : t);
    if (gal) { toks = toks.filter(t => t !== gal); prefix = prefix || gal; }
    const words = toks.filter(t => !/\d/.test(t) && !STYLE[t]);
    const chaseWanted = toks.some(t => STYLE[t] && t !== 'rare');
    const [cat, si] = await Promise.all([catalog(l), setIndex(l)]);
    const scored = [];
    for (const [id, localId, name, image] of cat) {
      const sid = id.slice(0, id.length - String(localId).length - 1), sx = si[sid] || {};
      if (!inSet(sid)) continue;
      if (/pocket/i.test(sx.serie || '') || /^tcgp/i.test(sid)) continue;   // TCG Pocket is a phone game, not cards
      if (year && !String(sx.date || '').startsWith(year) && !String(sx.name || '').includes(year)) continue;
      const nn = norm(name), nw = nn.split(' '), setHay = norm(sx.name + ' ' + String(sx.name || '').replace(/['’]/g, '') + ' ' + sx.code);
      let score = 0, ok = true;
      for (const w of words) {
        if (nw.includes(w)) score += 12;
        else if (nw.some(x => x.startsWith(w))) score += 7;
        else if (/[^\x00-\x7f]/.test(w) && nn.includes(w)) score += 7;   // ピカチュウ in ピカチュウex
        else if (setHay.split(' ').some(x => x.startsWith(w)) || norm(sx.code) === w) score += 4;
        else { ok = false; break; }
      }
      if (!ok) continue;
      if (want) { if (numKey(localId) !== want) continue; score += 30; }
      if (prefix && !String(localId).toUpperCase().startsWith(prefix.toUpperCase())) continue;
      if (!words.length && !want && !setF) continue;
      if (pin && sid === pin.set && numKey(localId) === numKey(pin.num)) score += 100;
      const chase = isChase(localId, sx.off) || /^(TG|GG|SV|RC)\d/i.test(localId);
      let price = null;
      if (tp) { const p = tp.find({ name: l === 'en' ? name : '', number: localId + (sx.off && /^\d+$/.test(localId) ? '/' + sx.off : ''), setName: sx.name, japanese: l === 'ja' }); if (p) price = Math.max(0, ...Object.values(p.prices || {})); }
      scored.push({ id, localId, name, image, sid, sx, score: score + (chaseWanted && chase ? 15 : 0), chase, price, date: sx.date || '' });
    }
    // best text match, then what it's worth (price, else chase cards), then newest
    const numOrder = (a, b) => (a.sid === b.sid ? 0 : a.sid.length - b.sid.length) || (parseInt(String(a.localId).replace(/^\D+/, ''), 10) || 0) - (parseInt(String(b.localId).replace(/^\D+/, ''), 10) || 0);
    if (setF && !toks.length) scored.sort(numOrder);   // browsing a set: in number order, like the binder
    else scored.sort((a, b) => b.score - a.score || (b.price ?? (b.chase ? 5000 : 0)) - (a.price ?? (a.chase ? 5000 : 0)) || b.date.localeCompare(a.date));
    const top = scored.slice(0, limit);
    // full details (prices, finishes, rarity) for the first few; the rest arrive light and load when picked
    const fulls = await Promise.all(top.slice(0, full).map(b => Promise.race([card(l, b.id).catch(() => null), sleep(9000).then(() => null)])));
    const out = top.map((b, i) => {
      const c = fulls[i];
      const base = c ? c : {
        id: b.id, localId: b.localId, name: b.name, image: b.image || null, _brief: true, _lang: l,
        set: { id: b.sid, name: b.sx.name || '' }, _set: { id: b.sid, name: b.sx.name || '', serie: b.sx.serie ? { name: b.sx.serie } : null, releaseDate: b.sx.date || '', tcgOnline: b.sx.code || '', abbreviation: null, cardCount: b.sx.off ? { official: b.sx.off } : null },
      };
      const e = c ? c : enrich(base);
      if (l === 'en') e._alt = e._alt || ptcgioImg(b.sid, b.localId);
      if (!e._pimg) { const pid = firstPid(e) || (e._tp && e._tp.productId); if (pid) e._pimg = pidImg(pid); }
      return e;
    });
    // TCGplayer's catalog for what TCGdex lacks (brand-new sets, English names for Japanese cards)
    if (out.length < 6 && tp && !setF) {
      const have = new Set(out.map(c => c._tp && c._tp.productId).filter(Boolean));
      for (const p of tp.search(q, { japanese: l === 'ja', limit })) if (!have.has(p.productId) && out.length < limit) out.push(pseudo(p, l));
    }
    return out;
  }

  /* Match inventory rows to cards: by TCGdex id, else set + number, else set + name. */
  async function match(l, items, { fresh = false } = {}) {
    l = lang(l);
    const all = await sets(l);
    const byNorm = new Map();
    for (const s of all) {
      for (const k of [s.id, s.name, s.tcgOnline, s.abbreviation && s.abbreviation.official].filter(Boolean)) { const was = byNorm.get(norm(k)); if (!was || s.id.length < was.length) byNorm.set(norm(k), s.id); }
    }
    let codes = null;
    const out = [];
    for (const it of items.slice(0, 100)) {
      try {
        let id = it.tcgdex || '';
        if (!id && it.ptcgio) id = it.ptcgio.replace(/^(sv)(\d)pt5/, '$1$2.5').replace(/^(sv)(\d)(?!\d)/, '$10$2'); // pokemontcg.io ids are close to TCGdex ids
        let c = id ? await card(l, id, { fresh }) : null;
        let how = c ? 'id' : '';
        if (!c) {
          let sid = byNorm.get(norm(it.setName)) || byNorm.get(norm(it.setCode));
          if (!sid && it.setCode) { codes = codes || await codeMap(l); sid = codes[norm(it.setCode)]; }
          if (sid) {
            // the set, then its gallery/vault siblings: Trainer Gallery, Galarian Gallery and Shiny Vault
            // cards live in their own sets (swsh9tg…) that share the main set's code
            const base = all.find(s => s.id === sid) || { id: sid, name: '' };
            const tail = (a, b) => a.startsWith(b) && /^[a-z]{1,3}$/i.test(a.slice(b.length));   // swsh9tg ↔ swsh9, swsh12.5gg ↔ swsh12.5
            const sibs = all.filter(s => s.id !== sid && (tail(s.id, sid) || tail(sid, s.id) || (base.name && s.name && (norm(s.name).startsWith(norm(base.name) + ' ') || norm(base.name).startsWith(norm(s.name) + ' ')))));
            const prefixed = /^[A-Z]{1,5}\d/.test(numKey(it.number));
            const order = prefixed ? [...sibs, base] : [base, ...sibs];
            let b = null;
            for (const s0 of order) {
              const s = await set(l, s0.id); const cards = (s && s.cards) || [];
              let hit = it.number ? cards.find(x => numKey(x.localId) === numKey(it.number)) : null;
              if (!hit && it.number && /promo/i.test(s0.name || '')) hit = cards.find(x => digitsKey(x.localId) === digitsKey(it.number));
              if (hit && it.name && norm(hit.name).split(' ')[0] !== norm(it.name).split(' ')[0]) hit = null;   // number typo guard
              if (hit) { b = hit; break; }
            }
            if (!b && it.name) { const s = await set(l, sid); const hits = ((s && s.cards) || []).filter(x => norm(x.name) === norm(it.name)); if (hits.length === 1) b = hits[0]; }
            if (b) { c = await card(l, b.id, { fresh }); how = 'set'; }
          }
          // still nothing: TCGplayer's catalog by name + number
          if (!c && tp && it.number) { const p = tp.find({ name: it.name, number: it.number, setName: it.setName || it.setCode, japanese: l === 'ja' }); if (p) { c = pseudo(p, l); how = 'tcgplayer'; } }
        }
        out.push({ key: it.key, card: c, how: c ? how : 'none' });
      } catch (e) { out.push({ key: it.key, card: null, how: 'error', error: e.message }); }
    }
    return out;
  }
  /* Sets for the picker, newest first (no TCG Pocket). */
  async function setList(l) {
    const si = await setIndex(lang(l));
    return Object.entries(si).filter(([id, x]) => !/pocket/i.test(x.serie || '') && !/^tcgp/i.test(id) && !/^A\d/.test(id))
      .map(([id, x]) => ({ id, name: x.name, code: x.code || '', date: x.date || '', count: x.off || null, serie: x.serie || '' }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  }
  return { search, card, match, sets, warm, catalog, setIndex, setList, health: () => ({ ...health }) };
};
