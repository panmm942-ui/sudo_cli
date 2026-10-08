import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Metadata schema and known slugs are pinned to Codex rust-v0.160.1, commit
// d27764b82f7118f674371e6d6e76271d9d606edb (models-manager/models.json).
// Retain native built-in metadata instead of replacing known model families.
const BUILTIN_SLUGS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol',
  'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-daybreak-blue-latest', 'gpt-daybreak-red-latest', 'gpt-5.5', 'codex-auto-review'];
const builtin = model => {
  const candidate = /^[a-zA-Z0-9_-]+\/[^/]+$/.test(model) ? model.slice(model.indexOf('/') + 1) : model;
  return BUILTIN_SLUGS.some(slug => candidate.startsWith(slug));
};

/** An owned temporary native catalog for an unknown custom endpoint model. */
export async function prepareCustomModelCatalog({ model, providerArgs = [], supportedEfforts, capabilities = {} } = {}) {
  if (!Array.isArray(providerArgs) || providerArgs.some(value => typeof value !== 'string')) throw new Error('Native provider arguments must be strings.');
  if (providerArgs.some(value => /^\s*model_catalog_json\s*=/.test(value))
    || !providerArgs.some(value => /^\s*model_provider\s*=\s*"sudo_session"\s*$/.test(value))) return undefined;
  if (typeof model !== 'string' || !model.trim() || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('A native model catalog requires a valid model ID.');
  if (builtin(model)) return undefined;
  const instructions = await readFile(new URL('./native-model-instructions.md', import.meta.url), 'utf8');
  const entry = {
    slug: model, display_name: model, description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: (supportedEfforts ?? []).map(effort => ({ effort, description: 'Declared by the selected endpoint.' })),
    shell_type: 'unified_exec', visibility: 'none', supported_in_api: true, priority: 99,
    availability_nux: null, upgrade: null,
    model_messages: { instructions_template: instructions },
    include_skills_usage_instructions: true, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false, default_reasoning_summary: 'none', support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: 'freeform', web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10000 }, effective_context_window_percent: 95,
    // Retain native fallback modalities unless the endpoint was explicitly
    // configured without vision. Runtime capability checks remain authoritative.
    experimental_supported_tools: [], input_modalities: capabilities.vision === false ? ['text'] : ['text', 'image'], tool_mode: 'direct',
  };
  const directory = await mkdtemp(join(tmpdir(), 'sudo-native-model-'));
  const path = join(directory, 'catalog.json');
  try { await writeFile(path, JSON.stringify({ models: [entry] }), { mode: 0o600 }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, async cleanup() { await rm(directory, { recursive: true, force: true }); } };
}
