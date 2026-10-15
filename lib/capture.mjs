import { idString, AppError } from './domain.mjs';
import { writeJsonAtomic } from './json-file.mjs';

export const MAX_GROUPS = 20;

// 采集范围：groups 为要拉取的群号；空列表表示一个群都不拉，而不是全部拉。
export function captureConfig(value) {
  if (!value) return null;
  if (!Array.isArray(value.groups) || value.groups.length > MAX_GROUPS) {
    throw new AppError(`采集范围最多 ${MAX_GROUPS} 个群`);
  }
  return { groups: [...new Set(value.groups.map(id => idString(id, '群号')))] };
}

export function saveCapture(file, config) {
  writeJsonAtomic(file, { groups: config.groups });
}

export function permitsCapture(event, config) {
  if (!config || !['message', 'message_sent'].includes(event.post_type)) return true;
  return event.message_type === 'group' && config.groups.includes(String(event.group_id));
}

export function prepareCapture(store, normalized, config) {
  if (config && normalized && !store.conversation(normalized.conversation.id)) {
    store.discover(normalized.conversation, true);
  }
}
