import { relay, UPSTREAM, DEFAULT_CF_ACCOUNT } from '../../_lib.js';
// Cloudflare /cf/run/{model} → https://api.cloudflare.com/client/v4/accounts/{aid}/ai/run/{model}
// 账户 ID 优先取页面传入的 X-CF-Account-Id 头，空则回退到内置默认值
export async function onRequest(context) {
  const p = context.params.path;
  const model = Array.isArray(p) ? p.join('/') : (p || '');
  const aid = (context.request.headers.get('X-CF-Account-Id') || '').trim() || DEFAULT_CF_ACCOUNT;
  return relay(context.request, UPSTREAM.cf, '/client/v4/accounts/' + aid + '/ai/run/' + model);
}
