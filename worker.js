// Urbex Worker v2: wspólna synchronizacja wypraw (KV) + rozwijanie skróconych linków Google Maps
// Wymaga: KV binding "TRIPS" oraz sekretu "KEY" (hasło dostępu)
const ORIGIN = 'https://pegazx7-ship-it.github.io';
const SHORT = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//;
const COORDS = /@-?\d+\.\d+,-?\d+\.\d+|!3d-?\d+\.\d+!4d-?\d+\.\d+|[?&](q|ll)=-?\d+\.\d+/;
const ID = /^[0-9A-Za-z_-]{1,40}$/;

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
  const o={id:b.id||a.id,v:2,meta:mergeEnt(a.meta,b.meta),locs:mergeMap(a.locs,b.locs),fuel:mergeMap(a.fuel,b.fuel),exp:mergeMap(a.exp,b.exp)};
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
        if (txt.length > 300000) return j({ error: 'za duże' }, 413);
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
        if (txt.length > 300000) return j({ error: 'za duże' }, 413);
        let inc; try { inc = JSON.parse(txt); } catch (e) { return j({ error: 'zły JSON' }, 400); }
        inc.updated = Date.now();
        await env.TRIPS.put('current', JSON.stringify(inc));
        return j({ ok: 1, updated: inc.updated });
      }
    }
    return j({ error: 'nie ma takiej ścieżki' }, 404);
  }
};
