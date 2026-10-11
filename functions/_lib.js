// Pages Functions 共享模块：上游地址、CORS、转发（重试+UA）、图片代理
// 对应本地 server.py 的 _proxy / _img_proxy 逻辑

export const UPSTREAM = {
  sense: 'https://token.sensenova.cn',
  agnes: 'https://apihub.agnes-ai.com',
  ms: 'https://api-inference.modelscope.cn',
  cf: 'https://api.cloudflare.com'
};

// CF 账户 ID 兜底值（与本地 server.py 一致）；页面会通过 X-CF-Account-Id 头覆盖
export const DEFAULT_CF_ACCOUNT = 'af4d85429a77278c53432d60eeea800a';

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Cache-Control, X-ModelScope-Async-Mode, X-ModelScope-Task-Type, X-CF-Account-Id'
};

export function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

// OPTIONS 预检统一回复
export function preflight() {
  return new Response(null, { status: 204, headers: { ...CORS, 'Content-Length': '0' } });
}

// 透传到上游：Authorization / Content-Type / X-ModelScope-* 一并带上；5xx 与网络错自动重试 3 次
export async function relay(request, upstream, pathTail) {
  const method = request.method;
  const body = (method !== 'GET' && method !== 'HEAD') ? await request.arrayBuffer() : null;
  const headers = new Headers();
  headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  const auth = request.headers.get('Authorization');
  if (auth) headers.set('Authorization', auth);
  // 魔搭异步模式等自定义头透传
  for (const [hk, hv] of request.headers.entries()) {
    if (hk.toLowerCase().startsWith('x-modelscope')) headers.set(hk, hv);
  }
  let search = '';
  try { search = new URL(request.url).search; } catch (e) {}
  const url = upstream + pathTail + search;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, { method, headers, body });
      const ctype = resp.headers.get('Content-Type') || 'application/json; charset=utf-8';
      const data = await resp.arrayBuffer();
      return new Response(data, { status: resp.status, headers: { 'Content-Type': ctype, ...CORS } });
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 800));
    }
  }
  return json(502, { error: '转发到上游失败(' + upstream + '): ' + ((lastErr && lastErr.message) || String(lastErr)) });
}

// 图片代理：绕防盗链（UA + Referer），透传 Content-Type，缓存 1 小时
export async function imgFetch(target) {
  let origin = '';
  try { origin = new URL(target).origin + '/'; } catch (e) {}
  const resp = await fetch(target, { headers: { 'User-Agent': BROWSER_UA, 'Referer': origin } });
  const ctype = resp.headers.get('Content-Type') || 'application/octet-stream';
  const data = await resp.arrayBuffer();
  return new Response(data, {
    status: resp.status,
    headers: { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' }
  });
}
