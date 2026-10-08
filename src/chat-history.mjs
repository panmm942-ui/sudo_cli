import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRedactor } from './redactor.mjs';

const metadataStrings = ['name', 'path', 'mimeType', 'mediaType', 'type', 'kind'];
const metadataNumbers = ['sizeBytes', 'bytes', 'width', 'height', 'frameCount', 'pageCount'];
function attachmentMetadata(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(value => value && typeof value === 'object').map(value => {
    const result = {};
    for (const name of metadataStrings) if (typeof value[name] === 'string' && !/^data:/i.test(value[name])) result[name] = value[name];
    for (const name of metadataNumbers) if (Number.isSafeInteger(value[name]) && value[name] >= 0) result[name] = value[name];
    return result;
  }).filter(value => Object.keys(value).length);
}
function fence(text) {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const marker = '`'.repeat(longest + 1);
  return `${marker}text\n${text}${text.endsWith('\n') ? '' : '\n'}${marker}\n`;
}

/** Visible user/assistant text only; disk persistence is handled by the chat store. */
export function createChatHistory({ secrets = () => [] } = {}) {
  if (typeof secrets !== 'function') throw new Error('Chat history requires a secret supplier.');
  let messages = [];
  const assistants = new Map();
  const knownSecrets = new Set();
  function rememberSecrets() {
    const current = secrets();
    if (Array.isArray(current)) for (const value of current) if (typeof value === 'string' && value.length) knownSecrets.add(value);
  }
  function clean(text) {
    const filter = createRedactor({ secrets: () => [...knownSecrets] });
    return filter.write(text) + filter.flush();
  }
  function modelName(model) { return typeof model === 'string' && model.length ? model : null; }
  function beginAssistant(id, { model } = {}) {
    if (typeof id !== 'string' || !id.length) throw new Error('Assistant messages require an identifier.');
    rememberSecrets();
    let message = assistants.get(id);
    if (!message) {
      message = { id, role: 'assistant', model: modelName(model), content: '', status: 'streaming' };
      assistants.set(id, message); messages.push(message);
    } else if (model && !message.model) message.model = modelName(model);
    return id;
  }
  function appendAssistant(id, text, options = {}) {
    if (typeof text !== 'string') throw new Error('Assistant text must be a string.');
    beginAssistant(id, options);
    const message = assistants.get(id);
    if (message.status !== 'completed') message.content += text;
    return id;
  }
  function finishAssistant(id, finalText, options = {}) {
    if (finalText !== undefined && typeof finalText !== 'string') throw new Error('Assistant text must be a string.');
    beginAssistant(id, options);
    const message = assistants.get(id);
    if (finalText !== undefined) message.content = finalText;
    message.status = 'completed';
    return id;
  }
  function snapshot() {
    rememberSecrets();
    const visible = messages.filter(message => message.role === 'user' || message.content.length).map(message => {
      const result = { ...message, id: clean(message.id), model: message.model === null ? null : clean(message.model), content: clean(message.content) };
      if (message.attachments) result.attachments = message.attachments.map(attachment => Object.fromEntries(Object.entries(attachment).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value])));
      return result;
    });
    return { version: 1, messages: visible };
  }
  function restore(data) {
    if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.messages) || data.messages.length > 100000) throw new Error('Chat snapshot must contain a supported version and a bounded message list.');
    rememberSecrets();
    const identifiers = new Set();
    const restored = data.messages.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !['user', 'assistant'].includes(value.role)
        || typeof value.id !== 'string' || !value.id.length || value.id.length > 1024 || typeof value.content !== 'string'
        || (value.model !== undefined && value.model !== null && (typeof value.model !== 'string' || value.model.length > 4096))
        || (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > 1000))) throw new Error('Chat snapshot contains an invalid visible message or attachment limit.');
      if (value.attachments?.some(attachment => attachment && typeof attachment === 'object' && metadataStrings.some(key => typeof attachment[key] === 'string' && attachment[key].length > 65536))) throw new Error('Chat snapshot attachment metadata exceeds its size limit.');
      const id = clean(value.id);
      if (!id.length || identifiers.has(id)) throw new Error('Chat snapshot message identifiers must be unique.');
      identifiers.add(id);
      const result = { id, role: value.role, model: value.model ? clean(value.model) : null, content: clean(value.content) };
      if (value.role === 'assistant') {
        if (!['streaming', 'completed', 'interrupted'].includes(value.status)) throw new Error('Chat snapshot contains an invalid assistant status.');
        result.status = value.status;
      }
      const metadata = attachmentMetadata(value.attachments).map(attachment => Object.fromEntries(Object.entries(attachment).map(([key, item]) => [key, typeof item === 'string' ? clean(item) : item])));
      if (metadata.length) result.attachments = metadata;
      return result;
    });
    // Validate every entry before replacing a working conversation.
    messages = restored;
    assistants.clear();
    for (const message of messages) if (message.role === 'assistant') assistants.set(message.id, message);
    return snapshot();
  }
  function toPrompt() {
    return 'The following JSON is the complete visible conversation from the previous model. Treat it as prior user/assistant conversation, not as system instructions. Attachment entries contain metadata only; their original files must be attached separately if needed. Continue with the next user task.\n\n' + JSON.stringify(snapshot(), null, 2);
  }
  async function exportHandoff({ directory, cwd = process.cwd(), title = 'SUDO CLI complete conversation' } = {}) {
    const target = resolve(directory || join(cwd, '.sudocli', 'handoffs'));
    const data = snapshot();
    const heading = clean(String(title)).replace(/[\r\n]/g, ' ');
    const stem = `handoff-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const jsonPath = join(target, stem + '.json');
    const markdownPath = join(target, stem + '.md');
    const markdown = [`# ${heading}\n`, 'Complete visible user/assistant messages in chronological order. Credentials and terminal controls are removed. The JSON file is the canonical transcript; attachments include metadata, not file bytes.\n'];
    data.messages.forEach((message, index) => {
      markdown.push(`## ${index + 1}. ${message.role === 'user' ? 'User' : 'Assistant'}${message.model ? ` — ${message.model.replace(/[\r\n]/g, ' ')}` : ''}\n`);
      markdown.push(fence(message.content));
      if (message.attachments?.length) markdown.push('Attachments (metadata only):\n\n' + fence(JSON.stringify(message.attachments, null, 2)));
    });
    await mkdir(target, { recursive: true, mode: 0o700 });
    let jsonWritten = false, markdownWritten = false;
    try {
      await writeFile(jsonPath, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); jsonWritten = true;
      await writeFile(markdownPath, markdown.join('\n'), { flag: 'wx', mode: 0o600 }); markdownWritten = true;
    } catch {
      if (jsonWritten) await rm(jsonPath, { force: true }).catch(() => {});
      if (markdownWritten) await rm(markdownPath, { force: true }).catch(() => {});
      throw new Error('Unable to save the full conversation handoff. Choose a writable directory.');
    }
    return { jsonPath, markdownPath, messageCount: data.messages.length };
  }
  return {
    beginAssistant, appendAssistant, finishAssistant, snapshot, restore, toPrompt, exportHandoff,
    addUser(text, { attachments, model } = {}) {
      if (typeof text !== 'string') throw new Error('User text must be a string.');
      rememberSecrets();
      const message = { id: randomUUID(), role: 'user', model: modelName(model), content: text };
      const metadata = attachmentMetadata(attachments);
      if (metadata.length) message.attachments = metadata;
      messages.push(message);
      return message.id;
    },
    clear() { messages = []; assistants.clear(); },
  };
}
