// ---------- 提示词自动翻译（中文 ↔ 英文，Chrome 内置 Translator API · 端侧模型） ----------
// 参考 tool/translate.html：不调用任何云端模型 / 接口，翻译全部在本机完成，内容不出设备
// 「中文/英文」标签切换两个输入框；在任一框输入都会自动判断方向后翻译到另一栏。不限字数。
// 防循环靠 _promptFillGuard：由翻译写回的赋值不触发反向翻译（切标签只改 display，不产生 input 事件）
// 生图时用 _promptMainLang 指向的那一版 = 你最后一次在哪个框里打字
// 要求 Chrome 138+ 桌面版；首次翻译会下载语言包（一次性，只含语言数据不含你的内容），之后可离线
let _promptMainLang = 'zh';
let _promptFillGuard = false;
let _promptTimer = null;
let _promptSeq = 0;
let _promptTransCache = null;     // { key, t }：每个语言对只创建一次
let _promptTransPending = null;   // { key: Promise }：同语言对正在创建时复用同一个 Promise，避免两个 monitor 抢状态
let _promptDetector = null;       // LanguageDetector 实例（复用，别每次按键停顿都 create 一次）
let _promptDetectorPending = null;

// 含中日韩表意字 / 假名 / 谚文即视为「非英文」；LanguageDetector 不可用时用它兜底判断方向
function isZhText(t) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(t);
}
function hasLocalTranslator() { return typeof window.Translator !== 'undefined'; }
function promptStatus(msg, color) {
  const n = document.getElementById('promptTransState');
  if (!n) return;
  n.textContent = msg || '';
  n.style.color = color || 'var(--muted)';
}
function promptEl(lang) { return document.getElementById(lang === 'en' ? 'promptEn' : 'prompt'); }
function promptTextOf(lang) { const e = promptEl(lang); return e ? e.value.trim() : ''; }
function setPromptText(lang, val) {
  const e = promptEl(lang);
  if (!e) return;
  _promptFillGuard = true;
  e.value = val;
  _promptFillGuard = false;
  updatePromptClearBtns();
}
// 提示词/翻译结果 滑动药丸：把白色 pill 定位到当前激活的 tab
let _promptPillInit = false;
function movePromptPill() {
  const seg = document.getElementById('promptLangSeg');
  if (!seg) return;
  const pill = seg.querySelector('.pill');
  const active = seg.querySelector('.seg-tab.active');
  if (!pill || !active) return;
  const a = active.getBoundingClientRect();
  const b = seg.getBoundingClientRect();
  if (!b.width) return;   // 面板未显示（display:none），跳过
  const first = !_promptPillInit;
  _promptPillInit = true;
  if (first) pill.style.transition = 'none';   // 首次定位不带动画（避免从 0 宽生长）
  pill.style.width = a.width + 'px';
  pill.style.transform = 'translateX(' + (a.left - b.left) + 'px)';
  if (first) requestAnimationFrame(function () { pill.style.transition = ''; });
}
window.addEventListener('resize', movePromptPill);
requestAnimationFrame(movePromptPill);

function switchPromptLang(lang) {
  _promptMainLang = lang;   // 点标签 = 决定用哪一版作为主语言，字数也跟随切换
  // 整个容器一起显隐：计数/清空按钮是容器的子元素，只隐藏 textarea 会留下计数残影
  document.getElementById('promptZhField').style.display = lang === 'zh' ? '' : 'none';
  document.getElementById('promptEnField').style.display = lang === 'en' ? '' : 'none';
  document.getElementById('tabZh').classList.toggle('active', lang === 'zh');
  document.getElementById('tabEn').classList.toggle('active', lang === 'en');
  movePromptPill();   // 药丸跟随当前激活 tab
  updatePromptClearBtns();
  updatePromptCount();
  const e = lang === 'en' ? document.getElementById('promptEn') : document.getElementById('prompt');
  try { e.focus(); e.setSelectionRange(e.value.length, e.value.length); } catch (err) {}
}
// 清空按钮：仅在有内容时显示（翻译结果只读，无清空按钮）
function updatePromptClearBtns() {
  const pairs = [['prompt', 'promptClear']];
  pairs.forEach(function (p) {
    const ta = document.getElementById(p[0]), btn = document.getElementById(p[1]);
    if (ta && btn) btn.classList.toggle('show', !!ta.value);
  });
}
function clearPrompt(lang) {
  setPromptText(lang, '');
  setPromptText(lang === 'zh' ? 'en' : 'zh', '');   // 另一栏是它的翻译，一并清掉避免留半截
  _promptMainLang = lang;
  updatePromptCount();
  updatePromptClearBtns();
  promptStatus('');
  const e = promptEl(lang);
  if (e) { try { e.focus(); } catch (err) {} }
}
function onPromptInput(lang) {
  if (_promptFillGuard) return;
  _promptMainLang = lang;
  updatePromptCount();
  updatePromptClearBtns();
  promptStatus(lang === 'zh' ? '输入中文 → 自动翻译成英文' : '输入英文 → 自动翻译成中文');
  if (_promptTimer) clearTimeout(_promptTimer);
  _promptTimer = setTimeout(function () { autoTranslate(lang); }, 550);
}
// 部分 Chrome 版本只接受 'zh-Hans' 而不是 'zh'，逐个探测语言对可用性
async function resolveLangCode(code) {
  const other = (code === 'zh' || code === 'zh-Hans') ? 'en' : 'zh';
  for (const c of (code === 'zh' ? ['zh', 'zh-Hans'] : [code])) {
    try {
      const a = await window.Translator.availability({ sourceLanguage: c, targetLanguage: other });
      if (a !== 'unavailable') return c;
    } catch (e) {}
  }
  return code;
}
// 语言包「已就绪」记忆：localStorage 存已下载过的语言对（如 'zh-Hans>en'），
// 刷新后再次翻译不再显示准备/下载提示。换浏览器/清站点数据后会自动回到首次提示流程。
const LANGPACK_KEY = 'prompt_langpacks';
function langpackReady(src, dst) {
  try {
    const arr = JSON.parse(localStorage.getItem(LANGPACK_KEY) || '[]');
    return Array.isArray(arr) && arr.indexOf(src + '>' + dst) >= 0;
  } catch (e) { return false; }
}
function langpackMark(src, dst) {
  try {
    const arr = JSON.parse(localStorage.getItem(LANGPACK_KEY) || '[]');
    const k = src + '>' + dst;
    if (Array.isArray(arr) && arr.indexOf(k) < 0) { arr.push(k); localStorage.setItem(LANGPACK_KEY, JSON.stringify(arr)); }
  } catch (e) {}
}
async function promptTranslator(srcCode, dstCode) {
  srcCode = await resolveLangCode(srcCode);
  dstCode = await resolveLangCode(dstCode);
  const key = srcCode + '\u0001' + dstCode;
  if (_promptTransCache && _promptTransCache.key === key) return _promptTransCache.t;
  _promptTransPending = _promptTransPending || {};
  if (_promptTransPending[key]) return _promptTransPending[key];   // 并发的同语言对请求复用，别建两个 monitor
  // 语言包下载一次后浏览器会缓存；用 localStorage 记住「这个语言对已就绪」，
  // 刷新页面后再次翻译就不再显示准备/下载提示（避免每次刷新都虚惊一场）
  const ready = langpackReady(srcCode, dstCode);
  if (!ready) promptStatus('首次使用此语言对，正在准备本地语言包…');
  const p = (async function () {
    let cleanup = function () {};
    try {
      const t = await window.Translator.create({
        sourceLanguage: srcCode,
        targetLanguage: dstCode,
        monitor(m) {
          let settled = false;
          const clean = function () {
            if (settled) return;
            settled = true;
            m.removeEventListener('downloadprogress', onProg);
            m.removeEventListener('downloadcomplete', onDone);
            m.removeEventListener('downloaderror', onErr);
          };
          const onProg = function (e) {
            if (ready) return;   // 已就绪：就算浏览器又触发一次进度事件也不打扰
            const pct = e.total ? Math.round((e.loaded / e.total) * 100) + '%' : '…';
            promptStatus('正在下载本地语言包… ' + pct + '（一次性，仅语言数据，不含你的内容）');
          };
          const onDone = clean;
          const onErr = clean;
          m.addEventListener('downloadprogress', onProg);
          m.addEventListener('downloadcomplete', onDone);
          m.addEventListener('downloaderror', onErr);
          cleanup = clean;
        }
      });
      return t;
    } finally {
      // create 收尾（成功或失败）就摘监听：迟到的 progress 事件不得再把「已自动翻译」盖回「正在下载」
      cleanup();
    }
  })();
  _promptTransPending[key] = p;
  try {
    const t = await p;
    _promptTransCache = { key: key, t: t };
    langpackMark(srcCode, dstCode);   // 就绪后记下来，下次刷新不用再走提示流程
    if (!ready) promptStatus('语言包已就绪');   // 进度文案到此结束，状态落回中性，后续由翻译流程接管
    return t;
  } finally {
    if (_promptTransPending && _promptTransPending[key] === p) delete _promptTransPending[key];
  }
}
// 复用同一个 LanguageDetector：之前每次按键停顿都 create 一次，既慢又可能拖住方向判断
async function getPromptDetector() {
  if (_promptDetector) return _promptDetector;
  if (typeof window.LanguageDetector === 'undefined') return null;
  if (_promptDetectorPending) return _promptDetectorPending;
  _promptDetectorPending = window.LanguageDetector.create().then(function (d) {
    _promptDetector = d;
    return d;
  }, function () {
    _promptDetectorPending = null;
    return null;
  });
  return _promptDetectorPending;
}
// 自动判断翻译方向：优先用 Chrome 的 LanguageDetector，不可用时退回字符统计
async function detectPromptDir(text) {
  const d = await getPromptDetector();
  if (d) {
    try {
      const res = await d.detect(text);
      const lang = (res && res[0] && res[0].detectedLanguage) || '';
      if (lang.indexOf('zh') === 0) return { src: 'zh', dst: 'en' };
      if (lang.indexOf('en') === 0) return { src: 'en', dst: 'zh' };
    } catch (e) {}
  }
  return isZhText(text) ? { src: 'zh', dst: 'en' } : { src: 'en', dst: 'zh' };
}
async function autoTranslate(lang) {
  const src = promptTextOf(lang);
  const other = lang === 'zh' ? 'en' : 'zh';
  const seq = ++_promptSeq;
  if (!src) { setPromptText(other, ''); promptStatus(''); return; }
  if (!hasLocalTranslator()) {
    promptStatus('当前浏览器不支持本地翻译：请用 Chrome 138+ 桌面版打开本页', '#dc2626');
    return;
  }
  const dir = await detectPromptDir(src);
  if (seq !== _promptSeq) return;
  promptStatus('本机翻译中…（' + (dir.src === 'zh' ? '中文 → 英文' : '英文 → 中文') + '）');
  try {
    const t = await promptTranslator(dir.src, dir.dst);
    const out = await t.translate(src);
    const clean = String(out || '').trim();
    if (!clean) throw new Error('翻译结果为空');
    // 用户在等待期间又改了内容或切了栏，就不覆盖
    if (seq !== _promptSeq || _promptMainLang !== lang || promptTextOf(lang) !== src) return;
    setPromptText(other, clean);
    promptStatus('已自动翻译 → ' + (dir.dst === 'zh' ? '中文' : '英文'), '#16a34a');
  } catch (e) {
    if (seq !== _promptSeq) return;
    promptStatus('翻译失败：' + ((e && e.message) || e), '#dc2626');
  }
}
// 页面加载时探测本地翻译引擎，结果显示在标签行右侧
async function checkPromptEngine() {
  if (!hasLocalTranslator()) {
    promptStatus('需 Chrome 138+ 桌面版才有本地翻译', '#d97706');
    return;
  }
  try {
    const a = await window.Translator.availability({ sourceLanguage: 'zh', targetLanguage: 'en' });
    if (a === 'unavailable') { promptStatus('本地翻译不支持该语言对', '#d97706'); return; }
    promptStatus(a === 'installed' ? '本地翻译就绪 · 已可离线' : '本地翻译就绪');
  } catch (e) {
    promptStatus('本地翻译引擎检测失败', '#d97706');
  }
}
// 生图实际使用的提示词：最后一次在哪个栏输入，就用哪一版；该栏为空则回退到另一栏
function promptForGeneration() {
  const t = promptTextOf(_promptMainLang);
  if (t) return t;
  return promptTextOf(_promptMainLang === 'zh' ? 'en' : 'zh');
}

function updatePromptCount() {
  const el = document.getElementById('prompt');
  const c = document.getElementById('promptCountZh');
  if (!c) return;
  const n = el ? el.value.length : 0;
  // 多选时按「最严的那个模型」显示（每个模型各自截断）
  let limit = null;
  selectedModels().forEach(function (mk) {
    const L = promptLimitFor(mk);
    if (L && (limit === null || L < limit)) limit = L;
  });
  if (limit) {
    const over = n > limit;
    c.textContent = over ? (n + ' / ' + limit + '（超出会截断）') : (n + ' / ' + limit);
    c.classList.toggle('over', over);
    c.title = '超过上限时只截断对应模型的请求，其他模型不受影响';
  } else {
    c.textContent = n + ' 字符（无限制）';
    c.classList.remove('over');
    c.title = '';
  }
}
updatePromptCount();

async function genOne(modelKey, prompt, size, k, signal) {
  const sense = modelKey === 'sensenova';
  const agnes = modelKey === 'agnes21' || modelKey === 'agnes25';
  const cf = modelKey === 'cfFlux' || modelKey === 'cfSdxl' || modelKey === 'cfSdxlBase';
  const ms = modelKey === 'msZimg';
  let baseUrl;
  if (sense) baseUrl = API_SENSE;
  else if (agnes) baseUrl = API_AGNES;
  else if (cf) baseUrl = API_CF;
  else if (ms) baseUrl = API_MS;
  else baseUrl = API;
  if (sense || agnes || cf || ms) {
    if (location.protocol.startsWith('http')) {
      const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.hostname);
      // Agnes 线上直连上游：不经 Functions 转发，出口从 CF 数据中心 IP 改为用户本机 IP，避开 Agnes 对 CF IP 的限流
      // 本地（localhost）仍走同源转发（server.py）；其余模型一律同源转发
      if (agnes && !isLocal) {
        // baseUrl 保持 API_AGNES，下面 endpoint 拼不带 /agnes 前缀
      } else {
        baseUrl = '';  // http(s) 同源转发（本地 server.py / 部署的 Functions），无需 CORS
      }
    } else {
      const proxy = document.getElementById('corsProxy').value.trim();
      if (proxy) {
        localStorage.setItem('cors_proxy', proxy);
        baseUrl = proxy.replace(/\/$/, '');
      }
    }
  }
  // Cloudflare：flux 固定 1024 返回 base64 JSON；SDXL 尺寸可调、直接返回图片字节
  if (cf) {
    const isFlux = modelKey === 'cfFlux';
    if (isFlux) prompt = truncatePrompt(prompt, PROMPT_MAX_CF_FLUX);   // Flux1 上限 2048
    const cfModel = isFlux ? MODEL_CF_FLUX : (modelKey === 'cfSdxlBase' ? MODEL_CF_SDXL_BASE : MODEL_CF_SDXL);
    const endpoint = baseUrl + '/cf/run/' + cfModel;
    const p = String(size).split('x');
    const fixed = isFlux || modelKey === 'cfSdxlBase';   // Flux1 与 SDXL-Base 输出固定 1024×1024
    const cfBody = isFlux ? { prompt: prompt, steps: 4 } : { prompt: prompt, width: fixed ? 1024 : (+p[0] || 1024), height: fixed ? 1024 : (+p[1] || 1024) };
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json', 'X-CF-Account-Id': keyCFAccount ? keyCFAccount.value.trim() : '' },
      body: JSON.stringify(cfBody),
      signal: signal
    });
    const ct = r.headers.get('Content-Type') || '';
    if (!r.ok) {
      let m2 = 'HTTP ' + r.status;
      try { const d = await r.json(); m2 = (d.errors && d.errors[0] && d.errors[0].message) || m2; } catch (_) {}
      if (m2.length > 200) m2 = m2.slice(0, 200) + '…';
      throw new Error(m2);
    }
    if (ct.indexOf('json') >= 0) {
      const d = await r.json();
      const b64 = d && d.result && d.result.image;
      if (!b64) throw new Error('Cloudflare 返回异常：' + JSON.stringify(d).slice(0, 180));
      return 'data:image/png;base64,' + b64;
    }
    const blob = await r.blob();
    return await new Promise(function (res, rej) {
      const fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取图片数据失败')); };
      fr.readAsDataURL(blob);
    });
  }
  // 魔搭 Z-Image：异步任务（提交 → 轮询 → output_images[0]）
  if (ms) {
    prompt = truncatePrompt(prompt, PROMPT_MAX_MS);   // 魔搭上限 4000
    const p = String(size).split('x');
    const endpoint = baseUrl + '/ms/v1/images/generations';
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json', 'X-ModelScope-Async-Mode': 'true' },
      // 魔搭文档里 Z-Image-Turbo 的尺寸字段是 size 字符串；这里同时带上 width/height，两者任一被网关认下都不会跑偏
      body: JSON.stringify({ model: MODEL_MS_ZIMG, prompt: prompt, size: size, width: +p[0] || 1024, height: +p[1] || 1024, num_inference_steps: 9 }),
      signal: signal
    });
    const d = await r.json();
    if (!r.ok) throw new Error('魔搭提交失败: ' + ((d.errors && d.errors.message) || ('HTTP ' + r.status)));
    const tid = d.task_id;
    if (!tid) throw new Error('魔搭未返回任务ID：' + JSON.stringify(d).slice(0, 180));
    const t0 = Date.now();
    let netErr = 0;
    while (Date.now() - t0 < 180000) {
      await sleepStoppable(2500, signal);
      if (window._stopGen) throw new Error('已停止');
      let pd = null;
      try {
        const pr = await fetch(baseUrl + '/ms/v1/tasks/' + tid, { headers: { 'Authorization': 'Bearer ' + k, 'X-ModelScope-Task-Type': 'image_generation' }, signal: signal });
        pd = await pr.json();
        netErr = 0;
      } catch (e) {
        if (window._stopGen || (e && e.name === 'AbortError')) throw new Error('已停止');
        if (++netErr >= 4) throw new Error('魔搭轮询网络失败：' + e.message);
        continue;
      }
      const st = pd.task_status;
      if (st === 'SUCCEED') {
        const urls = pd.output_images || (pd.task_output && pd.task_output.output_images) || [];
        if (urls.length) return urls[0];
        throw new Error('魔搭任务完成但没有图片输出');
      }
      if (st === 'FAILED' || st === 'CANCELED') {
        const nf = pd.errors && /task not found/i.test((pd.errors.message || '') + (pd.errors.code || ''));
        if (nf) throw new Error('魔搭任务结果丢失（task not found，结果只可读取一次）——请重新生成；连续失败请检查魔搭账号状态');
        throw new Error('魔搭任务失败：' + ((pd.errors && (pd.errors.message || pd.errors.code)) || st));
      }
    }
    throw new Error('魔搭任务超时（3分钟）');
  }
  let modelName, endpoint, body;
  if (sense) {
    modelName = MODEL_SENSE;
    endpoint = baseUrl + '/v1/images/generations';
    body = { model: modelName, prompt, size, watermark: false, prompt_extend: true, response_format: 'url' };
  } else if (agnes) {
    modelName = modelKey === 'agnes25' ? MODEL_AGNES_25 : MODEL_AGNES_21;
    // 直连上游走 /v1/，走同源转发走 /agnes/v1/（Functions 去掉 /agnes 前缀）
    endpoint = baseUrl + (baseUrl ? '/v1/images/generations' : '/agnes/v1/images/generations');
    // Agnes 文档要求 response_format 放在 extra_body 内部
    // 超长时只在 Agnes 请求内截断（不影响其他模型）
    prompt = truncatePrompt(prompt, PROMPT_MAX_AGNES);   // Agnes 上限 9000
    body = { model: modelName, prompt, size, extra_body: { response_format: 'url' } };
    // 参考图（图生图/多图合成，Agnes 2.0 支持）——仅单模型模式生效，全部模式不传参考图
    if (_refImage && !isAll()) body.extra_body.image = [_refImage];
  } else {
    modelName = MODEL_COGVIEW;
    endpoint = baseUrl + '/images/generations';
    body = { model: modelName, prompt, size };
  }
  const hdrs = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k };
  let resp = await fetch(endpoint, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
    signal: signal
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    // 上游返回非 JSON（HTML 错误页 / 网关限流页等）
    if (resp.status === 429) throw new Error('⏳ 上游限流（HTTP 429）：该模型 API 有速率限制，请稍后再试或将「数量」调小');
    throw new Error('🚫 上游返回非 JSON（HTTP ' + resp.status + '）：上游返回了非 JSON 内容（可能是网关错误页），请稍后重试；若持续失败请检查该模型 Key 与额度');
  }
  if (!resp.ok) {
    // 兼容多种错误格式：OpenAI 风格 {error:{message|code}}、原生 {code,message}、以及 {error:"not found"} 字符串
    let msg = (data.error && (typeof data.error === 'string' ? data.error : (data.error.message || data.error.code))) || data.message || ('HTTP ' + resp.status);
    const bodyStr = JSON.stringify(data).slice(0, 400);
    const isRL = resp.status === 429 || /rate limiting|too many requests|IPM|RPM|TPM|limit reached/i.test(bodyStr);
    const isQuota = /quota|RESOURCE_EXHAUSTED|free_tier|exceeded/i.test(bodyStr);
    // 404：路由未生效（本地 server.py 未重启 / 部署的 Functions 缺失或版本过旧）
    if (resp.status === 404) {
      msg = '🚫 服务返回 404（路由未生效）：部署版可能是 Functions 未部署或版本过旧，请确认已 push 最新代码（含 functions/ 目录）后重试；本地版请重启 server.py 后 Ctrl+F5。';
    } else if (/rejected by the safety system|moderation_blocked|safety_violations|content_filter/i.test(JSON.stringify(data.error || {}))) {
      msg = '⛔ 被该模型的安全审查拦截（未通过内容审核）。GPT-Image-2 审查最严格；可换 Flux / Z-Image，或调整提示词后重试';
    } else if (isRL) {
      msg = '⏳ 上游限流（HTTP 429）：页面会等待约 1 分钟后自动重试；也可将「数量」调小或稍后再试。';
    } else if (/balance|insufficient|30001/i.test(bodyStr)) {
      msg = '💰 上游账户余额不足（code 30001）：该模型为付费模型，请先给对应平台账户充值后再试。';
    } else if (typeof msg === 'string' && msg.length > 200) {
      msg = msg.slice(0, 200) + '…';
    }
    const err = new Error(msg);
    if (isRL && !isQuota) err._rateLimit = true;   // 配额耗尽不是瞬时限流，不浪费时间重试
    throw err;
  }
  // 兼容两种响应格式：OpenAI 风格 {data:[{url|b64_json}]} 与其他平台原生 {images:[{url}]}
  const items = (data.data && data.data.length) ? data.data : (Array.isArray(data.images) ? data.images : []);
  const item = items[0];
  if (item && item.url) return item.url;
  if (item && item.b64_json) return 'data:image/png;base64,' + item.b64_json;
  throw new Error('上游未返回图片地址：' + JSON.stringify(data).slice(0, 200));
}

function switchModelView(key) {
  document.querySelectorAll('.model-sec').forEach(s => s.style.display = s.dataset.model === key ? '' : 'none');
  document.querySelectorAll('.model-tab').forEach(t => t.classList.toggle('active', t.dataset.model === key));
}

// ---- 生成结果渲染 / 重试 / 小并发 ----
let _lastCtx = null; // 最近一次生成上下文：{prompt, size, models:{mk:{key, slots}}}

// ---- 图片 URL 统一出口 ----------------------------------------------------
// 当前策略：显示一律直连上游 —— 浏览器对每家 CDN 各开 6 条连接，几家并行，快得多。
// 本地代理会把并发压成「localhost 一个 origin 共 6 条」，而且必须先下完整张原图才能缩，
// 首屏反而更慢（实测：1.2MB 的图回源 8s，39 张被串成 7 波）。
// 只有「下载」走本地 /img：需要同源才能 fetch 成 blob。
// 服务端仍保留 /img?url=…&w=640 的缩略图实现（＝将来 Cloudflare Worker 的同一契约）；
// 上 CF 后把 grid 分支改成 p + '&w=640' 即可启用 —— 那时缩放发生在边缘，才真正省时间。
function imgUrl(url, purpose) {
  if (!/^https?:\/\//i.test(url)) return url;             // data:/blob:/其它：内联内容，没有 URL 可拼
  if (!location.protocol.startsWith('http')) return url;  // file:// 直开：没有本地服务可代理
  const p = location.origin + '/img?url=' + encodeURIComponent(url);
  return purpose === 'download' ? p : url;
}

// 预留显示比例：按本次请求的尺寸先占好位，出图前后盒子尺寸一致（消除网格抖动）
function reservedRatio(mk, size) {
  // Cloudflare 的 Flux 与 SDXL-Base 输出固定 1024×1024，与所选尺寸无关
  const src = (mk === 'cfFlux' || mk === 'cfSdxlBase') ? '1024x1024' : String(size || '1024x1024');
  const p = src.split('x');
  const w = parseInt(p[0], 10) || 1024;
  const h = parseInt(p[1], 10) || 1024;
  return w + ' / ' + h;
}
function imgBoxOpen(ratio) {
  return ratio ? '<div class="img-wrap ratio" style="aspect-ratio:' + ratio + '">' : '<div class="img-wrap">';
}
// 占位骨架：与最终图片同一个盒子，避免「生成中 → 出图」时高度跳变
function slotSkeleton(i, ratio, text) {
  return '<div class="slot-label">图片 ' + (i+1) + '</div>' +
    imgBoxOpen(ratio) +
      '<div class="img-loading"><span class="spinner"></span>' + text + '</div>' +
    '</div>';
}

// 下载按钮图标：b.html 第一种用的描边托盘箭头（stroke:currentColor，自动跟着白字变色）
const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

function renderSlot(i, url, ratio) {
  return '<div class="slot-label">图片 ' + (i+1) + '</div>' +
    imgBoxOpen(ratio) +
      '<div class="img-loading"><span class="spinner"></span>加载中…</div>' +
      '<img src="' + imgUrl(url, 'grid') + '" alt="生成结果 ' + (i+1) + '" decoding="async" onload="imgLoaded(this)" onerror="imgFailed(this)" onclick="showLightbox(this.dataset.full)" data-full="' + url + '" style="cursor:zoom-in">' +
    '</div>' +
    '<div class="slot-actions">' +
      '<button class="btn-dl" onclick="downloadImage(this.dataset.url)" data-url="' + url + '">' + DL_ICON + '下载</button>' +
    '</div>';
}

function renderFail(mk, i, e) {
  let msg = (e && e.message ? e.message : String(e));
  if (msg.length > 220) msg = msg.slice(0, 220) + '…';
  return '<div class="slot-loading err">' +
    '<div class="fail-msg">图片 ' + (i+1) + ' 失败：' + msg + '</div>' +
    '<div class="slot-actions fail-actions">' +
      '<button class="ghost" onclick="retrySlot(\'' + mk + '\',' + i + ')">↻ 重试这张</button>' +
    '</div></div>';
}

async function retrySlot(mk, idx) {
  const ctx = _lastCtx;
  if (!ctx || !ctx.models[mk]) return;
  const m = ctx.models[mk];
  const slot = m.slots[idx];
  if (!slot || window._stopGen) return;
  const ratio = reservedRatio(mk, ctx.size);
  slot.innerHTML = slotSkeleton(idx, ratio, '图片 ' + (idx+1) + ' 重试中…');
  try {
    const url = await genOne(mk, ctx.prompt, ctx.size, m.key);
    slot.innerHTML = renderSlot(idx, url, ratio);
  } catch (e) {
    slot.innerHTML = renderFail(mk, idx, e);
  }
}

// 小并发池：limit 个 worker 并发消费 items（每个 worker 顺序处理自己的任务）
async function poolRun(items, limit, worker) {
  let next = 0;
  const n = Math.min(limit, items.length);
  async function loop() {
    while (true) {
      if (window._stopGen) return;
      const i = next++;
      if (i >= items.length) return;
      await worker(i);
    }
  }
  await Promise.all(Array.from({ length: n }, () => loop()));
}

async function generate() {
  saveKeysNow(); // 点生成即保存当前已填 Key（不依赖失焦/回车）
  const k = getKey(); if (!k) return;
  let prompt = promptForGeneration();
  if (!prompt) { showErr('请填写提示词'); return; }

  // 商汤/Agnes/全部：本地 server 未启动（file:// 直开且无代理，或代理指向本地但服务没起）时提前提示
  const _proxyErr = await checkLocalProxyNeeded(needsLocalProxy());
  if (_proxyErr) { showErr(_proxyErr); return; }

  // 生成即记录到提示词库（原始提示词，不含自动追加的质量词）
  addToLib(prompt);

  // 参考图提示：仅 Agnes 支持图生图，其他勾选模型会忽略参考图
  if (_refImage) {
    const noAgnes = selectedModels().filter(m => m !== 'agnes21' && m !== 'agnes25');
    if (noAgnes.length) {
      showErr('⚠️ 参考图仅 Agnes 模型支持，勾选中的 ' + noAgnes.map(modelLabel).join('、') + ' 将忽略参考图，按文生图生成');
    }
  }

  // 自动在提示词末尾（底部）补充质量词兜底
  if (!/masterpiece/i.test(prompt)) {
    prompt = prompt.replace(/[,.，。]+$/, '') + ', masterpiece, best quality, highly detailed';
  }

  const size = document.getElementById('size').value;
  const btn = document.getElementById('btnGen');
  const err = document.getElementById('err');
  const result = document.getElementById('result');
  err.innerText = '';
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>生成中…';
  window._stopGen = false;
  _genAbort = new AbortController();
  document.getElementById('btnStop').style.display = '';
  document.getElementById('btnStop').disabled = false;
  document.getElementById('btnStop').innerText = '⏹ 停止生成';

  // 一次性生成多张，串行避免速率限制，先生成先展示
  const TOTAL = Math.max(1, parseInt(document.getElementById('count').value, 10) || 1);
  result.innerHTML = '';
  document.getElementById('btnDlAll').style.display = 'none';   // 新一轮生成，上一轮的批量下载先收起来

  // 只生成勾选且已填 Key 的模型（缺 Key 的跳过，并明确提示）
  const allSel = selectedModels();
  const models = allSel.filter(mk => keyForModel(mk));
  const skipped = allSel.filter(mk => !keyForModel(mk));
  if (!models.length) { showErr('勾选的模型都没有可用的 API Key：' + skipped.map(modelLabel).join('、') + '（请到「API Key」页签填写）'); btn.disabled = false; updateBtn(); return; }
  if (skipped.length) showErr('⚠️ 已跳过未填 Key 的模型：' + skipped.map(modelLabel).join('、'));
  const secs = {};
  if (models.length > 1) {
    const tabs = document.createElement('div');
    tabs.className = 'model-tabs';
    models.forEach((mk, idx) => {
      const t = document.createElement('div');
      t.className = 'model-tab' + (idx === 0 ? ' active' : '');
      t.dataset.model = mk;
        t.textContent = modelLabel(mk);
      t.onclick = () => switchModelView(mk);
      tabs.appendChild(t);
    });
    result.appendChild(tabs);
  }
  models.forEach(mk => {
    const sec = document.createElement('div');
    sec.className = 'model-sec';
    sec.dataset.model = mk;
    if (models.length > 1) sec.style.display = (mk === models[0] ? '' : 'none');
    const label = document.createElement('div');
    label.className = 'model-label';
    label.textContent = modelLabel(mk);
    const grid = document.createElement('div');
    grid.className = 'gen-grid';
    sec.appendChild(label);
    sec.appendChild(grid);
    result.appendChild(sec);
    const ratio = reservedRatio(mk, size);
    const slots = [];
    for (let i = 0; i < TOTAL; i++) {
      const slot = document.createElement('div');
      slot.className = 'gen-slot';
      slot.innerHTML = slotSkeleton(i, ratio, '图片 ' + (i+1) + ' 生成中…'); // 先按目标尺寸占位
      grid.appendChild(slot);
      slots.push(slot);
    }
    secs[mk] = { sec, grid, slots };
  });

  // 记录本次上下文（供失败单张重试）
  _lastCtx = { prompt, size, models: {} };
  models.forEach(mk => { _lastCtx.models[mk] = { key: keyForModel(mk), slots: secs[mk].slots }; });

  // 计时开始
  const t0 = performance.now();
  let okCount = 0;
  let failCount = 0;

  // 模型之间并行（各自独立进度）；模型内部小并发——仅 Agnes 支持并发，智谱/商汤串行避免上游限流
  function modelConcurrency(mk) {
    return (mk === 'agnes21' || mk === 'agnes25') ? 2 : 1;
  }
  await Promise.all(models.map(async (mk) => {
    if (window._stopGen) return;
    const m = _lastCtx.models[mk];
    const slots = m.slots;
    const ratio = reservedRatio(mk, size);
    await poolRun(slots, modelConcurrency(mk), async (i) => {
      if (window._stopGen) {
        slots[i].remove();
        return;
      }
      slots[i].innerHTML = slotSkeleton(i, ratio, '图片 ' + (i+1) + ' 生成中…');
      let url = null;
      try {
        url = await genOne(mk, prompt, size, m.key, _genAbort.signal);
      } catch (e1) {
        if (window._stopGen || (e1 && e1.name === 'AbortError')) { slots[i].remove(); return; }
        if (e1 && e1._rateLimit) {
          // 限流（如上游 IPM/RPM 配额）：等满一分钟窗口再重试，最多 2 次（65s / 再 45s）
          let done = false;
          for (let attempt = 1; attempt <= 2 && !done; attempt++) {
            const waitSec = attempt === 1 ? 65 : 45;
            slots[i].innerHTML = slotSkeleton(i, ratio, '图片 ' + (i+1) + ' 上游限流，等待 ' + waitSec + ' 秒后自动重试…');
            await sleepStoppable(waitSec * 1000, _genAbort.signal);
            if (window._stopGen) { slots[i].remove(); return; }
            try {
              url = await genOne(mk, prompt, size, m.key, _genAbort.signal);
              done = true;
            } catch (e2) {
              if (!(e2 && e2._rateLimit)) {
                slots[i].innerHTML = renderFail(mk, i, e2);
                failCount++;
                return;
              }
            }
          }
          if (!done) {
            slots[i].innerHTML = renderFail(mk, i, e1);
            failCount++;
            return;
          }
        } else {
          // 非限流：保持原有「立即重试一次」逻辑（网络抖动/上游偶发 5xx 常见）
          try {
            url = await genOne(mk, prompt, size, m.key, _genAbort.signal);
          } catch (e2) {
            slots[i].innerHTML = renderFail(mk, i, e2);
            failCount++;
            return;
          }
        }
      }
      slots[i].innerHTML = renderSlot(i, url, ratio);
      okCount++;
    });
    if (window._stopGen) {
      slots.forEach(s => { if (!s.querySelector('img')) s.remove(); });
    }
    // 该模型组完成标志：组名 tab 字体颜色（全成功绿 / 部分失败黄 / 全失败红）
    const okSlots = slots.filter(sl => sl.querySelector('img')).length;
    const bad = slots.length - okSlots;
    const tabEl = document.querySelector('.model-tab[data-model="' + mk + '"]');
    if (tabEl) tabEl.classList.add(okSlots > 0 ? (bad > 0 ? 'tab-part' : 'tab-ok') : 'tab-fail');
  }));

  // 完成提示：耗时 + 成功/失败统计
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const done = document.createElement('div');
  done.className = 'done-note';
  done.textContent = window._stopGen
    ? '⏹ 已停止 · 用时 ' + elapsed + ' 秒（成功 ' + okCount + ' / 失败 ' + failCount + '）'
    : '✅ 完成 · 用时 ' + elapsed + ' 秒（成功 ' + okCount + ' / 失败 ' + failCount + '）';
  result.insertBefore(done, result.firstChild);
  // 批量下载按钮（生成按钮旁，有成功图才显示）
  const dlAll = document.getElementById('btnDlAll');
  dlAll.disabled = false;
  dlAll.innerHTML = DL_ICON + '批量下载（' + okCount + ' 张）';
  dlAll.style.display = okCount > 0 ? '' : 'none';

  _genAbort = null;
  btn.disabled = false; updateBtn();
  document.getElementById('btnStop').style.display = 'none';
}

function stopGen() {
  window._stopGen = true;
  if (_genAbort) { try { _genAbort.abort(); } catch (e) {} }
  const sb = document.getElementById('btnStop');
  sb.disabled = true; sb.innerText = '正在停止…';
}

// ---------- 参考图（图生图，仅 Agnes 支持） ----------
let _refImage = null; // dataURL
const refDropzone = document.getElementById('refDropzone');
const refFileInput = document.getElementById('refFile');
refFileInput.addEventListener('change', () => { if (refFileInput.files[0]) setRefImage(refFileInput.files[0]); });
['dragover','dragenter'].forEach(ev => refDropzone.addEventListener(ev, e => { e.preventDefault(); refDropzone.classList.add('dragover'); }));
['dragleave','drop'].forEach(ev => refDropzone.addEventListener(ev, e => { e.preventDefault(); refDropzone.classList.remove('dragover'); }));
refDropzone.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) setRefImage(f);
});
async function setRefImage(file) {
  try {
    _refImage = await compressImage(file, 1024, 0.9);
    document.getElementById('refPlaceholder').style.display = 'none';
    document.getElementById('refPreviewRow').style.display = 'flex';
    document.getElementById('refPreview').src = _refImage;
    document.getElementById('refName').textContent = file.name;
  } catch (e) {
    alert('参考图读取失败：' + (e && e.message ? e.message : e));
  }
}
function clearRefImage(ev) {
  if (ev) ev.stopPropagation();
  _refImage = null;
  document.getElementById('refPlaceholder').style.display = '';
  document.getElementById('refPreviewRow').style.display = 'none';
  refFileInput.value = '';
}

function imgLoaded(img) {
  const wrap = img.parentElement;
  if (wrap && wrap.classList.contains('img-wrap')) wrap.classList.add('loaded');
}

function imgFailed(img) {
  const wrap = img.parentElement;
  // 缩略图失败（代理没起 / 上游拒绝 / 没装 Pillow 也失败）：退回原图再试一次，别让网格变碎图
  if (img.dataset.full && img.getAttribute('src') !== img.dataset.full) {
    img.setAttribute('src', img.dataset.full);
    return;
  }
  if (wrap && wrap.classList.contains('img-wrap')) wrap.classList.add('failed');
}

// ---------- 提示词库（历史 + 收藏） ----------
const LIB_KEY = 'prompt_lib';
function loadLib() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch (e) { return []; }
}
function saveLib(arr) {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(arr.slice(0, 100))); } catch (e) {}
}
function addToLib(text) {
  const t = (text || '').trim();
  if (!t) return;
  // 记录：原始提示词 + 原始语言 + 中文版。列表统一显示中文；点选时填入原始提示词
  const main = _promptMainLang;
  const srcLang = isZhText(t) ? 'zh' : 'en';                              // 按内容判断原始语言（不管在哪个框输入）
  const zhTxt = promptTextOf(main === 'zh' ? 'en' : 'zh');                // 另一栏 = 翻译结果
  const zh = srcLang === 'zh' ? t : (isZhText(zhTxt) ? zhTxt : '');       // 中文版（为空则显示时再补翻译）
  let arr = loadLib().filter(x => x.text !== t);
  arr.unshift({ text: t, lang: srcLang, zh: zh, star: false });
  saveLib(arr);
  updateLibCount();
}
function toggleLib() {
  const list = document.getElementById('libList');
  list.style.display = list.style.display === 'none' ? '' : 'none';
  renderLib();
}
function renderLib() {
  const list = document.getElementById('libList');
  const arr = loadLib();
  list.innerHTML = '';
  if (!arr.length) { list.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px">暂无记录，生成过的提示词会自动保存</div>'; return; }
  arr.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'lib-item';
    row.innerHTML =
      '<span class="lib-star' + (item.star ? ' on' : '') + '" onclick="toggleStar(' + idx + ')" title="收藏">' + (item.star ? '★' : '☆') + '</span>' +
      '<span class="lib-text" title="' + (item.zh || item.text).replace(/"/g,'&quot;').replace(/</g,'&lt;') + '（点击填入提示词）" onclick="usePrompt(' + idx + ')">' + (item.zh || item.text).replace(/</g,'&lt;') + '</span>' +
      '<span class="lib-del" onclick="removeFromLib(' + idx + ')">✕</span>';
    list.appendChild(row);
  });
  // 缺中文版（或中文版不是真中文，如历史记录把英文原文误存进 zh）的记录：补中文，完成后原地更新并写回
  arr.forEach(function (item, idx) { if (!(item.zh && isZhText(item.zh))) libEnsureZh(idx, item); });
}
function updateLibCount() {
  const c = document.getElementById('libCount');
  if (c) c.textContent = loadLib().length;
}
function toggleStar(idx) {
  const arr = loadLib();
  arr[idx].star = !arr[idx].star;
  saveLib(arr);
  renderLib();
}
function usePrompt(idx) {
  const arr = loadLib();
  const t = arr[idx].text;          // 原始提示词（中文或英文原文）
  setPromptText('zh', t);           // 填入「提示词」框
  setPromptText('en', '');
  _promptMainLang = 'zh';
  switchPromptLang('zh');           // 停在「提示词」标签，不切到「翻译结果」
  updatePromptCount();
  autoTranslate('zh');              // 自动识别方向，把另一栏翻译出来
  // 选择后收起提示词库
  const list = document.getElementById('libList');
  if (list) list.style.display = 'none';
}
function removeFromLib(idx) {
  const arr = loadLib();
  arr.splice(idx, 1);
  saveLib(arr);
  renderLib();
}
function clearLib() {
  if (!confirm('清空全部提示词记录？')) return;
  saveLib([]);
  renderLib();
}
// 库翻译专用实例（与提示词框的 _promptTransCache 互不干扰，也不写提示词状态栏）
let _libTrans = null;
async function libTranslator(srcCode, dstCode) {
  srcCode = await resolveLangCode(srcCode);
  dstCode = await resolveLangCode(dstCode);
  const key = srcCode + '\u0001' + dstCode;
  if (_libTrans && _libTrans.key === key) return _libTrans.t;
  const t = await window.Translator.create({ sourceLanguage: srcCode, targetLanguage: dstCode, monitor: function () {} });
  _libTrans = { key: key, t: t };
  return t;
}
// 补/修中文版：中文记录直接用原文；英文记录用本地翻译翻成中文（同时修掉把英文误存进 zh 的历史记录）
async function libEnsureZh(idx, item) {
  if (item.zh && isZhText(item.zh)) return;   // 已有有效中文版
  const t = (item.text || '').trim();
  if (!t) return;
  let out = '';
  if (isZhText(t)) {
    out = t;
  } else if (hasLocalTranslator()) {
    try {
      const tr = await libTranslator('en', 'zh');
      out = String(await tr.translate(t) || '').trim();
    } catch (e) { out = ''; }
  }
  if (!out) return;   // 没有可用中文版：保持原文显示
  const cur = loadLib();
  const hit = cur.find(x => x.text === t && !(x.zh && isZhText(x.zh)));
  if (hit) { hit.zh = out; saveLib(cur); }
  const rows = document.getElementById('libList').querySelectorAll('.lib-text');
  if (rows[idx] && rows[idx].textContent === t) rows[idx].textContent = out;
}
updateLibCount();
