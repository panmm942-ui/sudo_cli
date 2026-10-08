import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

test('custom model catalog declares native editing under the exact model ID and is disposable', async () => {
  const { prepareCustomModelCatalog } = await import('../src/model-catalog.mjs');
  const original = ['-c', 'model_provider="sudo_session"'];
  const catalog = await prepareCustomModelCatalog({ model: 'XiaomiMiMo/custom-fixture', providerArgs: original, supportedEfforts: ['low', 'ultra'] });
  assert.deepEqual(original, ['-c', 'model_provider="sudo_session"']);
  const value = JSON.parse(await readFile(catalog.path, 'utf8'));
  assert.equal(value.models[0].slug, 'XiaomiMiMo/custom-fixture');
  assert.equal(value.models[0].apply_patch_tool_type, 'freeform');
  assert.equal(value.models[0].shell_type, 'unified_exec');
  assert.deepEqual(value.models[0].supported_reasoning_levels.map(item => item.effort), ['low', 'ultra']);
  assert.equal(value.models[0].context_window, undefined, 'Unknown context capacity must not be invented');
  assert.match(value.models[0].model_messages.instructions_template, /coding agent running in the Codex CLI/);
  await catalog.cleanup();
  await assert.rejects(access(catalog.path));
});

test('trusted supplied catalog and unrelated native providers keep their metadata', async () => {
  const { prepareCustomModelCatalog } = await import('../src/model-catalog.mjs');
  assert.equal(await prepareCustomModelCatalog(), undefined, 'Native providers may choose their own default model');
  assert.equal(await prepareCustomModelCatalog({ model: 'model', providerArgs: ['-c', 'model_provider="fixture"'] }), undefined);
  assert.equal(await prepareCustomModelCatalog({ model: 'model', providerArgs: ['-c', 'model_provider="sudo_session"', '-c', 'model_catalog_json="C:/trusted/model-catalog.json"'] }), undefined);
  assert.equal(await prepareCustomModelCatalog({ model: 'gpt-6-astra', providerArgs: ['-c', 'model_provider="sudo_session"'] }), undefined);
  assert.equal(await prepareCustomModelCatalog({ model: 'provider/gpt-6.1-sol-snapshot', providerArgs: ['-c', 'model_provider="sudo_session"'] }), undefined);
});

test('custom native catalog honors explicitly disabled vision and declared reasoning levels', async () => {
  const { prepareCustomModelCatalog } = await import('../src/model-catalog.mjs');
  const catalog = await prepareCustomModelCatalog({ model: 'fixture-vision-disabled', providerArgs: ['-c', 'model_provider="sudo_session"'], capabilities: { vision: false } });
  try {
    const value = JSON.parse(await readFile(catalog.path, 'utf8'));
    assert.deepEqual(value.models[0].input_modalities, ['text']);
    assert.deepEqual(value.models[0].supported_reasoning_levels, []);
  } finally { await catalog.cleanup(); }
});
