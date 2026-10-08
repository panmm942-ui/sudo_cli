import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readdir, access, rm, chmod, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join, delimiter } from 'node:path';
import * as runtime from '../src/runtime.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {isolatedEnvironment} from '../src/permission-scope.mjs';

function feature(name) {
  assert.equal(typeof runtime[name], 'function', `${name} must be implemented`);
  return runtime[name];
}
test('sudo session ownership admission never changes an arbitrary or replaced HOME directory',{skip:process.platform!=='linux'||process.getuid?.()!==0},async t=>{
  const base=await mkdtemp(join(tmpdir(),'sudo-disposable-home-test-'));t.after(()=>rm(base,{recursive:true,force:true}));const outside=join(base,'arbitrary-home');await mkdir(outside,{mode:0o700});const before=await lstat(outside),identity={uid:65534,gid:65534};
  await assert.rejects(()=>runtime.grantSessionHomeOwner(outside,identity),/CLI-created disposable/);assert.equal((await lstat(outside)).uid,before.uid);
  const home=await runtime.createSessionHome();t.after(()=>home.cleanup());await writeFile(join(home.path,'unadmitted-file'),'private');await assert.rejects(()=>runtime.grantSessionHomeOwner(home.path,identity),/changed before ownership/);assert.equal((await lstat(home.path)).uid,0);
  await rm(join(home.path,'unadmitted-file'));await runtime.grantSessionHomeOwner(home.path,identity);assert.equal((await lstat(home.path)).uid,identity.uid);assert.equal((await lstat(home.path)).mode&0o777,0o700);await home.cleanup();await assert.rejects(lstat(home.path),{code:'ENOENT'});
  const replaced=await runtime.createSessionHome();t.after(()=>replaced.cleanup());await rm(replaced.path,{recursive:true});await symlink(outside,replaced.path);await assert.rejects(()=>runtime.grantSessionHomeOwner(replaced.path,identity),/changed before ownership/);assert.equal((await lstat(outside)).uid,before.uid);
});
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'sudo-runtime-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function executable(path) {
  await writeFile(path, 'test executable');
  await chmod(path, 0o700);
  return path;
}

test('resolves a literal executable override containing spaces', async t => {
  const base = await temporary(t);
  const path = await executable(join(base, 'codex engine.exe'));
  assert.equal(feature('resolveCodex')({ env: { SUDO_CLI_CODEX: path, PATH: '' } }), path);
});

test('rejects an invalid override rather than silently falling back to PATH', async t => {
  const base = await temporary(t);
  await executable(join(base, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  assert.throws(() => feature('resolveCodex')({ env: { SUDO_CLI_CODEX: join(base, 'missing.exe'), PATH: base } }), /override|SUDO_CLI_CODEX/i);
});

test('finds executable on PATH and ignores empty PATH entries', async t => {
  const base = await temporary(t);
  const path = await executable(join(base, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  assert.equal(feature('resolveCodex')({ env: { PATH: `${delimiter}${base}${delimiter}` } }), path);
});

test('does not accept a directory or shell command as an executable override', async t => {
  const resolveCodex = feature('resolveCodex');
  const base = await temporary(t);
  for (const value of [base, 'codex --version', 'codex; echo secret']) {
    assert.throws(() => resolveCodex({ env: { SUDO_CLI_CODEX: value, PATH: '' } }));
  }
});

test('uses desktop bundled executable only when PATH has no executable', { skip: process.platform !== 'win32' }, async t => {
  const base = await temporary(t);
  const bin = join(base, 'OpenAI', 'Codex', 'bin', 'test-version');
  await mkdir(bin, { recursive: true });
  const path = await executable(join(bin, 'codex.exe'));
  assert.equal(feature('resolveCodex')({ env: { PATH: '', LOCALAPPDATA: base } }), path);
});

test('Windows executable discovery rejects batch and PowerShell overrides', { skip: process.platform !== 'win32' }, async t => {
  const resolveCodex = feature('resolveCodex');
  const base = await temporary(t);
  for (const name of ['codex.cmd', 'codex.bat', 'codex.ps1']) {
    const path = await executable(join(base, name));
    assert.throws(() => resolveCodex({ env: { SUDO_CLI_CODEX: path, PATH: '' } }));
  }
});

test('normalizes connection URL while preserving the literal model and runtime credentials', () => {
  const actual = feature('validateConnection')({ transport: 'responses', model: 'model "max" and \'quotes\'', baseUrl: 'https://EXAMPLE.com/v1/', apiKeyEnv: 'MY_MODEL_KEY', apiKey: 'private-session-value', contextWindow: 1000000 });
  assert.deepEqual(actual, { transport: 'responses', model: 'model "max" and \'quotes\'', baseUrl: 'https://example.com/v1/', apiKeyEnv: 'MY_MODEL_KEY', apiKey: 'private-session-value', contextWindow: 1000000 });
});

test('accepts user selected HTTP endpoints including private cloud and localhost', () => {
  for (const baseUrl of ['http://localhost:8000/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1', 'http://private.example.com/v1']) {
    assert.equal(feature('validateConnection')({ transport: 'chat-completions', model: 'kimi-k3', baseUrl }).baseUrl, baseUrl);
  }
});

test('rejects unsafe URLs without echoing credentials into errors', () => {
  const validateConnection = feature('validateConnection');
  for (const baseUrl of ['ftp://example.com/v1', 'https://user:secret-credential@example.com/v1', 'https://example.com/v1?key=secret-credential', 'https://example.com/v1#secret-credential', 'bad-url']) {
    assert.throws(() => validateConnection({ transport: 'responses', model: 'm', baseUrl, apiKey: 'secret-credential' }), error => {
      assert.ok(!error.message.includes('secret-credential'));
      return true;
    });
  }
});

test('rejects invalid transport, blank model, environment name and context window', () => {
  const validateConnection = feature('validateConnection');
  const valid = { transport: 'responses', model: 'm', baseUrl: 'https://example.com/v1' };
  for (const patch of [{ transport: 'codex' }, { model: '  ' }, { model: 'm\ncommand' }, { apiKeyEnv: 'INVALID=KEY' }, { contextWindow: NaN }, { contextWindow: Infinity }, { contextWindow: 1.5 }, { contextWindow: 0 }, { contextWindow: '1000' }]) {
    assert.throws(() => validateConnection({ ...valid, ...patch }));
  }
});

test('provider arguments quote model strings and omit secret values', () => {
  const args = feature('providerArgs')({ transport: 'responses', model: 'm "quoted" \\ windows \'single\'', baseUrl: 'https://example.com/v1', apiKey: 'secret-credential', apiKeyEnv: 'SOURCE_KEY', contextWindow: 1000000 });
  assert.equal(args.length % 2, 0);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], '-c');
    const boundary = args[i + 1].indexOf('=');
    options.set(args[i + 1].slice(0, boundary), args[i + 1].slice(boundary + 1));
  }
  assert.equal(JSON.parse(options.get('model')), 'm "quoted" \\ windows \'single\'');
  assert.equal(JSON.parse(options.get('model_provider')), 'sudo_session');
  assert.equal(JSON.parse(options.get('model_providers.sudo_session.wire_api')), 'responses');
  assert.equal(JSON.parse(options.get('model_providers.sudo_session.env_key')), 'SUDO_CLI_SESSION_KEY');
  assert.equal(options.get('model_providers.sudo_session.requires_openai_auth'), 'false');
  assert.equal(options.get('model_providers.sudo_session.supports_websockets'), 'false');
  assert.equal(JSON.parse(options.get('web_search')), 'disabled');
  assert.equal(options.get('model_supports_reasoning_summaries'), 'false');
  assert.equal(options.get('model_context_window'), '1000000');
  assert.ok(!args.join(' ').includes('secret-credential'));
  assert.ok(!args.join(' ').includes('SOURCE_KEY'));
});

test('provider arguments use a validated bridge override without serializing credentials', () => {
  const args = feature('providerArgs')({ transport: 'chat-completions', model: 'm', baseUrl: 'https://example.com/v1', apiKey: 'secret-credential' }, { baseUrl: 'http://127.0.0.1:9999/v1', keyEnv: 'BRIDGE_KEY' });
  assert.ok(args.includes('model_providers.sudo_session.base_url="http://127.0.0.1:9999/v1"'));
  assert.ok(args.includes('model_providers.sudo_session.env_key="BRIDGE_KEY"'));
  assert.throws(() => feature('providerArgs')({ transport: 'responses', model: 'm', baseUrl: 'https://example.com' }, { keyEnv: 'BAD=KEY' }));
});

test('isolated session home starts empty and cleanup removes only its owned directory', async t => {
  const base = await temporary(t);
  const sentinel = join(base, 'keep.txt');
  await writeFile(sentinel, 'keep');
  const first = await feature('createSessionHome')({ baseDir: base });
  const second = await feature('createSessionHome')({ baseDir: base });
  assert.notEqual(first.path, second.path);
  assert.deepEqual(await readdir(first.path), []);
  await writeFile(join(first.path, 'session-data'), 'runtime only');
  await first.cleanup();
  await first.cleanup();
  await assert.rejects(access(first.path));
  await access(second.path);
  await access(sentinel);
  await second.cleanup();
});

test('session cleanup waits for a transient Windows native file lock without deleting siblings', {skip:process.platform!=='win32',timeout:10000}, async t=>{
  const base=await temporary(t),home=await runtime.createSessionHome({baseDir:base});
  const sibling=join(base,'keep.txt'),held=join(home.path,'.tmp','plugins-clone-fixture','held.txt');
  await writeFile(sibling,'keep');await mkdir(join(home.path,'.tmp','plugins-clone-fixture'),{recursive:true});await writeFile(held,'native fixture');
  const command="$stream=[IO.File]::Open($env:SUDO_CLI_LOCK_FIXTURE_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try { [Console]::WriteLine('LOCK_READY'); Start-Sleep -Milliseconds 450 } finally { $stream.Dispose() }";
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{env:isolatedEnvironment(process.env,{SUDO_CLI_LOCK_FIXTURE_PATH:held}),windowsHide:true,stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close');child.stderr.resume();
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Native file-lock fixture did not become ready.')),5000);
      let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('LOCK_READY')){clearTimeout(timer);resolve();}});
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Native file-lock fixture could not start.'));});
      child.once('close',()=>{clearTimeout(timer);if(!output.includes('LOCK_READY'))reject(new Error('Native file-lock fixture exited before readiness.'));});
    });
    await home.cleanup();
    await assert.rejects(access(home.path),{code:'ENOENT'});await access(sibling);
  } finally { child.kill();await closed; }
});

test('runtime permissions default to asking and web access defaults to off', () => {
  assert.deepEqual(feature('validateRuntimeOptions')(), { permissions: 'ask', webAccess: false });
  assert.deepEqual(feature('validateRuntimeOptions')({ permissions: 'allow-everything', webAccess: true }), { permissions: 'allow-everything', webAccess: true });
  for (const options of [{ permissions: 'never' }, { permissions: '' }, { webAccess: 'on' }, { webAccess: 1 }, { webAccess: null }]) {
    assert.throws(() => feature('validateRuntimeOptions')(options), /Permissions|Web Access/);
  }
});

test('web and permission options reach native configuration without blocking the model endpoint', () => {
  const connection = { transport: 'responses', model: 'm', baseUrl: 'https://model.example/v1' };
  const off = feature('providerArgs')(connection);
  assert.ok(off.includes('approval_policy="on-request"'));
  assert.ok(off.includes('sandbox_mode="workspace-write"'));
  assert.ok(off.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(off.includes('web_search="disabled"'));
  assert.ok(off.includes('model_providers.sudo_session.base_url="https://model.example/v1"'));
  const on = feature('providerArgs')(connection, { permissions: 'allow-everything', webAccess: true });
  assert.ok(on.includes('approval_policy="never"'));
  assert.ok(on.includes('sandbox_mode="danger-full-access"'));
  assert.ok(on.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(on.includes('web_search="live"'));
  const chat = feature('providerArgs')({ ...connection, transport: 'chat-completions' }, { webAccess: true });
  assert.ok(chat.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(chat.includes('web_search="disabled"'), 'The Chat bridge cannot execute native hosted search tools');
  assert.throws(() => feature('providerArgs')(connection, { permissions: 'secret-invalid-permission' }), error => /Permissions/.test(error.message) && !error.message.includes('secret-invalid-permission'));
});

test('reasoning uses native levels, preserves omitted defaults and restricts declared model profiles', () => {
  const validate = feature('validateReasoningEffort');
  assert.equal(validate(undefined), undefined);
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']) assert.equal(validate(effort), effort);
  assert.equal(validate('adaptive', { supportedEfforts: ['adaptive', 'high'] }), 'adaptive');
  assert.throws(() => validate('adaptive'), /Reasoning effort/);
  assert.throws(() => validate('high', { supportedEfforts: ['low'] }), /model profile/);
  for (const value of [null, '', 'secret\nvalue', 2]) assert.throws(() => validate(value), error => /Reasoning effort/.test(error.message) && !error.message.includes('secret'));
  assert.deepEqual(feature('validateConnection')({ transport: 'responses', model: 'm', baseUrl: 'https://example.com', supportedEfforts: ['adaptive', 'high'] }).supportedEfforts, ['adaptive', 'high']);
});

test('connection capability declarations are copied, boolean and bounded to known names', () => {
  const validate = feature('validateConnection');
  const base = { transport: 'responses', model: 'm', baseUrl: 'https://example.test/v1' };
  const capabilities = { tools: false, hostedSearch: false, training: true };
  const actual = validate({ ...base, capabilities });
  assert.deepEqual(actual.capabilities, capabilities);
  capabilities.tools = true;
  assert.equal(actual.capabilities.tools, false);
  assert.ok(!Object.hasOwn(validate(base), 'capabilities'));
  for (const capabilities of [[], null, { tools: 'false' }, { secretUnknown: true }, { search: true }]) assert.throws(() => validate({ ...base, capabilities }), error => /capabilit/i.test(error.message) && !error.message.includes('secretUnknown'));
});

test('declared hosted-search unavailability disables native search with Web On', () => {
  const base = { transport: 'responses', model: 'm', baseUrl: 'https://example.test/v1' };
  assert.ok(feature('providerArgs')({ ...base, capabilities: { hostedSearch: false } }, { webAccess: true }).includes('web_search="disabled"'));
  assert.ok(feature('providerArgs')({ ...base, capabilities: {} }, { webAccess: true }).includes('web_search="live"'));
});
