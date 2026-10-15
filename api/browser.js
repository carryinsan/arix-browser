/**
 * Arix Browser keyless search backend.
 * Fixed-source retrieval only; no API keys, telemetry, persistent query cache,
 * arbitrary-URL proxying, or result fallbacks that open another tab.
 */
const SOURCES = Object.freeze({
  webA: { kind: 'web', url: (q, region, safe) => `https://www.google.com/search?q=${enc(q)}&gl=${enc(region.toLowerCase())}&safe=${safe ? 'active' : 'off'}` },
  webB: { kind: 'web', url: (q, region, safe) => `https://www.bing.com/search?format=rss&q=${enc(q)}&cc=${enc(region.toLowerCase())}&adlt=${safe ? 'strict' : 'off'}` },
  webC: { kind: 'web', url: (q, region, safe) => `https://search.brave.com/search?q=${enc(q)}&country=${enc(region.toLowerCase())}&safesearch=${safe ? 'moderate' : 'off'}` },
  videos: { kind: 'video', url: q => `https://www.youtube.com/results?search_query=${enc(q)}` },
  news: { kind: 'news', url: (q, region) => `https://news.google.com/rss/search?q=${enc(q)}&hl=en-${enc(region.toUpperCase())}&gl=${enc(region.toUpperCase())}&ceid=${enc(region.toUpperCase())}:en` }
});
const SOURCE_IDS = Object.keys(SOURCES);
const MAX_QUERY = 250, MAX_RESULTS = 8, FETCH_TIMEOUT_MS = 6200, RATE_WINDOW_MS = 60_000, RATE_LIMIT = 45;
const rates = new Map();
const enc = v => encodeURIComponent(String(v ?? ''));
function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.end(JSON.stringify(payload));
}
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    const key = name.toLowerCase();
    if (key[0] === '#') { const n = key[1] === 'x' ? parseInt(key.slice(2),16) : parseInt(key.slice(1),10); return Number.isFinite(n)&&n>=0&&n<=0x10ffff?String.fromCodePoint(n):all; }
    return named[key] ?? all;
  });
}
function cleanText(value='') {
  return decodeEntities(String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\\u003c/gi,'<').replace(/\\u003e/gi,'>').replace(/\\n/g,' ').replace(/\s+/g,' ')).trim();
}
function safeResultUrl(raw, base='https://example.org/') {
  if(typeof raw!=='string'||!raw.trim())return null;
  let candidate=raw.trim();
  if(candidate.startsWith('//'))candidate='https:'+candidate;
  if(candidate.startsWith('/url?')){try{const p=new URL(candidate,base);candidate=p.searchParams.get('q')||p.searchParams.get('url')||''}catch{return null}}
  try{const u=new URL(candidate,base);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return null;const host=u.hostname.toLowerCase();if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal'))return null;if(/^(\d{1,3}\.){3}\d{1,3}$/.test(host)){const p=host.split('.').map(Number);if(p.some(n=>n>255)||p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168))return null}return u.href}catch{return null}
}
function extractTag(s,tag){const escaped=tag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const m=String(s).match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`,'i'));return m?cleanText(m[1]):''}
function dedupe(items,limit){const seen=new Set(),out=[];for(const x of items){const url=safeResultUrl(x.url);if(!url||!x.title)continue;const key=url.replace(/#.*$/,'').replace(/\/$/,'').toLowerCase();if(seen.has(key))continue;seen.add(key);out.push({title:cleanText(x.title).slice(0,500),url,snippet:cleanText(x.snippet||'').slice(0,650),category:x.category||'web'});if(out.length>=limit)break}return out}
function parseRss(xml,limit,category,base){const out=[];const items=String(xml).match(/<item\b[\s\S]*?<\/item>/gi)||[];for(const item of items){if(out.length>=limit)break;const title=extractTag(item,'title'),url=safeResultUrl(extractTag(item,'link'),base),snippet=extractTag(item,'description');if(title&&url)out.push({title,url,snippet,category})}return dedupe(out,limit)}
function parseGoogle(html,limit){const out=[];const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?<h3\b[^>]*>[\s\S]*?<\/h3>[\s\S]*?)<\/a>/gi;let m;while((m=re.exec(html))&&out.length<limit){const url=safeResultUrl(m[1],'https://www.google.com');const title=cleanText(m[2].match(/<h3\b[^>]*>[\s\S]*?<\/h3>/i)?.[0]||'');if(!url||!title)continue;let host='';try{host=new URL(url).hostname.toLowerCase()}catch{}if(host==='google.com'||host.endsWith('.google.com')||host.endsWith('.google.co.in'))continue;const tail=String(html).slice(re.lastIndex,re.lastIndex+1500);const sm=tail.match(/class=["'][^"']*(?:VwiC3b|aCOpRe|IsZvec)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);out.push({title,url,snippet:sm?cleanText(sm[1]):'',category:'web'})}return dedupe(out,limit)}
function parseOtherWeb(html,limit){const out=[];const patterns=[/<a\b[^>]*class=["'][^"']*(?:heading-serpresult|result-header|snippet-title)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*(?:heading-serpresult|result-header|snippet-title)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi];for(const re of patterns){let m;while((m=re.exec(html))&&out.length<limit){const url=safeResultUrl(m[1],'https://search.brave.com'),title=cleanText(m[2]);if(url&&title&&!/search\.brave\.com$/i.test(new URL(url).hostname))out.push({title,url,snippet:'',category:'web'})}if(out.length)break}return dedupe(out,limit)}
function parseJsonObjectAt(text,start){const open=text.indexOf('{',start);if(open<0)return null;let depth=0,quoted=false,escaped=false;for(let i=open;i<text.length;i++){const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue}if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{return JSON.parse(text.slice(open,i+1))}catch{return null}}}return null}
function parseVideos(html,limit){const out=[];const marker=/"videoRenderer"\s*:\s*\{/g;let m;while((m=marker.exec(html))&&out.length<limit){const obj=parseJsonObjectAt(html,m.index+m[0].indexOf('{'));if(!obj?.videoId)continue;const title=obj.title?.runs?.map(x=>x.text||'').join('')||obj.title?.simpleText||'';if(!title)continue;const desc=obj.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(x=>x.text||'').join('')||'';const channel=obj.ownerText?.runs?.map(x=>x.text||'').join('')||obj.shortBylineText?.runs?.map(x=>x.text||'').join('')||'';out.push({title,url:`https://www.youtube.com/watch?v=${encodeURIComponent(obj.videoId)}`,snippet:desc||channel,category:'video'})}return dedupe(out,limit)}
function getIp(req){const f=req.headers?.['x-forwarded-for'];return (typeof f==='string'&&f?f.split(',')[0].trim():String(req.socket?.remoteAddress||'unknown')).slice(0,80)}
function rateLimited(ip){const now=Date.now();let r=rates.get(ip);if(!r||now-r.start>=RATE_WINDOW_MS)r={start:now,count:0};r.count++;rates.set(ip,r);if(rates.size>4000){for(const [k,v] of rates)if(now-v.start>RATE_WINDOW_MS)rates.delete(k);while(rates.size>3500)rates.delete(rates.keys().next().value)}return r.count>RATE_LIMIT}
async function fetchText(url){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);try{const response=await fetch(url,{method:'GET',signal:controller.signal,redirect:'follow',headers:{'Accept':'text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en-IN,en;q=0.9','User-Agent':'Mozilla/5.0 (compatible; ArixBrowser/1.1)'}});if(!response.ok)throw new Error('upstream-unavailable');const text=await response.text();if(!text||text.length>5_000_000)throw new Error('invalid-upstream-response');return text}finally{clearTimeout(timer)}}
async function retrieve(id,query,region,safe,limit){const source=SOURCES[id];try{let url=source.url(query,region,safe);if(id==='news')url=`https://news.google.com/rss/search?q=${enc(query)}&hl=en-${enc(region.toUpperCase())}&gl=${enc(region.toUpperCase())}&ceid=${enc(region.toUpperCase())}:en`;const body=await fetchText(url);if(id==='webB')return parseRss(body,limit,'web','https://www.bing.com');if(id==='news')return parseRss(body,limit,'news','https://news.google.com');if(id==='webA')return parseGoogle(body,limit);if(id==='webC')return parseOtherWeb(body,limit);return parseVideos(body,limit)}catch{return []}}
export default async function handler(req,res){
  if(req.method==='OPTIONS'){res.setHeader('Allow','GET, POST, OPTIONS');res.setHeader('Cache-Control','no-store');return send(res,204,{})}
  if(req.method==='GET')return send(res,200,{ok:true,name:'Arix Browser API',version:'1.1.0',apiKeyRequired:false,privacy:'No persistent query cache or analytics in this function.'});
  if(req.method!=='POST'){res.setHeader('Allow','GET, POST, OPTIONS');return send(res,405,{error:'Method not allowed.'})}
  if(rateLimited(getIp(req)))return send(res,429,{error:'Too many searches. Please wait and try again.'});
  try{
    let body=req.body;if(typeof body==='string'){if(body.length>12000)return send(res,413,{error:'Request is too large.'});try{body=JSON.parse(body)}catch{return send(res,400,{error:'Invalid JSON request.'})}}
    if(!body||typeof body!=='object'||Array.isArray(body))return send(res,400,{error:'A JSON object is required.'});
    const query=typeof body.query==='string'?body.query.trim().replace(/\s+/g,' '):'';if(!query)return send(res,400,{error:'Enter a search query.'});if(query.length>MAX_QUERY)return send(res,400,{error:`Search query must be ${MAX_QUERY} characters or fewer.`});
    const mode=['all','web','videos','news'].includes(body.mode)?body.mode:'all';const rawRegion=typeof body.region==='string'?body.region.toUpperCase():'IN';const region=/^[A-Z]{2}$/.test(rawRegion)?rawRegion:'IN';const safe=body.safeSearch!==false;const n=Number(body.limit);const limit=Number.isFinite(n)?Math.max(1,Math.min(MAX_RESULTS,Math.floor(n))):6;
    const ids=mode==='web'?['webA','webB','webC']:mode==='videos'?['videos']:mode==='news'?['news']:SOURCE_IDS;
    const retrieved=await Promise.all(ids.map(id=>retrieve(id,query,region,safe,limit)));
    const results=dedupe(retrieved.flat(),Math.min(MAX_RESULTS*ids.length,30));
    // No per-source identifiers or fallback search URLs leave the backend.
    return send(res,200,{ok:true,query,mode,results,count:results.length,attempted:ids.length,returnedSources:retrieved.filter(items=>items.length).length,note:'Results are best-effort. Arix does not invent missing results or open a search source in another tab.'});
  }catch{return send(res,500,{error:'Arix could not complete this search. Please try again.'})}
}
