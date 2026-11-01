/* ============ 视频生成（Agnes 异步任务：提交 → 轮询） ============ */
const DEBUG_VIDEO = false;   // 调试日志开关：置 true 打印参考图/提交/轮询细节
const vScenesEl = document.getElementById('vScenes');
const vSizeEl = document.getElementById('vSize');
const vSecondsEl = document.getElementById('vSeconds');
// 胶囊同步函数：必须提前声明（updateVideoSizeOptions 在顶层 vPickRefresh 中被调用，早于下方胶囊绑定代码）
let vSizePillsSync = null, vSecondsPillsSync = null;
const vState = document.getElementById('vState');
const vErr = document.getElementById('vErr');
const btnGenVideo = document.getElementById('btnGenVideo');
const btnStopVideo = document.getElementById('btnStopVideo');
const btnDlAllVideo = document.getElementById('btnDlAllVideo');
const vResultsEl = document.getElementById('vResults');

// 场景衔接（chain）模式：上一场景尾帧作为下一场景首帧，顺序生成
let _chainMode = false;
const vChainEl = document.getElementById('vChainMode');
try { _chainMode = localStorage.getItem('v_chain_mode') === '1'; } catch (e) {}
vChainEl.checked = _chainMode;
vChainEl.addEventListener('change', function () {
  _chainMode = vChainEl.checked;
  try { localStorage.setItem('v_chain_mode', _chainMode ? '1' : '0'); } catch (e) {}
  updateVideoBtn();
});

// 视频模型：Agnes 视频（keyAgnes，转发/直连）
const VIDEO_MODEL_LIST = [
  { key: 'agnesVideo', label: 'Agnes Video 2.5 Flash', model: 'agnes-video-2.5-flash', keyEl: 'keyAgnes', upstream: 'agnes' },
];
const VIDEO_MODEL_SIZES = {
  agnesVideo: ['720P'],
};
// 每个模型支持的时长（秒）：Agnes 4–12
const VIDEO_SECONDS = {
  agnesVideo: ['4', '5', '6', '8', '10', '12'],
};

function vModelName(key) { const m = VIDEO_MODEL_LIST.find(x => x.key === key); return m ? m.model : key; }
function vModelLabel(key) { const m = VIDEO_MODEL_LIST.find(x => x.key === key); return m ? m.label : key; }

function selectedVideoModels() {
  return Array.from(document.querySelectorAll('input.v-model-check:checked')).map(b => b.value);
}
let vSingleMode = false;
function vApplySingleKeepOne() {
  applySingleKeepOne('input.v-model-check');
}
function checkAllVideoModels(on) {
  const boxes = document.querySelectorAll('input.v-model-check');
  if (on && vSingleMode) { boxes.forEach((b, i) => { b.checked = (i === 0); }); }
  else { boxes.forEach(b => { b.checked = on; }); }
  vPickRefresh(); vSaveModels();
}
function openVideoPicker() { vPickRefresh(); document.getElementById('videoPicker').classList.add('show'); }
function closeVideoPicker() { document.getElementById('videoPicker').classList.remove('show'); vPickRefresh(); }
function vPickRefresh() {
  const n = selectedVideoModels().length;
  const modeTxt = vSingleMode ? '单选' : '多选';
  const s = document.getElementById('vPickSummary');
  if (s) s.textContent = '已选 ' + n + ' 个 · ' + modeTxt;
  const c = document.getElementById('vPickCount');
  if (c) c.textContent = '已选 ' + n + ' 个模型 · ' + modeTxt;
  updateVideoSizeOptions();
  updateVideoSecondsOptions();
  updateVideoBtn();
}
const vModeSwitchEl = document.getElementById('vModeSwitch');
try { vSingleMode = localStorage.getItem('v_single_mode') === '1'; } catch (e) { vSingleMode = false; }
vModeSwitchEl.checked = !vSingleMode;
vModeSwitchEl.addEventListener('change', function () {
  vSingleMode = !vModeSwitchEl.checked;
  try { localStorage.setItem('v_single_mode', vSingleMode ? '1' : '0'); } catch (e) {}
  if (vSingleMode) vApplySingleKeepOne();
  vPickRefresh(); vSaveModels();
});
if (vSingleMode) vApplySingleKeepOne();

// 视频模型勾选状态持久化
function vSaveModels() { try { localStorage.setItem('v_sel_models', JSON.stringify(selectedVideoModels())); } catch (e) {} }
function vRestoreModels() {
  try {
    const arr = JSON.parse(localStorage.getItem('v_sel_models') || 'null');
    if (Array.isArray(arr) && arr.length) {
      document.querySelectorAll('input.v-model-check').forEach(b => { b.checked = arr.indexOf(b.value) >= 0; });
    }
  } catch (e) {}
  if (vSingleMode) vApplySingleKeepOne();
}
document.querySelectorAll('input.v-model-check').forEach(b => b.addEventListener('change', function () {
  if (vSingleMode) {
    if (b.checked) { document.querySelectorAll('input.v-model-check').forEach(o => { if (o !== b) o.checked = false; }); }
    else if (!document.querySelector('input.v-model-check:checked')) { b.checked = true; }
  }
  vPickRefresh(); vSaveModels();
}));

// 恢复视频模型勾选记忆（必须在尺寸下拉重建之前）
vRestoreModels();
vPickRefresh();

// 视频分辨率：多选取交集；单选取该模型档位；交集为空 → 'auto'（各模型发自己的默认档位）
function updateVideoSizeOptions() {
  const sel = vSizeEl; if (!sel) return;
  const sels = selectedVideoModels();
  let list;
  if (!sels.length) list = VIDEO_MODEL_SIZES.agnesVideo.slice();
  else if (sels.length === 1) list = (VIDEO_MODEL_SIZES[sels[0]] || ['1280x720']).slice();
  else {
    list = sels.reduce(function (acc, mk) {
      return acc.filter(v => (VIDEO_MODEL_SIZES[mk] || []).indexOf(v) >= 0);
    }, (VIDEO_MODEL_SIZES[sels[0]] || []).slice());
    if (!list.length) list = ['auto'];
  }
  const prev = sel.value;
  sel.innerHTML = list.map(v => '<option value="' + v + '">' + (v === 'auto' ? '自动（各模型默认档位）' : v) + '</option>').join('');
  if (list.indexOf(prev) >= 0) sel.value = prev; else sel.value = list[0];
  try { localStorage.setItem('v_size_sel', sel.value); } catch (e) {}
  if (vSizePillsSync) vSizePillsSync();
}
// 时长选项：按所选模型过滤（多选取交集；无交集退回共同默认 5 秒）
function updateVideoSecondsOptions() {
  const sels = selectedVideoModels();
  let list;
  if (!sels.length) list = VIDEO_SECONDS.agnesVideo.slice();
  else if (sels.length === 1) list = (VIDEO_SECONDS[sels[0]] || ['5']).slice();
  else {
    list = sels.reduce(function (acc, mk) {
      return acc.filter(v => (VIDEO_SECONDS[mk] || []).indexOf(v) >= 0);
    }, (VIDEO_SECONDS[sels[0]] || []).slice());
    if (!list.length) list = ['5'];
  }
  const prev = vSecondsEl.value;
  vSecondsEl.innerHTML = list.map(v => '<option value="' + v + '">' + v + '</option>').join('');
  if (list.indexOf(prev) >= 0) vSecondsEl.value = prev; else vSecondsEl.value = list[0];
  try { localStorage.setItem('v_seconds_sel', vSecondsEl.value); } catch (e) {}
  if (vSecondsPillsSync) vSecondsPillsSync();
}
// ---------- 分辨率/时长胶囊按钮 ----------
const vSizePillsEl = document.getElementById('vSizePills');
const vSecondsPillsEl = document.getElementById('vSecondsPills');
if (vSizeEl && vSizePillsEl) {
  vSizePillsSync = bindPills(vSizePillsEl, {
    get: function () { return vSizeEl.value; },
    set: function (v) { vSizeEl.value = v; vSizeEl.dispatchEvent(new Event('change')); },
    options: function () { return Array.from(vSizeEl.options).map(function (o) { return { value: o.value, label: o.textContent }; }); },
    onSync: updateVideoSummary
  });
}
if (vSecondsEl && vSecondsPillsEl) {
  vSecondsPillsSync = bindPills(vSecondsPillsEl, {
    get: function () { return vSecondsEl.value; },
    set: function (v) { vSecondsEl.value = v; vSecondsEl.dispatchEvent(new Event('change')); },   // 触发 change 监听（存 localStorage）
    options: function () { return Array.from(vSecondsEl.options).map(function (o) { return { value: o.value, label: o.textContent }; }); },
    onSync: updateVideoSummary
  });
}

// 视频生成设置摘要按钮 + 弹窗
function updateVideoSummary() {
  const el = document.getElementById('videoSummary');
  if (!el) return;
  const sEl = document.getElementById('vSize');
  const dEl = document.getElementById('vSeconds');
  const s = sEl ? (sEl.value === 'auto' ? '自动' : sEl.value) : '—';
  const d = dEl ? dEl.value : '5';
  el.textContent = s + ' · ' + d;
}
function openVideoSettings() { const el = document.getElementById('videoSettings'); if (el) el.classList.add('show'); }
function closeVideoSettings() { const el = document.getElementById('videoSettings'); if (el) el.classList.remove('show'); }

// 视频分辨率/时长：先读上次选择，再建选项（多选取交集），最后恢复选择
let _savedVSize = null, _savedVSeconds = null;
try {
  _savedVSize = localStorage.getItem('v_size_sel');
  _savedVSeconds = localStorage.getItem('v_seconds_sel');
} catch (e) {}
updateVideoSizeOptions();
updateVideoSecondsOptions();
try {
  if (_savedVSize && Array.from(vSizeEl.options).some(o => o.value === _savedVSize)) {
    vSizeEl.value = _savedVSize;
    try { localStorage.setItem('v_size_sel', _savedVSize); } catch (e) {}
  }
  if (_savedVSeconds && Array.from(vSecondsEl.options).some(o => o.value === _savedVSeconds)) {
    vSecondsEl.value = _savedVSeconds;
    try { localStorage.setItem('v_seconds_sel', _savedVSeconds); } catch (e) {}
  }
  if (vSizePillsSync) vSizePillsSync();
  if (vSecondsPillsSync) vSecondsPillsSync();
} catch (e) {}
vSecondsEl.addEventListener('change', function () {
  try { localStorage.setItem('v_seconds_sel', vSecondsEl.value); } catch (e) {}
});
vSizeEl.addEventListener('change', function () {
  try { localStorage.setItem('v_size_sel', vSizeEl.value); } catch (e) {}
});

// 多场景管理：每个场景一张卡片（提示词 + 结果），id 用自增计数器
let _sceneSeq = 0;
function collectScenes() {
  const out = [];
  document.querySelectorAll('#vScenes .v-scene').forEach(function (s) {
    const ta = s.querySelector('textarea');
    const p = ta ? ta.value : '';
    if (p && p.trim()) out.push({ el: s, prompt: p.trim() });
  });
  return out;
}
function addVideoScene(prompt) {
  const id = ++_sceneSeq;
  const scene = document.createElement('div');
  scene.className = 'v-scene';
  scene.dataset.sceneId = id;
  scene.innerHTML = '<div class="v-scene-head">' +
    '<span class="v-scene-title">场景 <i data-role="idx"></i></span>' +
    '<button type="button" class="v-scene-del" onclick="removeVideoScene(' + id + ')" title="删除此场景">×</button>' +
    '</div>' +
    '<textarea class="v-scene-prompt" placeholder="描述这个场景的画面、动作、运镜…"></textarea>';
  const ta = scene.querySelector('textarea');
  if (prompt) ta.value = prompt;
  ta.addEventListener('input', saveScenes);
  vScenesEl.appendChild(scene);
  renumberScenes();
  updateVideoBtn();
  saveScenes();
  return scene;
}
function removeVideoScene(id) {
  const scenes = Array.from(document.querySelectorAll('#vScenes .v-scene'));
  if (scenes.length <= 1) {   // 至少保留一张
    const ta = scenes[0].querySelector('textarea');
    ta.value = '';
    ta.focus();
    updateVideoBtn();
    saveScenes();
    return;
  }
  const el = document.querySelector('#vScenes .v-scene[data-scene-id="' + id + '"]');
  if (el) el.remove();
  renumberScenes();
  updateVideoBtn();
  saveScenes();
}
function renumberScenes() {
  document.querySelectorAll('#vScenes .v-scene').forEach(function (s, i) {
    const idx = s.querySelector('[data-role="idx"]');
    if (idx) idx.textContent = (i + 1);
  });
}
// 生成中锁定场景编辑（灰掉删除按钮/输入框/添加按钮），防止生成中改动导致困惑
let _videoLocked = false;   // 生成中锁定标志（参考图区也检查它）
function lockScenes(locked) {
  _videoLocked = locked;
  document.querySelectorAll('#vScenes .v-scene').forEach(function (s) {
    const ta = s.querySelector('textarea');
    const del = s.querySelector('.v-scene-del');
    if (ta) {
      ta.disabled = locked;
      ta.style.opacity = locked ? '.5' : '';
      ta.style.cursor = locked ? 'not-allowed' : '';
      ta.placeholder = locked ? '生成中，请等待…' : '描述这个场景的画面、动作、运镜…';
    }
    if (del) {
      del.disabled = locked;
      del.style.opacity = locked ? '.4' : '';
      del.style.cursor = locked ? 'not-allowed' : '';
      del.title = locked ? '生成中，请等待' : '删除此场景';
    }
  });
  const addBtn = document.getElementById('btnAddScene');
  if (addBtn) {
    addBtn.disabled = locked;
    addBtn.style.opacity = locked ? '.5' : '';
    addBtn.style.cursor = locked ? 'not-allowed' : '';
  }
  const resetBtn = document.getElementById('btnResetVideo');
  if (resetBtn) {
    resetBtn.disabled = locked;
    resetBtn.style.opacity = locked ? '.5' : '';
    resetBtn.style.cursor = locked ? 'not-allowed' : '';
  }
  const charBtn = document.getElementById('btnCharGenRef');
  if (charBtn) {
    charBtn.disabled = locked;
    charBtn.style.opacity = locked ? '.5' : '';
    charBtn.style.cursor = locked ? 'not-allowed' : '';
  }
  const clearBtn = document.getElementById('btnClearRef');
  if (clearBtn) {
    clearBtn.disabled = locked;
    clearBtn.style.opacity = locked ? '.5' : '';
    clearBtn.style.cursor = locked ? 'not-allowed' : '';
  }
  if (vChainEl) {
    vChainEl.disabled = locked;
    vChainEl.style.opacity = locked ? '.5' : '';
    vChainEl.style.cursor = locked ? 'not-allowed' : '';
  }
  if (vRefDropzone) vRefDropzone.style.cursor = locked ? 'not-allowed' : '';
}
function updateVideoBtn() {
  const n = collectScenes().length;
  btnGenVideo.innerHTML = _chainMode ? '🔗 顺序生成 ' + n + ' 个场景（衔接）' : '🎬 同时生成 ' + n + ' 个场景';
}
function saveScenes() {
  try {
    const arr = Array.from(document.querySelectorAll('#vScenes .v-scene textarea')).map(function (ta) { return ta.value; });
    localStorage.setItem('v_scenes', JSON.stringify(arr));
  } catch (e) {}
}
function restoreScenes() {
  let arr = null;
  try { arr = JSON.parse(localStorage.getItem('v_scenes') || 'null'); } catch (e) {}
  if (!Array.isArray(arr) || !arr.length) arr = [''];
  arr.forEach(function (p) { addVideoScene(p); });
}
restoreScenes();   // 恢复上次场景（无记录则一张空场景）

// ---------- 角色参考图（图生视频 reference 模式：锁定人物，所有场景共用） ----------
let _vRefImage = null; // dataURL
const vRefDropzone = document.getElementById('vRefDropzone');
const vRefFileInput = document.getElementById('vRefFile');
vRefFileInput.addEventListener('change', function () { if (vRefFileInput.files[0]) setVideoRefImage(vRefFileInput.files[0]); });
['dragover', 'dragenter'].forEach(function (ev) { vRefDropzone.addEventListener(ev, function (e) { e.preventDefault(); vRefDropzone.classList.add('dragover'); }); });
['dragleave', 'drop'].forEach(function (ev) { vRefDropzone.addEventListener(ev, function (e) { e.preventDefault(); vRefDropzone.classList.remove('dragover'); }); });
function pickRefFile() {
  if (_videoLocked) return;   // 生成中不允许更换参考图
  vRefFileInput.click();
}
vRefDropzone.addEventListener('drop', function (e) {
  if (_videoLocked) return;   // 生成中不允许更换参考图
  const f = e.dataTransfer.files[0];
  if (f && f.type.indexOf('image/') === 0) setVideoRefImage(f);
});
async function setVideoRefImage(file) {
  try {
    applyVideoRef(await compressImage(file, 1024, 0.9), file.name);
  } catch (e) {
    alert('角色参考图读取失败：' + (e && e.message ? e.message : e));
  }
}
// 统一设置参考图（内存 + 缩略图 + 持久化到 localStorage）
function applyVideoRef(src, name) {
  _vRefImage = src;
  // 验证：打印参考图来源（URL 可直接复制去浏览器点开，确认是否还有效）
  if (src) {
    const s = String(src);
    const isUrl = /^https?:\/\//i.test(s);
    if (DEBUG_VIDEO) console.log('[参考图] ' + (name || '角色参考图') + ' | 类型=' + (isUrl ? 'URL' : 'base64(' + s.length + ' 字符)') + (isUrl ? ' | 地址=' + s : ''));
  }
  document.getElementById('vRefPlaceholder').style.display = 'none';
  document.getElementById('vRefPreviewRow').style.display = 'flex';
  document.getElementById('vRefPreview').src = src;
  document.getElementById('vRefName').textContent = name || '角色参考图';
  try {
    if (src && String(src).length < 3000000) {   // 只存 <3MB，避免撑爆 localStorage（约 5MB 上限）
      localStorage.setItem('v_ref_image', src);
      localStorage.setItem('v_ref_name', name || '');
    }
  } catch (e) {}
}
function clearVideoRefImage(ev) {
  if (ev) ev.stopPropagation();
  _vRefImage = null;
  document.getElementById('vRefPlaceholder').style.display = '';
  document.getElementById('vRefPreviewRow').style.display = 'none';
  vRefFileInput.value = '';
  try { localStorage.removeItem('v_ref_image'); localStorage.removeItem('v_ref_name'); } catch (e) {}
}
// 刷新后恢复上次的角色参考图
try {
  const savedRef = localStorage.getItem('v_ref_image');
  if (savedRef) applyVideoRef(savedRef, localStorage.getItem('v_ref_name') || '角色参考图');
} catch (e) {}
// 点击缩略图放大查看角色参考图（复用全局 lightbox）
function previewVideoRef(ev) {
  if (ev) ev.stopPropagation();
  if (_vRefImage) showLightbox(_vRefImage, true);
}

// 重置视频面板：清空角色参考图 + 所有场景提示词，回到一张空场景
function resetVideoPanel() {
  if (!confirm('重置视频面板？会清空角色参考图和所有场景提示词。')) return;
  clearVideoRefImage();
  try { localStorage.removeItem('v_scenes'); } catch (e) {}
  document.querySelectorAll('#vScenes .v-scene').forEach(function (s) { s.remove(); });
  addVideoScene();   // 回到一张空场景（会自动 saveScenes）
  vErr.textContent = '';
  vMsg('');
}

// ---------- 一键生成角色设定图（图像模型生成三视图 → 自动设为角色参考图） ----------
function openCharPicker() {
  document.getElementById('charErr').textContent = '';
  document.getElementById('charStatus').textContent = '';
  document.getElementById('charPicker').classList.add('show');
  setTimeout(function () { const d = document.getElementById('charDesc'); if (d) d.focus(); }, 50);
}
function closeCharPicker() {
  document.getElementById('charPicker').classList.remove('show');
}

const CHAR_SHEET_SIZES = { msZimg: '1024x1024', agnes25: '1024x1024', agnes21: '1024x1024', cogview: '1024x1024', sensenova: '1344x1344', cfFlux: '1024x1024' };
async function genCharSheet() {
  const desc = document.getElementById('charDesc').value.trim();
  if (!desc) { document.getElementById('charErr').textContent = '请先填写角色描述'; return; }
  const modelKey = document.getElementById('charModel').value;
  const k = keyForModel(modelKey);
  if (!k) { document.getElementById('charErr').textContent = '该图像模型还没填 API Key，请先在「API Key」页签填写'; return; }
  const btn = document.getElementById('btnCharGen');
  const errEl = document.getElementById('charErr');
  const stEl = document.getElementById('charStatus');
  errEl.textContent = '';
  stEl.textContent = '';
  btn.disabled = true;
  btn.textContent = '⏳ 生成中…';
  try {
    window._stopGen = false;   // 防止图像面板残留的停止标志误杀本次生成
    const prompt = '二次元动漫角色设定集，赛璐璐上色，清晰线条描边。角色正面/侧面/背面三视图，全身，纯白背景，细节清晰，一致外观。' + desc;
    const size = CHAR_SHEET_SIZES[modelKey] || '1024x1024';
    const abort = new AbortController();
    const result = await genOne(modelKey, prompt, size, k, abort.signal);
    if (!result) throw new Error('图像模型未返回图片');
    applyVideoRef(result, '角色设定图');
    stEl.textContent = '✅ 已设为参考图';
    setTimeout(closeCharPicker, 700);
  } catch (e) {
    errEl.textContent = '生成失败：' + (e && e.message ? e.message : e);
    stEl.textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '🎨 生成并设为参考图';
  }
}

function vMsg(html) { vState.innerHTML = html || ''; vState.style.display = html ? 'block' : 'none'; }
function vFail(msg) { vErr.textContent = msg; }

let _videoAbort = null;
let _videoStopped = false;
function sleepV(ms, signal) {
  return sleepStoppable(ms, signal, function () { return _videoStopped; });
}

// 计算 Agnes 视频的提交/轮询环境（本地同源转发 / 线上直连）
function vEnv(modelKey) {
  const model = vModelName(modelKey);
  let base, submitPath, pollPath;
  if (location.protocol.startsWith('http')) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.hostname);
    if (isLocal) { base = ''; submitPath = '/agnes/v1/videos'; pollPath = '/agnesapi?'; }
    else { base = API_AGNES; submitPath = '/v1/videos'; pollPath = '/agnesapi?'; }
  } else {
    base = API_AGNES; submitPath = '/v1/videos'; pollPath = '/agnesapi?';
  }
  return { model: model, base: base, submitPath: submitPath, pollPath: pollPath };
}

// 阶段一：提交视频任务（带限流重试），返回 { taskId, env }
async function submitVideoTask(modelKey, prompt, size, k, signal, opts) {
  const env = vEnv(modelKey);
  const effSize = (size === 'auto') ? ((VIDEO_MODEL_SIZES[modelKey] || ['720P'])[0]) : size;
  const secVal = parseInt(vSecondsEl.value, 10) || 5;
  opts = opts || {};
  // 三种模式：keyframe（尾帧衔接，first_frame 优先）> reference（角色参考图）> text（纯文本）
  const useKey = !!opts.firstFrame;
  const useRef = !useKey && !!_vRefImage;
  const mode = useKey ? 'keyframe' : (useRef ? 'reference' : 'text');
  const finalPrompt = useRef ? ('以 <Picture 1> 中的角色为参考，保持外观一致。' + prompt) : prompt;
  const body = { model: env.model, prompt: finalPrompt, mode: mode, seconds: String(secVal), size: effSize, aspect_ratio: '16:9' };
  if (useKey) body.first_frame = opts.firstFrame;
  if (useRef) body.images = [_vRefImage];
  // 验证：打印实际发出去的请求，确认参考图/首帧是否真的附加
  if (DEBUG_VIDEO) console.log('[视频提交] 模式=' + mode,
    '| 参考图 images=' + (body.images ? body.images.length + ' 张' : '无'),
    body.images && body.images[0] ? ('| 类型=' + (String(body.images[0]).indexOf('data:') === 0 ? 'base64(' + body.images[0].length + ' 字符)' : 'URL')) : '',
    '| 首帧 first_frame=' + (body.first_frame ? '有(' + body.first_frame.length + ' 字符)' : '无'),
    '| 提示词前 40 字=' + finalPrompt.slice(0, 40));
  const maxRetry = 30;   // Agnes 免费队列/RPM 严格，加长重试次数等队列排空
  let sd = null;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    let sub;
    try {
      sub = await fetch(env.base + env.submitPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
        body: JSON.stringify(body),
        signal: signal
      });
    } catch (e) {
      if (_videoStopped || (e && e.name === 'AbortError')) throw new Error('已停止');
      if (attempt < maxRetry) { await sleepV(2000, signal); continue; }
      throw new Error('提交网络失败：' + (e && e.message ? e.message : e));
    }
    sd = await sub.json().catch(function () { return null; });
    if (sub.ok) {
      if (DEBUG_VIDEO) console.log('[视频提交] 响应成功:', JSON.stringify(sd).slice(0, 400));
      break;
    }
    const ec = sd && sd.error && sd.error.code;
    const em = (sd && sd.error && (sd.error.message || sd.error.code)) || (sd && sd.message) || ('HTTP ' + sub.status);
    const isQueue = ec === 'video_queue_full' || ec === 'queue_full' || /queue|队列|繁忙|稍后|服务忙/i.test(String(ec) + String(em));
    const retryable = sub.status === 429 || sub.status >= 500 || ec === '1305' || ec === 1305 || isQueue || /访问量过大|too many|overloaded|rate/i.test(String(em));
    if (DEBUG_VIDEO) console.log('[submitVideo] attempt=' + attempt + ' status=' + sub.status + ' ec=' + ec + ' em=' + String(em).slice(0, 100));
    if (retryable && attempt < maxRetry) {
      if (_videoStopped || signal.aborted) throw new Error('已停止');
      // 队列满/429：快速重试（5s→10s→15s…最长60s）；其他错误：短退避
      const wait = (sub.status === 429 || isQueue) ? Math.min(60000, attempt * 5000) : Math.min(10000, attempt * 2000);
      await sleepV(wait, signal);
      if (_videoStopped || signal.aborted) throw new Error('已停止');
      continue;
    }
    throw new Error('提交失败：' + em);
  }
  const taskId = sd.video_id || sd.id || sd.task_id;
  if (!taskId) throw new Error('Agnes 未返回任务 ID：' + JSON.stringify(sd).slice(0, 180));
  return { taskId: taskId, env: env };
}

// 阶段二：轮询视频任务直至完成，返回视频地址
async function pollVideoTask(taskId, env, k, signal) {
  const t0 = Date.now();
  let netErr = 0;
  const pollInterval = 6000;   // Agnes 免费 RPM 严格，降低撞限流概率
  let rateBackoff = 0;   // 429 时额外退避（累加），正常轮询复位
  while (Date.now() - t0 < 1800000) {   // 30 分钟：免费通道排队+生成更久
    await sleepV(pollInterval + rateBackoff, signal);
    if (_videoStopped || signal.aborted) throw new Error('已停止');
    let pd = null;
    let pollStatus = 0;
    try {
      const pr = await fetch(env.base + env.pollPath + ('video_id=' + encodeURIComponent(taskId) + '&model_name=' + encodeURIComponent(env.model)), { headers: { 'Authorization': 'Bearer ' + k }, signal: signal });
      pollStatus = pr.status;
      pd = await pr.json().catch(function () { return null; });
      netErr = 0;
    } catch (e) {
      if (_videoStopped || (e && e.name === 'AbortError')) throw new Error('已停止');
      if (++netErr >= 4) throw new Error('轮询网络失败：' + e.message);
      continue;
    }
    if (pollStatus === 429) {
      rateBackoff = Math.min(20000, (rateBackoff || 2000) + 4000);
      continue;
    }
    rateBackoff = 0;
    const st = pd.task_status || pd.status;
    const done = (st === 'completed' || st === 'Completed' || st === 'COMPLETED');
    if (done) {
      const vurl = pd.url || pd.video_url;
      if (!vurl) throw new Error('任务完成但没有视频地址：' + JSON.stringify(pd).slice(0, 400));
      return /^https?:\/\//i.test(vurl) ? vurl : (env.base + vurl.replace(/^\//, ''));
    }
    const failed = (st === 'failed' || st === 'Failed' || st === 'FAILED');
    if (failed) {
      const fm = (pd.error && (pd.error.message || pd.error.code)) || pd.message || st;
      throw new Error('任务失败：' + fm);
    }
  }
  throw new Error('任务超时（30 分钟，可能仍在排队，可稍后重试）');
}

// 视频结果渲染（就地渲染到每个场景卡片下方）
function renderSceneStatus(text) {
  return '<div class="scene-status"><span class="spinner"></span>' + text + '</div>';
}
function renderSceneFail(e) {
  let msg = (e && e.message ? e.message : String(e));
  if (msg.length > 220) msg = msg.slice(0, 220) + '…';
  return '<div class="scene-status err2">' + msg + '</div>';
}
function renderSceneVideo(url) {
  const full = /^https?:\/\//.test(url) ? url : (API + url.replace(/^\//, ''));
  return '<video src="' + full + '" controls autoplay loop muted></video>' +
    '<div class="scene-actions">' +
      '<button class="btn-dl" onclick="downloadVideo(\'' + full.replace(/'/g, "\\'") + '\')">' + DL_ICON + '下载</button>' +
    '</div>';
}

// 底部集中结果区：不预建，哪个场景真正开始生成/出结果了才出现对应项
function initResults(n) {
  if (!vResultsEl) return;
  vResultsEl.innerHTML = '';
}
function fillResult(idx, html, modeTag) {
  if (!vResultsEl) return;
  let item = vResultsEl.querySelector('.v-result-item[data-result-idx="' + idx + '"]');
  if (!item) {
    item = document.createElement('div');
    item.className = 'v-result-item';
    item.dataset.resultIdx = idx;
    item.innerHTML = '<div class="v-result-head"></div><div class="v-result-body"></div>';
    vResultsEl.appendChild(item);
  }
  const head = item.querySelector('.v-result-head');
  if (head) head.innerHTML = '场景 ' + (idx + 1) + (modeTag ? ' <span class="v-result-mode">' + modeTag + '</span>' : '');
  const body = item.querySelector('.v-result-body');
  if (body) body.innerHTML = html;
}
// 计算某场景用的模式标签（用于结果区角标，验证参考图是否生效）
function videoModeTag(i, chainActive) {
  if (chainActive && i > 0) return '🔗 尾帧衔接';
  if (_vRefImage) return '🖼️ 参考图';
  return '📝 纯文本';
}

async function genVideo() {
  saveKeysNow();
  const scenes = collectScenes();
  if (!scenes.length) { vFail('请至少填写一个场景提示词'); return; }
  const sels = selectedVideoModels();
  if (!sels.length) { vFail('请至少勾选一个视频模型'); return; }
  const models = sels.filter(mk => keyForModel(mk));
  if (!models.length) { vFail('勾选的视频模型还没有 API Key（Agnes）'); return; }
  const mk = models[0];            // 当前仅一个视频模型（Agnes Video 2.5 Flash）
  const k = keyForModel(mk);
  const size = vSizeEl.value;

  _videoStopped = false;
  _videoAbort = new AbortController();
  btnGenVideo.disabled = true;
  btnStopVideo.style.display = '';
  vErr.textContent = '';
  btnDlAllVideo.style.display = 'none';
  vMsg('');
  lockScenes(true);
  btnGenVideo.innerHTML = '<span class="spinner"></span>' + (_chainMode && scenes.length > 1 ? '顺序生成 ' + scenes.length + ' 个场景（衔接）' : '同时生成 ' + scenes.length + ' 个场景');

  // 重建底部集中结果区（进度 + 最终视频都在这里显示）
  initResults(scenes.length);

  const t0 = performance.now();
  let okCount = 0, failCount = 0;
  const chainActive = _chainMode && scenes.length > 1;

  if (chainActive) {
    // ===== 衔接模式：顺序生成，上一场景尾帧作为下一场景首帧（keyframe） =====
    let prevFrame = null;
    for (let i = 0; i < scenes.length; i++) {
      if (_videoStopped) break;
      const scene = scenes[i];
      const modeTag = i === 0 ? (_vRefImage ? '参考图' : '文本') : '🔗 尾帧衔接';
      try {
        fillResult(i, renderSceneStatus(modeTag + ' · 提交中…'));
        const res = await submitVideoTask(mk, scene.prompt, size, k, _videoAbort.signal, i > 0 ? { firstFrame: prevFrame } : {});
        fillResult(i, renderSceneStatus(modeTag + ' · 生成中…'));
        const url = await pollVideoTask(res.taskId, res.env, k, _videoAbort.signal);
        fillResult(i, renderSceneVideo(url), videoModeTag(i, true));
        okCount++;
        if (i < scenes.length - 1) {
          vMsg('📷 正在截取场景 ' + (i + 1) + ' 尾帧（供下一场景衔接）…');
          fillResult(i + 1, renderSceneStatus('⏳ 等待上一场景完成…'));
          try {
            prevFrame = await extractLastFrame(url);
          } catch (ex) {
            for (let j = i + 1; j < scenes.length; j++) {
              fillResult(j, '<div class="scene-status err2">⛓ 未生成（尾帧截取失败：' + (ex && ex.message ? ex.message : ex) + '）</div>');
            }
            break;
          }
        }
      } catch (e) {
        if (_videoStopped || (e && e.name === 'AbortError')) break;
        fillResult(i, renderSceneFail(e), videoModeTag(i, true));
        failCount++;
        for (let j = i + 1; j < scenes.length; j++) {
          fillResult(j, '<div class="scene-status err2">⛓ 未生成（衔接中断：上游失败）</div>');
        }
        break;
      }
    }
  } else {
    // ===== 普通模式：快速串行提交 + 并行轮询 =====
    // 阶段一：快速串行提交所有场景（间隔 1 秒，避开 Agnes 免费 RPM 撞限流）
    const tasks = [];   // { scene, taskId, env }
    vMsg('正在提交 ' + scenes.length + ' 个场景…');
    for (let i = 0; i < scenes.length; i++) {
      if (_videoStopped) break;
      const scene = scenes[i];
      fillResult(i, renderSceneStatus('排队提交…'));
      try {
        const res = await submitVideoTask(mk, scene.prompt, size, k, _videoAbort.signal);
        tasks.push({ idx: i, scene: scene, taskId: res.taskId, env: res.env });
        fillResult(i, renderSceneStatus('已提交 · 生成中…'));
      } catch (e) {
        if (_videoStopped || (e && e.name === 'AbortError')) break;
        fillResult(i, renderSceneFail(e), videoModeTag(i, false));
        failCount++;
      }
      if (i < scenes.length - 1 && !_videoStopped) await sleepV(1000, _videoAbort.signal);
    }

    // 阶段二：并行轮询所有已提交任务
    if (_videoStopped) vMsg('⏹ 已停止');
    else vMsg('已提交 ' + tasks.length + ' 个 · 并行等待生成…');
    await Promise.all(tasks.map(async function (t) {
      if (_videoStopped) return;
      try {
        const url = await pollVideoTask(t.taskId, t.env, k, _videoAbort.signal);
        fillResult(t.idx, renderSceneVideo(url), videoModeTag(t.idx, false));
        okCount++;
      } catch (e) {
        if (_videoStopped || (e && e.name === 'AbortError')) return;
        fillResult(t.idx, renderSceneFail(e), videoModeTag(t.idx, false));
        failCount++;
      }
    }));
  }

  // 停止后：清掉还卡在"生成中"状态的结果项（任务已中断，不会再完成）
  if (_videoStopped && vResultsEl) {
    vResultsEl.querySelectorAll('.v-result-item').forEach(function (item) {
      const body = item.querySelector('.v-result-body');
      if (body && body.querySelector('.scene-status:not(.err2)')) item.remove();
    });
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  vMsg((_videoStopped ? '⏹ 已停止 · ' : '✅ 完成 · ') + '用时 ' + elapsed + ' 秒（成功 ' + okCount + ' / 失败 ' + failCount + '）');

  btnGenVideo.disabled = false;
  btnStopVideo.style.display = 'none';
  _videoAbort = null;
  updateVideoBtn();
  lockScenes(false);
  if (okCount > 0) {
    btnDlAllVideo.disabled = false;
    btnDlAllVideo.innerHTML = DL_ICON + '批量下载（' + okCount + ' 个）';
    btnDlAllVideo.style.display = '';
  }
}

function stopVideo() {
  _videoStopped = true;
  if (_videoAbort) { try { _videoAbort.abort(); } catch (e) {} }
}

// 视频下载：跨域视频经 /img 代理取 blob 再保存；代理失败退回新标签打开
async function downloadVideo(url) {
  const target = /^https?:\/\//.test(url) ? url : (API + url.replace(/^\//, ''));
  try {
    const r = await fetch(videoProxyUrl(target));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'drawdeck-video-' + Date.now() + '.mp4';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  } catch (e) {
    const a = document.createElement('a');
    a.href = target; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
}

// 视频代理 URL：视频文件较大，走透传代理 /vimg（图片代理 /img 会把 video/mp4 处理坏）
function videoProxyUrl(url) {
  if (!/^https?:\/\//i.test(url)) return url;
  if (!location.protocol.startsWith('http')) return url;
  return location.origin + '/vimg?url=' + encodeURIComponent(url);
}

// 截取视频尾帧（走同源 /vimg 代理，canvas 不被污染）→ JPEG dataURL，供下一场景 keyframe 首帧
function extractLastFrame(url) {
  return new Promise(function (resolve, reject) {
    const v = document.createElement('video');
    let settled = false;
    const timer = setTimeout(function () { fail('尾帧截取超时'); }, 30000);
    function fail(msg) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.remove();
      reject(new Error(msg));
    }
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.style.display = 'none';
    v.onerror = function () { fail('视频无法加载（尾帧截取失败）'); };
    v.onloadeddata = function () {
      try {
        const d = (v.duration && isFinite(v.duration)) ? v.duration : 0;
        v.currentTime = Math.max(0, d - 0.1);   // 取倒数第 0.1 秒，避开可能的黑帧
      } catch (e) { fail('视频无法定位'); }
    };
    v.onseeked = function () {
      if (settled) return;
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth || 1280;
        c.height = v.videoHeight || 704;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL('image/jpeg', 0.9);
        settled = true;
        clearTimeout(timer);
        v.remove();
        resolve(dataUrl);
      } catch (e) {
        fail('尾帧截取失败：' + (e && e.message ? e.message : e));
      }
    };
    document.body.appendChild(v);
    v.src = videoProxyUrl(url);
  });
}

// 批量下载：JSZip 打包（与图片批量下载一致）
async function downloadAllVideos() {
  const urls = [];
  document.querySelectorAll('#vResults video').forEach(v => { if (v.src) urls.push(v.src); });
  if (!urls.length) { vFail('没有可下载的视频'); return; }
  const btn = btnDlAllVideo;
  const setBtn = function (html, disabled) { if (btn) { btn.disabled = disabled; btn.innerHTML = html; } };
  setBtn('打包中…', true);
  try {
    if (!window.JSZip) await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    if (!window.JSZip) throw new Error('JSZip 加载失败');
    const zip = new JSZip();
    let ok = 0, fail = 0;
    await Promise.all(urls.map(async function (u, i) {
      try {
        const r = await fetch(videoProxyUrl(u));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        zip.file('video_' + String(i + 1).padStart(2, '0') + '.mp4', blob);
        ok++;
      } catch (e) { fail++; }
      setBtn('打包中… ' + (ok + fail) + ' / ' + urls.length, true);
    }));
    if (!ok) throw new Error('没有视频下载成功');
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'videos_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    setBtn(DL_ICON + '批量下载（' + ok + ' 个' + (fail ? '，失败 ' + fail : '') + '）', false);
  } catch (e) {
    setBtn(DL_ICON + '批量下载（' + urls.length + ' 个）', false);
    vFail('批量下载失败：' + (e && e.message ? e.message : e));
  }
}
