import { relay, UPSTREAM } from './_lib.js';
// Agnes 视频任务查询：/agnesapi?video_id=…&model_name=…（query 由 relay 自动透传）
// 注意上游地址是 https://api.agnes-ai.cn/agnesapi（不带 /v1）
export async function onRequest(context) {
  return relay(context.request, UPSTREAM.agnes, '/agnesapi');
}
