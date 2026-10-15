'use strict';

const $ = selector => document.querySelector(selector);
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const VIEWS = ['tasks', 'messages', 'conversations', 'settings', 'logs', 'maintenance'];
const state = { data: null, view: 'tasks', filter: 'all', search: '', selected: new Set(), messageConversation: '', messagePlatform: 'all', drafts: {}, fileDrafts: {}, chatScope: 'all', chatBusy: false, mainStamp: '', refreshBusy: false };
// 所有时间按北京时间显示，格式如「10月16日 周四 17:00」，不是今年时加年份。
const dayOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
const clockOf = date => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
const shanghaiDay = (offset = 0) => dayOf(new Date(Date.now() + offset * 86400000));
function dueLabel(date, time = null) {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = '日一二三四五六'[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${String(year) === shanghaiDay().slice(0, 4) ? '' : `${year}年`}${month}月${day}日 周${weekday}${time ? ` ${time}` : ''}`;
}
const formatDate = (value, full = false) => !value ? '尚未明确' : !value.includes('T') ? dueLabel(value) : dueLabel(dayOf(new Date(value)), full ? clockOf(new Date(value)) : null);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
// 截止时间一律显示；注明依据（原文写明 / 推算 / 你填写的 / 未明确），推算的不当作确定时间。
function deadline(task) {
  const basis = task.dueBasis || (task.dueDate ? (task.origin === 'manual' ? 'manual' : 'inferred') : 'none');
  if (!task.dueDate) return { main: '未明确', note: task.dueText ? `通知原文：${task.dueText}` : '通知里没有写截止时间', flag: '', late: false };
  const notes = [];
  if (basis === 'inferred') notes.push(`按消息发送日推算${task.dueText ? `，原文：${task.dueText}` : ''}`);
  if (basis === 'manual') notes.push('你填写的');
  if (!task.dueTime) notes.push('没有具体时刻');
  const lateDays = daysBetween(task.dueDate, shanghaiDay());
  const passedToday = lateDays === 0 && task.dueTime && task.dueTime < clockOf(new Date());
  const flag = lateDays > 0 ? `已过期 ${lateDays} 天` : passedToday ? '今天已过截止时刻' : lateDays === 0 ? '今天截止' : '';
  return { main: dueLabel(task.dueDate, task.dueTime), note: notes.join('；'), flag, late: lateDays > 0 || Boolean(passedToday) };
}
const analysisLabels = { idle: '等待新消息', queued: '等待整理', analyzing: '正在整理', waiting_model: '等待配置 AI', error: '整理失败，可重试', ready: '已整理' };
const relationLabels = { mine: '与我有关', everyone: '全体适用', other: '他人事项', unclear: '归属待确认' };

async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(route, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  // 工作台重启后会话失效，重新载入页面即可拿到新会话。
  if (response.status === 403 && value.error === '请先打开工作台页面') { location.reload(); return new Promise(() => {}); }
  if (!response.ok) throw new Error(value.error || '请求失败，请稍后重试');
  return value;
}
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function pageHead(title, caption, actions = '') { return `<div class="page-header"><div><h1>${safe(title)}</h1>${caption ? `<p>${safe(caption)}</p>` : ''}</div><div class="header-actions">${actions}</div></div>`; }
function empty(title, description, action = '') { return `<div class="empty-state"><div class="empty-art" aria-hidden="true">✓</div><h2>${safe(title)}</h2><p>${safe(description)}</p>${action}</div>`; }
const aiReady = () => state.data.model.configured;
function qqOnline() {
  if (state.data.qq.online) return true;
  const last = state.data.connection.lastReport;
  return !state.data.capture && Boolean(last && Date.now() - Date.parse(last) < 10 * 60000);
}
// 采集模式下 QQ 不在线时说明原因并给出下一步；在线时不打扰。
function notice() {
  const qq = state.data.qq;
  if (!state.data.capture || qq.online) return '';
  const body = qq.blockedReason ? safe(qq.error)
    : !qq.keepRunning ? 'QQ 采集已停止，新消息暂时收不到。<button class="link-button" data-action="qq-start">启动采集</button>'
    : qq.available ? 'QQ 需要扫码登录。<a href="/qq-login">去扫码</a>'
    : `QQ 采集正在启动或重新连接，通常需要半分钟。${qq.error ? safe(qq.error) : ''}`;
  return `<div class="notice amber"><span aria-hidden="true">!</span><div>${body}</div></div>`;
}
function conversationName(id) { return state.data.conversations.find(value => value.id === id)?.title || '手动待办'; }

// 只统计已接入（关注中）的群和手动添加的任务；移除的群的任务保留在本机，恢复拉取后会重新出现。
const connected = task => !task.conversationId || state.data.conversations.some(value => value.id === task.conversationId && value.monitored);
// 未完成 = 状态为待处理，不是明确属于别人的事项，且来自已接入的群。
const unfinished = task => task.status === 'pending' && task.relevance !== 'other' && connected(task);
const dueKey = task => task.dueDate ? `${task.dueDate} ${task.dueTime || '99:99'}` : '9999';
function drawTasks() {
  const tasks = state.data.tasks;
  const today = shanghaiDay(), nextWeek = shanghaiDay(7);
  const dueSoon = task => task.dueDate && task.dueDate >= today && task.dueDate <= nextWeek;
  const open = tasks.filter(unfinished).sort((a, b) => dueKey(a).localeCompare(dueKey(b)));
  const others = tasks.filter(task => task.status === 'pending' && task.relevance === 'other' && connected(task)).length;
  const late = open.filter(task => deadline(task).late).length, soon = open.filter(dueSoon).length;
  // 有 7 天内截止的任务时数字显示赭黄，有过期的显示朱红。
  const stats = [[open.length, '未完成'], [open.filter(task => task.needsReview).length, '待确认'], [soon, '7 天内截止', soon ? 'warn' : ''], [late, '已过期', late ? 'danger' : '']];
  const filters = [['all', '未完成'], ['review', '待确认'], ['week', '7 天内截止'], ['done', '已完成']];
  const matches = task => !state.search || `${task.title} ${task.description} ${conversationName(task.conversationId)}`.toLowerCase().includes(state.search.toLowerCase());
  let body;
  if (state.filter === 'done') {
    state.selected.clear();
    body = `<div class="task-list">${tasks.filter(task => task.status === 'done' && matches(task)).map(taskCard).join('') || '<div class="no-results">还没有已完成的待办。</div>'}</div>`;
  } else {
    const rows = open.filter(task => matches(task) && (state.filter !== 'review' || task.needsReview) && (state.filter !== 'week' || dueSoon(task)));
    // 只保留仍显示在列表里的勾选，已完成或被筛掉的任务不会被误确认。
    const visible = new Set(rows.map(task => task.id));
    for (const id of state.selected) if (!visible.has(id)) state.selected.delete(id);
    body = tasks.length ? unfinishedTable(rows) + (others ? `<p class="inline-note">另有 ${others} 条明确属于他人的事项，未列入未完成任务。</p>` : '')
      : empty('还没有待办', aiReady() ? '关注的群收到通知后，AI 会把待办整理到这里。也可以手动添加。' : '配置 AI 后，群通知会自动整理成待办；现在可以先手动添加。', '<button class="button" data-action="new-task">＋ 添加待办</button>');
  }
  $('#main').innerHTML = pageHead('待办清单', '截止时间均为北京时间。点任务名称可核对来源原话。', '<button class="button" data-action="new-task">＋ 添加待办</button>') + notice() + runPanel() +
    `<div class="stats">${stats.map(([value, label, tone = '']) => `<div class="stat" ${tone ? `data-tone="${tone}"` : ''}><div class="stat-label">${label}</div><div class="stat-value" data-count="${value}">${value}</div></div>`).join('')}</div>` +
    `<div class="toolbar"><div class="filters">${filters.map(([id, label]) => `<button class="filter ${state.filter === id ? 'active' : ''}" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join('')}</div><label class="sr-only" for="task-search">搜索任务或会话</label><input id="task-search" class="search" placeholder="搜索任务或会话" value="${safe(state.search)}"></div>` + body;
}
// 勾选只是选中；点“确认完成”后才标记完成并从列表消失。
function unfinishedTable(rows) {
  if (!rows.length) return '<div class="no-results">这个范围内没有未完成的任务。</div>';
  const allChecked = rows.every(task => state.selected.has(task.id));
  return `<div id="select-bar" class="select-bar" ${state.selected.size ? '' : 'hidden'}><span>已选 <strong>${state.selected.size}</strong> 项</span>` +
    '<button class="button" data-action="confirm-complete">确认完成</button><button class="button quiet" data-action="clear-selection">取消选择</button></div>' +
    `<div class="table-wrap"><table class="todo-table"><thead><tr><th><label class="select-all"><input type="checkbox" data-select-all ${allChecked ? 'checked' : ''}> 未完成任务</label></th>` +
    `<th>截止时间</th><th>来源</th><th>状态</th><th class="col-countdown">倒计时</th></tr></thead><tbody>${rows.map(task => {
    const due = deadline(task), checked = state.selected.has(task.id);
    const status = task.suggestedStatus ? `AI 认为${task.suggestedStatus === 'done' ? '已完成' : '已取消'}，待你确认` : task.needsReview ? '待确认' : '待处理';
    const source = task.conversationId ? `${safe(conversationName(task.conversationId))}${task.sourceAt ? `<small>${safe(formatDate(task.sourceAt, true))} 发</small>` : ''}` : '手动添加';
    return `<tr class="${due.late ? 'late' : due.flag ? 'today' : ''} ${checked ? 'selected' : ''}"><td data-label="未完成任务"><div class="todo-name">` +
      `<input type="checkbox" class="row-check" data-select="${safe(task.id)}" ${checked ? 'checked' : ''} aria-label="选择：${safe(task.title)}">` +
      `<button class="task-link" data-action="task-detail" data-id="${safe(task.id)}">${safe(task.title)}</button></div>${task.relevance === 'unclear' ? '<span class="tag">归属待确认</span>' : ''}</td>` +
      `<td data-label="截止时间"><strong>${safe(due.main)}</strong>${due.flag ? `<span class="due-flag">${safe(due.flag)}</span>` : ''}${due.note ? `<small>${safe(due.note)}</small>` : ''}</td>` +
      `<td data-label="来源">${source}</td><td data-label="状态"><span class="tag ${task.needsReview ? 'review' : ''}">${safe(status)}</span></td>` +
      `<td class="col-countdown">${countdownRing(task)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
// 勾选变化时只更新选中状态和操作条，不重绘整页，保留键盘焦点。
function updateSelection() {
  const boxes = [...document.querySelectorAll('[data-select]')];
  for (const box of boxes) { box.checked = state.selected.has(box.dataset.select); box.closest('tr').classList.toggle('selected', box.checked); }
  const all = $('[data-select-all]');
  if (all) all.checked = boxes.length > 0 && boxes.every(box => box.checked);
  const bar = $('#select-bar');
  if (bar) { bar.hidden = !state.selected.size; bar.querySelector('strong').textContent = state.selected.size; }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
async function confirmComplete() {
  const tasks = state.data.tasks.filter(task => state.selected.has(task.id));
  const rows = tasks.map(task => document.querySelector(`[data-select="${CSS.escape(task.id)}"]`)?.closest('tr')).filter(Boolean);
  // 先给每行盖上朱红「已完成」印章，保存成功的行再滑走。
  for (const row of rows) row.cells[0].insertAdjacentHTML('beforeend', '<span class="stamp" aria-hidden="true">已完成</span>');
  const failed = [];
  const save = (async () => {
    for (const task of tasks) {
      try { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { revision: task.revision, status: 'done', needsReview: false }, 'PATCH'); state.selected.delete(task.id); }
      catch { failed.push(task.title); }
    }
  })();
  await Promise.all([save, wait(calm() ? 0 : 650)]);
  for (const row of rows) if (!state.selected.has(row.querySelector('[data-select]').dataset.select)) row.classList.add('leaving');
  await wait(calm() ? 0 : 380);
  await refresh(true);
  const done = tasks.length - failed.length;
  toast(failed.length ? `已完成 ${done} 项；${failed.length} 项没能保存（${failed.join('、')}），可能刚被修改过，请再试一次` : `已完成 ${done} 项，可以在“已完成”里恢复`);
}

// 圆形倒计时：从通知发出到截止，圆环逐渐缩短、颜色由绿变红；没写时刻的按当天 24:00 计算。
const DAY = 86400000, HOUR = 3600000, MINUTE = 60000;
const spanText = ms => { const d = Math.floor(ms / DAY), h = Math.floor(ms % DAY / HOUR), m = Math.floor(ms % HOUR / MINUTE); return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分钟` : `${Math.max(m, 1)} 分钟`; };
function countdownRing(task) {
  const circumference = 2 * Math.PI * 17;
  const ring = (cls, tip, text, color = '', fraction = 0) => `<svg class="countdown ${cls}" viewBox="0 0 44 44" role="img" aria-label="${safe(tip)}"><title>${safe(tip)}</title>` +
    '<circle class="countdown-track" cx="22" cy="22" r="17"/>' +
    (color ? `<circle class="countdown-fill" cx="22" cy="22" r="17" stroke="${color}" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${(circumference * (1 - fraction)).toFixed(2)}" transform="rotate(-90 22 22)"/>` : '') +
    `<text x="22" y="25.5" ${color ? `fill="${color}"` : ''}>${text}</text></svg>`;
  if (!task.dueDate) return ring('none', '没有截止时间', '未定');
  const due = Date.parse(`${task.dueDate}T${task.dueTime || '23:59'}:00+08:00`);
  const left = due - Date.now();
  if (left <= 0) return ring('over', '已过截止时间', '过期', 'hsl(4, 66%, 46%)', 1);
  const start = Math.min(Date.parse(task.sourceAt || task.createdAt) || due, due);
  const fraction = due > start ? Math.min(left / (due - start), 1) : 1;
  const label = left >= DAY ? `${Math.floor(left / DAY)}天` : left >= HOUR ? `${Math.floor(left / HOUR)}时` : `${Math.max(1, Math.floor(left / MINUTE))}分`;
  const tip = `剩余 ${spanText(left)}${task.dueTime ? '' : '（没有具体时刻，按当天 24:00 计算）'}`;
  return ring(left < DAY ? 'urgent' : '', tip, label, `hsl(${Math.round(120 * fraction)}, 62%, 36%)`, fraction);
}
// AI 每整理完一批的结果；AI 未配置时说明有多少消息在等。
function runPanel() {
  const { runs, pendingCount } = state.data;
  if (!aiReady()) return `<div class="run-panel"><span class="run-label">AI 未配置</span><div>${pendingCount} 条消息等待整理。<button class="link-button" data-view="settings">去配置</button></div></div>`;
  const describe = run => run.error ? `${safe(formatDate(run.at, true))} · ${safe(run.conversation)}：整理失败（${safe(run.error)}）。消息已保留，10 分钟后自动重试。`
    : `${safe(formatDate(run.at, true))} · ${safe(run.conversation)}：处理 ${run.messages} 条新消息，${run.created || run.updated ? `新增 ${run.created} 条、更新 ${run.updated} 条任务` : '没有发现新任务'}${run.needsReview ? `，其中 ${run.needsReview} 条待你确认` : ''}。`;
  const [last, ...older] = runs;
  // 有会话在排队或整理中时显示动态提示。
  const busy = state.data.conversations.some(value => value.monitored && ['queued', 'analyzing'].includes(value.analysisState));
  return `<div class="run-panel ${busy ? 'busy' : ''}"><span class="run-label">最新整理结果</span><div>${last ? describe(last) : '还没有整理记录。'}${pendingCount ? ` 还有 ${pendingCount} 条消息正在排队整理。` : ''}` +
    `${busy ? '<span class="busy-line">AI 正在整理新消息<i></i><i></i><i></i></span>' : ''}</div>` +
    `${older.length ? `<details><summary>之前 ${older.length} 次</summary><ul>${older.map(run => `<li>${describe(run)}</li>`).join('')}</ul></details>` : ''}</div>`;
}
function taskCard(task) {
  const done = task.status === 'done';
  const due = deadline(task).main;
  return `<article class="task-card"><button class="task-check ${done ? 'done' : ''}" data-action="complete-task" data-id="${safe(task.id)}" aria-label="${done ? '恢复' : '完成'}：${safe(task.title)}">${done ? '✓' : ''}</button>` +
    `<div><div class="task-heading"><span class="task-title ${done ? 'done' : ''}">${safe(task.title)}</span>${task.needsReview ? '<span class="tag review">待确认</span>' : ''}${task.relevance === 'other' ? '<span class="tag other">他人事项</span>' : ''}</div>` +
    `<p class="task-desc">${safe(task.description || '可以在详情里补充任务要求。')}</p><div class="task-meta"><span>${safe(conversationName(task.conversationId))}</span><span>${safe(task.kind)}</span><span>${safe(relationLabels[task.relevance])}</span></div></div>` +
    `<div class="task-right"><div class="task-deadline ${task.dueDate ? '' : 'unknown'}">${safe(due)}</div><button class="task-detail" data-action="task-detail" data-id="${safe(task.id)}">详情与来源 ↗</button></div></article>`;
}

async function drawMessages() {
  const request = state.messageRequest = Symbol();
  const conversations = state.data.conversations.filter(value => state.messagePlatform === 'all' || value.platform === state.messagePlatform);
  if (!conversations.some(value => value.id === state.messageConversation)) state.messageConversation = conversations[0]?.id || '';
  const selected = conversations.find(value => value.id === state.messageConversation);
  if (!selected) {
    $('#main').innerHTML = pageHead('聊天与消息', '', '<button class="button" data-action="discover-messages">发现本机会话</button>') + notice() + empty('等待账号与会话', '正常登录电脑微信后会自动发现会话；QQ 需要本机消息组件已接入。');
    return;
  }
  const status = aiReady() ? `<p class="inline-note">${safe(analysisLabels[selected.analysisState] || '等待整理')}。${safe(selected.analysisError)}</p>` : '';
  $('#main').innerHTML = pageHead('聊天与消息', '文字、图片和文件由你点击发送。开启整理后，这个会话的新消息会保存并进入待办分析。', '<button class="button secondary" data-action="discover-messages">刷新会话</button>') +
    `<div class="message-header"><label class="sr-only" for="message-platform">平台</label><select id="message-platform"><option value="all">QQ 与微信</option><option value="qq">QQ</option><option value="wechat">微信</option></select><label class="sr-only" for="message-conversation">消息会话</label><select id="message-conversation">${conversations.map(value => `<option value="${safe(value.id)}" ${value.id === selected.id ? 'selected' : ''}>${value.platform === 'wechat' ? '微信' : 'QQ'} · ${safe(value.title)}</option>`).join('')}</select>` +
    `<button class="button secondary" data-action="toggle-conversation" data-id="${safe(selected.id)}">${selected.monitored ? '停止保存与整理' : '开启保存与整理'}</button>${aiReady() && selected.monitored ? `<button class="button secondary" data-action="analyze" data-id="${safe(selected.id)}">整理新消息</button>` : ''}</div>` +
    `${selected.summary ? `<div class="summary">${safe(selected.summary)}</div>` : ''}${selected.monitored ? status : '<p class="inline-note">当前只查看客户端消息。开启保存与整理后，才会持续入库并交给已配置的 AI。</p>'}<div id="message-list"><div class="loading">正在读取消息…</div></div>` +
    `<form id="message-send-form" class="message-composer" data-conversation="${safe(selected.id)}"><label class="sr-only" for="message-text">发送内容</label><textarea id="message-text" name="text" rows="3" maxlength="6000" placeholder="发送给 ${safe(selected.title)}…">${safe(state.drafts[selected.id] || '')}</textarea><div class="composer-footer"><label class="button secondary" for="message-files">＋ 图片 / 文件</label><input id="message-files" type="file" multiple class="sr-only"><span id="selected-files" class="muted"></span><button class="button" type="submit">发送</button></div></form><div id="outbox-list"></div>`;
  $('#message-platform').value = state.messagePlatform;
  $('#selected-files').textContent = (state.fileDrafts[selected.id] || []).map(file => file.name).join('、');
  const id = selected.id;
  let messages;
  try { messages = await api(`/api/conversations/${encodeURIComponent(id)}/messages`); }
  catch (error) {
    if (state.view === 'messages' && state.messageRequest === request && state.messageConversation === id && $('#message-list')) {
      $('#message-list').innerHTML = empty('消息暂时不可读取', error.message);
      $('#message-send-form button[type="submit"]').disabled = true;
    }
    return;
  }
  if (state.view !== 'messages' || state.messageRequest !== request || state.messageConversation !== id || !$('#message-list')) return;
  $('#message-list').innerHTML = messages.slice().reverse().map(message => `<article class="message-card">${senderAvatar(message)}<div><div class="message-byline"><span>${safe(message.senderName)}${message.isSelf ? ' · 我' : ''}${message.source === 'history' ? ' · 历史采集' : ''}</span><time>${safe(formatDate(message.sentAt, true))}</time></div><p class="message-body">${safe(message.content)}</p>${selected.platform === 'wechat' && ['图片', '文件/链接/卡片'].includes(message.messageType) ? `<button class="button quiet" data-action="view-media" data-conversation="${safe(selected.id)}" data-id="${safe(message.id)}">${message.messageType === '图片' ? '查看本机图片' : '打开本机文件'}</button>` : ''}</div></article>`).join('')
    || '<div class="no-results">这个客户端暂时没有可读取的消息。</div>';
  const outbox = await api(`/api/conversations/${encodeURIComponent(id)}/outbox`);
  if (state.view !== 'messages' || state.messageRequest !== request || !$('#outbox-list') || state.messageConversation !== id) return;
  $('#outbox-list').innerHTML = outbox.slice(0, 5).map(item => `<p class="inline-note">${safe(formatDate(item.at, true))} · ${item.status === 'sent' ? '已发送' : item.status === 'sending' ? '发送中' : item.status === 'failed' ? '未提交发送，请检查客户端' : item.partial ? '部分内容已发送，请核查其余内容' : '发送结果未确认，请先查看客户端'}${item.attachments.length ? ` · ${item.attachments.length} 个附件` : ''}${selected.platform === 'wechat' && item.status === 'uncertain' && !item.attachments.length ? ` <button class="link-button" data-action="check-send" data-conversation="${safe(selected.id)}" data-id="${safe(item.id)}">核查发送结果</button>` : ''}</p>`).join('');
}
// 发言人头像：取名字里第一个非数字字符，颜色按 QQ 号固定，同一个人颜色不变。
function senderAvatar(message) {
  const initial = [...String(message.senderName || '')].find(char => /[^\d\s·\-_]/.test(char)) || '?';
  const hue = [...String(message.senderId || message.senderName)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
  return `<span class="message-avatar av-${hue}" aria-hidden="true">${safe(initial)}</span>`;
}

function conversationCard(value, actions) {
  return `<article class="conversation-card"><span class="conversation-avatar">${value.kind === 'private' ? '友' : '群'}</span><div class="conversation-info"><h3>${safe(value.title)}</h3>` +
    `<p>${safe(value.remoteId)}${value.messageCount === undefined ? ' · 等待第一次拉取' : ` · ${value.messageCount} 条消息`}${aiReady() && value.analysisState ? ` · ${safe(analysisLabels[value.analysisState] || '等待新消息')}` : ''}${value.rules ? ' · 已设规则' : ''}</p></div>` +
    `<div class="conversation-actions">${value.id ? `<button class="button quiet" data-action="conversation-rules" data-id="${safe(value.id)}">名称与规则</button>` : ''}${actions}</div></article>`;
}
function drawConversations() {
  const { conversations, capture } = state.data;
  if (capture) {
    drawCaptureGroups(conversations.filter(value => value.kind === 'group'), capture.groups);
    const extra = conversations.filter(value => value.kind === 'private');
    if (extra.length) $('#main').insertAdjacentHTML('beforeend', '<h2 class="section-title">好友与私聊</h2>' + extra.map(value => conversationCard(value,
      `<span class="tag">${value.platform === 'wechat' ? '微信' : 'QQ'}</span><button class="button ${value.monitored ? 'secondary' : ''}" data-action="toggle-conversation" data-id="${safe(value.id)}">${value.monitored ? '停止保存与整理' : '开启保存与整理'}</button>`)).join(''));
    return;
  }
  $('#main').innerHTML = pageHead('会话管理', '只有已关注会话的消息会被保存；每个会话可以设置自己的整理规则。', '<button class="button" data-action="add-group">＋ 添加群聊</button>') + notice() +
    (conversations.length ? conversations.map(value => `<article class="conversation-card"><span class="conversation-avatar">${value.kind === 'group' ? '群' : '友'}</span><div class="conversation-info"><h3>${safe(value.title)}</h3><p>${safe(value.remoteId)} · ${value.messageCount} 条消息${aiReady() ? ` · ${safe(analysisLabels[value.analysisState] || '等待新消息')}` : ''}${value.rules ? ' · 已设规则' : ''}</p></div><div class="conversation-actions"><button class="button quiet" data-action="conversation-rules" data-id="${safe(value.id)}">名称与规则</button><button class="button ${value.monitored ? 'secondary' : ''}" data-action="toggle-conversation" data-id="${safe(value.id)}">${value.monitored ? '停止关注' : '开始关注'}</button></div></article>`).join('')
      : empty('还没有会话', 'QQ 消息桥上报消息后，会话会自动出现在这里。'));
}
// 采集模式：列出正在拉取的群（可移除），以及移除后保留了历史的群（可恢复）。
function drawCaptureGroups(conversations, groups) {
  const wechat = conversations.filter(value => value.platform === 'wechat' && value.monitored);
  const captured = [...groups.map(groupId => conversations.find(value => value.id === `qq:group:${groupId}`) || { platform: 'qq', remoteId: groupId, title: `群 ${groupId}`, kind: 'group' }), ...wechat];
  const removed = conversations.filter(value => value.platform === 'qq' ? !groups.includes(value.remoteId) : !value.monitored && value.messageCount > 0);
  const groupCard = (value, restore = false) => conversationCard(value, `<span class="tag">${value.platform === 'wechat' ? '微信' : 'QQ'}</span>` +
    `<button class="button ${restore ? '' : 'secondary'}" data-action="${value.platform === 'wechat' ? `wechat-group-${restore ? 'add' : 'remove'}` : `capture-${restore ? 'add' : 'remove'}`}" data-id="${safe(value.platform === 'wechat' ? value.id : value.remoteId)}">${restore ? '恢复拉取' : '移除'}</button>`);
  $('#main').innerHTML = pageHead('拉取的群聊', `已添加 ${groups.length} 个 QQ 群、${wechat.length} 个微信群。账号接入后保存新消息，并交给已配置的 AI 整理。`, '<button class="button" data-action="add-group">＋ 添加群聊</button>') + notice() +
    (captured.length ? captured.map(value => groupCard(value)).join('')
      : empty('还没有要拉取的群', '点击“添加群聊”，选择 QQ 群或当前电脑微信中的群聊。', '<button class="button" data-action="add-group">＋ 添加群聊</button>')) +
    `<h2 class="section-title">QQ · 最近有消息、还没接入的群</h2><div id="active-groups">${activeGroupsHtml()}</div>` +
    (removed.length ? `<h2 class="section-title">未在拉取的群聊（保留历史消息和任务）</h2>${removed.map(value => groupCard(value, true)).join('')}` : '');
  loadActiveGroups();
}
// 从 QQ「最近联系人」读取最近有消息但未接入的群；缓存一分钟，避免页面每次刷新都去问 QQ。
function activeGroupsHtml() {
  const active = state.activeGroups;
  if (!active) return '<p class="inline-note">正在读取…</p>';
  if (active.error) return `<p class="inline-note">${safe(active.error)}</p>`;
  if (!active.list.length) return '<p class="inline-note">最近有消息的群都已经接入了。</p>';
  return `<ul class="group-list">${active.list.map(group => `<li><div><strong>${safe(group.name || `群 ${group.groupId}`)}</strong><small>${safe(group.groupId)}${group.lastAt ? ` · 最后消息 ${safe(formatDate(group.lastAt, true))}` : ''}</small></div>` +
    `<button class="button secondary" data-action="capture-add" data-id="${safe(group.groupId)}">添加</button></li>`).join('')}</ul>`;
}
let activeGroupsLoading = false;
async function loadActiveGroups(force = false) {
  if (activeGroupsLoading || (!force && state.activeGroups && Date.now() - state.activeGroups.at < 60000)) return;
  activeGroupsLoading = true;
  try { state.activeGroups = { at: Date.now(), list: await api('/api/qq/active-groups') }; }
  catch (error) { state.activeGroups = { at: Date.now(), list: [], error: error.message }; }
  finally { activeGroupsLoading = false; }
  if ($('#active-groups')) $('#active-groups').innerHTML = activeGroupsHtml();
}
let groupPickerRequest = 0;
async function showGroupPicker(platform = state.groupPlatform || (state.data.wechat?.online && !state.data.qq.online ? 'wechat' : 'qq')) {
  const request = ++groupPickerRequest;
  state.groupPlatform = platform === 'wechat' ? 'wechat' : 'qq';
  const isWechat = state.groupPlatform === 'wechat', label = isWechat ? '微信' : 'QQ';
  const tabs = `<div class="group-platforms" role="group" aria-label="群聊平台">${[['qq', 'QQ 群'], ['wechat', '微信群']].map(([id, name]) =>
    `<button class="button ${state.groupPlatform === id ? '' : 'secondary'}" data-action="group-platform" data-platform="${id}" aria-pressed="${state.groupPlatform === id}">${name}</button>`).join('')}<button class="button quiet" data-action="group-refresh">刷新列表</button></div>`;
  const note = isWechat ? '<p class="inline-note">选择当前登录电脑微信中的群聊。找不到群时，请先在电脑微信中打开该群，再刷新列表。只有点击添加的群才会保存消息并参与整理。</p>' : '';
  const manual = isWechat ? '' : '<form id="group-manual-form" class="group-manual"><label class="field-label" for="manual-group">或直接填写 QQ 群号</label><div class="inline-form"><input id="manual-group" name="groupId" inputmode="numeric" pattern="[0-9]+" required placeholder="例如 1048751336"><button class="button" type="submit">添加</button></div></form>';
  openDialog('添加群聊', tabs + note + `<div id="group-picker-results" data-request="${request}" aria-live="polite"><div class="loading">正在读取${label}群列表…</div></div>` + manual);
  let list;
  try {
    const groups = await api(isWechat ? '/api/wechat/groups' : '/api/qq/groups');
    list = groups.length ? `<label class="sr-only" for="group-search">搜索群聊</label><input id="group-search" class="search wide" placeholder="${isWechat ? '搜索微信群名' : '搜索群名或群号'}"><ul class="group-list">${groups.map(group => {
      const id = isWechat ? group.id : group.groupId, name = isWechat ? group.title : group.name;
      return `<li data-search="${safe(`${name} ${isWechat ? group.remoteId : id}`.toLowerCase())}"><div><strong>${safe(name || `群 ${id}`)}</strong><small>${safe(isWechat ? group.remoteId : id)}${group.memberCount ? ` · ${group.memberCount} 人` : ''}</small></div>` +
        ((isWechat ? group.monitored : group.captured) ? '<span class="tag">已添加</span>' : `<button class="button secondary" data-action="${isWechat ? 'wechat-group-add' : 'capture-add'}" data-id="${safe(id)}">添加</button>`) + '</li>';
    }).join('')}</ul><p id="group-search-empty" class="inline-note" hidden>没有匹配的群聊，请换个关键词或刷新列表。</p>` : `<p class="inline-note">${isWechat ? '暂未发现微信群，请在电脑微信中打开目标群后刷新。' : '这个 QQ 账号还没有加入任何群。'}</p>`;
  } catch (error) { list = `<div class="notice amber">${safe(error.message)}</div>`; }
  const results = $('#group-picker-results');
  if ($('#detail-dialog').open && results?.dataset.request === String(request)) results.innerHTML = list;
}

const modelPresets = () => state.data.settings.modelPresets;
function drawSettings() {
  const { model, connection, capture, qq } = state.data;
  const lastLive = connection.messages > (connection.historyMessages || 0) && connection.lastMessage;
  const groupLabel = groupId => `「${safe(state.data.conversations.find(value => value.id === `qq:group:${groupId}`)?.title || `群 ${groupId}`)}」`;
  const scope = capture ? (capture.groups.length ? `只拉取 ${capture.groups.map(groupLabel).join('、')}，其他群和私聊不保存。` : '还没有要拉取的群。') : '按“群聊管理”中的关注设置保存消息。';
  const [pillClass, pillText] = qq.blockedReason === 'desktop_in_use' ? ['', '桌面 QQ 优先'] : qq.blockedReason ? ['', '等待检查'] : qq.online ? ['ready', 'QQ 已连接'] : qq.available ? ['', '等待扫码'] : qq.keepRunning ? ['', '正在启动'] : ['', '已停止'];
  const backfill = qq.lastBackfill ? `${safe(formatDate(qq.lastBackfill.at, true))}，${qq.lastBackfill.error ? safe(qq.lastBackfill.error) : `新增 ${qq.lastBackfill.imported} 条`}` : '尚无';
  const preset = modelPresets().find(value => value.baseUrl === model.baseUrl) || (!model.baseUrl ? modelPresets()[0] : null);
  const defaults = preset || { baseUrl: '', name: '' };
  $('#main').innerHTML = pageHead('接入设置', '') + notice() +
    `<section class="content-card"><h2>微信 · 本机登录自动接入</h2><div class="settings-row"><span>${state.data.wechat?.online ? `${safe(state.data.wechat.name)} · ${safe(state.data.wechat.selfId)}` : safe(state.data.wechat?.error || '等待电脑微信正常登录')}</span><span class="status-pill ${state.data.wechat?.online ? 'ready' : ''}">${state.data.wechat?.online ? '微信已连接' : '等待接入'}</span></div><p>工作台每 ${state.data.settings.messaging.pollIntervalMs / 1000} 秒检查电脑微信的登录状态。退出或重新登录后会重新识别账号；在聊天页面选择需要保存与整理的会话。</p><p class="inline-note">发送文字、图片或文件时请保持桌面解锁。发送结果未确认时，先检查微信客户端再决定是否重发。</p><button class="button secondary" data-action="discover-messages">发现会话</button></section>` +
    `<section class="content-card"><h2>QQ 消息</h2><div class="settings-row"><span>${scope}</span><span class="status-pill ${pillClass}">${pillText}</span></div>` +
    `<p>${qq.keepRunning ? '常驻已开启：采集退出后会自动恢复。检测到桌面 QQ 时会暂停，避免重复登录。' : '常驻已关闭：工作台不会自动启动 QQ 采集，桌面 QQ 可以正常使用。'}</p>` +
    `<p>自动登录账号：${qq.account ? `${safe(qq.account)} <button class="link-button" data-action="qq-forget">忘记</button>` : '未设置。下次启动需要扫码，登录成功后会自动记住。'}</p>` +
    `<p>已保存 ${connection.messages || 0} 条消息，其中 ${connection.historyMessages || 0} 条来自历史补拉。</p>` +
    `<p class="inline-note">最近上报：${connection.lastReport ? safe(formatDate(connection.lastReport, true)) : '尚无'} · 最近新消息：${lastLive ? safe(formatDate(lastLive, true)) : '尚无'} · 最近补拉：${backfill}</p>` +
    sourceLine(connection.lastSource) +
    `${qq.error && (qq.keepRunning || qq.blockedReason) && !qq.online ? `<div class="notice amber">${safe(qq.error)}</div>` : ''}` +
    `<div class="settings-actions">${qq.keepRunning || qq.available || qq.ownedQQRunning ? '<button class="button secondary" data-action="qq-stop">停止采集，使用桌面 QQ</button>' : `<button class="button" data-action="qq-start" ${qq.blockedReason ? 'disabled' : ''}>启动采集</button>`}` +
    `<button class="button secondary" data-action="qq-backfill" ${qq.online ? '' : 'disabled'}>立即补拉</button><a class="button quiet" href="/qq-login">扫码页</a></div></section>` +
    `<section class="content-card"><h2>AI 模型</h2>${model.error ? `<p class="notice amber">${safe(model.error)}</p>` : ''}<div class="settings-row"><span>${model.configured ? `${safe(model.name)} · ${safe(model.host)}` : '未配置，消息只保存在本机。'}</span><span class="status-pill ${model.configured ? 'ready' : ''}">${model.configured ? '已启用' : '未启用'}</span></div>` +
    `<form id="model-form"><div class="field-row"><div><label class="field-label" for="model-preset">服务</label><select id="model-preset">${modelPresets().map(value => `<option value="${safe(value.id)}" ${preset?.id === value.id ? 'selected' : ''}>${safe(value.label)}</option>`).join('')}<option value="custom" ${preset ? '' : 'selected'}>其他（兼容 OpenAI 接口）</option></select></div>` +
    `<div><label class="field-label" for="model-name">模型名称</label><input id="model-name" name="name" required maxlength="150" value="${safe(model.name || defaults.name)}"></div></div>` +
    `<label class="field-label" for="model-base">服务地址</label><input id="model-base" name="baseUrl" required maxlength="300" value="${safe(model.baseUrl || defaults.baseUrl)}">` +
    `<label class="field-label" for="model-key">API Key</label><input id="model-key" name="key" type="password" autocomplete="off" maxlength="500" placeholder="${model.hasKey ? '已保存，不修改请留空' : '在服务商控制台创建后粘贴到这里'}">` +
    `<label class="check-row"><input type="checkbox" name="enabled" ${model.enabled || !model.baseUrl ? 'checked' : ''}> 启用 AI 整理</label>` +
    '<p id="model-test-result" class="inline-note" role="status"></p><div class="dialog-actions"><button class="button secondary" type="button" data-action="test-model">测试连接</button><button class="button" type="submit">保存</button></div></form>' +
    '<p class="inline-note">保存后立即生效，已关注会话里尚未整理的消息会自动开始整理。所关注群的文字会发送给该服务；Key 保存在本机 data/model.json。</p></section>' +
    `<section class="content-card"><h2>开机自启</h2><div class="settings-row"><span>${state.data.autostart ? '已开启：登录 Windows 后，工作台会在后台自动启动；QQ 采集开着时也会一并启动，自动补拉和 AI 整理不需要手动操作。' : '未开启：开机后需要手动双击“打开工作台.cmd”，工作台没运行时不会拉补。'}</span>` +
    `<button class="button ${state.data.autostart ? 'secondary' : ''}" data-action="toggle-autostart">${state.data.autostart ? '关闭' : '开启'}</button></div></section>` +
    '<p class="inline-note">消息、任务和规则都保存在本机 data/workbench.sqlite，停止服务后仍会保留。</p>';
}

async function drawLogs() {
  const request = state.logRequest = Symbol(), platform = state.logPlatform;
  const rows = await api('/api/logs' + (platform ? '?platform=' + encodeURIComponent(platform) : ''));
  if (state.view !== 'logs' || state.logRequest !== request) return;
  const level = { 30: '信息', 40: '提示', 50: '错误' };
  $('#main').innerHTML = pageHead('运行日志', '记录账号连接、收发与后台处理的结果。聊天正文和密钥不写入运行日志。') +
    (state.data.logging?.error ? `<p class="inline-note" role="status">${safe(state.data.logging.error)}</p>` : '') +
    '<div class="message-header"><label for="log-platform">平台</label><select id="log-platform"><option value="">全部</option><option value="qq">QQ</option><option value="wechat">微信</option></select><button class="button secondary" data-action="refresh-logs">刷新</button></div>' +
    `<div class="log-list">${rows.map(row => `<article class="content-card log-entry"><div class="message-byline"><span>${safe(level[row.level] || '信息')} ${row.platform ? ` · ${row.platform === 'wechat' ? '微信' : 'QQ'}` : ''}</span><time>${safe(formatDate(row.time, true))}</time></div><p>${safe(row.msg)}</p><small class="muted">${safe([row.job, row.status, row.code, row.count != null ? `数量 ${row.count}` : ''].filter(Boolean).join(' · '))}</small></article>`).join('') || '<div class="no-results">当前筛选下还没有运行记录。</div>'}</div>`;
  $('#log-platform').value = platform || '';
}

async function drawMaintenance() {
  const request = state.maintenanceRequest = Symbol();
  const value = await api('/api/maintenance');
  if (state.view !== 'maintenance' || state.maintenanceRequest !== request) return;
  const jobs = { analysis: '消息整理', backup: '一致性备份', optimize: '检查与优化' };
  $('#main').innerHTML = pageHead('数据与定时处理', '按北京时间处理工作台数据库，原始聊天会保留。') +
    `<section class="content-card"><h2>定时安排</h2><form id="maintenance-form"><label class="check-row"><input type="checkbox" name="enabled" ${value.config.enabled ? 'checked' : ''}>启用定期处理</label><div class="field-row"><div><label class="field-label" for="analysis-minutes">消息整理间隔（分钟）</label><input id="analysis-minutes" name="analysisMinutes" type="number" min="1" max="60" value="${value.config.analysisMinutes}"></div><div><label class="field-label" for="backup-hour">每天备份的小时（北京时间）</label><input id="backup-hour" name="backupHour" type="number" min="0" max="23" value="${value.config.backupHour}"></div></div><label class="field-label" for="optimize-minutes">检查与优化间隔（分钟）</label><input id="optimize-minutes" name="optimizeMinutes" type="number" min="5" max="60" value="${value.config.optimizeMinutes}"><p class="inline-note">消息整理会排入已有 AI 队列；备份读取完整一致的数据库；检查与优化不会删除聊天。同一任务运行期间不会重复执行。</p><div class="dialog-actions"><button class="button" type="submit">保存安排</button></div></form></section>` +
    `<section class="content-card"><h2>立即处理</h2><div class="settings-actions">${Object.entries(jobs).map(([job, label]) => `<button class="button secondary" data-action="maintenance-run" data-job="${job}" ${value.active.includes(job) ? 'disabled' : ''}>${value.active.includes(job) ? '处理中…' : label}</button>`).join('')}</div></section>` +
    `<section class="content-card"><h2>最近处理</h2>${value.runs.slice(0, 10).map(run => `<p class="maintenance-row">${safe(formatDate(run.startedAt, true))} · ${safe(jobs[run.job])} · ${run.status === 'success' ? '已完成' : run.status === 'failed' ? safe(run.error) : '处理中'}</p>`).join('') || '<p class="muted">还没有后台处理记录。</p>'}</section>` +
    `<section class="content-card"><h2>本机备份</h2>${value.backups.map(file => `<p class="maintenance-row"><span>${safe(file.name)}</span><small>${(file.bytes / 1024).toFixed(1)} KB</small></p>`).join('') || '<p class="muted">可以点击“一致性备份”立即创建。</p>'}</section>`;
}
// 说明最近一条实时消息上报来自哪里；来自未接入的群时，提示它没有被保存。
function sourceLine(source) {
  if (!source) return '';
  const from = source.kind === 'private' ? '私聊' : `「${safe(source.name || `群 ${source.groupId}`)}」`;
  return `<p>最近一条消息上报：${safe(formatDate(source.at, true))}，来自${from}${source.captured ? '（已接入，已保存）' : '（<strong>未接入，没有保存</strong>）'}。` +
    `${source.captured ? '' : '<button class="link-button" data-view="conversations">管理拉取的群</button>'}</p>`;
}
function modelValues() {
  const field = name => $('#model-form').elements.namedItem(name);
  return { baseUrl: field('baseUrl').value.trim(), name: field('name').value.trim(), key: field('key').value.trim(), enabled: field('enabled').checked };
}

// 进场动画只在切换页面、筛选时播放；自动刷新的重绘不重播。
let enterTimer;
function markEnter() {
  if (calm()) return;
  $('#main').classList.add('enter');
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => $('#main').classList.remove('enter'), 1200);
}
// 统计数字从 0 滚动到实际值。
function countUp() {
  if (!$('#main').classList.contains('enter')) return;
  for (const element of document.querySelectorAll('#main [data-count]')) {
    const target = Number(element.dataset.count), started = performance.now();
    if (!target) continue;
    const step = now => { const t = Math.min((now - started) / 700, 1); element.textContent = Math.round(target * (1 - (1 - t) ** 3)); if (t < 1) requestAnimationFrame(step); };
    element.textContent = '0';
    requestAnimationFrame(step);
  }
}
// 侧栏高亮块滑到当前页面（CSP 允许用脚本设置样式属性）。
function moveIndicator() {
  const active = $('.nav-item.active'), indicator = $('.nav-indicator');
  if (!active || !indicator) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.height = `${active.offsetHeight}px`;
  indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  requestAnimationFrame(() => indicator.classList.add('ready'));
}

async function drawMain() {
  const focused = document.activeElement?.id, position = document.activeElement?.selectionStart;
  if (state.view === 'tasks') drawTasks();
  else if (state.view === 'messages') await drawMessages();
  else if (state.view === 'conversations') drawConversations();
  else if (state.view === 'logs') await drawLogs();
  else if (state.view === 'maintenance') await drawMaintenance();
  else drawSettings();
  if (focused === 'task-search' && $('#task-search')) { $('#task-search').focus(); if (position !== null) $('#task-search').setSelectionRange(position, position); }
}

function renderChrome() {
  const data = state.data, online = qqOnline();
  $('#qq-status').textContent = online ? 'QQ 已连接' : 'QQ 未连接';
  $('#qq-status').classList.toggle('ready', online);
  $('#wechat-status').textContent = data.wechat?.online ? '微信已连接' : '微信等待登录';
  $('#wechat-status').classList.toggle('ready', Boolean(data.wechat?.online));
  $('#ai-status').textContent = aiReady() ? 'AI 已配置' : 'AI 未配置';
  $('#ai-status').classList.toggle('ready', aiReady());
  document.body.classList.toggle('no-ai', !aiReady());
  const openCount = data.tasks.filter(unfinished).length;
  $('#nav-count').textContent = openCount;
  $('#nav-count').toggleAttribute('data-zero', !openCount);
  $('#profile-label').textContent = data.profile.name || '我的信息与规则';
  if (!aiReady()) return;
  $('#chat-model-label').textContent = data.model.name;
  const choices = data.conversations.filter(value => value.monitored);
  $('#chat-scope').innerHTML = '<option value="all">所有已关注会话与手动待办</option>' + choices.map(value => `<option value="${safe(value.id)}">${safe(value.title)}</option>`).join('');
  $('#chat-scope').value = state.chatScope;
}

async function refresh(force = false) {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  try {
    const data = await api('/api/state');
    if (!data.settings) throw new Error('工作台正在更新，请稍后刷新页面');
    state.data = data;
    if (state.chatScope !== 'all' && !state.data.conversations.some(value => value.id === state.chatScope && value.monitored)) { state.chatScope = 'all'; if (aiReady()) await loadChat(); }
    renderChrome();
    const stamp = JSON.stringify([state.view, state.data]);
    // 正在填写 AI 设置时不自动重绘，避免清掉输入内容。
    const editing = !force && ($('#model-form')?.dataset.dirty || $('#maintenance-form')?.dataset.dirty || $('#message-send-form')?.dataset.dirty);
    if (!editing && (force || stamp !== state.mainStamp)) { state.mainStamp = stamp; await drawMain(); }
  } finally { state.refreshBusy = false; }
}

function openDialog(title, body) { $('#dialog-content').innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${safe(title)}</h2><button class="close-button" data-action="close-dialog" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div>`; $('#detail-dialog').showModal(); }
function closeDialog() { $('#detail-dialog').close(); }

function taskForm(task = {}) {
  const options = (entries, current) => entries.map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('');
  return `<form id="task-form" data-id="${safe(task.id || '')}" data-revision="${task.revision || ''}">` +
    `<label class="field-label" for="edit-title">任务内容</label><input id="edit-title" name="title" maxlength="180" required value="${safe(task.title)}">` +
    `<label class="field-label" for="edit-description">具体要求</label><textarea id="edit-description" name="description" rows="3" maxlength="2000">${safe(task.description)}</textarea>` +
    `<div class="field-row"><div><label class="field-label" for="edit-date">截止日期（未知可留空）</label><input id="edit-date" name="dueDate" type="date" value="${safe(task.dueDate)}"></div><div><label class="field-label" for="edit-time">截止时刻（未知可留空）</label><input id="edit-time" name="dueTime" type="time" value="${safe(task.dueTime)}"></div></div>` +
    `<label class="field-label" for="edit-due-text">原始时间表述</label><input id="edit-due-text" name="dueText" maxlength="200" value="${safe(task.dueText)}" placeholder="例如：明天下午 / 尽快">` +
    `<div class="field-row"><div><label class="field-label" for="edit-status">状态</label><select id="edit-status" name="status">${options([['pending', '待处理'], ['done', '已完成'], ['cancelled', '已取消']], task.status || 'pending')}</select></div>` +
    `<div><label class="field-label" for="edit-relevance">与我的关系</label><select id="edit-relevance" name="relevance">${options(Object.entries(relationLabels), task.relevance || 'mine')}</select></div></div>` +
    '<div class="dialog-actions"><button class="button secondary" type="button" data-action="close-dialog">关闭</button><button class="button" type="submit">保存并确认</button></div></form>';
}

async function showTask(id) {
  const { task, sources } = await api(`/api/tasks/${encodeURIComponent(id)}`);
  const questions = task.questions.length ? `<div class="notice amber">${task.questions.map(safe).join('<br>')}</div>` : '';
  const suggestion = task.suggestedStatus ? `<div class="notice amber">AI 建议${task.suggestedStatus === 'done' ? '完成' : '取消'}此任务，请核实后在状态栏选择。</div>` : '';
  const quotes = sources.map(message => `<div class="source-quote"><small>${safe(conversationName(message.conversationId))} · ${safe(message.senderName)} · ${safe(formatDate(message.sentAt, true))}</small><p>${safe(message.content)}</p></div>`).join('') || '<p class="inline-note">这是一条手动待办，没有关联 QQ 消息。</p>';
  const history = task.history.length ? `<h3>修改记录</h3>${task.history.slice().reverse().map(change => `<div class="history-item">${safe(change.reason)} · ${safe(formatDate(change.at, true))}<br>修改前：${safe(change.title)} · ${safe(change.dueDate || change.dueText || '截止日期未定')}${change.dueTime ? ` ${safe(change.dueTime)}` : ''}</div>`).join('')}` : '';
  openDialog('任务详情与来源', `${questions}${suggestion}${taskForm(task)}<h3>来源消息</h3>${quotes}${history}`);
}

function showProfile() {
  const profile = state.data.profile;
  openDialog('我的信息与整理规则', `<p class="inline-note">保存在本机。配置 AI 后，会随上下文提供给模型，帮助判断通知是否与你有关。</p><form id="profile-form"><label class="field-label" for="profile-name">你的称呼</label><input id="profile-name" name="name" maxlength="100" value="${safe(profile.name)}"><label class="field-label" for="profile-context">身份与长期规则</label><textarea id="profile-context" name="context" rows="7" maxlength="5000" placeholder="例如：我是动物科学专业大一学生。通知群里的全体通知通常与我有关。">${safe(profile.context)}</textarea><div class="dialog-actions"><button class="button" type="submit">保存规则</button></div></form>`);
}
function showConversation(id) {
  const conversation = state.data.conversations.find(value => value.id === id);
  if (!conversation) return;
  openDialog('会话名称与规则', `<form id="conversation-form" data-id="${safe(id)}"><label class="field-label" for="conversation-title">会话名称</label><input id="conversation-title" name="title" required maxlength="100" value="${safe(conversation.title)}"><label class="field-label" for="conversation-rules">这个会话的整理规则</label><textarea id="conversation-rules" name="rules" rows="6" maxlength="5000" placeholder="例如：这是学院通知群，辅导员发布的全体通知都适用于我。">${safe(conversation.rules)}</textarea><p class="inline-note">规则只用于此会话，之后分析新消息时生效。</p><div class="dialog-actions"><button class="button" type="submit">保存</button></div></form>`);
}

async function loadChat() {
  const scope = state.chatScope;
  const turns = await api(`/api/chat?scope=${encodeURIComponent(scope)}`);
  if (scope !== state.chatScope) return;
  if (turns.length) $('#chat-log').innerHTML = turns.map(turn => `<div class="chat-bubble ${turn.role === 'user' ? 'user' : ''}">${safe(turn.content)}</div>`).join('');
  else $('#chat-log').innerHTML = '<div class="assistant-intro"><h3>今天，从哪里开始？</h3><p>我可以结合通知、待办和对话记录，帮你整理学习安排。</p></div>';
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
}
async function sendChat(prompt) {
  if (state.chatBusy || !aiReady()) return;
  state.chatBusy = true;
  $('#chat-send').disabled = true; $('#chat-scope').disabled = true;
  const bubble = document.createElement('div'); bubble.className = 'chat-bubble user'; bubble.textContent = prompt; $('#chat-log').append(bubble);
  const answer = document.createElement('div'); answer.className = 'chat-bubble';
  answer.innerHTML = '<span class="typing" role="status" aria-label="正在结合通知和待办思考"><i></i><i></i><i></i></span>'; $('#chat-log').append(answer);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  try { const result = await api('/api/chat', { prompt, scope: state.chatScope }); answer.textContent = result.reply; $('#chat-input').value = ''; }
  catch (error) { answer.textContent = error.message; answer.classList.add('error'); }
  finally { state.chatBusy = false; $('#chat-send').disabled = false; $('#chat-scope').disabled = false; $('#chat-log').scrollTop = $('#chat-log').scrollHeight; }
}
function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  moveIndicator();
}
function switchView(view) {
  if (!VIEWS.includes(view)) return;
  setView(view);
  history.replaceState(null, '', view === 'tasks' ? '/' : `/?view=${view}`);
  markEnter();
  drawMain().then(countUp).catch(error => toast(error.message));
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) { switchView(button.dataset.view); return; }
  if (button.dataset.filter) { state.filter = button.dataset.filter; markEnter(); drawTasks(); return; }
  if (button.dataset.prompt) { $('#chat-input').value = button.dataset.prompt; await sendChat(button.dataset.prompt); return; }
  const action = button.dataset.action;
  try {
    if (action === 'check-send') {
      const result = await api('/api/messages/check', { conversationId: button.dataset.conversation, requestId: button.dataset.id });
      if (result.status === 'sent' && state.drafts[button.dataset.conversation] === result.text) { state.drafts[button.dataset.conversation] = ''; state.fileDrafts[button.dataset.conversation] = []; }
      toast(result.status === 'sent' ? '已从客户端记录确认发送' : '仍未确认，请先查看客户端');
      await refresh(true); return;
    }
    if (action === 'view-media') {
      button.disabled = true;
      try {
        const value = await api('/api/messages/media', { conversationId: button.dataset.conversation, messageId: button.dataset.id });
        const link = `/api/attachments/${encodeURIComponent(value.id)}`;
        openDialog(value.type === 'image' ? '本机缓存图片' : '本机文件', value.type === 'image' ? `<img class="media-preview" src="${link}" alt="微信本机缓存图片"><p><a href="${link}" target="_blank" rel="noopener">打开图片</a></p>` : `<p><a href="${link}" download>${safe(value.name)}</a></p>`);
      } finally { button.disabled = false; }
      return;
    }
    if (action === 'close-dialog') closeDialog();
    if (action === 'new-task') openDialog('添加一条待办', taskForm());
    if (action === 'task-detail') await showTask(button.dataset.id);
    if (action === 'conversation-rules') showConversation(button.dataset.id);
    if (action === 'complete-task') {
      const task = state.data.tasks.find(value => value.id === button.dataset.id);
      if (!task) return;
      await api(`/api/tasks/${encodeURIComponent(task.id)}`, { revision: task.revision, status: task.status === 'done' ? 'pending' : 'done', needsReview: false }, 'PATCH');
      await refresh(true); toast(task.status === 'done' ? '已恢复为待处理' : '已标记完成');
    }
    if (action === 'toggle-conversation') {
      const conversation = state.data.conversations.find(value => value.id === button.dataset.id);
      await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { monitored: !conversation.monitored }, 'PATCH');
      await refresh(true); toast(conversation.monitored ? '已停止关注，之后的消息不再保存' : '已关注，之后的新消息会保存');
    }
    if (action === 'analyze') { await api(`/api/conversations/${encodeURIComponent(button.dataset.id)}/analyze`, {}); toast('已加入整理队列'); await refresh(true); }
    if (action === 'discover-messages') {
      button.disabled = true;
      try { await api('/api/conversations/discover', {}); await refresh(true); toast('本机已接入账号的会话已更新'); }
      finally { button.disabled = false; }
    }
    if (action === 'refresh-logs') await drawLogs();
    if (action === 'maintenance-run') {
      button.disabled = true;
      const result = await api('/api/maintenance/run', { job: button.dataset.job });
      toast(result.status === 'success' ? '本机处理已完成' : result.error); await drawMaintenance();
    }
    if (action === 'add-group') await showGroupPicker();
    if (action === 'group-platform') await showGroupPicker(button.dataset.platform);
    if (action === 'group-refresh') await showGroupPicker();
    if (action === 'clear-selection') { state.selected.clear(); updateSelection(); }
    if (action === 'confirm-complete') { button.disabled = true; await confirmComplete(); }
    if (['qq-start', 'qq-stop', 'qq-backfill', 'qq-forget', 'test-model', 'toggle-autostart', 'capture-add', 'capture-remove', 'wechat-group-add', 'wechat-group-remove'].includes(action)) await slowAction(button, action);
  } catch (error) { toast(error.message); }
});
async function addCaptureGroup(groupId) {
  const { backfill } = await api('/api/capture/groups', { groupId });
  state.activeGroups = null; loadActiveGroups(true);
  closeDialog();
  toast(!backfill ? '已添加。QQ 登录后会自动拉取这个群的消息' : backfill.error ? `已添加，但拉取失败：${backfill.error}` : `已添加，拉取到 ${backfill.imported} 条消息`);
}
// 这些操作要等 QQ 或 AI 服务响应，期间禁用按钮防止重复点击。
async function slowAction(button, action) {
  button.disabled = true;
  try {
    if (action === 'qq-start') { await api('/api/qq/start', {}); toast('已开启 QQ 采集，几秒后启动；需要扫码时会提示'); }
    if (action === 'qq-stop') { await api('/api/qq/stop', {}); toast('QQ 采集已停止，不会再自动启动'); }
    if (action === 'qq-backfill') { const result = await api('/api/qq/backfill', {}); toast(result.error || `补拉完成，新增 ${result.imported} 条消息`); }
    if (action === 'qq-forget') { await api('/api/qq/account', {}, 'DELETE'); toast('已忘记账号，下次启动 QQ 采集需要扫码'); }
    if (action === 'toggle-autostart') { const { autostart } = await api('/api/autostart', { enabled: !state.data.autostart }, 'PUT'); toast(autostart ? '已开启开机自启' : '已关闭开机自启'); }
    if (action === 'capture-add') await addCaptureGroup(button.dataset.id);
    if (action === 'wechat-group-add') {
      const { backfill } = await api('/api/wechat/groups', { conversationId: button.dataset.id });
      closeDialog();
      toast(backfill.error || `已添加微信群，本次保存 ${backfill.imported} 条消息`);
    }
    if (action === 'wechat-group-remove') {
      const conversation = state.data.conversations.find(value => value.id === button.dataset.id);
      if (!confirm(`不再拉取「${conversation.title}」的新消息？已保存的消息和任务会保留，之后可以恢复。`)) return;
      await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { monitored: false }, 'PATCH');
      toast(`已移除「${conversation.title}」`);
    }
    if (action === 'capture-remove') {
      const name = state.data.conversations.find(value => value.remoteId === button.dataset.id)?.title || `群 ${button.dataset.id}`;
      if (!confirm(`不再拉取「${name}」的新消息？已保存的消息和任务会保留，之后可以恢复。`)) return;
      await api(`/api/capture/groups/${encodeURIComponent(button.dataset.id)}`, {}, 'DELETE'); toast(`已移除「${name}」`);
      state.activeGroups = null;
    }
    if (action === 'test-model') {
      $('#model-test-result').textContent = '正在连接…';
      try { const result = await api('/api/model/test', modelValues()); $('#model-test-result').textContent = `连接成功，模型回复：${result.reply}`; }
      catch (error) { $('#model-test-result').textContent = error.message; }
      return;
    }
    await refresh(true);
  } finally { button.disabled = false; }
}

$('#profile-button').addEventListener('click', showProfile);
document.addEventListener('input', event => {
  if (event.target.id === 'task-search') { state.search = event.target.value; drawMain().catch(error => toast(error.message)); }
  if (event.target.closest('#model-form')) $('#model-form').dataset.dirty = '1';
  if (event.target.closest('#maintenance-form')) $('#maintenance-form').dataset.dirty = '1';
  if (event.target.id === 'message-text') {
    state.drafts[state.messageConversation] = event.target.value;
    $('#message-send-form').dataset.dirty = '1';
  }
  if (event.target.id === 'group-search') {
    const query = event.target.value.trim().toLowerCase();
    const items = [...document.querySelectorAll('#group-picker-results [data-search]')];
    items.forEach(item => { item.hidden = Boolean(query) && !item.dataset.search.includes(query); });
    $('#group-search-empty').hidden = items.some(item => !item.hidden);
  }
});
document.addEventListener('change', async event => {
  const box = event.target;
  try {
    if (box.id === 'message-files') { state.fileDrafts[state.messageConversation] = [...box.files]; $('#selected-files').textContent = [...box.files].map(file => file.name).join('、'); $('#message-send-form').dataset.dirty = '1'; return; }
    if (box.id === 'message-platform') { state.messagePlatform = box.value; await drawMessages(); return; }
    if (box.id === 'log-platform') { state.logPlatform = box.value; await drawLogs(); return; }
    if (box.dataset.select !== undefined) { box.checked ? state.selected.add(box.dataset.select) : state.selected.delete(box.dataset.select); updateSelection(); return; }
    if (box.hasAttribute('data-select-all')) {
      for (const row of document.querySelectorAll('[data-select]')) box.checked ? state.selected.add(row.dataset.select) : state.selected.delete(row.dataset.select);
      updateSelection(); return;
    }
    if (event.target.id === 'model-preset') {
      $('#model-form').dataset.dirty = '1';
      const preset = modelPresets().find(value => value.id === event.target.value);
      if (preset) { $('#model-base').value = preset.baseUrl; $('#model-name').value = preset.name; }
      else { $('#model-base').value = ''; $('#model-name').value = ''; $('#model-base').focus(); }
    }
    if (event.target.id === 'message-conversation') { state.messageConversation = event.target.value; markEnter(); await drawMessages(); }
    if (event.target.id === 'chat-scope') { state.chatScope = event.target.value; await loadChat(); }
  } catch (error) { toast(error.message); }
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'chat-form') { const prompt = $('#chat-input').value.trim(); if (prompt) await sendChat(prompt); return; }
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    if (form.id === 'message-send-form') {
      const text = form.elements.namedItem('text').value.trim(), files = state.fileDrafts[form.dataset.conversation] || [];
      if (files.length > state.data.settings.messaging.maxAttachments) throw new Error(`一次最多发送 ${state.data.settings.messaging.maxAttachments} 个附件`);
      const attachments = form.uploadedAttachments || [];
      if (!form.uploadedAttachments) for (const file of files) {
        if (file.size > state.data.settings.messaging.maxAttachmentBytes) throw new Error(`单个附件不能超过 ${state.data.settings.messaging.maxAttachmentBytes / 1024 / 1024} MB`);
        const response = await fetch('/api/attachments', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
        const result = await response.json(); if (!response.ok) throw new Error(result.error); attachments.push(result.id);
      }
      form.uploadedAttachments = attachments;
      form.dataset.requestId ||= crypto.randomUUID();
      const result = await api('/api/messages/send', { requestId: form.dataset.requestId, conversationId: form.dataset.conversation, text, attachments });
      if (result.status === 'sent') { state.drafts[form.dataset.conversation] = ''; state.fileDrafts[form.dataset.conversation] = []; delete form.dataset.dirty; toast('发送已确认'); await refresh(true); }
      else { form.dataset.uncertain = '1'; toast(result.status === 'failed' ? '发送未提交，请检查客户端后重新选择会话' : result.partial ? '部分内容已发送，请核查其余内容，不要重复发送' : '发送结果未确认，请先检查客户端，不要直接重复发送'); }
      return;
    }
    if (form.id === 'maintenance-form') {
      const values = Object.fromEntries(new FormData(form)); values.enabled = form.elements.namedItem('enabled').checked;
      await api('/api/maintenance', values, 'PUT'); toast('定时安排已保存'); delete form.dataset.dirty; await drawMaintenance(); return;
    }
    if (form.id === 'group-manual-form') { await addCaptureGroup(form.elements.namedItem('groupId').value.trim()); await refresh(true); return; }
    if (form.id === 'model-form') {
      const model = await api('/api/model', modelValues(), 'PUT');
      delete form.dataset.dirty; await refresh(true);
      toast(model.configured ? 'AI 设置已保存并生效' : 'AI 整理已停用');
      return;
    }
    const values = Object.fromEntries(new FormData(form));
    if (form.id === 'task-form') {
      values.needsReview = false;
      if (form.dataset.id) { values.revision = Number(form.dataset.revision); await api(`/api/tasks/${encodeURIComponent(form.dataset.id)}`, values, 'PATCH'); }
      else await api('/api/tasks', values);
    } else if (form.id === 'profile-form') await api('/api/profile', values, 'PUT');
    else if (form.id === 'conversation-form') await api(`/api/conversations/${encodeURIComponent(form.dataset.id)}`, values, 'PATCH');
    else return;
    closeDialog(); await refresh(true); toast('已保存到本机');
  } catch (error) { toast(error.message); }
  finally { if (button) button.disabled = form.dataset.uncertain === '1'; }
});
$('#chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); } });
$('#detail-dialog').addEventListener('click', event => { if (event.target === $('#detail-dialog')) { const rect = $('#detail-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });
$('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
const requestedView = new URLSearchParams(location.search).get('view');
setView(VIEWS.includes(requestedView) ? requestedView : 'tasks');
addEventListener('resize', moveIndicator);
markEnter();
async function boot() {
  try {
    await refresh(true); countUp();
    setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, state.data.settings.ui.refreshIntervalMs);
    if (aiReady()) loadChat().catch(error => toast(error.message));
  } catch (error) {
    $('#main').innerHTML = empty('暂时无法连接本机工作台', error.message);
    setTimeout(boot, 1000);
  }
}
boot();
// 倒计时每分钟走一次；勾选状态保存在 state.selected 中，重绘后保留。
setInterval(() => {
  if (document.hidden || !state.data || state.view !== 'tasks' || document.activeElement?.closest('.todo-table, #select-bar')) return;
  drawMain().catch(() => {});
}, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });
