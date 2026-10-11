// 全局中间件：统一处理 OPTIONS 预检，其余请求照常走各自路由
import { preflight } from './_lib.js';
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  return context.next();
}
