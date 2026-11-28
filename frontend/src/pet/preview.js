// 浏览器不提供操作系统的双击间隔。用 dblclick 和 detail 识别双击，
// 为网页中的单击保留短暂的撤销窗口。
export function bindPetPreview(target, signal, actions) {
  let pending;
  let timer;
  let down;
  let dragged = false;
  function clear() {
    clearTimeout(timer);
    pending = undefined;
  }
  function deliver() {
    const point = pending;
    clear();
    if (point) actions.click(...point);
  }
  signal.addEventListener('abort', clear, { once: true });
  const on = (type, fn, opts) => target.addEventListener(type, fn, { ...opts, signal });
  on('pointerdown', e => {
    down = [e.clientX, e.clientY];
    dragged = false;
  });
  on('pointermove', e => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) dragged = true;
    actions.cursor(e.clientX, e.clientY);
  });
  on('pointerup', () => { down = null; });
  on('pointercancel', () => { down = null; dragged = true; });
  on('click', e => {
    if (dragged || e.detail > 1 || !actions.inside(e.clientX, e.clientY)) return;
    if (pending) deliver();
    pending = [e.clientX, e.clientY];
    timer = setTimeout(deliver, 500);
  });
  on('dblclick', e => {
    clear();
    if (!dragged && actions.inside(e.clientX, e.clientY)) actions.doubleClick(e.clientX, e.clientY);
  });
  on('contextmenu', e => { e.preventDefault(); actions.menu(); });
  on('wheel', e => { if (actions.inside(e.clientX, e.clientY)) actions.wheel(-e.deltaY); }, { passive: true });
}
