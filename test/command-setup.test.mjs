import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codexcli-command-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project with spaces');
  const homeDir = join(root, 'home');
  await mkdir(join(projectRoot, 'bin'), { recursive: true });
  await mkdir(homeDir);
  await writeFile(join(projectRoot, 'bin', 'sudocli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  return { root, projectRoot, homeDir };
}

test('Windows registration creates a managed user command and updates only its injected user PATH', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  let value = 'C:\\Existing Tools';
  let writes = 0;
  const result = await registerCommand({ ...fixtureData, platform: 'win32', env: { LOCALAPPDATA: join(fixtureData.homeDir, 'AppData', 'Local') }, windowsPathStore: { read: async () => value, write: async next => { writes++; value = next; } } });
  assert.equal(result.commandPath, join(fixtureData.homeDir, 'AppData', 'Local', 'codexcli', 'bin', 'sudocli.cmd'));
  const body = await readFile(result.commandPath, 'utf8');
  assert.match(body, /CODEXCLI_MANAGED_COMMAND_V1/);
  assert.ok(body.includes('sudocli.mjs'));
  assert.ok(body.includes('%*'));
  assert.ok(!body.includes('call '));
  assert.equal(writes, 1);
  assert.ok(value.endsWith(';C:\\Existing Tools'));
  assert.equal(result.profilePath, undefined);
});

test('Windows registration is idempotent and preserves environment-variable PATH entries', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  const appData = join(fixtureData.homeDir, 'AppData', 'Local');
  let value = '%LOCALAPPDATA%\\codexcli\\bin;C:\\Keep';
  let writes = 0;
  const options = { ...fixtureData, platform: 'win32', env: { LOCALAPPDATA: appData }, windowsPathStore: { read: async () => value, write: async next => { writes++; value = next; } } };
  const first = await registerCommand(options);
  const before = (await stat(first.commandPath)).mtimeMs;
  const second = await registerCommand(options);
  assert.equal(writes, 0);
  assert.equal(second.commandChanged, false);
  assert.equal(second.pathChanged, false);
  assert.equal((await stat(first.commandPath)).mtimeMs, before);
  assert.equal(value, '%LOCALAPPDATA%\\codexcli\\bin;C:\\Keep');
});

test('registration refuses a foreign command without touching PATH or shell startup files', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  const bin = join(fixtureData.homeDir, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  const command = join(bin, 'sudocli');
  await writeFile(command, '#!/bin/sh\necho foreign\n');
  await assert.rejects(registerCommand({ ...fixtureData, platform: 'linux', env: { SHELL: '/bin/bash' } }), /existing|foreign|managed/i);
  assert.equal(await readFile(command, 'utf8'), '#!/bin/sh\necho foreign\n');
  assert.deepEqual(await readdir(fixtureData.homeDir), ['.local']);
});

test('Unix registration adds one managed PATH block while preserving existing shell startup content', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  const profile = join(fixtureData.homeDir, '.zshrc');
  const original = '# user settings\nexport EDITOR=vim\n';
  await writeFile(profile, original);
  const options = { ...fixtureData, platform: 'darwin', env: { SHELL: '/bin/zsh' } };
  const first = await registerCommand(options);
  const text = await readFile(profile, 'utf8');
  assert.equal(first.profilePath, profile);
  assert.ok(text.startsWith(original));
  assert.equal((text.match(/>>> codexcli sudocli PATH >>>/g) ?? []).length, 1);
  const again = await registerCommand(options);
  assert.equal(await readFile(profile, 'utf8'), text);
  assert.equal(again.commandChanged, false);
  assert.equal(again.pathChanged, false);
  assert.deepEqual((await readdir(fixtureData.homeDir)).sort(), ['.local', '.zshrc']);
});

test('Unix registration selects one startup file appropriate to the configured shell', async () => {
  const { startupFile } = await import('../src/command-setup.mjs');
  assert.equal(startupFile({ homeDir: '/home/test', platform: 'linux', env: { SHELL: '/bin/bash' } }).filename, '.bashrc');
  assert.equal(startupFile({ homeDir: '/home/test', platform: 'darwin', env: { SHELL: '/bin/bash' } }).filename, '.bash_profile');
  assert.equal(startupFile({ homeDir: '/home/test', platform: 'darwin', env: {} }).filename, '.zshrc');
  assert.equal(startupFile({ homeDir: '/home/test', platform: 'linux', env: { SHELL: '/bin/sh' } }).filename, '.profile');
  assert.equal(startupFile({ homeDir: '/home/test', platform: 'linux', env: { SHELL: '/usr/bin/fish' } }).shell, 'fish');
});

test('managed wrapper updates after the project is moved while keeping unrelated profile content', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  const first = await registerCommand({ ...fixtureData, platform: 'linux', env: { SHELL: '/bin/bash' } });
  const newProject = join(fixtureData.root, 'new project');
  await mkdir(join(newProject, 'bin'), { recursive: true });
  await writeFile(join(newProject, 'bin', 'sudocli.mjs'), 'console.log("moved")');
  const second = await registerCommand({ ...fixtureData, projectRoot: newProject, platform: 'linux', env: { SHELL: '/bin/bash' } });
  assert.equal(first.commandPath, second.commandPath);
  assert.equal(second.commandChanged, true);
  assert.ok((await readFile(second.commandPath, 'utf8')).includes(newProject));
  assert.equal(second.pathChanged, false);
});

test('setup refuses broken managed PATH blocks and does not rewrite the original profile', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  const profile = join(fixtureData.homeDir, '.bashrc');
  const text = '# >>> codexcli sudocli PATH >>>\nuser content with no end\n';
  await writeFile(profile, text);
  await assert.rejects(registerCommand({ ...fixtureData, platform: 'linux', env: { SHELL: '/bin/bash' } }), /block|marker/i);
  assert.equal(await readFile(profile, 'utf8'), text);
});

test('setup chooses bundled Node when available and stores no session key or model selection', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  await mkdir(join(fixtureData.projectRoot, 'runtime'));
  await writeFile(join(fixtureData.projectRoot, 'runtime', 'node.exe'), 'bundled node fixture');
  const result = await registerCommand({ ...fixtureData, platform: 'win32', env: { LOCALAPPDATA: join(fixtureData.homeDir, 'local'), SUDO_CLI_API_KEY: 'never-save-this', SUDO_CLI_MODEL: 'never-save-model' }, windowsPathStore: { read: async () => '', write: async () => {} } });
  const body = await readFile(result.commandPath, 'utf8');
  assert.ok(body.includes('runtime\\node.exe') || body.includes('runtime/node.exe'));
  assert.ok(!body.includes('never-save-this'));
  assert.ok(!body.includes('never-save-model'));
});

test('Unix wrapper executes literal arguments from a project path with spaces and quotes', { skip: process.platform === 'win32' }, async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  const quotedProject = join(fixtureData.root, "project 'quotes' with spaces");
  await mkdir(join(quotedProject, 'bin'), { recursive: true });
  await writeFile(join(quotedProject, 'bin', 'sudocli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  const result = await registerCommand({ ...fixtureData, projectRoot: quotedProject, platform: 'linux', env: { SHELL: '/bin/bash' } });
  const args = ['arg with spaces', '$(should-not-run)', 'semi;colon'];
  const run = spawnSync(result.commandPath, args, { encoding: 'utf8', shell: false });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), args);
  const source = spawnSync('/bin/sh', ['-c', '. "$1"; command -v sudocli', 'fixture', result.profilePath], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(source.status, 0);
  assert.equal(source.stdout.trim(), result.commandPath);
});

test('setup refuses symlinked command destinations and symlinked shell profiles', { skip: process.platform === 'win32' }, async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  const outside = join(fixtureData.root, 'outside');
  await writeFile(outside, 'keep');
  await symlink(outside, join(fixtureData.homeDir, '.bashrc'));
  await assert.rejects(registerCommand({ ...fixtureData, platform: 'linux', env: { SHELL: '/bin/bash' } }), /symlink|symbolic/i);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
});

test('Windows setup refuses a foreign command before reading or writing the user PATH', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  const appData = join(fixtureData.homeDir, 'local');
  const directory = join(appData, 'codexcli', 'bin');
  await mkdir(directory, { recursive: true });
  const command = join(directory, 'sudocli.cmd');
  await writeFile(command, '@echo foreign\r\n');
  let touched = false;
  await assert.rejects(registerCommand({ ...fixtureData, platform: 'win32', env: { LOCALAPPDATA: appData }, windowsPathStore: { read: async () => { touched = true; return ''; }, write: async () => { touched = true; } } }), /existing|managed/i);
  assert.equal(touched, false);
  assert.equal(await readFile(command, 'utf8'), '@echo foreign\r\n');
});

test('Windows setup detects a concurrently changed PATH instead of overwriting it', async t => {
  const { registerCommand } = await import('../src/command-setup.mjs');
  const fixtureData = await fixture(t);
  let reads = 0;
  let written = false;
  await assert.rejects(registerCommand({ ...fixtureData, platform: 'win32', env: { LOCALAPPDATA: join(fixtureData.homeDir, 'local') }, windowsPathStore: { read: async () => ++reads === 1 ? 'C:\\original' : 'C:\\original;C:\\new-other-tool', write: async () => { written = true; } } }), /PATH changed/i);
  assert.equal(written, false);
});

test('first setup help makes no registration or model connection', () => {
  const script = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', shell: false, windowsHide: true, env: { ...process.env, SUDO_CLI_CODEX: 'missing-runtime', SUDO_CLI_API_KEY: 'never-print-key' } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /codexcli first setup/);
  assert.ok(!result.stdout.includes('never-print-key'));
});

test('Unix first setup command-only completes registration end to end in a temporary home', { skip: process.platform === 'win32' }, async t => {
  const fixtureData = await fixture(t);
  const { validateSignedReleaseManifest, verifyReleaseIntegrity, RELEASE_MANIFEST_FILE, RELEASE_SIGNATURE_FILE } = await import('../src/release-integrity.mjs');
  const { VERSION } = await import('../src/version.mjs');
  const { CODEX_VERSION } = await import('../src/platforms.mjs');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  // Reuse the real publisher-authenticated release bytes. A five-module copy
  // or a fake bin entry cannot exercise setup's signed source verification.
  const [manifestBytes, signatureBytes] = await Promise.all([
    readFile(join(sourceRoot, RELEASE_MANIFEST_FILE)),
    readFile(join(sourceRoot, RELEASE_SIGNATURE_FILE)),
  ]);
  const manifest = validateSignedReleaseManifest({ manifestBytes, signatureBytes, expectedVersion: VERSION });
  for (const entry of manifest.files) {
    const target = join(fixtureData.projectRoot, ...entry.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceRoot, ...entry.path.split('/')), target);
  }
  await writeFile(join(fixtureData.projectRoot, RELEASE_MANIFEST_FILE), manifestBytes);
  await writeFile(join(fixtureData.projectRoot, RELEASE_SIGNATURE_FILE), signatureBytes);
  await verifyReleaseIntegrity({ root: fixtureData.projectRoot, expectedVersion: VERSION });

  // The native engine is deliberately external to the sealed source tree.
  const native = join(fixtureData.root, 'native engine fixture');
  const nativeArguments = join(fixtureData.root, 'native-arguments.txt');
  await writeFile(native, `#!/bin/sh\nprintf '%s\\n' "$@" > "$SUDO_CLI_SETUP_ARGS_FILE"\nprintf '%s\\n' 'codex-cli ${CODEX_VERSION}'\n`);
  await chmod(native, 0o755);
  const childEnv = { ...process.env, HOME: fixtureData.homeDir, SHELL: '/bin/bash', SUDO_CLI_CODEX: native, SUDO_CLI_SETUP_ARGS_FILE: nativeArguments };
  const result = spawnSync(process.execPath, [join(fixtureData.projectRoot, 'scripts', 'setup.mjs'), '--command-only'], { encoding: 'utf8', shell: false, env: childEnv });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Registered sudocli/);
  assert.equal(await readFile(nativeArguments, 'utf8'), '--version\n');
  const command = join(fixtureData.homeDir, '.local', 'bin', 'sudocli');
  await writeFile(nativeArguments, '');
  const run = spawnSync(command, ['doctor'], { encoding: 'utf8', shell: false, env: childEnv });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(`Engine: codex-cli ${CODEX_VERSION}`));
  assert.match(run.stdout, /Ready\. Model configuration happens at launch; no connection was made\./);
  assert.equal(await readFile(nativeArguments, 'utf8'), '--version\n');
});
