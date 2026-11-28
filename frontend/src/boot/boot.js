// 讯课 · 打开动画的开关（main.js 第一个引入，比 Vue 挂载先跑）。
// - 每个窗口会话第一次加载时播一次；后台重启后自动刷新页面不会重播（sessionStorage 记着）
// - 桌面外壳在「双击程序 / 托盘打开主工作台」时调 window.__xunkeBoot() 重播
// - 至少播 1.35 秒；那时应用还没挂好就原地晃着等，最多等 8 秒；点一下可以跳过
(function () {
  var root = document.getElementById('xk-boot');
  if (!root) return;
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
  var MIN_MS = 1350;
  var MAX_MS = 8000;
  var startedAt = 0;
  var running = false;
  var ready = !!window.__xunkeReady;
  var minTimer = 0;
  var capTimer = 0;

  function finish() {
    if (!running || root.classList.contains('out')) return;
    clearTimeout(minTimer);
    clearTimeout(capTimer);
    root.classList.remove('wait');
    root.classList.add('out');
  }

  function afterMin() {
    if (ready) finish();
    else root.classList.add('wait');
  }

  function play() {
    if (reduce) return false;
    running = true;
    root.classList.remove('play', 'out', 'wait');
    void root.offsetWidth; // 重新触发 CSS 动画
    root.classList.add('on', 'play');
    startedAt = Date.now();
    clearTimeout(minTimer);
    clearTimeout(capTimer);
    minTimer = setTimeout(afterMin, MIN_MS);
    capTimer = setTimeout(finish, MAX_MS);
    return true;
  }

  root.addEventListener('animationend', function (e) {
    if (e.animationName !== 'xk-tear') return;
    running = false;
    root.classList.remove('on', 'play', 'out', 'wait');
  });
  root.addEventListener('pointerdown', finish);

  window.addEventListener('xunke:ready', function () {
    ready = true;
    if (running && Date.now() - startedAt >= MIN_MS) finish();
  });

  window.__xunkeBoot = play;

  var seen = false;
  try {
    seen = sessionStorage.getItem('xk-boot') === '1';
    sessionStorage.setItem('xk-boot', '1');
  } catch (e) { /* ignore */ }
  if (!seen) play();
})();
