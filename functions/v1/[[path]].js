import { relay, UPSTREAM } from '../_lib.js';
// 商汤 /v1/* → https://token.sensenova.cn/v1/*
export async function onRequest(context) {
  const p = context.params.path;
  const tail = Array.isArray(p) ? p.join('/') : (p || '');
  return relay(context.request, UPSTREAM.sense, '/v1/' + tail);
}
