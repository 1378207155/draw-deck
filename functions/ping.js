import { json } from './_lib.js';
// 健康检查：前端 file:// 模式下探测本地/代理是否可用
export async function onRequestGet() {
  return json(200, { ok: true });
}
