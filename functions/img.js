import { imgFetch, json } from './_lib.js';
// 图片代理 /img?url=... —— 下载用：同源才能 fetch 成 blob；绕防盗链（UA + Referer）
// 缩略图 w 参数在边缘暂不支持（无 PIL），返回原图；将来可接 Cloudflare Image Resizing
export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  const target = u.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return json(400, { error: 'bad url' });
  try {
    return await imgFetch(target);
  } catch (e) {
    return json(502, { error: '图片代理失败: ' + ((e && e.message) || String(e)) });
  }
}
