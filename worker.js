// Urbex Worker v3: synchronizacja wypraw (KV) + rozwijanie linków Google Maps + zdjęcia w Telegramie
// Wymaga: KV binding "TRIPS", sekretu "KEY" (hasło), sekretu "BOT_TOKEN" i zmiennej "CHAT_ID"
const ORIGIN = 'https://pegazx7-ship-it.github.io';
const SHORT = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//;
const COORDS = /@-?\d+\.\d+,-?\d+\.\d+|!3d-?\d+\.\d+!4d-?\d+\.\d+|[?&](q|ll)=-?\d+\.\d+/;
const ID = /^[0-9A-Za-z_-]{1,40}$/;

const FID = /^[0-9A-Za-z_-]{10,300}$/;
const TG = 'https://api.telegram.org/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// wywołanie metody Bot API; przy 429 czeka i ponawia
async function tg(env, method, body, tries = 3) {
  let d = null;
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await fetch(TG + 'bot' + env.BOT_TOKEN + '/' + method, { method: 'POST', body }); }
    catch (e) { return { ok: false, description: 'brak połączenia z Telegramem' }; }
    d = null; try { d = await r.json(); } catch (e) {}
    if (d && d.ok) return d;
    if (r.status === 429 && i < tries - 1) {
      const ra = Math.min((d && d.parameters && d.parameters.retry_after) || 3, 20);
      await sleep(ra * 1000 + 200);
      continue;
    }
    break;
  }
  return d || { ok: false, description: 'brak odpowiedzi Telegrama' };
}

/* --- wspólna logika łączenia zmian (ta sama w Workerze i w aplikacji) --- */
const canon=v=>JSON.stringify(v,(k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(y=>[y,x[y]])):x);
function mergeEnt(a,b){
  a=a||{};b=b||{};
  const d=Math.max(a.d||0,b.d||0);
  if(d)return{d};
  const o={f:{},t:{}},ta=a.t||{},tb=b.t||{},fa=a.f||{},fb=b.f||{};
  for(const k of new Set([...Object.keys(ta),...Object.keys(tb)])){
    const x=ta[k]||0,y=tb[k]||0;
    const pickB=y>x||(y===x&&canon(fb[k])>canon(fa[k]));
    o.f[k]=pickB?fb[k]:fa[k];o.t[k]=pickB?y:x;
  }
  return o;
}
function mergeMap(a,b){
  a=a||{};b=b||{};const o={};
  for(const k of new Set([...Object.keys(a),...Object.keys(b)]))o[k]=mergeEnt(a[k],b[k]);
  return o;
}
function mergeDoc(a,b){
  a=a||{};b=b||{};
  const o={id:b.id||a.id,v:2,meta:mergeEnt(a.meta,b.meta),locs:mergeMap(a.locs,b.locs),fuel:mergeMap(a.fuel,b.fuel),exp:mergeMap(a.exp,b.exp),pic:mergeMap(a.pic,b.pic)};
  const del=Math.max(a.deleted||0,b.deleted||0);if(del)o.deleted=del;
  return o;
}
const stripU=d=>{const o={...d};delete o.updated;return o};
/* --- koniec wspólnej logiki --- */


export default {
  async fetch(req, env) {
    const h = {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Headers': 'X-Key,Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Content-Type': 'application/json'
    };
    const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: h });
    if (req.method === 'OPTIONS') return new Response(null, { headers: h });
    if (!env.KEY || req.headers.get('X-Key') !== env.KEY) return j({ error: 'auth' }, 401);

    const url = new URL(req.url);

    if (url.pathname === '/expand') {
      let u = url.searchParams.get('u') || '';
      if (!SHORT.test(u)) return j({ error: 'niedozwolony adres' }, 400);
      try {
        for (let i = 0; i < 6; i++) {
          const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } });
          const loc = r.headers.get('Location');
          if (!loc) break;
          u = new URL(loc, u).href;
          if (COORDS.test(u) || /consent\./.test(u)) break;
        }
        return j({ url: u });
      } catch (e) { return j({ error: 'błąd rozwijania' }, 502); }
    }

    // ---- zdjęcia w Telegramie ----
    if (url.pathname === '/topic' || url.pathname === '/photo' || url.pathname.startsWith('/file/')) {
      if (!env.BOT_TOKEN || !env.CHAT_ID) return j({ error: 'Brak BOT_TOKEN lub CHAT_ID w ustawieniach Workera.' }, 500);
    }
    if (url.pathname === '/topic' && req.method === 'POST') {
      let b; try { b = await req.json(); } catch (e) { b = {}; }
      const name = String((b && b.name) || 'Urbex').slice(0, 100);
      const d = await tg(env, 'createForumTopic', new URLSearchParams({ chat_id: env.CHAT_ID, name }));
      return d.ok ? j({ tid: d.result.message_thread_id }) : j({ error: d.description || 'błąd Telegrama' }, 502);
    }
    if (url.pathname === '/photo' && req.method === 'POST') {
      if (Number(req.headers.get('Content-Length') || 0) > 20e6) return j({ error: 'zdjęcie za duże' }, 413);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return j({ error: 'puste zdjęcie' }, 400);
      if (buf.byteLength > 20e6) return j({ error: 'zdjęcie za duże' }, 413);
      let type = (req.headers.get('Content-Type') || '').split(';')[0];
      if (!/^image\//.test(type)) type = 'image/jpeg';
      const tid = url.searchParams.get('tid') || '';
      const cap = (url.searchParams.get('cap') || '').slice(0, 200);
      const send = withThread => {
        const fd = new FormData();
        fd.append('chat_id', env.CHAT_ID);
        if (withThread) fd.append('message_thread_id', tid); else if (cap) fd.append('caption', cap);
        fd.append('photo', new Blob([buf], { type }), 'foto.jpg');
        return tg(env, 'sendPhoto', fd, 4);
      };
      const hasT = /^\d+$/.test(tid);
      let d = await send(hasT);
      if (!d.ok && hasT && /thread|topic/i.test(d.description || '')) d = await send(false);
      if (!d.ok) return j({ error: d.description || 'błąd Telegrama' }, 502);
      const ph = ((d.result && d.result.photo) || []).slice().sort((a, b) => a.width * a.height - b.width * b.height);
      if (!ph.length) return j({ error: 'Telegram nie zwrócił zdjęcia' }, 502);
      const full = ph[ph.length - 1], th = ph.find(p => p.width >= 300) || ph[0];
      return j({ fid: full.file_id, th: th.file_id, mid: d.result.message_id });
    }
    const fm = url.pathname.match(/^\/file\/([^/]+)$/);
    if (fm && req.method === 'GET') {
      if (!FID.test(fm[1])) return j({ error: 'zły identyfikator pliku' }, 400);
      const g = await tg(env, 'getFile', new URLSearchParams({ file_id: fm[1] }), 2);
      if (!g.ok || !g.result || !g.result.file_path) return j({ error: g.description || 'nie ma takiego pliku' }, 404);
      let r;
      try { r = await fetch(TG + 'file/bot' + env.BOT_TOKEN + '/' + g.result.file_path); } catch (e) { return j({ error: 'błąd pobierania' }, 502); }
      if (!r.ok) return j({ error: 'błąd pobierania' }, 502);
      const ct = r.headers.get('Content-Type') || '';
      return new Response(r.body, { headers: {
        'Access-Control-Allow-Origin': ORIGIN,
        'Content-Type': /^image\//.test(ct) ? ct : 'image/jpeg',
        'Cache-Control': 'private, max-age=604800'
      } });
    }

    // lista wypraw w chmurze (bez usuniętych)
    if (url.pathname === '/trips' && req.method === 'GET') {
      const l = await env.TRIPS.list({ prefix: 't:' });
      return j(l.keys.map(k => ({ id: k.name.slice(2), ...(k.metadata || {}) })).filter(x => !x.deleted));
    }

    // wspólna wyprawa: GET (opcjonalnie ?since=) i POST (scalenie zmian)
    const m = url.pathname.match(/^\/sync\/([^/]+)$/);
    if (m) {
      const id = m[1];
      if (!ID.test(id)) return j({ error: 'zły identyfikator' }, 400);
      const key = 't:' + id;
      const old = await env.TRIPS.get(key, 'json');
      if (req.method === 'GET') {
        if (!old) return j({ none: true });
        if (String(old.updated) === url.searchParams.get('since')) return j({ same: true });
        return j(old);
      }
      if (req.method === 'POST') {
        const txt = await req.text();
        if (txt.length > 400000) return j({ error: 'za duże' }, 413);
        let inc; try { inc = JSON.parse(txt); } catch (e) { return j({ error: 'zły JSON' }, 400); }
        if (!inc || inc.v !== 2 || typeof inc !== 'object') return j({ error: 'zły format' }, 400);
        inc.id = id;
        const merged = mergeDoc(old || {}, inc);
        const changed = !old || canon(stripU(old)) !== canon(stripU(merged));
        if (changed) {
          merged.updated = Date.now();
          const f = (merged.meta && merged.meta.f) || {};
          await env.TRIPS.put(key, JSON.stringify(merged), {
            metadata: { name: String(f.name == null ? '' : f.name).slice(0, 100), date: f.date || '', updated: merged.updated, deleted: merged.deleted ? 1 : 0 }
          });
        } else merged.updated = old.updated;
        return j(merged);
      }
    }

    // stary format (jedna trasa) – zostawiony dla zgodności
    if (url.pathname === '/trip') {
      if (req.method === 'GET') {
        const v = await env.TRIPS.get('current');
        return j(v ? JSON.parse(v) : null);
      }
      if (req.method === 'PUT') {
        const txt = await req.text();
        if (txt.length > 400000) return j({ error: 'za duże' }, 413);
        let inc; try { inc = JSON.parse(txt); } catch (e) { return j({ error: 'zły JSON' }, 400); }
        inc.updated = Date.now();
        await env.TRIPS.put('current', JSON.stringify(inc));
        return j({ ok: 1, updated: inc.updated });
      }
    }
    return j({ error: 'nie ma takiej ścieżki' }, 404);
  }
};
