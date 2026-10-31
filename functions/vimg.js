import { json } from './_lib.js';
// 视频透传代理 /vimg?url=... —— 下载视频用：同源才能 fetch 成 blob（与 /img 图片代理并列）
// 视频不走图片代理（imgFetch 的 Referer/UA 是图片取向，且避免图片缓存/嗅探逻辑干扰）
export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  const target = u.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return json(400, { error: 'bad url' });
  try {
    let origin = '';
    try { origin = new URL(target).origin + '/'; } catch (e) {}
    const resp = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': origin } });
    const ctype = resp.headers.get('Content-Type') || 'video/mp4';
    const data = await resp.arrayBuffer();
    return new Response(data, {
      status: resp.status,
      headers: { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return json(502, { error: '视频代理失败: ' + ((e && e.message) || String(e)) });
  }
}
