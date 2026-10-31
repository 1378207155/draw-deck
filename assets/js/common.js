const API = "https://open.bigmodel.cn/api/paas/v4";
const API_SENSE = "https://token.sensenova.cn";
const MODEL_COGVIEW = "cogview-3-flash";
const MODEL_SENSE = "sensenova-u1.5-lite";
const MODEL_AGNES_21 = "agnes-image-2.1-flash";
const MODEL_AGNES_25 = "agnes-image-2.5-flash";
const API_AGNES = "https://api.agnes-ai.cn";
const MODEL_CF_FLUX = "@cf/black-forest-labs/flux-1-schnell";        // 固定 1024x1024，返回 base64 JSON
const MODEL_CF_SDXL = "@cf/bytedance/stable-diffusion-xl-lightning"; // 尺寸可调，直接返回图片字节
const MODEL_MS_ZIMG = "Tongyi-MAI/Z-Image-Turbo";   // 异步任务制（提交→轮询）
const API_CF = "https://api.cloudflare.com";
const API_MS = "https://api-inference.modelscope.cn";
const MODEL_CF_SDXL_BASE = "@cf/stabilityai/stable-diffusion-xl-base-1.0"; // 固定 1024x1024，返回图片字节

function gcd2(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }
function sizeLabel(v) {
  const p = String(v).split('x'), w = parseInt(p[0], 10) || 0, h = parseInt(p[1], 10) || 0;
  const g = gcd2(w, h) || 1, rw = w / g, rh = h / g;
  const ratio = (rw <= 40 && rh <= 40) ? (rw + ':' + rh) : (w + '×' + h);
  const orient = w > h ? '横版' : (w < h ? '竖版' : '方形');
  return w + '×' + h + '（' + ratio + ' ' + orient + '）';
}

function isLocalBase(base) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(String(base).trim());
}

async function probeLocal(base) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(base.replace(/\/+$/, '') + '/ping', { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch (e) {
    return false;
  }
}

// —— file:// 直开时的本地代理检查（generate 与 describe 共用）——
// 需要代理但未填/连不上时返回错误文案；无需代理或连得上则返回 null。
async function checkLocalProxyNeeded(needProxy) {
  if (!needProxy || location.protocol.startsWith('http')) return null;
  const proxy = document.getElementById('corsProxy').value.trim();
  if (!proxy) return '⚠️ 该模型不支持浏览器直连：请用本地服务（双击 start.bat 后访问 http://localhost:8000）或部署到 Cloudflare 后用 https 访问；file:// 直开需在下方「CORS 代理地址」填转发路径。';
  if (isLocalBase(proxy) && !(await probeLocal(proxy))) return '⚠️ 转发服务连不上：CORS 代理填的是 ' + proxy.replace(/\/+$/, '') + '，但该地址无响应。本地请启动 server.py（双击 start.bat）；或清空「CORS 代理地址」框。';
  return null;
}

const TAB_HASHES = ['image', 'reverse', 'keys', 'video'];   // 标签 ↔ URL hash（刷新保持当前标签用）
function switchTab(i, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('show'));
  (el || document.querySelectorAll('.tab')[i]).classList.add('active');
  document.getElementById('panel'+i).classList.add('show');
  if (i === 0 && typeof movePromptPill === 'function') movePromptPill();   // 切到文生图：定位提示词/翻译药丸
  // 同步 URL hash（replaceState 不产生历史记录）：刷新后停留在当前标签
  try { history.replaceState(null, '', '#' + TAB_HASHES[i]); } catch (e) {}
}

// ---------- 会话状态持久化（刷新不丢：提示词 / 模型勾选 / 尺寸 / 数量 / 反推模型） ----------
function _ssGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function _ssSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function _ssGetJson(k) { try { return JSON.parse(_ssGet(k) || 'null'); } catch (e) { return null; } }
function _ssSetJson(k, v) { _ssSet(k, JSON.stringify(v)); }

// ---------- 生成中止：AbortController 取消进行中的 fetch；睡眠可被停止打断 ----------
let _genAbort = null;
// 可中断 sleep：期间每 ≤250ms 采样一次，stopped() 或 signal 被中止就立即结束。
// 图片生成传 AbortController；视频生成额外传 () => _videoStopped。
function sleepStoppable(ms, signal, stopped) {
  const stopped_ = stopped || function () { return window._stopGen; };
  return new Promise(function (resolve) {
    if (stopped_() || (signal && signal.aborted)) return resolve();
    const end = Date.now() + ms;
    (function tick() {
      const remain = end - Date.now();
      if (stopped_() || (signal && signal.aborted) || remain <= 0) return resolve();
      setTimeout(tick, Math.min(250, remain));
    })();
  });
}

// 各模型的提示词长度上限（字符）。超出时只截断「该模型自己的请求」，不影响其他模型
const PROMPT_MAX_AGNES = 9000;   // Agnes Image 2.0 / 2.1
const PROMPT_MAX_CF_FLUX = 2048; // Cloudflare Flux1
const PROMPT_MAX_MS = 4000;      // 魔搭 Z-Image Turbo
function promptLimitFor(mk) {
  if (mk === 'agnes21' || mk === 'agnes25') return PROMPT_MAX_AGNES;
  if (mk === 'cfFlux') return PROMPT_MAX_CF_FLUX;
  if (mk === 'msZimg') return PROMPT_MAX_MS;
  return null;
}
// 截断时优先保住结尾自动追加的质量词（generate() 加的那串），避免超长时把 quality 词切掉
const PROMPT_TAIL = ', masterpiece, best quality, highly detailed';
function truncatePrompt(p, max) {
  if (p.length <= max) return p;
  let head = p, tail = '';
  if (p.endsWith(PROMPT_TAIL)) { head = p.slice(0, p.length - PROMPT_TAIL.length); tail = PROMPT_TAIL; }
  return head.slice(0, Math.max(0, max - tail.length)) + tail;
}

// 图片转 base64 并压缩
function compressImage(file, maxW = 1024, quality = 0.90) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e => { img.src = e.target.result; };
    reader.onerror = reject;
    reader.readAsDataURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
  });
}

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = function () { reject(new Error('加载失败 ' + src)); };
    document.head.appendChild(s);
  });
}

// 记住 Key（四模型）
const keyZhipu = document.getElementById('keyZhipu');
const keySense = document.getElementById('keySense');
const keyAgnes = document.getElementById('keyAgnes');
const keyCF = document.getElementById('keyCF');
const savedZ = localStorage.getItem('zhipu_key');
if (savedZ) keyZhipu.value = savedZ;
const savedS = localStorage.getItem('sensenova_key');
if (savedS) keySense.value = savedS;
const savedA = localStorage.getItem('agnes_key');
if (savedA) keyAgnes.value = savedA;
const savedCF = localStorage.getItem('cf_key');
if (savedCF) keyCF.value = savedCF;
const keyCFAccount = document.getElementById('keyCFAccount');
const savedCFA = localStorage.getItem('cf_account');
if (savedCFA) keyCFAccount.value = savedCFA;
const keyMS = document.getElementById('keyMS');
const savedMS = localStorage.getItem('ms_key');
if (savedMS) keyMS.value = savedMS;

// Key 输入失焦/回车即保存，不必等点「生成」
const keyStorageMap = { keyZhipu: 'zhipu_key', keySense: 'sensenova_key', keyAgnes: 'agnes_key', keyCF: 'cf_key', keyCFAccount: 'cf_account', keyMS: 'ms_key' };
function saveKeysNow() {
  const remember = document.getElementById('remember').checked;
  Object.keys(keyStorageMap).forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    const v = el.value.trim();
    if (!remember) { localStorage.removeItem(keyStorageMap[id]); return; }
    if (v) localStorage.setItem(keyStorageMap[id], v);
    // 空值不删：保留上次已保存的 Key，避免其他 Key 框为空时误删
  });
}
Object.keys(keyStorageMap).forEach(function (id) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', saveKeysNow);
});
document.getElementById('remember').addEventListener('change', saveKeysNow);

function selectedModels() {
  const boxes = document.querySelectorAll('input.model-check:checked');
  return Array.from(boxes).map(b => b.value);
}
function isSense() { return selectedModels().includes('sensenova'); }
function isAgnes() { return selectedModels().includes('agnes21') || selectedModels().includes('agnes25'); }
function isCF() { return selectedModels().includes('cfFlux') || selectedModels().includes('cfSdxl') || selectedModels().includes('cfSdxlBase'); }
function isMS() { return selectedModels().includes('msZimg'); }
function isAll() { return selectedModels().length >= 2; }
function needsLocalProxy() { return isSense() || isAgnes() || isCF() || isMS(); }
let singleMode = false; // 默认多选；true 时勾选互斥（单选）
function checkAllModels(on) {
  const boxes = document.querySelectorAll('input.model-check');
  if (on && singleMode) {
    // 单选模式下「全选」只保留第一个，其余取消
    boxes.forEach((b, i) => { b.checked = (i === 0); });
  } else {
    boxes.forEach(b => { b.checked = on; });
  }
  toggleKeyUI();
  updatePickSummary();
  saveModels();
}
function openModelPicker() {
  updatePickSummary();
  document.getElementById('modelPicker').classList.add('show');
}
function closeModelPicker() {
  document.getElementById('modelPicker').classList.remove('show');
  updatePickSummary(); // 关闭弹层时兜底刷新外部按钮数量
}
function updatePickSummary() {
  const n = selectedModels().length;
  const modeTxt = singleMode ? '单选' : '多选';
  const s = document.getElementById('pickSummary');
  if (s) s.textContent = '已选 ' + n + ' 个 · ' + modeTxt;
  const c = document.getElementById('pickCount');
  if (c) c.textContent = '已选 ' + n + ' 个模型 · ' + modeTxt;
}


function toggleKeyUI() {
  const proxyEl = document.getElementById('corsProxy');
  // 通过 http(s) 打开时是同源转发（本地 server.py 或部署后的 Functions），不需要也不显示代理框
  const needProxy = needsLocalProxy() && !location.protocol.startsWith('http');
  proxyEl.style.display = needProxy ? '' : 'none';
  if (needProxy) {
    const p = localStorage.getItem('cors_proxy');
    if (p) proxyEl.value = p;
  }
  updateSizeOptions();
  updatePromptCount();
  // 参考图：仅当所有勾选模型都支持图生图（目前只有 Agnes）时才显示
  const sels = selectedModels();
  const refOk = sels.length > 0 && sels.every(m => m === 'agnes21' || m === 'agnes25');
  const refZone = document.getElementById('refZone');
  if (refZone) refZone.style.display = refOk ? '' : 'none';
}

// ---- 各模型支持的尺寸（按官方文档逐家核实，来源见各条注释）--------------------------------
// 数组第一项 = 该模型默认尺寸；值为 null = 模型输出尺寸固定，不参与多选时的尺寸交集。
const SIZE_FIXED_CF_FLUX = '1024x1024';
const MODEL_SIZES = {
  // 智谱 cogview-3-flash（docs.bigmodel.cn「图像生成」size 说明）：
  // 官方枚举 7 个；自定义要求边长 512–2048、16 的倍数、总像素 ≤2^21（2048x1024 恰好等于上限）
  cogview:   ['1440x720', '720x1440', '1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '2048x1024', '1024x2048'],
  // 商汤日日新 U1.5 Lite：官方 API 规则为「边长 512–4096、均为 32 的倍数、最大 3:1」，官方 SDK 另有一套
  // 预设桶（最宽 16:9、最高 9:21，比新闻页更紧且两处口径冲突）。这里直接采用官方 SDK 的桶值，最稳。
  // 来源：sensetime 官网参数说明 + OpenSenseNova/SenseNova-Skills 的 SDK 桶表
  sensenova: ['2048x2048', '1344x1344', '1792x992', '864x2048', '2752x1536', '1344x3136', '4096x4096', '4096x2304', '1755x4096'],
  // Agnes 2.1（wiki.agnes-ai.com「agnes-image-21-flash」）：下面是官方原生档位（1K/2K），
  // 非原生精确尺寸会被自动归一到最接近的档位+宽高比（例如 1440x720 会落到 1312x736），故不再提供
  agnes21:   ['1024x1024', '1152x864', '864x1152', '1312x736', '736x1312', '1248x832', '832x1248', '1024x768', '768x1024', '2048x2048', '2304x1728', '1728x2304', '2624x1472', '1472x2624'],
  // Agnes 2.5（agnes-image-2.5-flash）：同族档位，沿用 2.1 的原生尺寸表
  agnes25:   ['1024x1024', '1152x864', '864x1152', '1312x736', '736x1312', '1248x832', '832x1248', '1024x768', '768x1024', '2048x2048', '2304x1728', '1728x2304', '2624x1472', '1472x2624'],
  // 魔搭 Z-Image-Turbo（github.com/Tongyi-MAI/Z-Image README「Recommended Parameters」）：
  // 官方推荐 512×512 ~ 2048×2048（按总像素面积计，任意宽高比）
  msZimg:    ['1024x1024', '1280x720', '720x1280', '1344x768', '768x1344', '1152x864', '864x1152', '1536x1024', '1024x1536', '2048x1024', '1024x2048', '2048x2048'],
  // Cloudflare Flux1（Workers AI 模型页）：接口只有 prompt/steps，没有尺寸参数 → 固定 1024×1024
  cfFlux:    null,
  // Cloudflare SDXL-Lightning（Workers AI 模型页）：width/height 各 256–2048
  cfSdxl:    ['1024x1024', '1344x768', '768x1344', '1152x864', '864x1152', '1536x1024', '1024x1536', '2048x1024', '1024x2048'],
  // Cloudflare SDXL-Base：输出固定 1024×1024
  cfSdxlBase: null,
};

// ---------- 分段胶囊按钮（替代下拉/数字输入，参考视频生成 UI 风格） ----------
// source: { get: () => 当前值, set: (v) => 写入值, options: () => [{value,label}] }
// 返回 sync 函数：值/选项被程序化改动后调用它刷新胶囊高亮
function bindPills(container, source) {
  function sync() {
    const cur = String(source.get());
    container.innerHTML = source.options().map(function (o) {
      return '<button type="button" class="pill' + (String(o.value) === cur ? ' active' : '') + '" data-value="' + o.value + '">' + o.label + '</button>';
    }).join('');
    container.querySelectorAll('.pill').forEach(function (b) {
      b.addEventListener('click', function () {
        const v = b.dataset.value;
        if (v === String(source.get())) return;
        source.set(v);
        sync();
      });
    });
    if (source.onSync) source.onSync();
  }
  sync();
  return sync;
}

// 用户是否手动改过「尺寸」：程序重建下拉不触发 change，只有用户手动才会置真（用于「多选默认 1024x1024」判定）
let _sizeUserPicked = false;
const sizeSelEl = document.getElementById('size');
if (sizeSelEl) sizeSelEl.addEventListener('change', function () { _sizeUserPicked = true; saveSize(); });

// 尺寸胶囊：点击设置隐藏下拉的值并触发 change（等价于手动选择）
const sizePillsEl = document.getElementById('sizePills');
let sizePillsSync = null;
if (sizeSelEl && sizePillsEl) {
  sizePillsSync = bindPills(sizePillsEl, {
    get: function () { return sizeSelEl.value; },
    set: function (v) { sizeSelEl.value = v; sizeSelEl.dispatchEvent(new Event('change')); },
    options: function () { return Array.from(sizeSelEl.options).map(function (o) { return { value: o.value, label: o.textContent }; }); },
    onSync: updateSizeSummary
  });
}

// 数量胶囊（1–8）：点击设置隐藏数字输入的值并触发 input（等价于手动输入）
const countInputEl = document.getElementById('count');
const countPillsEl = document.getElementById('countPills');
let countPillsSync = null;
if (countInputEl && countPillsEl) {
  let cv = parseInt(countInputEl.value, 10);
  if (!cv || cv < 1 || cv > 8) { cv = 3; countInputEl.value = String(cv); }
  countPillsSync = bindPills(countPillsEl, {
    get: function () { return countInputEl.value; },
    set: function (v) { countInputEl.value = v; countInputEl.dispatchEvent(new Event('input')); },
    options: function () { return [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) { return { value: String(n), label: String(n) }; }); },
    onSync: updateSizeSummary
  });
}

// 生成设置摘要按钮 + 弹窗
function updateSizeSummary() {
  const el = document.getElementById('sizeSummary');
  if (!el) return;
  const s = document.getElementById('size').value;
  const c = document.getElementById('count').value;
  el.textContent = (s || '—') + ' · ' + c;
}
function openSizeSettings() { const el = document.getElementById('sizeSettings'); if (el) el.classList.add('show'); }
function closeSizeSettings() { const el = document.getElementById('sizeSettings'); if (el) el.classList.remove('show'); }

function updateSizeOptions() {
  const sel = document.getElementById('size');
  const hint = document.getElementById('sizeHint');
  if (!sel) return;
  const sels = selectedModels();
  const rigid = sels.filter(function (mk) { return MODEL_SIZES[mk]; });   // 会把尺寸发给上游的模型
  const fixedOnly = sels.length > 0 && rigid.length === 0;               // 全是固定输出尺寸的模型
  let list, note = '';
  if (!sels.length) {
    list = MODEL_SIZES.cogview.slice();                                  // 未勾选：给通用清单
  } else if (sels.length === 1) {
    list = (MODEL_SIZES[sels[0]] || [SIZE_FIXED_CF_FLUX]).slice();
    if (!MODEL_SIZES[sels[0]]) note = '该模型输出尺寸固定，不随此处选择变化。';
  } else if (fixedOnly) {
    list = [SIZE_FIXED_CF_FLUX];
    note = '所选模型输出尺寸都固定，此处仅供占位。';
  } else {
    // 多选 = 所有「会用到尺寸」的模型都支持的尺寸（交集）
    list = rigid.reduce(function (acc, mk) {
      return acc.filter(function (v) { return MODEL_SIZES[mk].indexOf(v) >= 0; });
    }, MODEL_SIZES[rigid[0]].slice());
    if (!list.length) {                                                   // 无共同尺寸：退回最宽松那个（不提示）
      list = MODEL_SIZES[rigid[0]].slice();
    }
  }
  const prev = sel.value;
  sel.innerHTML = list.map(function (v) { return '<option value="' + v + '">' + sizeLabel(v) + '</option>'; }).join('');
  // 多选默认 1024x1024：用户从未手动改过尺寸时，多选优先落到 1024x1024（若各模型都支持）
  if (!_sizeUserPicked && sels.length > 1 && list.indexOf('1024x1024') >= 0) {
    sel.value = '1024x1024';
  } else if (list.indexOf(prev) >= 0) {
    sel.value = prev;                       // 之前选的值仍可用：保留不打扰
  } else {
    sel.value = list[0] || '';
  }
  if (hint) { hint.textContent = note; hint.style.display = note ? '' : 'none'; }
  if (sizePillsSync) sizePillsSync();
}

function getKey() {
  if (isAll()) {
    // 全部模式：至少有一个 Key 即可（缺 Key 的模型自动跳过）
    const have = [];
    if (keyZhipu.value.trim()) have.push('智谱');
    if (keySense.value.trim()) have.push('商汤');
    if (keyAgnes.value.trim()) have.push('Agnes');
    if (keyCF.value.trim()) have.push('Cloudflare');
    if (keyMS.value.trim()) have.push('魔搭');
    if (!have.length) { showErr('「全部」模式请至少填写一个 API Key'); return null; }
    return true;
  }
  const sels = selectedModels();
  if (!sels.length) { showErr('请至少勾选一个模型'); return null; }
  const missing = sels.filter(mk => {
    const m = MODEL_LIST.find(x => x.key === mk);
    if (!m) return false;
    return !document.getElementById(m.keyEl).value.trim();
  });
  if (missing.length === sels.length) {
    showErr('勾选的模型都还没填 API Key：请在「API Key」页签填写对应 Key 再生成');
    return null;
  }
  return true;
}

function showErr(msg) { document.getElementById('err').innerText = msg; }

function saveModels() { _ssSetJson('sel_models', selectedModels()); }
function restoreModels() {
  const arr = _ssGetJson('sel_models'); if (!Array.isArray(arr) || !arr.length) return;
  document.querySelectorAll('input.model-check').forEach(b => { b.checked = arr.indexOf(b.value) >= 0; });
  if (singleMode) applySingleKeepOne();   // 单选模式：收敛到第一个已勾选
}
function saveSize() { _ssSet('size_sel', document.getElementById('size').value); }
function restoreSize() {
  const v = _ssGet('size_sel'); const sel = document.getElementById('size');
  if (v && sel && Array.from(sel.options).some(o => o.value === v)) { sel.value = v; _sizeUserPicked = true; }
  if (sizePillsSync) sizePillsSync();
}
function saveCount() { _ssSet('count_sel', document.getElementById('count').value); }
function restoreCount() {
  const v = _ssGet('count_sel'); const el = document.getElementById('count');
  if (v && el) { const n = parseInt(v, 10); if (n >= 1 && n <= 8) el.value = String(n); updateBtn(); }   // 胶囊只提供 1–8
  if (countPillsSync) countPillsSync();
}
function saveDescModel() { _ssSet('desc_model', document.getElementById('descModel').value); _ssSet('desc_model_name', document.getElementById('descModelName').value); }
function restoreDescModel() {
  const m = _ssGet('desc_model'); if (m) document.getElementById('descModel').value = m;
  const n = _ssGet('desc_model_name'); if (n != null) document.getElementById('descModelName').value = n;
}

function updateBtn() {
  const btn = document.getElementById('btnGen');
  if (btn.disabled) return;
  const n = document.getElementById('count').value;
  btn.innerHTML = '生成图片（' + n + '张）';
}
updateBtn();
document.querySelectorAll('input.model-check').forEach(b => b.addEventListener('change', () => {
  if (singleMode) {
    if (b.checked) {
      // 单选模式：勾选当前项时，取消其它所有项（互斥）
      document.querySelectorAll('input.model-check').forEach(o => { if (o !== b) o.checked = false; });
    } else if (!document.querySelector('input.model-check:checked')) {
      // 单选模式下至少保留一个勾选，避免出现「一个模型都没选」
      b.checked = true;
    }
  }
  toggleKeyUI();
  updatePickSummary();
  saveModels();
})); // change 不冒泡，直接绑到每个复选框

// 单选 / 多选开关：勾选 = 多选（默认），取消勾选 = 单选（互斥）
const modeSwitchEl = document.getElementById('modeSwitch');
try { singleMode = localStorage.getItem('single_mode') === '1'; } catch (e) { singleMode = false; }
modeSwitchEl.checked = !singleMode;   // 与 CSS（checked 高亮「多选」）保持一致
// 单选模式：只保留第一个已勾选的模型（图/视频模型弹层共用；切换与恢复记忆时共用）
function applySingleKeepOne(selector) {
  const boxes = Array.from(document.querySelectorAll(selector || 'input.model-check'));
  const keep = boxes.filter(x => x.checked)[0] || boxes[0];
  boxes.forEach(x => { x.checked = (x === keep); });
}
modeSwitchEl.addEventListener('change', () => {
  singleMode = !modeSwitchEl.checked;
  try { localStorage.setItem('single_mode', singleMode ? '1' : '0'); } catch (e) {}
  if (singleMode) applySingleKeepOne();  // 切到单选：立刻收敛为一个
  toggleKeyUI();
  updatePickSummary();
  saveModels();
});

// 刷新后恢复「单选」记忆时同样收敛，避免「写着单选却勾了 13 个」
if (singleMode) applySingleKeepOne();

const MODEL_LIST = [
  { key: 'cogview', label: '智谱', keyEl: 'keyZhipu' },
  { key: 'sensenova', label: '商汤', keyEl: 'keySense' },
  { key: 'agnes21', label: 'Agnes 2.1', keyEl: 'keyAgnes' },
  { key: 'agnes25', label: 'Agnes 2.5', keyEl: 'keyAgnes' },
  { key: 'cfFlux', label: 'CF Flux1', keyEl: 'keyCF' },
  { key: 'cfSdxl', label: 'CF SDXL', keyEl: 'keyCF' },
  { key: 'msZimg', label: '魔搭 Z-Image', keyEl: 'keyMS' },
  { key: 'cfSdxlBase', label: 'CF SDXL-Base', keyEl: 'keyCF' },
];

function modelLabel(key) {
  const m = MODEL_LIST.find(x => x.key === key);
  return m ? m.label : key;
}

function keyForModel(key) {
  // 同时查图片模型列表与视频模型列表（视频模型 agnesVideo 等不在图片列表里，否则会回退到 keyZhipu 导致用错 Key）
  const m = MODEL_LIST.find(x => x.key === key) || (typeof VIDEO_MODEL_LIST !== 'undefined' && VIDEO_MODEL_LIST.find(x => x.key === key));
  return document.getElementById(m ? m.keyEl : 'keyZhipu').value.trim();
}
