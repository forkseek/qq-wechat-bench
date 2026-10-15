const qr = document.querySelector('#qr');
const status = document.querySelector('#status');
const refreshButton = document.querySelector('#refresh');
const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
let busy = false;
function describe(result) {
  if (result.blockedReason) return result.error;
  if (result.online) return `QQ 已登录${result.account ? `（${result.account}）` : ''}，可以返回工作台查看消息。`;
  if (!result.available) return result.keepRunning ? `正在启动 QQ 采集，通常需要半分钟…${result.error ? ` ${result.error}` : ''}` : '独立采集已停止，可以打开官方桌面 QQ 登录。QQ 新消息采集暂时暂停。';
  if (result.scanned || result.phase === 'qrcode_scanned') return '已扫码，等待手机确认和 QQ 初始化…';
  if (result.phase === 'initializing') return 'QQ 正在初始化…';
  return result.error || '等待扫码；请使用已加入采集群的账号。登录成功后会记住这个账号，下次自动登录。';
}
async function update() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch('/api/qq/status');
    const result = await response.json();
    if (response.status === 403 && result.error === '请先打开工作台页面') { location.reload(); return; } // 工作台重启后会话失效
    const waiting = result.available && !result.online && !result.blockedReason;
    qr.hidden = !waiting;
    refreshButton.hidden = !waiting;
    startButton.hidden = result.keepRunning || result.online;
    startButton.disabled = Boolean(result.blockedReason);
    stopButton.hidden = !result.keepRunning && !result.available && !result.launcherRunning && !result.ownedQQRunning;
    if (waiting) qr.src = '/api/qq/qr?t=' + Date.now();
    status.textContent = describe(result);
  } catch { status.textContent = '状态暂不可用，请稍后重试。'; }
  finally { busy = false; }
}
async function post(button, route) {
  button.disabled = true;
  try {
    const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作未完成，请检查登录状态');
    await update();
  } catch (error) { status.textContent = error.message || '操作未完成，请稍后重试'; }
  finally { button.disabled = false; }
}
refreshButton.addEventListener('click', () => post(refreshButton, '/api/qq/refresh-qr'));
startButton.addEventListener('click', () => post(startButton, '/api/qq/start'));
stopButton.addEventListener('click', () => post(stopButton, '/api/qq/stop'));
async function initialize() {
  try {
    const response = await fetch('/api/state');
    if (response.status === 403) { location.reload(); return; }
    const state = await response.json();
    if (!state.settings) throw new Error('工作台正在更新，请稍后重试');
    document.querySelector('#scope').textContent = state.capture ? `采集范围：群 ${state.capture.groups.join('、')}` : '';
    await update(); setInterval(update, state.settings.ui.qqLoginPollIntervalMs);
  } catch (error) { status.textContent = error.message || '暂时无法读取程序设置'; setTimeout(initialize, 1000); }
}
initialize();
