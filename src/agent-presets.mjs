import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createPrivateRecord } from './private-state.mjs';
import { defaultWorkStateDir } from './work-meter.mjs';
import { redactWorkspaceText } from './workspace-tools.mjs';

export const AGENT_ROLES = Object.freeze(['planner', 'reviewer', 'tester', 'security', 'researcher', 'coder']);
export const BUILTIN_AGENTS = Object.freeze([
  { name: 'planner', role: 'planner', mode: 'review', instructions: 'Produce a concrete plan, bounded steps and meaningful acceptance checks.' },
  { name: 'reviewer', role: 'reviewer', mode: 'review', instructions: 'Find concrete bugs and regressions. Cite source files and explain practical fixes.' },
  { name: 'tester', role: 'tester', mode: 'review', instructions: 'Identify meaningful tests and missing coverage. Report recommendations without claiming tests were executed.' },
  { name: 'security', role: 'security', mode: 'review', instructions: 'Inspect source defensively for exploitable flaws. Explain evidence and practical remediation. Do not execute exploits.' },
  { name: 'researcher', role: 'researcher', mode: 'review', instructions: 'Research the supplied source and documentation. Cite local evidence and distinguish facts from assumptions. External web access is disabled.' },
  { name: 'coder', role: 'coder', mode: 'edit', instructions: 'Implement the requested task in the disposable source copy. Preserve existing behavior and human changes. Explain proposed changes and checks still required.' },
].map(agent => Object.freeze({ ...agent, builtIn: true })));
const builtinNames = new Set(BUILTIN_AGENTS.map(agent => agent.name));
const fields = new Set(['name', 'role', 'mode', 'instructions', 'profileName']);
const invalidPlainText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function agentName(value) {
  if (typeof value !== 'string') throw new Error('Agent name must be a simple identifier.');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(normalized)) throw new Error('Agent name must start with a letter and use up to 40 letters, numbers, hyphens or underscores.');
  return normalized;
}

/** Copy only bounded public metadata. Connections, keys and permissions are never stored. */
export function validateAgentDefinition(input, { secrets = () => [] } = {}) {
  if (!object(input) || typeof secrets !== 'function') throw new Error('Agent definition is invalid.');
  const name = agentName(input.name), role = input.role;
  if (!AGENT_ROLES.includes(role)) throw new Error('Agent role must be planner, reviewer, tester, security, researcher or coder.');
  const mode = input.mode ?? 'review';
  if (!['review', 'edit'].includes(mode)) throw new Error('Agent mode must be review or edit.');
  const instructions = input.instructions ?? '';
  if (typeof instructions !== 'string' || Buffer.byteLength(instructions) > 8192 || invalidPlainText.test(instructions)) throw new Error('Agent instructions must be plain text within 8 KiB.');
  const value = { name, role, mode, instructions: redactWorkspaceText(instructions, secrets) };
  if (input.profileName !== undefined) {
    const profileName = input.profileName;
    if (typeof profileName !== 'string' || !profileName.trim() || profileName.length > 120 || /[\p{Cc}\p{Cf}]/u.test(profileName)) throw new Error('Agent model profile name must be bounded plain text.');
    value.profileName = profileName.trim().normalize('NFC');
    if (redactWorkspaceText(value.profileName, secrets) !== value.profileName) throw new Error('Agent profile names cannot contain credentials.');
  }
  if (redactWorkspaceText(name, secrets) !== name) throw new Error('Agent names cannot contain credentials.');
  return value;
}

export async function createAgentPresets({ cwd = process.cwd(), stateDir = defaultWorkStateDir(), secrets = () => [] } = {}) {
  if (typeof cwd !== 'string' || !cwd || /[\u0000-\u001f\u007f]/.test(cwd) || typeof stateDir !== 'string' || !stateDir || /[\u0000-\u001f\u007f]/.test(stateDir) || typeof secrets !== 'function') throw new Error('Agent project storage is invalid.');
  const id = createHash('sha256').update(resolve(cwd)).digest('hex');
  const record = await createPrivateRecord({ directory: join(resolve(stateDir), 'agents'), filename: `${id}.json`, maxBytes: 512 * 1024 });
  const lockPath = record.path + '.edit.lock';
  async function customAgents() {
    const stored = await record.read();
    if (stored === undefined) return [];
    try {
      if (!object(stored) || stored.version !== 1 || Object.keys(stored).some(key => !['version', 'agents'].includes(key)) || !Array.isArray(stored.agents) || stored.agents.length > 32) throw new Error();
      const agents = stored.agents.map(agent => {
        if (!object(agent) || Object.keys(agent).some(key => !fields.has(key))) throw new Error();
        const sanitized = validateAgentDefinition(agent, { secrets });
        if (builtinNames.has(sanitized.name) || sanitized.name !== agent.name || sanitized.role !== agent.role || sanitized.mode !== agent.mode) throw new Error();
        return sanitized;
      });
      if (new Set(agents.map(agent => agent.name)).size !== agents.length) throw new Error();
      return agents;
    } catch { throw new Error('Saved agent definitions are invalid; existing storage was left unchanged.'); }
  }
  async function mutate(operation) {
    let lock;
    try {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Agent definitions are locked by another or interrupted edit.'); throw error; }
      return await operation(await customAgents());
    } finally { if (lock) { await lock.close(); await rm(lockPath, { force: true }); } }
  }
  return {
    path: record.path, directory: dirname(record.path),
    async list() { return [...BUILTIN_AGENTS, ...(await customAgents()).sort((a, b) => a.name.localeCompare(b.name))]; },
    async get(name) {
      const selected = agentName(name); return BUILTIN_AGENTS.find(agent => agent.name === selected) ?? (await customAgents()).find(agent => agent.name === selected);
    },
    async save(input) {
      const agent = validateAgentDefinition(input, { secrets });
      if (builtinNames.has(agent.name)) throw new Error('Built-in agents cannot be replaced. Save a custom name instead.');
      return mutate(async agents => {
        const index = agents.findIndex(value => value.name === agent.name);
        if (index < 0 && agents.length >= 32) throw new Error('The project already has the limit of 32 saved custom agents.');
        if (index < 0) agents.push(agent); else agents[index] = agent;
        await record.write({ version: 1, agents }); return agent;
      });
    },
    async remove(name) {
      const selected = agentName(name);
      if (builtinNames.has(selected)) throw new Error('Built-in agents cannot be removed.');
      return mutate(async agents => {
        const filtered = agents.filter(agent => agent.name !== selected);
        if (filtered.length === agents.length) return false;
        await record.write({ version: 1, agents: filtered }); return true;
      });
    },
  };
}
