import { relay, UPSTREAM } from '../../_lib.js';
// Agnes /agnes/v1/* → https://api.agnes-ai.cn/v1/*（去掉 /agnes 前缀）
export async function onRequest(context) {
  const p = context.params.path;
  const tail = Array.isArray(p) ? p.join('/') : (p || '');
  return relay(context.request, UPSTREAM.agnes, '/v1/' + tail);
}
