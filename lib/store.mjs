import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AppError, text, dateString, timeString } from './domain.mjs';

const read = row => row ? JSON.parse(row.payload) : null;
const stamp = () => new Date().toISOString();
const toConversation = row => ({ id: row.id, platform: row.platform || 'qq', title: row.title, kind: row.kind, selfId: row.self_id, remoteId: row.remote_id,
  monitored: Boolean(row.monitored), rules: row.rules, lastSeen: row.last_seen, cursor: row.cursor,
  analysisState: row.analysis_state, analysisError: row.analysis_error, summary: row.summary });

export class Store {
  constructor(file = ':memory:', { recover = true } = {}) {
    this.db = new DatabaseSync(file);
    try {
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, self_id TEXT NOT NULL, remote_id TEXT NOT NULL,
        monitored INTEGER NOT NULL DEFAULT 0, rules TEXT NOT NULL DEFAULT '',
        last_seen TEXT, cursor INTEGER NOT NULL DEFAULT 0, analysis_state TEXT NOT NULL DEFAULT 'idle',
        analysis_error TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_turns (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'platform')) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN platform TEXT NOT NULL DEFAULT 'qq'");
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, platform TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, payload TEXT NOT NULL);`);
    if (recover) this.recoverInterrupted();
    // 清理旧版本的示例数据；示例消息与任务随会话级联删除。
    this.db.exec("DELETE FROM chat_turns WHERE scope LIKE 'demo:%'; DELETE FROM conversations WHERE id LIKE 'demo:%';");
    this.migrateGroupIds();
    } catch (error) { this.db.close(); throw error; }
  }

  recoverInterrupted() {
    this.transaction(() => {
      this.db.exec("UPDATE outbox SET payload=json_set(payload,'$.status','uncertain','$.error','上次运行中断，请先核查客户端发送记录') WHERE json_extract(payload,'$.status')='sending'");
      this.db.prepare("UPDATE conversations SET analysis_state='queued' WHERE analysis_state='analyzing'").run();
    });
  }

  // 旧版本的群会话编号含登录账号（qq:<账号>:group:<群号>），合并到只按群号识别的 qq:group:<群号>。
  migrateGroupIds() {
    for (const { id } of this.db.prepare("SELECT id FROM conversations WHERE id GLOB 'qq:[0-9]*:group:*'").all()) {
      const target = `qq:group:${id.split(':group:')[1]}`;
      this.transaction(() => {
        this.db.prepare(`INSERT OR IGNORE INTO conversations(id,title,kind,self_id,remote_id,monitored,rules,last_seen,cursor,analysis_state,analysis_error,summary)
          SELECT ?,title,kind,self_id,remote_id,monitored,rules,last_seen,cursor,analysis_state,analysis_error,summary FROM conversations WHERE id=?`).run(target, id);
        this.db.prepare("UPDATE messages SET conversation_id=?, payload=json_set(payload,'$.conversationId',?) WHERE conversation_id=?").run(target, target, id);
        this.db.prepare("UPDATE tasks SET conversation_id=?, payload=json_set(payload,'$.conversationId',?) WHERE conversation_id=?").run(target, target, id);
        this.db.prepare('UPDATE chat_turns SET scope=? WHERE scope=?').run(target, id);
        this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      });
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  meta(key, fallback = null) { return read(this.db.prepare('SELECT payload FROM meta WHERE key=?').get(key)) ?? fallback; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key, JSON.stringify(value)); }
  profile() { return this.meta('profile', { name: '', context: '', timezone: 'Asia/Shanghai' }); }
  saveProfile(value) { const profile = { name: text(value.name, 100), context: text(value.context, 5000), timezone: 'Asia/Shanghai' }; this.setMeta('profile', profile); return profile; }

  bridge() { return this.meta('bridge', { messages: 0, historyMessages: 0, lastReport: null, lastMessage: null, selfId: null }); }
  // 记录消息桥上报情况；历史采集不算作实时上报。source 记录最近一条实时消息来自哪个群、是否已接入（只记群号和群名，不记正文）。
  recordEvent({ history, saved, selfId, source = null }) {
    const bridge = this.bridge(), now = stamp();
    this.setMeta('bridge', { messages: (bridge.messages || 0) + Number(saved), historyMessages: (bridge.historyMessages || 0) + Number(history && saved),
      lastReport: history ? bridge.lastReport : now, lastMessage: saved && !history ? now : bridge.lastMessage, selfId: selfId || bridge.selfId,
      lastSource: source && !history ? { ...source, at: now } : bridge.lastSource || null });
  }

  conversation(id) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    return row ? toConversation(row) : null;
  }
  conversations() {
    return this.db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count
      FROM conversations c ORDER BY c.last_seen DESC, c.title`).all().map(row => ({ ...toConversation(row), messageCount: row.message_count }));
  }
  discover(value, monitored = false) {
    this.db.prepare('INSERT OR IGNORE INTO conversations(id,title,kind,self_id,remote_id,monitored,platform) VALUES(?,?,?,?,?,?,?)')
      .run(value.id, value.title, value.kind, value.selfId, value.remoteId, Number(monitored), value.platform || 'qq');
    return this.conversation(value.id);
  }
  accounts() { return this.db.prepare('SELECT payload FROM accounts ORDER BY platform,id').all().map(read); }
  putAccount(platform, value) {
    const id = `${platform}:${encodeURIComponent(value.selfId)}`;
    const account = { id, platform, selfId: String(value.selfId), name: text(value.name, 100) || String(value.selfId),
      online: value.online === true, phase: text(value.phase, 50), lastSeen: stamp() };
    if (account.online) this.db.prepare("UPDATE accounts SET payload=json_set(payload,'$.online',json('false'),'$.phase','offline') WHERE platform=? AND id<>? AND json_extract(payload,'$.online')=1").run(platform, id);
    this.db.prepare('INSERT INTO accounts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id, platform, JSON.stringify(account));
    return account;
  }
  offlineAccounts(platform) { this.db.prepare("UPDATE accounts SET payload=json_set(payload,'$.online',json('false'),'$.phase','offline') WHERE platform=?").run(platform); }
  outbox(id) { return read(this.db.prepare('SELECT payload FROM outbox WHERE id=?').get(id)); }
  putOutbox(value) { this.db.prepare('INSERT INTO outbox VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(value.id, value.conversationId, JSON.stringify(value)); return value; }
  sentItems(id) { return this.db.prepare('SELECT payload FROM outbox WHERE conversation_id=? ORDER BY rowid DESC LIMIT 30').all(id).map(read); }
  updateConversation(id, value) {
    const current = this.conversation(id);
    if (!current) throw new AppError('会话不存在', 404);
    const title = value.title === undefined ? current.title : text(value.title, 100);
    if (!title) throw new AppError('会话名称不能为空');
    this.db.prepare('UPDATE conversations SET title=?, rules=?, monitored=? WHERE id=?').run(title,
      value.rules === undefined ? current.rules : text(value.rules, 5000),
      value.monitored === undefined ? Number(current.monitored) : Number(Boolean(value.monitored)), id);
    return this.conversation(id);
  }
  ingest(normalized) {
    const { conversation, message } = normalized;
    return this.transaction(() => {
      const current = this.discover(conversation);
      this.db.prepare('UPDATE conversations SET last_seen=? WHERE id=?').run(message.receivedAt, conversation.id);
      // 未关注会话仅登记元信息，不保存消息正文，也不送给模型。
      if (!current.monitored) return { saved: false, ignored: true, duplicate: false, conversationId: conversation.id };
      // 早期保存的消息没有群内序号，按「发送者 + 发送时间 + 内容」认出同一条，避免换账号补拉后重复。
      if (message.groupSeq && this.db.prepare(`SELECT 1 FROM messages WHERE conversation_id=? AND json_extract(payload,'$.groupSeq') IS NULL
        AND json_extract(payload,'$.senderId')=? AND json_extract(payload,'$.sentAt')=? AND json_extract(payload,'$.content')=? LIMIT 1`)
        .get(conversation.id, message.senderId, message.sentAt, message.content)) return { saved: false, ignored: false, duplicate: true, conversationId: conversation.id };
      const result = this.db.prepare('INSERT OR IGNORE INTO messages(id,conversation_id,payload) VALUES(?,?,?)').run(message.id, conversation.id, JSON.stringify(message));
      return { saved: result.changes > 0, ignored: false, duplicate: result.changes === 0, conversationId: conversation.id };
    });
  }
  // 按发送时间排序：补拉回来的旧消息虽然后写入，也排在正确位置。
  messageCount(id) { return this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?').get(id).count; }
  messages(id, limit = 80) {
    return this.db.prepare("SELECT seq,payload FROM messages WHERE conversation_id=? ORDER BY json_extract(payload,'$.sentAt') DESC, seq DESC LIMIT ?").all(id, limit).reverse().map(row => ({ ...read(row), seq: row.seq }));
  }
  sources(ids) {
    return ids.map(id => read(this.db.prepare('SELECT payload FROM messages WHERE id=?').get(id))).filter(Boolean);
  }
  batch(id) {
    const conversation = this.conversation(id);
    if (!conversation) throw new AppError('会话不存在', 404);
    const pending = this.db.prepare('SELECT seq,payload FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 25').all(id, conversation.cursor).map(row => ({ ...read(row), seq: row.seq }));
    const history = this.db.prepare('SELECT seq,payload FROM messages WHERE conversation_id=? AND seq<=? ORDER BY seq DESC LIMIT 20').all(id, conversation.cursor).reverse().map(row => ({ ...read(row), seq: row.seq }));
    return { conversation, pending, messages: [...history, ...pending], tasks: this.tasks().filter(task => task.conversationId === id), profile: this.profile() };
  }
  // 已关注会话中还没交给 AI 整理的消息数。
  pendingCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.monitored=1 AND m.seq>c.cursor').get().n;
  }
  // 任务最新一条来源消息的发送时间，用于在列表中显示「x月x日发」。
  sourceTime(ids = []) {
    if (!ids.length) return null;
    return this.db.prepare(`SELECT MAX(json_extract(payload,'$.sentAt')) AS at FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).at;
  }
  // AI 每整理一批记一条，供页面展示「最新整理结果」；只保留最近 50 条。
  recordRun(run) {
    this.db.prepare('INSERT INTO analysis_runs(payload) VALUES(?)').run(JSON.stringify({ at: stamp(), ...run }));
    this.db.prepare('DELETE FROM analysis_runs WHERE seq <= (SELECT MAX(seq) - 50 FROM analysis_runs)').run();
  }
  runs(limit = 5) { return this.db.prepare('SELECT payload FROM analysis_runs ORDER BY seq DESC LIMIT ?').all(limit).map(read); }
  analysisState(id, state, error = '') { this.db.prepare('UPDATE conversations SET analysis_state=?,analysis_error=? WHERE id=?').run(state, text(error, 500), id); }
  tasks() { return this.db.prepare('SELECT payload FROM tasks').all().map(read).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || b.updatedAt.localeCompare(a.updatedAt)); }
  task(id) { return read(this.db.prepare('SELECT payload FROM tasks WHERE id=?').get(id)); }
  putTask(task) { this.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(task.id, task.conversationId, JSON.stringify(task)); return task; }

  commitAnalysis(batch, candidates, summary) {
    return this.transaction(() => {
      const now = stamp();
      const currentConversation = this.conversation(batch.conversation.id);
      if (!currentConversation?.monitored) return [];
      const updates = candidates.map(candidate => {
        const current = candidate.id ? this.task(candidate.id) : null;
        const previous = candidate.id ? batch.tasks.find(task => task.id === candidate.id) : null;
        if (current && current.revision !== previous?.revision) throw new AppError('任务在分析期间被修改，请重新整理新消息', 409);
        const task = { ...candidate, id: current?.id || randomUUID(), conversationId: batch.conversation.id,
          status: current?.status || 'pending', origin: 'ai',
          sourceIds: [...new Set([...(current?.sourceIds || []), ...candidate.sourceIds])],
          needsReview: true, createdAt: current?.createdAt || now, updatedAt: now, revision: (current?.revision || 0) + 1,
          history: [...(current?.history || []), ...(current ? [{ at: now, reason: '后续消息更新', title: current.title,
            dueDate: current.dueDate, dueTime: current.dueTime, dueText: current.dueText, sourceIds: candidate.sourceIds }] : [])].slice(-30) };
        return this.putTask(task);
      });
      this.db.prepare("UPDATE conversations SET cursor=?, summary=?, analysis_state='ready', analysis_error='' WHERE id=?")
        .run(batch.pending.at(-1).seq, text(summary, 1500), batch.conversation.id);
      return updates;
    });
  }

  manualTask(value, id = null) {
    const current = id ? this.task(id) : null;
    if (id && !current) throw new AppError('任务不存在', 404);
    if (current && value.revision !== current.revision) throw new AppError('任务已更新，请重新打开后保存', 409);
    const title = value.title === undefined ? current?.title : text(value.title, 180);
    if (!title) throw new AppError('请输入任务标题');
    const dueDate = value.dueDate === undefined ? current?.dueDate || null : dateString(value.dueDate);
    const dueTime = value.dueTime === undefined ? current?.dueTime || null : timeString(value.dueTime);
    if (dueTime && !dueDate) throw new AppError('请同时填写截止日期');
    const status = value.status || current?.status || 'pending';
    if (!['pending', 'done', 'cancelled'].includes(status)) throw new AppError('任务状态不正确');
    const relevance = value.relevance || current?.relevance || 'mine';
    if (!['mine', 'everyone', 'other', 'unclear'].includes(relevance)) throw new AppError('任务关系不正确');
    // 用户改动了截止时间，依据就变成「你填写的」；没改动则保留 AI 给出的依据。
    const dueChanged = !current || dueDate !== (current.dueDate || null) || dueTime !== (current.dueTime || null);
    const dueBasis = !dueDate ? 'none' : dueChanged ? 'manual' : current.dueBasis || (current.origin === 'manual' ? 'manual' : 'inferred');
    const now = stamp();
    const task = { ...(current || {}), id: current?.id || randomUUID(), conversationId: current?.conversationId || null,
      title, dueDate, dueTime, dueBasis, status, relevance, kind: current?.kind || '手动待办',
      description: value.description === undefined ? current?.description || '' : text(value.description, 2000),
      dueText: value.dueText === undefined ? current?.dueText || '' : text(value.dueText, 200),
      responsible: current?.responsible || '', sourceIds: current?.sourceIds || [], questions: current?.questions || [],
      needsReview: value.needsReview === undefined ? current?.needsReview || false : Boolean(value.needsReview),
      suggestedStatus: value.needsReview === false ? null : current?.suggestedStatus || null,
      origin: current?.origin || 'manual',
      revision: (current?.revision || 0) + 1, createdAt: current?.createdAt || now, updatedAt: now,
      history: [...(current?.history || []), ...(current ? [{ at: now, reason: '用户修改或确认', title: current.title,
        dueDate: current.dueDate, dueTime: current.dueTime, dueText: current.dueText, sourceIds: [] }] : [])].slice(-30) };
    return this.putTask(task);
  }
  chat(scope) { return this.db.prepare('SELECT role,content,at FROM chat_turns WHERE scope=? ORDER BY seq DESC LIMIT 16').all(scope).reverse(); }
  appendChat(scope, prompt, reply) {
    this.transaction(() => { for (const [role, content] of [['user', prompt], ['assistant', reply]]) this.db.prepare('INSERT INTO chat_turns(scope,role,content,at) VALUES(?,?,?,?)').run(scope, role, content, stamp()); });
  }
}
