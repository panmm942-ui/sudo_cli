import { createHash } from 'node:crypto';
import { open, mkdir, lstat, chmod, rm, readdir, mkdtemp, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createGunzip } from 'node:zlib';

export const CODEX_VERSION = '0.160.1';

// Hashes and sizes are pinned to the official rust-v0.160.1 GitHub release.
// https://api.github.com/repos/openai/codex/releases/tags/rust-v0.160.1
const targets = {
  'linux-x64': ['x86_64-unknown-linux-musl', 160785122, '340801565906a7028f6baaa9ab6853addaef221f0016a1417a7c1ffdd96c21f0'],
  'linux-arm64': ['aarch64-unknown-linux-musl', 150931915, 'dff0954438fa455c2197ddb1f421d8d68625d98de610f76bedb6e5bc837ea35b'],
  'darwin-x64': ['x86_64-apple-darwin', 141316108, 'a98f330c9b1652cef2edc7bc2ee4c47a0fe19fa098b686381be3c8842abf0ac0'],
  'darwin-arm64': ['aarch64-apple-darwin', 129977637, 'f73527ee09c6db869acbb37b709866b339ea74ef91d2de255e9c74ec960c6314'],
  'win32-x64': ['x86_64-pc-windows-msvc', 157434529, '25c6fe4e46d5bff939312fc46de67ace37561f6f1f89b409af63fd8cc6098425'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 145421581, '844e17c492175ec62f8c11890ed89ef208d3502d2c79622c3be9876d2755f085'],
};

export function platformRuntime(platform = process.platform, arch = process.arch) {
  const id = `${platform}-${arch}`;
  const target = targets[id];
  if (!target) throw new Error('Unsupported system or architecture. sudo cli supports Windows, Linux and macOS on x64 or arm64.');
  const [triple, bytes, sha256] = target;
  const asset = `codex-package-${triple}.tar.gz`;
  return { id, platform, arch, triple, bytes, sha256, asset, executable: platform === 'win32' ? 'codex.exe' : 'codex', url: `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${asset}` };
}

const downloadHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function downloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid runtime download URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !downloadHosts.has(url.hostname)) {
    throw new Error('Runtime download redirect uses an unapproved URL.');
  }
  return url;
}

/** Save a verified archive exclusively; a failure removes only the file created here. */
export async function downloadVerified(metadata, destination, { fetchImpl = fetch, signal = AbortSignal.timeout(300000), onProgress = () => {} } = {}) {
  if (!metadata || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes > 512 * 1024 * 1024) {
    throw new Error('Invalid pinned runtime metadata.');
  }
  let url = downloadUrl(metadata.url);
  let file;
  let response;
  try {
    file = await open(destination, 'wx', 0o600);
    for (let attempt = 0; ; attempt++) {
      response = await fetchImpl(url, { redirect: 'manual', signal, headers: { 'user-agent': 'sudo-cli-runtime-setup' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || attempt >= 5) throw new Error('Runtime download has too many or invalid redirects.');
        url = downloadUrl(new URL(location, url));
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Official runtime download failed. Try again when the release server is available.');
      }
      break;
    }
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > metadata.bytes) throw new Error('Runtime archive size exceeds its pinned length.');
      digest.update(chunk);
      // FileHandle.write may write fewer bytes than requested.
      let offset = 0;
      while (offset < chunk.length) offset += (await file.write(chunk.subarray(offset))).bytesWritten;
      onProgress(bytes, metadata.bytes);
    }
    if (bytes !== metadata.bytes) throw new Error('Runtime archive size does not match its pinned length.');
    if (digest.digest('hex') !== metadata.sha256) throw new Error('Runtime archive failed SHA-256 digest verification.');
    await file.close();
    file = undefined;
  } catch (error) {
    if (file) {
      await file.close().catch(() => {});
      await rm(destination, { force: true }).catch(() => {});
    }
    if (error?.code === 'EEXIST') throw new Error('Runtime download destination already exists.');
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error('Runtime download was interrupted or timed out.');
    throw error;
  }
}

class ArchiveReader {
  constructor(source) { this.source = source[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.done = false; }
  async take(maximum) {
    while (!this.chunk.length && !this.done) {
      const value = await this.source.next();
      this.done = value.done;
      this.chunk = this.done ? Buffer.alloc(0) : Buffer.from(value.value);
    }
    const part = this.chunk.subarray(0, maximum);
    this.chunk = this.chunk.subarray(part.length);
    return part;
  }
  async read(bytes) {
    const output = Buffer.alloc(bytes);
    let position = 0;
    while (position < bytes) {
      const part = await this.take(bytes - position);
      if (!part.length) throw new Error('Runtime package archive is truncated.');
      output.set(part, position);
      position += part.length;
    }
    return output;
  }
}

function text(header, start, length) {
  const value = header.subarray(start, start + length);
  const nullIndex = value.indexOf(0);
  return value.subarray(0, nullIndex < 0 ? value.length : nullIndex).toString('utf8');
}
function octal(header, start, length) {
  const value = text(header, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('Runtime package archive has an invalid number.');
  const result = parseInt(value || '0', 8);
  if (!Number.isSafeInteger(result)) throw new Error('Runtime package archive entry is too large.');
  return result;
}
function packagePath(root, name) {
  const stripped = name.replace(/\/$/, '');
  if (!stripped || /[\\:\u0000-\u001f\u007f]/.test(name) || isAbsolute(stripped) || stripped.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('Runtime package archive has an unsafe path.');
  }
  const destination = resolve(root, ...stripped.split('/'));
  const relation = relative(root, destination);
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) throw new Error('Runtime package archive path escapes its directory.');
  return destination;
}

/** Extract regular files and directories only, into a fresh, owned staging directory. */
export async function extractPackage(source, directory) {
  const root = resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(root)).length) {
    throw new Error('Runtime package archive requires an empty staging directory.');
  }
  const reader = new ArchiveReader(source);
  const names = new Set();
  let entries = 0;
  let total = 0;
  for (;;) {
    const header = await reader.read(512);
    if (header.every(byte => byte === 0)) {
      const end = await reader.read(512);
      if (!end.every(byte => byte === 0)) throw new Error('Runtime package archive has an invalid terminator.');
      // Drain zero padding to EOF so gzip validates its trailer and closes the input.
      let trailing = 0;
      for (;;) {
        const padding = await reader.take(65536);
        if (!padding.length) break;
        trailing += padding.length;
        if (trailing > 1024 * 1024 || !padding.every(byte => byte === 0)) throw new Error('Runtime package archive has unexpected trailing data.');
      }
      return;
    }
    if (++entries > 4096) throw new Error('Runtime package archive has too many entries.');
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(header, 148, 8)) throw new Error('Runtime package archive header checksum failed.');
    const size = octal(header, 124, 12);
    total += size;
    if (size > 1024 * 1024 * 1024 || total > 2 * 1024 * 1024 * 1024) throw new Error('Runtime package archive exceeds its size limit.');
    const type = text(header, 156, 1);
    if (type === 'x') {
      // Python's release packager writes PAX timestamps. Paths, sizes and links
      // remain in the standard header; reject any extension that can alter them.
      if (size > 16384) throw new Error('Runtime package archive metadata is too large.');
      const extended = (await reader.read(size)).toString('utf8');
      let offset = 0;
      while (offset < extended.length) {
        const space = extended.indexOf(' ', offset);
        const length = Number(extended.slice(offset, space));
        if (!Number.isSafeInteger(length) || length <= 0 || offset + length > extended.length) throw new Error('Runtime package archive metadata is invalid.');
        const record = extended.slice(space + 1, offset + length);
        if (!/^(mtime|atime|ctime|uid|gid|uname|gname)=.*\n$/.test(record)) throw new Error('Runtime package archive metadata changes an unsupported field.');
        offset += length;
      }
      await reader.read((512 - size % 512) % 512);
      continue;
    }
    if (!['', '0', '5'].includes(type)) throw new Error('Runtime package archive contains a link or unsupported entry.');
    const prefix = text(header, 345, 155);
    const name = (prefix ? `${prefix}/` : '') + text(header, 0, 100);
    const destination = packagePath(root, name);
    const unique = process.platform === 'win32' ? destination.toLowerCase() : destination;
    if (names.has(unique)) throw new Error('Runtime package archive contains a duplicate entry.');
    names.add(unique);
    if (type === '5') {
      if (size) throw new Error('Runtime package archive directory has unexpected data.');
      await mkdir(destination, { recursive: true, mode: 0o755 });
      continue;
    }
    const parent = resolve(destination, '..');
    await mkdir(parent, { recursive: true, mode: 0o755 });
    const file = await open(destination, 'wx', 0o600);
    try {
      let remaining = size;
      while (remaining) {
        const part = await reader.take(Math.min(remaining, 65536));
        if (!part.length) throw new Error('Runtime package archive file is truncated.');
        let offset = 0;
        while (offset < part.length) offset += (await file.write(part.subarray(offset))).bytesWritten;
        remaining -= part.length;
      }
    } finally { await file.close(); }
    await chmod(destination, octal(header, 100, 8) & 0o111 ? 0o755 : 0o644);
    await reader.read((512 - size % 512) % 512);
  }
}

async function validatePackage(directory, target) {
  let metadata;
  try { metadata = JSON.parse(await readFile(join(directory, 'codex-package.json'), 'utf8')); }
  catch { throw new Error('Installed runtime package metadata is missing or invalid.'); }
  const expected = { layoutVersion: 1, version: CODEX_VERSION, target: target.triple, variant: 'codex', entrypoint: `bin/${target.executable}`, resourcesDir: 'codex-resources', pathDir: 'codex-path' };
  if (Object.entries(expected).some(([field, value]) => metadata[field] !== value)) throw new Error('Installed runtime does not match the pinned version or platform.');
  const suffix = target.platform === 'win32' ? '.exe' : '';
  const files = [`bin/${target.executable}`, `bin/codex-code-mode-host${suffix}`, `codex-path/rg${suffix}`];
  if (target.platform === 'linux') files.push('codex-resources/bwrap');
  if (target.platform === 'win32') files.push('codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe');
  for (const filename of files) {
    let info;
    try { info = await lstat(join(directory, ...filename.split('/'))); } catch { throw new Error('Installed runtime package is incomplete.'); }
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && !(info.mode & 0o100))) throw new Error('Installed runtime executable is missing or lacks execute permission.');
  }
}

/** Install only into this project's runtime/<platform>-<architecture> directory. */
export async function installRuntime({ projectRoot, platform = process.platform, arch = process.arch, fetchImpl = fetch, signal = AbortSignal.timeout(300000), onProgress = () => {} } = {}) {
  const target = platformRuntime(platform, arch);
  const root = await realpath(resolve(projectRoot));
  const runtimes = join(root, 'runtime');
  await mkdir(runtimes, { recursive: true });
  const info = await lstat(runtimes);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Runtime directory must be a real project-local directory.');
  const destination = join(runtimes, target.id);
  const lockPath = join(runtimes, `.setup-${target.id}.lock`);
  let lock;
  let stage;
  let input;
  let gunzip;
  try {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error?.code === 'EEXIST') throw new Error('Runtime setup is already running or has an interrupted setup lock. Finish that setup before retrying.');
      throw error;
    }
    try {
      const existing = await lstat(destination);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Runtime destination already exists and is not a package directory.');
      await validatePackage(destination, target);
      return { path: join(destination, 'bin', target.executable), target, installed: false };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    stage = await mkdtemp(join(runtimes, `.install-${target.id}-`));
    const archive = join(stage, 'package.tar.gz');
    const packageDirectory = join(stage, 'package');
    await downloadVerified(target, archive, { fetchImpl, signal, onProgress });
    await mkdir(packageDirectory, { mode: 0o700 });
    input = createReadStream(archive);
    gunzip = createGunzip();
    input.on('error', error => gunzip.destroy(error));
    input.pipe(gunzip);
    await extractPackage(gunzip, packageDirectory);
    await validatePackage(packageDirectory, target);
    await writeFile(join(packageDirectory, 'sudo-runtime.json'), JSON.stringify({ codexVersion: CODEX_VERSION, platform: target.id, source: target.url, archiveBytes: target.bytes, archiveSha256: target.sha256 }, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    // Refuse a destination created while the archive was downloading.
    try {
      await lstat(destination);
      throw new Error('Runtime destination appeared during setup. It will not be replaced.');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(packageDirectory, destination);
    return { path: join(destination, 'bin', target.executable), target, installed: true };
  } finally {
    input?.destroy();
    gunzip?.destroy();
    // `stage` is the exact owned mkdtemp child within this checked runtime directory.
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    finally {
      if (lock) {
        try { await lock.close(); }
        finally { await rm(lockPath, { force: true }); }
      }
    }
  }
}
