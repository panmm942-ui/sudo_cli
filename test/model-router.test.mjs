import test from 'node:test';
import assert from 'node:assert/strict';

async function api() {
  const module = await import('../src/model-router.mjs').catch(() => ({}));
  assert.equal(typeof module.routeModel, 'function', 'manual model routing API must exist');
  return module;
}
const profiles = [
  { name: 'current', model: 'full', baseUrl: 'https://example.com/v1', transport: 'responses' },
  { name: 'cheap', model: 'mini', baseUrl: 'https://other.example/v1', transport: 'chat-completions', pricing: { inputPerMillion: 1, outputPerMillion: 2 }, capabilities: { tools: true } },
  { name: 'local', model: 'local', baseUrl: 'http://127.0.0.1:1234/v1', transport: 'chat-completions' },
];

test('automatic routing is opt-in and manual model selection always wins', async () => {
  const { routeModel } = await api();
  assert.equal(routeModel({ profiles, currentProfile: profiles[0] }).profile.name, 'current');
  assert.equal(routeModel({ profiles, currentProfile: profiles[0], enabled: true, mode: 'local', manualProfile: 'cheap' }).profile.name, 'cheap');
  assert.throws(() => routeModel({ profiles, currentProfile: profiles[0], manualProfile: 'missing' }));
});

test('optional simple-task routing uses supplied prices or local endpoints and preserves unknown capability fallback', async () => {
  const { routeModel } = await api();
  assert.equal(routeModel({ profiles, currentProfile: profiles[0], enabled: true, mode: 'cheap', task: 'simple' }).profile.name, 'cheap');
  assert.equal(routeModel({ profiles, currentProfile: profiles[0], enabled: true, mode: 'local', task: 'simple' }).profile.name, 'local');
  assert.equal(routeModel({ profiles, currentProfile: profiles[0], enabled: true, mode: 'local', task: 'complex' }).profile.name, 'current');
  assert.equal(routeModel({ profiles, currentProfile: profiles[0], enabled: true, mode: 'local', requiredCapabilities: ['tools'] }).profile.name, 'current');
});

test('cheap routing never upgrades to a more expensive listed model or marks the same connection as switched', async () => {
  const { routeModel } = await api();
  const currentProfile = { ...profiles[0], pricing: { inputPerMillion: 0.1, outputPerMillion: 0.2 } };
  const result = routeModel({ profiles: profiles.slice(1), currentProfile, enabled: true });
  assert.equal(result.profile.name, 'current');
  const same = routeModel({ profiles: [{ ...profiles[1] }], currentProfile: { ...profiles[1] }, enabled: true });
  assert.equal(same.routed, false);
});

test('routing consumes canonical budget USD prices and manual changes report an actual switch', async () => {
  const { routeModel } = await api();
  const current = { ...profiles[0], pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 } };
  const cheap = { ...profiles[1], pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 } };
  assert.equal(routeModel({ profiles: [cheap], currentProfile: current, enabled: true }).profile, cheap);
  const manual = routeModel({ profiles: [cheap], currentProfile: current, manualProfile: 'cheap' });
  assert.equal(manual.profile, cheap);
  assert.equal(manual.routed, true);
  assert.match(manual.reason, /Manual/);
  assert.equal(routeModel({ profiles: [cheap], currentProfile: cheap, manualProfile: cheap }).routed, false);
});
