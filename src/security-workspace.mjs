import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { collectWorkspaceFiles, createWorkspaceSnapshot, isExcludedWorkspacePath, redactWorkspaceText } from './workspace-tools.mjs';

const approvedTargets = new WeakSet();
const abortError = () => new DOMException('Security scan was cancelled.', 'AbortError');
const sourceRules = [
  { id: 'dynamic-evaluation', pattern: /\b(?:eval|Function)\s*\(/g, message: 'Dynamic code evaluation requires review of input trust and reachable callers.' },
  { id: 'shell-execution', pattern: /\bexec(?:Sync)?\s*\(|\bshell\s*:\s*true/g, message: 'Shell execution requires review of interpolation and untrusted input.' },
  { id: 'tls-verification-disabled', pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/g, message: 'TLS verification appears disabled; review transport authenticity.' },
  { id: 'weak-digest', pattern: /createHash\s*\(\s*["'](?:md5|sha1)["']/g, message: 'A legacy digest is used; review whether this is a security-sensitive integrity check.' },
  { id: 'html-injection-sink', pattern: /\.innerHTML\s*=|dangerouslySetInnerHTML\s*=/g, message: 'HTML injection sink requires review of sanitization and input origin.' },
];
const secretRules = [
  { id: 'credential-pattern', pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g },
  { id: 'credential-assignment', pattern: /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["'][^"'\r\n]{8,}["']/gi },
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

/** Local heuristic source/dependency/secret scan; does not execute code or contact a service. */
export async function scanWorkspace({ cwd = process.cwd(), path = '.', signal, maxFindings = 200, secrets = () => [], ...limits } = {}) {
  if (signal?.aborted) throw abortError();
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > 1000 || typeof secrets !== 'function') throw new Error('Security scan bounds are invalid.');
  const source = await collectWorkspaceFiles({ cwd, path, signal, ...limits });
  const findings = []; let filesScanned = 0, truncated = false;
  const add = finding => { if (findings.length >= maxFindings) { truncated = true; return; } findings.push({ ...finding, path: redactWorkspaceText(finding.path, secrets) }); };
  for (const file of source.files) {
    if (signal?.aborted) throw abortError(); if (file.data.includes(0)) continue;
    const text = file.data.toString('utf8'); filesScanned++;
    for (const rule of secretRules) {
      rule.pattern.lastIndex = 0; let match;
      while ((match = rule.pattern.exec(text))) {
        add({ category: 'secrets', rule: rule.id, severity: 'high', path: file.path, line: text.slice(0, match.index).split('\n').length,
          message: 'Possible embedded credential or private key. Value suppressed; confirm locally and rotate if real.' }); if (truncated) break;
      }
    }
    if (/\.(?:[cm]?[jt]sx?|py|rb|php|go|rs|java|cs|sh|ps1)$/i.test(file.path)) {
      for (const rule of sourceRules) {
        rule.pattern.lastIndex = 0; let match;
        while ((match = rule.pattern.exec(text))) { add({ category: 'source', rule: rule.id, severity: 'review', path: file.path, line: text.slice(0, match.index).split('\n').length, message: rule.message }); if (truncated) break; }
      }
    }
    if (file.path === 'package.json' || file.path.endsWith('/package.json')) {
      let manifest;
      try { manifest = JSON.parse(text); } catch { add({ category: 'dependencies', rule: 'invalid-manifest', severity: 'review', path: file.path, line: 1, message: 'Package manifest is invalid JSON; dependency inspection was incomplete.' }); continue; }
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const [name, version] of Object.entries(manifest?.[section] ?? {})) {
        if (typeof version !== 'string') continue;
        if (/^(?:\*|latest|next|>=|>|$)/.test(version.trim())) add({ category: 'dependencies', rule: 'unbounded-version', severity: 'review', path: file.path, line: 1, message: 'A dependency version is unconstrained. Review reproducibility and the lockfile.' });
        if (/^http:/i.test(version)) add({ category: 'dependencies', rule: 'insecure-dependency-url', severity: 'high', path: file.path, line: 1, message: 'A dependency uses plaintext HTTP. Review authenticity and use a verified HTTPS source.' });
        if (/^(?:git\+|https?:|github:|file:)/i.test(version)) add({ category: 'dependencies', rule: 'nonregistry-dependency', severity: 'review', path: file.path, line: 1, message: 'A nonregistry dependency requires review of its source, integrity and update policy.' });
        void name;
      }
      if (manifest?.scripts && ['preinstall', 'install', 'postinstall', 'prepare'].some(name => typeof manifest.scripts[name] === 'string' && manifest.scripts[name])) add({ category: 'dependencies', rule: 'install-script', severity: 'review', path: file.path, line: 1, message: 'Installation lifecycle commands are present; inspect them before running dependency installation.' });
    }
  }
  return { defensive: true, verified: false, findings, filesScanned, partial: source.partial || truncated, truncated, skipped: source.skipped.map(item => ({ ...item, path: redactWorkspaceText(item.path, secrets) })),
    limitations: 'Local heuristics only. Findings need validation; absence of findings is not proof of security. No dependency advisory database, network target, exploit or external system was accessed.' };
}

/** Approval is a literal foreground decision for a relative local source target, never a URL. */
export async function resolveSecurityTarget({ cwd = process.cwd(), path = '.', approved = false, label = 'Defensive source review' } = {}) {
  if (approved !== true) throw new Error('Security target requires explicit local target approval.');
  if (typeof cwd !== 'string' || !cwd || typeof path !== 'string' || !path || path.length > 4096 || isAbsolute(path) || /[\u0000-\u001f\u007f:]|^\\/.test(path)
    || path !== '.' && path.split(/[\\/]/).some(part => !part || part === '..' || part === '.') || isExcludedWorkspacePath(path)
    || typeof label !== 'string' || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error('Security target must be a bounded relative nonsecret local source path.');
  const root = await realpath(resolve(cwd)), targetPath = resolve(root, path), rel = relative(root, targetPath);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !(await lstat(root)).isDirectory()) throw new Error('Security target escapes the project.');
  let current = root;
  if (path !== '.') for (const part of path.split(/[\\/]/)) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic security targets are refused.'); }
  const info = await lstat(targetPath); if (!info.isDirectory() && !info.isFile()) throw new Error('Security target is not a local regular source file or directory.');
  const target = Object.freeze({ cwd: root, path, label, approved: true, scope: 'defensive-local-source' }); approvedTargets.add(target); return target;
}
export const approveSecurityTarget = resolveSecurityTarget;

export async function createSecurityLab({ target, signal, baseDir, secrets = () => [], ...limits } = {}) {
  if (!target || !approvedTargets.has(target)) throw new Error('Security lab requires a resolved approved local target.');
  const current = await resolveSecurityTarget({ ...target, approved: true });
  const copy = await createWorkspaceSnapshot({ ...limits, cwd: current.cwd, path: current.path, signal, secrets, ...(baseDir ? { baseDir } : {}) });
  return { ...copy, defensive: true, verified: false, target: { path: current.path, label: current.label, scope: current.scope },
    limitations: 'Disposable source copy for defensive review. The original project and external targets are not an authorized lab scope.' };
}
