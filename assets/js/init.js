checkPromptEngine();   // 探测本地翻译引擎（Chrome 内置 Translator API）

// 标签栏鼠标跟随光晕（玻璃效果）
(function () {
  const g = document.querySelector('.tabs');
  if (!g) return;
  g.addEventListener('pointermove', function (e) {
    const r = g.getBoundingClientRect();
    g.style.setProperty('--x', (e.clientX - r.left) + 'px');
    g.style.setProperty('--y', (e.clientY - r.top) + 'px');
  });
})();

// 从 URL hash 恢复标签（刷新保持当前标签，不用 localStorage）
(function () {
  const fromHash = function () {
    const i = TAB_HASHES.indexOf((location.hash || '').replace('#', ''));
    if (i >= 0) switchTab(i);
  };
  fromHash();
  window.addEventListener('hashchange', fromHash);
  // 标签恢复完成：显示标签区（解除 pre-js 隐藏）
  document.documentElement.classList.remove('pre-js');
})();

// 初始化必须放在 MODEL_LIST 之后：updateSizeOptions() 会用到 modelLabel()（const 有 TDZ，提前调用会抛错）
restoreModels();      // 先恢复模型勾选（单选模式顺手收敛），再据此建尺寸选项
toggleKeyUI();
restoreSize();        // 选项建好后恢复尺寸（标记 _sizeUserPicked，后续重建保留）
restoreCount();
updatePickSummary();
restoreDescModel();   // 反推模型下拉 + 模型名，再跑 toggleDescModelUI 补默认名
toggleDescModelUI();
try { localStorage.removeItem('prompt_state'); } catch (e) {}   // 提示词不再持久化：清掉旧版本残留
