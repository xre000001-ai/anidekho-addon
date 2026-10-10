// AniDekho addon v1.0.0 — AnimeDekho.tv (VidStream/ravok) উৎস-স্ট্রিম-অ্যাডন
// রেসিপি: tt→TMDB id→ /embed/{tmdb}/{s}-{e} →ravok vid→ getVideo→ m3u8→ প্রক্সি; ব্যর্থ-হলে-externalUrl-ফলব্যাক
const http = require('http');
const crypto = require('crypto');
const URL_ = require('url');
const VERSION = '1.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const TMDB_KEY = '439c478a771f35c05022f9feabcca01c';
const SECRET = 'anidekho-' + crypto.randomBytes(8).toString('hex');
const PUBLIC_BASE = process.env.PUBLIC_BASE || ('http://127.0.0.1:' + (process.env.PORT || 7007));
const log = (...a) => console.log('[AniDekho]', ...a);
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
function sign(u) { return crypto.createHash('md5').update(SECRET + u).digest('hex').slice(0, 16); }
function validPx(u, k) { return u && k === sign(u); }

const MANIFEST = {
  id: 'community.anidekho', version: VERSION, name: 'AniDekho',
  description: 'Anime (Hindi & multi-dub) streams from AnimeDekho — VidStream server, all episodes',
  types: ['series', 'movie'], resources: ['stream'], idPrefixes: ['tt'], catalogs: []
};

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(b);
}
async function fetchText(url, ms, headers) {
  const r = await withTimeout(fetch(url, { headers: Object.assign({ 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' }, headers || {}) }), ms || 10000);
  if (!r || !r.ok) throw new Error('http ' + (r && r.status));
  return r.text();
}

// ---------- TMDB ----------
async function tmdbLookup(tt) {
  const j = JSON.parse(await fetchText('https://api.themoviedb.org/3/find/' + tt + '?api_key=' + TMDB_KEY + '&external_source=imdb_id', 8000));
  if (j.tv_results && j.tv_results.length) return { kind: 'series', tmdb: j.tv_results[0].id, title: j.tv_results[0].name };
  if (j.movie_results && j.movie_results.length) return { kind: 'movie', tmdb: j.movie_results[0].id, title: j.movie_results[0].title };
  return null;
}

// ---------- AnimeDekho ----------
async function dekhoVid(tmdb, s, e) {
  const u = 'https://animedekho.tv/embed/' + tmdb + '/' + s + '-' + e;
  const t = await fetchText(u, 12000);
  const m = t.match(/ravok\.buzz\/video\/([a-f0-9]{16,40})/);
  return m ? { vid: m[1], embed: u } : null;
}
async function ravokResolve(vid) {
  const body = 'vid=' + vid + '&do=getVideo';
  const r = await withTimeout(fetch('https://ravok.buzz/video/', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://ravok.buzz/video/' + vid,
      'Origin': 'https://ravok.buzz',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': '*/*'
    },
    body: body
  }), 10000).catch(() => null);
  if (!r || !r.ok) throw new Error('ravok http ' + (r && r.status));
  const t = await r.text();
  const urls = t.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/g) || [];
  const mp4s = t.match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/g) || [];
  return { hls: urls[0] || null, mp4: mp4s[0] || null, raw: t.slice(0, 300) };
}

// ---------- প্রক্সি ----------
function pxUrl(u, kind) { return PUBLIC_BASE + '/proxy/' + kind + '?u=' + encodeURIComponent(u) + '&k=' + sign(u); }
function upHeaders(u) {
  const h = { 'User-Agent': UA, 'Accept': '*/*' };
  if (/ravok|vidstream/.test(u)) { h['Referer'] = 'https://ravok.buzz/'; }
  return h;
}
function rewritePlaylist(t, base) {
  const master = t.indexOf('#EXT-X-STREAM-INF') >= 0;
  return t.split('\n').map(line => {
    const tr = line.trim();
    if (!tr) return line;
    if (tr[0] === '#') return line.replace(/URI="([^"]+)"/, (m, x) => 'URI="' + pxUrl(new URL(x, base).href, master ? 'raw' : 'seg') + '"');
    const abs = new URL(tr, base).href;
    return pxUrl(abs, master ? 'm3u8' : 'seg');
  }).join('\n');
}
function pipeUpstream(res, u, kind, range) {
  const h = upHeaders(u);
  if (range) h['Range'] = range;
  return fetch(u, { headers: h }).then(r => {
    if (!r || !r.ok) throw new Error('up ' + (r && r.status));
    const hd = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': r.headers.get('content-type') || (kind === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'application/octet-stream') };
    const cl = r.headers.get('content-length');
    if (cl) hd['Content-Length'] = cl;
    if (r.headers.get('content-range')) hd['Content-Range'] = r.headers.get('content-range');
    res.writeHead(r.status, hd);
    return r.body.pipe(res);
  });
}

// ---------- স্ট্রিম ----------
async function streams(type, id) {
  const m = id.match(/tt(\d+):(\d+):(\d+)/);
  if (!m) return [];
  const s = parseInt(m[2], 10), e = parseInt(m[3], 10);
  const lk = await tmdbLookup('tt' + m[1]).catch(() => null);
  if (!lk) return [];
  const vid = await dekhoVid(lk.tmdb, s, e).catch(() => null);
  const cards = [];
  const info = '⧉ ' + lk.title + '\n⬡ S' + s + 'E' + e + ' · AniDekho';
  if (vid) {
    const rv = await ravokResolve(vid.vid).catch(eR => { log('getVideo fail', eR.message); return null; });
    if (rv && rv.hls) {
      cards.push({ name: 'AniDekho\nVidStream', title: info + ' · HLS', description: 'Hindi/multi-dub · m3u8', url: pxUrl(rv.hls, 'm3u8') });
    } else if (rv && rv.mp4) {
      cards.push({ name: 'AniDekho\nVidStream', title: info + ' · MP4', description: 'Hindi/multi-dub · mp4', url: pxUrl(rv.mp4, 'raw') });
    } else { // geo/ব্লক-ফলব্যাক: এমবেড-পাতা-সরাসরি (ওদের-নিজের-প্লেয়ার)
      cards.push({ name: 'AniDekho\nWeb', title: info, description: 'AniDekho player (opens web player)', externalUrl: vid.embed });
    }
  }
  log(type, id, '→', cards.length, 'card(s)');
  return cards;
}

const server = http.createServer(async (req, res) => {
  const u = URL_.parse(req.url, true);
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const q = u.query || {};
  try {
    if (p === '/manifest.json') return json(res, 200, MANIFEST);
    if (p === '/status') return json(res, 200, { ok: true, version: VERSION, t: Date.now() });
    const pm = p.match(/^\/proxy\/(m3u8|seg|raw)$/);
    if (pm) {
      const tu = String(q.u || ''), k = String(q.k || '');
      if (!validPx(tu, k)) { res.writeHead(403); return res.end('bad sig'); }
      if (pm[1] === 'm3u8') {
        const t = await fetchText(tu, 10000, upHeaders(tu));
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end(rewritePlaylist(t, tu));
      }
      return pipeUpstream(res, tu, pm[1], req.headers.range).catch(eP => { log('proxy fail', eP.message); try { res.writeHead(502); res.end(); } catch (e2) {} });
    }
    const sm = p.match(/^\/stream\/(series|movie)\/(.+)\.json$/);
    if (sm) return json(res, 200, { streams: await streams(sm[1], decodeURIComponent(sm[2])) });
    return json(res, 404, {});
  } catch (eS) {
    log('err', eS.message);
    try { json(res, 500, { error: eS.message }); } catch (e2) {}
  }
});
const PORT = process.env.PORT || 7007;
server.listen(PORT, '0.0.0.0', () => log('AniDekho v' + VERSION, 'on port', PORT));
