import test from 'node:test';
import assert from 'node:assert/strict';

const plain = view => view.lines.map(line => line.map(segment => segment.text).join(''));
async function viewport(options) {
  const module = await import('../src/chat-viewport.mjs').catch(() => ({}));
  assert.equal(typeof module.createChatViewport, 'function', 'chat viewport must retain and navigate the conversation');
  return module.createChatViewport(options);
}

test('scrolling to the beginning retains conversation older than the previous 65536 character tail', async () => {
  const chat = await viewport({columns:80, rows:4});
  chat.append('FIRST SAVED MESSAGE\n' + 'long transcript line\n'.repeat(4000));
  chat.top();
  assert.equal(plain(chat.view())[0], 'FIRST SAVED MESSAGE');
  assert.equal(chat.view().trimmed, 0);
});

test('page navigation freezes its text anchor while assistant output streams', async () => {
  const chat = await viewport({columns:20, rows:3});
  chat.append('zero\none\ntwo\nthree\nfour\nfive\n');
  chat.pageUp();
  assert.deepEqual(plain(chat.view()), ['one', 'two', 'three']);
  chat.append('NEW ANSWER\nMORE ANSWER\n');
  assert.deepEqual(plain(chat.view()), ['one', 'two', 'three']);
  assert.equal(chat.view().isScrolled, true);
  assert.ok(chat.view().unseen > 0);
  chat.bottom();
  assert.deepEqual(plain(chat.view()), ['NEW ANSWER', 'MORE ANSWER', '']);
  assert.equal(chat.view().unseen, 0);
});

test('Unicode wraps by grapheme cells and keeps user and assistant segments', async () => {
  const chat = await viewport({columns:4, rows:8});
  chat.append('A界e\u0301', {user:true});
  chat.append('🙂B\n👩‍💻xy');
  assert.deepEqual(plain(chat.view()), ['A界e\u0301', '🙂B', '👩‍💻xy']);
  assert.deepEqual(chat.view().lines[0], [{text:'A界e\u0301', user:true}]);
  assert.deepEqual(chat.view().lines[1], [{text:'🙂B', user:false}]);
});

test('resizing a paused viewport follows the same text instead of a stale wrapped row number', async () => {
  const chat = await viewport({columns:6, rows:2});
  chat.append('abcdefghijklmno\nlast\n');
  chat.top();chat.scroll(1);
  assert.equal(plain(chat.view())[0], 'ghijkl');
  chat.resize({columns:4, rows:2});
  assert.equal(plain(chat.view())[0], 'efgh');
  assert.equal(chat.view().isScrolled, true);
});

test('clear and replace discard old anchors and preserve saved message roles', async () => {
  const chat = await viewport({columns:20, rows:2});
  chat.append('old\n'.repeat(10));chat.top();chat.append('unseen');
  chat.clear();
  assert.deepEqual(plain(chat.view()), ['']);
  assert.equal(chat.view().isScrolled, false);
  assert.equal(chat.view().unseen, 0);
  chat.replace([{text:'saved user\n', user:true}, {text:'saved answer', user:false}]);
  assert.deepEqual(chat.view().lines, [[{text:'saved user', user:true}], [{text:'saved answer', user:false}]]);
});

test('bounded retention exposes truncation and never cuts a surrogate pair at the oldest boundary', async () => {
  const chat = await viewport({columns:8, rows:2, maxCharacters:8});
  chat.append('🙂abcdefghi');chat.top();
  assert.equal(plain(chat.view()).join(''), 'bcdefghi');
  assert.equal(chat.view().trimmed, 3);
  chat.clear();chat.append('🙂1234567');chat.top();
  assert.equal(plain(chat.view()).join(''), '1234567');
  assert.equal(chat.view().trimmed, 2);
});

test('terminal controls in retained text cannot clear the viewport on replay', async () => {
  const chat = await viewport({columns:20, rows:4});
  chat.append('\x1b[2Jone\r\n\x1b[31mtwo\x1b[0m\x07\n');
  assert.deepEqual(plain(chat.view()), ['one', 'two', '']);
});

test('tabs after Unicode and a role boundary expand to the same terminal column', async () => {
  const chat = await viewport({columns:10, rows:4});
  chat.append('🙂a', {user:true});chat.append('\tb');
  assert.deepEqual(chat.view().lines, [[{text:'🙂a',user:true},{text:'     b',user:false}]]);
});

test('default text pictographs fit one cell while their emoji presentation fits two', async () => {
  const chat = await viewport({columns:4, rows:8});
  chat.append('©©©©\n™™™™\n❤❤❤❤\n❤️❤️');
  assert.deepEqual(plain(chat.view()), ['©©©©', '™™™™', '❤❤❤❤', '❤️❤️']);
});
