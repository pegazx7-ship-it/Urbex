// Urbex Worker: synchronizacja trasy (KV) + rozwijanie skróconych linków Google Maps
// Wymaga: KV binding "TRIPS" oraz sekretu "KEY" (hasło dostępu)
const ORIGIN = 'https://pegazx7-ship-it.github.io';
const SHORT = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//;
const COORDS = /@-?\d+\.\d+,-?\d+\.\d+|!3d-?\d+\.\d+!4d-?\d+\.\d+|[?&](q|ll)=-?\d+\.\d+/;

export default {
  async fetch(req, env) {
    const h = {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Headers': 'X-Key,Content-Type',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
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

    if (url.pathname === '/trip') {
      if (req.method === 'GET') {
        const v = await env.TRIPS.get('current');
        return j(v ? JSON.parse(v) : null);
      }
      if (req.method === 'PUT') {
        const txt = await req.text();
        if (txt.length > 200000) return j({ error: 'za duże' }, 413);
        let inc; try { inc = JSON.parse(txt); } catch (e) { return j({ error: 'zły JSON' }, 400); }
        const raw = await env.TRIPS.get('current');
        const old = raw ? JSON.parse(raw) : null;
        if (old && old.id === inc.id) {
          // odhaczone miejsca nigdy nie "odhaczają się z powrotem"
          const done = new Map((old.locs || []).filter(l => l.done).map(l => [l.id, l.done]));
          inc.locs = (inc.locs || []).map(l => ({ ...l, done: l.done || done.get(l.id) || null }));
        }
        inc.updated = Date.now();
        await env.TRIPS.put('current', JSON.stringify(inc));
        return j({ ok: 1, updated: inc.updated });
      }
    }
    return j({ error: 'nie ma takiej ścieżki' }, 404);
  }
};
