import { relay, UPSTREAM } from '../../_lib.js';
// 魔搭 /ms/v1/* → https://api-inference.modelscope.cn/v1/*（去掉 /ms 前缀）
export async function onRequest(context) {
  const p = context.params.path;
  const tail = Array.isArray(p) ? p.join('/') : (p || '');
  return relay(context.request, UPSTREAM.ms, '/v1/' + tail);
}
