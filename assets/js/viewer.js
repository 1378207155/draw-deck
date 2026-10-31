let _lbUrls = [];
let _lbIdx = 0;

let _lbGroup = ''; // '' = 全部组；否则为模型 key，只看该组

function collectLightboxUrls() {
  // 只收集成功渲染的图片（失败 slot 是 .slot-loading.err，里面没有 img，天然跳过）
  // 组筛选：'' 收所有模型组；指定 key 只收该组
  _lbUrls = [];
  document.querySelectorAll('#result .model-sec').forEach(sec => {
    if (_lbGroup && sec.dataset.model !== _lbGroup) return;
    sec.querySelectorAll('.gen-slot img').forEach(img => _lbUrls.push(img.dataset.full));
  });
  if (!_lbUrls.length) {
    document.querySelectorAll('#result .gen-slot img').forEach(img => _lbUrls.push(img.dataset.full));
  }
}

function groupNameOf(url) {
  let name = '';
  document.querySelectorAll('#result .model-sec').forEach(sec => {
    if (name) return;
    sec.querySelectorAll('.gen-slot img').forEach(img => {
      if (img.dataset.full === url) {
        const lab = sec.querySelector('.model-label');
        name = lab ? lab.textContent : sec.dataset.model;
      }
    });
  });
  return name;
}

function buildLbGroups() {
  const rail = document.getElementById('lbRail');
  const wrap = document.getElementById('lbGroups');
  const lb = document.getElementById('lightbox');
  const secs = document.querySelectorAll('#result .model-sec');
  if (!wrap || !rail) return;
  const many = secs.length > 1;
  rail.style.display = many ? '' : 'none';             // 只有一个模型时不显示底部模型栏
  if (lb) lb.classList.toggle('has-models', many);     // 画面同步留出底栏高度
  if (!many) return;
  wrap.innerHTML = '';
  const addBtn = (g, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-group-btn' + (g === _lbGroup ? ' active' : '');
    b.textContent = label;
    b.onclick = (ev) => { ev.stopPropagation(); _lbGroup = g; collectLightboxUrls(); _lbIdx = 0; buildLbGroups(); lightboxShow(); };
    wrap.appendChild(b);
  };
  addBtn('', '全部');
  secs.forEach(sec => {
    const lab = sec.querySelector('.model-label');
    addBtn(sec.dataset.model, lab ? lab.textContent : sec.dataset.model);
  });
}

function showLightbox(url) {
  _lbGroup = ''; // 从大图进入默认「全部」
  collectLightboxUrls();
  _lbIdx = _lbUrls.indexOf(url);
  if (_lbIdx === -1) { _lbUrls = [url]; _lbIdx = 0; }
  buildLbGroups();
  lightboxShow();
}

function lightboxShow() {
  const img = document.getElementById('lightboxImg');
  const raw = _lbUrls[_lbIdx];                 // 上游原图地址
  const src = imgUrl(raw, 'view');             // 观看档（当前=直连原图，与大图缓存同源）
  const tip = document.getElementById('lbTip');
  document.getElementById('lbName').textContent = groupNameOf(raw) || '大图';
  document.getElementById('lbCounter').textContent = (_lbIdx + 1) + ' / ' + _lbUrls.length;
  document.getElementById('lbDims').textContent = '';
  lbSetZoom(1, false);                         // 换图回到「适应窗口」
  img.classList.add('lb-loading');             // 立即隐藏旧图，避免新图未加载时仍显示上一张
  if (tip) tip.classList.add('show');
  img.onload = () => {
    img.classList.remove('lb-loading');
    if (tip) tip.classList.remove('show');
    const d = document.getElementById('lbDims');
    if (d) d.textContent = img.naturalWidth + '×' + img.naturalHeight;   // 实际像素，便于判断清晰度
  };
  img.onerror = () => {
    img.classList.remove('lb-loading');
    if (tip) tip.classList.remove('show');
    if (img.getAttribute('src') !== raw) img.setAttribute('src', raw);   // 代理失败：退回直连原图
  };
  img.src = src;
  document.getElementById('lightbox').classList.add('show');
  document.body.style.overflow = 'hidden';     // 大图打开期间锁住页面滚动
  lbWake();                                    // 重新计时，控件先显示出来
  const atStart = _lbIdx <= 0, atEnd = _lbIdx >= _lbUrls.length - 1;
  const ps = document.getElementById('lbPrevSide'), ns = document.getElementById('lbNextSide');
  if (ps) ps.disabled = atStart;
  if (ns) ns.disabled = atEnd;
}

function nextImage() {
  if (_lbIdx < _lbUrls.length - 1) { _lbIdx++; lightboxShow(); }
}

function prevImage() {
  if (_lbIdx > 0) { _lbIdx--; lightboxShow(); }
}

function downloadImage(url) {
  if (!url) return;
  const isData = url.indexOf('data:') === 0;
  const target = imgUrl(url, 'download');   // 同源 /img 代理（原图，不带 w），可 fetch 成 blob
  const ext = isData ? 'png' : 'jpg';
  const name = 'image_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.' + ext;
  fetch(target)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    })
    .catch(() => {
      // 跨域/代理失败：新标签打开原图
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
}

async function downloadAllImages() {
  const urls = [];
  document.querySelectorAll('#result .gen-slot img').forEach(img => {
    if (img.dataset.full) urls.push(img.dataset.full);
  });
  if (!urls.length) { showErr('没有可下载的图片'); return; }
  if (!location.protocol.startsWith('http')) {
    // file:// 无本地服务：降级逐个新标签打开
    urls.forEach(u => {
      const a = document.createElement('a');
      a.href = u; a.target = '_blank'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    });
    return;
  }
  const btn = document.getElementById('btnDlAll');
  const setBtn = function (html, disabled) { if (btn) { btn.disabled = disabled; btn.innerHTML = html; } };
  setBtn('打包中…', true);
  try {
    // 按需加载 JSZip（首次使用），打包在浏览器端完成，无需服务端 /dl-zip
    if (!window.JSZip) await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    if (!window.JSZip) throw new Error('JSZip 加载失败');
    const zip = new JSZip();
    let ok = 0, fail = 0;
    // 逐张经 /img 代理同源取 blob（跨域 CDN 无法直接 fetch），并发拉取
    await Promise.all(urls.map(async function (u, i) {
      try {
        const r = await fetch(imgUrl(u, 'download'));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        const ext = /png/i.test(blob.type) ? 'png' : /webp/i.test(blob.type) ? 'webp' : 'jpg';
        zip.file('image_' + String(i + 1).padStart(2, '0') + '.' + ext, blob);
        ok++;
      } catch (e) {
        fail++;
      }
      setBtn('打包中… ' + (ok + fail) + ' / ' + urls.length, true);
    }));
    if (!ok) throw new Error('没有图片下载成功');
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'images_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    setBtn(DL_ICON + '批量下载（' + ok + ' 张' + (fail ? '，失败 ' + fail : '') + '）', false);
  } catch (e) {
    setBtn(DL_ICON + '批量下载（' + urls.length + ' 张）', false);
    showErr('批量下载失败：' + (e && e.message ? e.message : e));
  }
}

function downloadCurrentImage() { downloadImage(_lbUrls[_lbIdx]); }

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.classList.remove('show', 'idle');
  clearTimeout(_lbIdleTimer);
  document.body.style.overflow = '';
  _lbDrag = null; _lbDragMoved = false;
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
  lbSetZoom(1, false);
}

// ---------- 大图交互：缩放 / 拖动 / 全屏 / 控件自动隐藏（参考 Spotlight.js 的交互方式） ----------
let _lbZoom = 1, _lbPanX = 0, _lbPanY = 0, _lbDrag = null, _lbDragMoved = false, _lbIdleTimer = null;

function lbApplyTransform() {
  const img = document.getElementById('lightboxImg');
  if (!img) return;
  img.style.transform = (_lbZoom === 1 && !_lbPanX && !_lbPanY)
    ? '' : 'translate(' + _lbPanX + 'px,' + _lbPanY + 'px) scale(' + _lbZoom + ')';
  const v = document.getElementById('lbZoomVal');
  if (v) v.textContent = Math.round(_lbZoom * 100) + '%';
  const stage = document.getElementById('lbStage');
  if (stage) stage.classList.toggle('zoomed', _lbZoom > 1.001);
}
function lbSetZoom(z, animate) {
  const img = document.getElementById('lightboxImg');
  _lbZoom = Math.min(8, Math.max(1, z));
  if (_lbZoom <= 1.001) { _lbZoom = 1; _lbPanX = 0; _lbPanY = 0; }   // 回到适应窗口就顺手归位
  if (animate && img) {
    img.style.transition = 'transform .18s ease';                     // 只有按钮缩放做过渡，滚轮/拖动要跟手
    setTimeout(function () { img.style.transition = ''; }, 200);
  }
  lbApplyTransform();
}
function lbZoomBy(dir) { lbSetZoom(_lbZoom * (dir > 0 ? 1.25 : 1 / 1.25), true); }
function lbZoomReset() { lbSetZoom(1, true); }
function lbZoomActual() {                        // 双击：适应窗口 ↔ 原始像素（绝不放大超过原图）
  if (_lbZoom > 1.001) { lbSetZoom(1, true); return; }
  const img = document.getElementById('lightboxImg');
  const s = (img && img.clientWidth) ? img.naturalWidth / img.clientWidth : 1;
  lbSetZoom(s > 1 ? s : 1, true);
}
function lbClampPan() {                          // 拖动时不许把图拖出视野
  const img = document.getElementById('lightboxImg');
  if (!img) return;
  const mx = img.clientWidth * (_lbZoom - 1) / 2, my = img.clientHeight * (_lbZoom - 1) / 2;
  _lbPanX = Math.max(-mx, Math.min(mx, _lbPanX));
  _lbPanY = Math.max(-my, Math.min(my, _lbPanY));
}
function toggleLbFullscreen() {
  const el = document.getElementById('lightbox');
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (el && el.requestFullscreen) el.requestFullscreen().catch(function () {});
}
document.addEventListener('fullscreenchange', function () {
  const b = document.getElementById('lbFsBtn');
  if (b) b.textContent = document.fullscreenElement ? '⤡' : '⛶';
  lbSetZoom(1, false);                           // 视口尺寸变了，回到适应窗口
});
function lbWake() {                              // 鼠标一动就唤醒控件，空闲 4 秒再隐藏
  const lb = document.getElementById('lightbox');
  if (!lb || !lb.classList.contains('show')) return;
  lb.classList.remove('idle');
  clearTimeout(_lbIdleTimer);
  _lbIdleTimer = setTimeout(function () { if (lb.classList.contains('show')) lb.classList.add('idle'); }, 4000);
}

(function lbBindStage() {
  const stage = document.getElementById('lbStage');
  if (!stage) return;
  // 底部模型栏：滚轮直接横向滑动，方便够到后面的模型
  const groups = document.getElementById('lbGroups');
  if (groups) groups.addEventListener('wheel', function (e) {
    if (!e.deltaY) return;
    groups.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  // 点空白处关闭：拖动结束的那次 click 不算
  stage.addEventListener('click', function (e) {
    if (_lbDragMoved) { _lbDragMoved = false; return; }
    if (e.target && e.target.closest && e.target.closest('button')) return;
    closeLightbox();
  });
  stage.addEventListener('mousedown', function (e) {
    if (_lbZoom <= 1.001) return;
    e.preventDefault();
    _lbDrag = { x: e.clientX, y: e.clientY, px: _lbPanX, py: _lbPanY };
    _lbDragMoved = false;
    stage.classList.add('dragging');
  });
  window.addEventListener('mousemove', function (e) {
    if (_lbDrag) {
      const dx = e.clientX - _lbDrag.x, dy = e.clientY - _lbDrag.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _lbDragMoved = true;
      _lbPanX = _lbDrag.px + dx;
      _lbPanY = _lbDrag.py + dy;
      lbClampPan();
      lbApplyTransform();
    }
    lbWake();
  });
  window.addEventListener('mouseup', function () {
    if (_lbDrag) { _lbDrag = null; stage.classList.remove('dragging'); }
  });
  stage.addEventListener('wheel', function (e) {          // 滚轮缩放
    const lb = document.getElementById('lightbox');
    if (!lb || !lb.classList.contains('show')) return;
    e.preventDefault();
    lbSetZoom(_lbZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), false);
  }, { passive: false });
  // 双击图片：适应窗口 ↔ 原始像素；但双击落在按钮上（上一张/下一张等）不触发缩放，否则切图时误放大
  stage.addEventListener('dblclick', function (e) {
    if (e.target && e.target.closest && e.target.closest('button')) return;
    lbZoomActual();
  });
  let sx = 0, sy = 0;                                     // 触屏左右滑动切换
  stage.addEventListener('touchstart', function (e) { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
  stage.addEventListener('touchend', function (e) {
    if (_lbZoom > 1.001) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dy) < 40) (dx < 0 ? nextImage() : prevImage());
  }, { passive: true });
})();

// ESC 关大图；←/→ 切换；+/-/0 缩放（仅大图打开时生效）
document.addEventListener('keydown', e => {
  const lbOpen = document.getElementById('lightbox').classList.contains('show');
  if (lbOpen) lbWake();
  if (e.key === 'Escape' || e.keyCode === 27) {
    // 统一关闭所有弹层：模型/视频模型选择、角色设定图、两个设置弹窗
    const overlays = [
      ['modelPicker', 'closeModelPicker'],
      ['videoPicker', 'closeVideoPicker'],
      ['charPicker', 'closeCharPicker'],
      ['sizeSettings', 'closeSizeSettings'],
      ['videoSettings', 'closeVideoSettings']
    ];
    for (let i = 0; i < overlays.length; i++) {
      const el = document.getElementById(overlays[i][0]);
      if (el && el.classList.contains('show')) {
        const closer = window[overlays[i][1]];
        if (closer) closer();
        return;
      }
    }
    closeLightbox();
  }
  else if (e.key === 'ArrowLeft' || e.keyCode === 37) { if (lbOpen) prevImage(); }
  else if (e.key === 'ArrowRight' || e.keyCode === 39) { if (lbOpen) nextImage(); }
  else if (lbOpen && (e.key === '+' || e.key === '=')) lbZoomBy(1);
  else if (lbOpen && (e.key === '-' || e.key === '_')) lbZoomBy(-1);
  else if (lbOpen && e.key === '0') lbZoomReset();
});

// 文件拖拽与文件名显示
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file');
const previewImg = document.getElementById('preview');

// 点击上传缩略图 → 大图查看（阻止冒泡，避免触发文件选择）
function previewUpload(ev) {
  if (ev) ev.stopPropagation();
  if (previewImg && previewImg.src) showLightbox(previewImg.src);
}

function showPreview(file) {
  const placeholder = document.getElementById('dzPlaceholder');
  const row = document.getElementById('dzPreviewRow');
  if (!file) {
    placeholder.style.display = '';
    row.style.display = 'none';
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    previewImg.src = e.target.result;
    document.getElementById('fileName').textContent = file.name;
    placeholder.style.display = 'none';
    row.style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

fileInput.addEventListener('change', () => {
  showPreview(fileInput.files[0]);
});
['dragover','dragenter'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave','drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) {
    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    showPreview(f);
  }
});

function toggleDescModelUI() {
  const provider = document.getElementById('descModel').value;
  // 切换模型时，若输入框为空或仍是旧默认值，则填入对应默认模型名（保留用户自定义）
  const input = document.getElementById('descModelName');
  const cur = input.value.trim();
  const defaults = ['glm-4.6v-flash', 'sensenova-6.8-flash-lite', 'agnes-2.5-flash', 'Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash', 'deepseek-ai/DeepSeek-V4-Pro-0813'];
  if (!cur || defaults.includes(cur)) {
    if (provider === 'sensenova') input.value = 'sensenova-6.8-flash-lite';
    else if (provider === 'agnes') input.value = 'agnes-2.5-flash';
    else if (provider === 'ms') input.value = 'Qwen/Qwen3.8-27B';
    else input.value = 'glm-4.6v-flash';
  }
}

async function describe() {
  const provider = document.getElementById('descModel').value;
  const sense = provider === 'sensenova';
  const agnes = provider === 'agnes';
  const ms = provider === 'ms';
  // 按所选反推模型取对应 Key，不再依赖文生图页签的选中模型
  const k = sense ? keySense.value.trim() : agnes ? keyAgnes.value.trim() : ms ? keyMS.value.trim() : keyZhipu.value.trim();
  const btn = document.getElementById('btnDescribe');
  const out = document.getElementById('descOut');
  out.innerHTML = '';
  const fillBtn0 = document.getElementById('btnFillPrompt');
  if (fillBtn0) fillBtn0.style.display = 'none';

  if (!k) {
    const errDiv = document.createElement('div');
    errDiv.className = 'err';
    errDiv.textContent = sense ? '请先在上方填写商汤 API Key' : agnes ? '请先在上方填写 Agnes API Key' : ms ? '请先在上方填写魔搭 Token' : '请先在上方填写智谱 API Key';
    out.appendChild(errDiv);
    return;
  }
  const file = document.getElementById('file').files[0];
  if (!file) {
    const errDiv = document.createElement('div');
    errDiv.className = 'err';
    errDiv.textContent = '请先上传图片再反推提示词';
    out.appendChild(errDiv);
    return;
  }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>识别中…';

  let dataUrl;
  try {
    dataUrl = await compressImage(file);
  } catch (e) {
    const errDiv = document.createElement('div');
    errDiv.className = 'err';
    errDiv.textContent = '图片读取失败：' + (e && e.message ? e.message : String(e));
    out.appendChild(errDiv);
    btn.disabled = false; btn.innerHTML = '反推提示词';
    return;
  }

  // 商汤/Agnes/魔搭：如果页面不是通过本地 server（http）打开、也没有代理，就给出提示
  const _proxyErr = await checkLocalProxyNeeded(sense || agnes || ms);
  if (_proxyErr) {
    const errDiv = document.createElement('div');
    errDiv.className = 'err';
    errDiv.textContent = _proxyErr;
    out.appendChild(errDiv);
    btn.disabled = false; btn.innerHTML = '反推提示词';
    return;
  }

  const modelName = document.getElementById('descModelName').value.trim() || (sense ? 'sensenova-6.8-flash-lite' : agnes ? 'agnes-2.5-flash' : ms ? 'Qwen/Qwen3.8-27B' : 'glm-4.6v-flash');
  let endpoint, model;
  if (sense) {
    if (location.protocol.startsWith('http')) {
      endpoint = '/v1/chat/completions';  // http(s) 同源转发（本地 server.py / Functions），忽略代理残留值
    } else {
      const proxy = document.getElementById('corsProxy').value.trim();
      const base = proxy ? proxy.replace(/\/$/, '') : 'https://token.sensenova.cn';
      endpoint = base + '/v1/chat/completions';
    }
    model = modelName;
  } else if (agnes) {
    if (location.protocol.startsWith('http')) {
      const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.hostname);
      // Agnes 线上直连上游（走用户 IP，避开 CF 出口被 Agnes 限流）；本地走同源转发
      endpoint = isLocal ? '/agnes/v1/chat/completions' : (API_AGNES + '/v1/chat/completions');
    } else {
      const proxy = document.getElementById('corsProxy').value.trim();
      const base = proxy ? proxy.replace(/\/$/, '') : 'https://api.agnes-ai.cn';
      endpoint = base + '/agnes/v1/chat/completions';
    }
    model = modelName;
  } else if (ms) {
    if (location.protocol.startsWith('http')) {
      endpoint = '/ms/v1/chat/completions';  // http(s) 同源转发（本地 server.py / Functions）
    } else {
      const proxy = document.getElementById('corsProxy').value.trim();
      const base = proxy ? proxy.replace(/\/$/, '') : 'https://api-inference.modelscope.cn';
      endpoint = base + '/v1/chat/completions';
    }
    model = modelName;
  } else {
    endpoint = API + '/chat/completions';
    model = modelName;
  }

  let lastErr = null;
  const MAX = 4;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    if (attempt > 1) btn.innerHTML = '<span class="spinner"></span>重试中(' + (attempt - 1) + '/3)…';
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: '请详细描述这张图的画面、风格、色彩、光线，然后给一段直接可用于文生图的英文 prompt（含风格与画质词），保持竖版 2:3 构图。只输出 prompt，不要多余说明。' }
          ]}]
        })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ? data.error.message || data.error.code : ('HTTP ' + resp.status));
      const promptText = (data.choices[0].message.content || '').trim();
      out.innerHTML = '<label>反推提示词</label><div class="out">' + promptText.replace(/</g,'&lt;') + '</div>';
      const fillBtn = document.getElementById('btnFillPrompt');
      if (fillBtn) fillBtn.style.display = '';
      window._lastPrompt = promptText;
      btn.disabled = false; btn.innerHTML = '反推提示词';
      return;
    } catch (e) {
      lastErr = e;
    }
  }

  const errDiv = document.createElement('div');
  errDiv.className = 'err';
  errDiv.textContent = '识别失败（已重试3次）：' + (lastErr && lastErr.message ? lastErr.message : String(lastErr));
  out.innerHTML = '';
  out.appendChild(errDiv);
  btn.disabled = false; btn.innerHTML = '反推提示词';
}

function fillPrompt() {
  setPromptText('zh', window._lastPrompt || '');
  setPromptText('en', '');
  _promptMainLang = 'zh';
  switchPromptLang('zh');
  updatePromptCount();
  switchTab(0, document.querySelector('.tab'));
  if (window._lastPrompt) autoTranslate('zh');
}

// ---------- 背景模式切换（Vanta 效果组，选择存 localStorage） ----------
// 唯一数据源：一项 = 一个背景模式（label 供下拉显示，file/fn 供按需加载，cfg 是该效果的参数）。
// 对象的键顺序即下拉里的显示顺序；BG_MODES 由它派生，不再单独维护数组，避免两处不同步。
// cfg 在官网（vantajs.com）演示 defaultOptions 基础上，仅把 backgroundColor 改为浅色（让画布回归浅色主题）
const VANTA_EFFECTS = {
  vanta:      { label: '飞鸟', file: 'lib/vanta.birds.min.js', fn: 'BIRDS', cfg: { backgroundColor: 0xd8e0f0, color1: 0xff0000, color2: 0x00d1ff, colorMode: 'varianceGradient', birdSize: 1, wingSpan: 30, speedLimit: 5, separation: 20, alignment: 20, cohesion: 20, quantity: 5 } },
  vantaRings: { label: '光环', file: 'lib/vanta.rings.min.js', fn: 'RINGS', cfg: { backgroundColor: 0xd2e8cc, color: 0x88ff00 } },
  vantaDots:  { label: '圆点', file: 'lib/vanta.dots.min.js',  fn: 'DOTS',  cfg: { backgroundColor: 0xf4e0c8, color: 0xff8820, color2: 0xff8820, size: 3, spacing: 35, showLines: true } },
  vantaGlobe: { label: '地球', file: 'lib/vanta.globe.min.js', fn: 'GLOBE', cfg: { backgroundColor: 0xf0d3e0, color: 0xff3f81, color2: 0xffffff, size: 1, points: 10, maxDistance: 20, spacing: 15, showDots: true } }
};
// 静态图片背景（非 Vanta 动画）：url 直接作为 body 背景图
const BG_IMAGES = {
  naruto: { label: '鸣人', url: 'https://z.wiki/u/9oSPMceyI' }
};
const BG_NONE = 'none';
const BG_MODES = [BG_NONE].concat(Object.keys(BG_IMAGES), Object.keys(VANTA_EFFECTS));   // "默认"放最前，再是图片背景 + Vanta 效果
const BG_DEFAULT = BG_NONE;
let _vanta = null;        // Vanta 实例：切走时 destroy 停掉 WebGL 循环，切回时重建
let _vantaMode = null;    // 当前实例对应哪个效果

// 任意模式的显示名（默认 / Vanta label / 图片 label）
function bgLabel(m) {
  if (m === BG_NONE) return '默认';
  if (VANTA_EFFECTS[m] && VANTA_EFFECTS[m].label) return VANTA_EFFECTS[m].label;
  if (BG_IMAGES[m] && BG_IMAGES[m].label) return BG_IMAGES[m].label;
  return m;
}

async function ensureVanta(m) {
  const def = VANTA_EFFECTS[m];
  if (!def) {   // "默认"或未知模式：销毁旧动画，什么都不建
    if (_vanta) { _vanta.destroy(); _vanta = null; _vantaMode = null; }
    return;
  }
  if (_vanta && _vantaMode === m) return;
  if (!document.body.classList.contains('bg-' + m)) return;   // 切换到别的模式了，不建
  if (_vanta) { _vanta.destroy(); _vanta = null; _vantaMode = null; }   // 换效果，先销毁旧的
  const el = document.getElementById('vantaBg');
  if (!el) return;
  try {
    if (typeof window.THREE === 'undefined') await loadScript('lib/three.min.js');
    if (typeof window.VANTA === 'undefined' || typeof window.VANTA[def.fn] === 'undefined') await loadScript(def.file);
    if (!document.body.classList.contains('bg-' + m)) return;   // 等待加载期间被切走了，不建
    _vanta = window.VANTA[def.fn](Object.assign({
      el: el,
      mouseControls: false,   // 背景层在内容后面收不到鼠标事件，动画自己跑
      touchControls: false,
      gyroControls: false,
      minHeight: 200,
      minWidth: 200,
      scale: 1,
      scaleMobile: 1
    }, def.cfg));
    _vantaMode = m;
  } catch (e) {
    console.warn('Vanta ' + m + ' 加载失败，已停用背景效果：', e);
    if (document.body.classList.contains('bg-' + m)) {
      BG_MODES.forEach(function (k) { document.body.classList.remove('bg-' + k); });
      try { localStorage.removeItem('bg_mode'); } catch (e2) {}
      bgLbxRefresh('');
    }
  }
}
// 背景下拉：Headless UI Listbox 风格（选项由 BG_MODES 自动生成，选中项打勾 + 触发按钮显示当前值）
function bgLbxRefresh(m) {
  const val = document.getElementById('bgLbxValue');
  if (val) val.textContent = bgLabel(m);
  const list = document.getElementById('bgLbxList');
  if (list) list.querySelectorAll('.lbx-opt').forEach(function (o) { o.classList.toggle('sel', o.dataset.value === m); });
}
function bgLbxInit() {
  const btn = document.getElementById('bgLbxBtn');
  const list = document.getElementById('bgLbxList');
  if (!btn || !list) return;
  if (!list.childElementCount) {   // 选项列表由 BG_MODES 自动生成
    const checkSvg = '<svg class="lbx-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
    BG_MODES.forEach(function (m) {
      const li = document.createElement('li');
      li.className = 'lbx-opt';
      li.dataset.value = m;
      li.setAttribute('role', 'option');
      li.setAttribute('tabindex', '-1');
      li.innerHTML = checkSvg + bgLabel(m);
      list.appendChild(li);
    });
  }
  const closeLbx = function () { if (!list.hidden) { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); } };
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    const open = list.hidden;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { const sel = list.querySelector('.lbx-opt.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' }); }
  });
  list.addEventListener('click', function (e) {
    const opt = e.target.closest('.lbx-opt');
    if (opt) { setBgMode(opt.dataset.value); closeLbx(); }
  });
  document.addEventListener('click', closeLbx);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLbx(); });
}
function setBgMode(m) {
  const body = document.body;
  BG_MODES.forEach(function (k) { body.classList.remove('bg-' + k); });
  if (m && m !== BG_NONE) body.classList.add('bg-' + m);
  // 图片背景：设内联背景图；其它模式清空内联（回落到 CSS 渐变底色）
  const img = BG_IMAGES[m];
  if (img && img.url) {
    body.style.backgroundImage = 'url("' + img.url + '")';
    body.style.backgroundSize = 'contain';
    body.style.backgroundPosition = 'right center';
    body.style.backgroundRepeat = 'no-repeat';
    body.style.backgroundAttachment = 'fixed';
    // 让图片的白色背景融入 body 底色：白×底色=底色（图底变底色），黑线保持，整图像画在页面上
    body.style.backgroundBlendMode = 'multiply';
    body.style.backgroundColor = '#FFF1F2';   // 鸣人背景底色（左侧无图区域 + 图底白 都统一为此色）
  } else {
    body.style.backgroundImage = '';
    body.style.backgroundSize = '';
    body.style.backgroundPosition = '';
    body.style.backgroundRepeat = '';
    body.style.backgroundAttachment = '';
    body.style.backgroundBlendMode = '';
    body.style.backgroundColor = '';   // 回落到 CSS 默认 var(--bg)
  }
  try { localStorage.setItem('bg_mode', m); } catch (e) {}
  bgLbxRefresh(m);
  ensureVanta(m);
}
(function () {
  let m = localStorage.getItem('bg_mode');
  if (!m || BG_MODES.indexOf(m) < 0) m = null;   // 无记忆：保持"默认"、无动画、无勾选
  bgLbxInit();
  if (m) setBgMode(m);   // 有记忆才恢复（含"默认"）
})();
