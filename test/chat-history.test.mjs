import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatHistory } from '../src/chat-history.mjs';

test('full conversation preserves message order, Unicode, code blocks and trailing whitespace', () => {
  const history = createChatHistory();
  const user = 'Please edit this:\n```js\nconst greeting = "Γεια 🌍";\n```\n\n';
  const assistant = 'Done.\n```js\nconst greeting = "Hello 🌍";\n```  \n';
  history.addUser(user, { model: 'first-model' });
  history.appendAssistant('thread-one:reply', assistant.slice(0, 20), { model: 'first-model' });
  history.appendAssistant('thread-one:reply', assistant.slice(20));
  history.finishAssistant('thread-one:reply', assistant);
  history.addUser('Continue with another model.', { model: 'second-model' });
  history.finishAssistant('thread-two:reply', 'Second model response.', { model: 'second-model' });
  const messages = history.snapshot().messages;
  assert.deepEqual(messages.map(message => [message.role, message.model, message.content]), [
    ['user', 'first-model', user], ['assistant', 'first-model', assistant],
    ['user', 'second-model', 'Continue with another model.'], ['assistant', 'second-model', 'Second model response.'],
  ]);
});

test('completion replaces streamed text and repeated completion cannot duplicate an assistant message', () => {
  const history = createChatHistory();
  history.addUser('Explain');
  history.beginAssistant('reply', { model: 'example-model' });
  history.beginAssistant('reply');
  history.appendAssistant('reply', 'partial');
  history.finishAssistant('reply', 'complete final response');
  history.finishAssistant('reply', 'complete final response');
  assert.equal(history.snapshot().messages.length, 2);
  assert.equal(history.snapshot().messages[1].content, 'complete final response');
});

test('secret redaction includes credentials from prior model connections and split deltas', () => {
  let keys = ['first-api-key'];
  const history = createChatHistory({ secrets: () => keys });
  history.addUser('Do not publish first-api-key');
  history.appendAssistant('reply', 'Use first-api-');
  history.appendAssistant('reply', 'key carefully.');
  keys = ['second-api-key'];
  history.addUser('Now connected using second-api-key', { model: 'second-model' });
  const serialized = JSON.stringify(history.snapshot());
  assert.doesNotMatch(serialized, /first-api-key|second-api-key/);
  assert.match(serialized, /Do not publish \[redacted\]/);
  assert.match(serialized, /Use \[redacted\] carefully/);
  assert.doesNotMatch(history.toPrompt(), /first-api-key|second-api-key/);
});

test('attachment exports retain metadata without embedding image bytes or provider payloads', () => {
  const history = createChatHistory();
  history.addUser('Describe these attachments.', { attachments: [
    { name: 'image.png', path: '/project/image.png', mimeType: 'image/png', sizeBytes: 42, width: 10, height: 20, data: 'private-base64-image', buffer: Buffer.from('image pixels') },
    { name: 'video.mp4', path: '/project/video.mp4', type: 'video', frameCount: 3, base64: 'private-video-bytes' },
  ] });
  const attachments = history.snapshot().messages[0].attachments;
  assert.deepEqual(attachments, [
    { name: 'image.png', path: '/project/image.png', mimeType: 'image/png', sizeBytes: 42, width: 10, height: 20 },
    { name: 'video.mp4', path: '/project/video.mp4', type: 'video', frameCount: 3 },
  ]);
  assert.doesNotMatch(history.toPrompt(), /private-base64|private-video|image pixels/);
});

test('handoff explicitly saves complete Markdown and canonical JSON without shortening messages', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codexcli-handoff-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = createChatHistory({ secrets: () => ['fixture-secret'] });
  const text = 'Long user detail\n'.repeat(2000) + '\n```code\ninside fence\n```\n';
  history.addUser(text, { model: 'model-one' });
  history.finishAssistant('answer', 'Complete answer with fixture-secret masked.', { model: 'model-one' });
  assert.equal((await readdir(directory)).length, 0, 'Messages must remain in memory until export is invoked');
  const files = await history.exportHandoff({ directory, title: 'Fixture complete chat' });
  const json = JSON.parse(await readFile(files.jsonPath, 'utf8'));
  const markdown = await readFile(files.markdownPath, 'utf8');
  assert.equal(files.messageCount, 2);
  assert.equal(json.messages[0].content, text);
  assert.equal(json.messages[1].content, 'Complete answer with [redacted] masked.');
  assert.ok(markdown.includes(text));
  assert.ok(markdown.includes('Complete answer with [redacted] masked.'));
  assert.doesNotMatch(markdown, /fixture-secret/);
  const second = await history.exportHandoff({ directory });
  assert.notEqual(second.jsonPath, files.jsonPath);
  assert.equal(JSON.parse(await readFile(files.jsonPath, 'utf8')).messages[0].content, text);
});

test('prompt contains the complete conversation and explicit memory clear resets only history', () => {
  const history = createChatHistory();
  history.addUser('Original question');
  history.finishAssistant('reply', 'Original complete reply', { model: 'model-a' });
  history.addUser('Next complete question');
  const prompt = history.toPrompt();
  assert.ok(prompt.includes('Original question'));
  assert.ok(prompt.includes('Original complete reply'));
  assert.ok(prompt.includes('Next complete question'));
  history.clear();
  assert.deepEqual(history.snapshot().messages, []);
});

test('complete Markdown handoffs preserve large messages with many inline code markers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codexcli-handoff-many-fences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = createChatHistory();
  const text = '`inline` '.repeat(100000) + '\n````long code fence````\n';
  history.addUser(text);
  const files = await history.exportHandoff({ directory });
  assert.equal(JSON.parse(await readFile(files.jsonPath, 'utf8')).messages[0].content, text);
  const markdown = await readFile(files.markdownPath, 'utf8');
  assert.ok(markdown.includes('`````text\n' + text));
});
