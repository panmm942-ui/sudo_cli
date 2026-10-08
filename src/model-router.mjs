import { validateConnection } from './runtime.mjs';
import { capabilityReport } from './provider-capabilities.mjs';

const isLocal = profile => {
  const host = new URL(profile.baseUrl).hostname;
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
};
const price = profile => {
  const rates = profile.pricing ?? {};
  const inputPerMillion = rates.inputUsdPerMillion ?? rates.inputPerMillion, outputPerMillion = rates.outputUsdPerMillion ?? rates.outputPerMillion;
  return [inputPerMillion, outputPerMillion].every(value => Number.isFinite(value) && value >= 0) ? inputPerMillion + outputPerMillion : null;
};
const sameConnection = (a, b) => ['model', 'transport', 'baseUrl'].every(key => a[key] === b[key]);

/** Explicit opt-in deterministic routing; metadata and overrides remain caller-owned. */
export function routeModel({ profiles = [], currentProfile, enabled = false, mode = 'cheap', task = 'simple', manualProfile, requiredCapabilities = [] } = {}) {
  if (!Array.isArray(profiles) || typeof enabled !== 'boolean' || !['cheap', 'local'].includes(mode) || !Array.isArray(requiredCapabilities)) throw new Error('Routing options are invalid.');
  validateConnection(currentProfile);
  for (const profile of profiles) validateConnection(profile);
  if (manualProfile !== undefined) {
    const chosen = typeof manualProfile === 'string' ? profiles.find(profile => profile.name === manualProfile) : manualProfile;
    if (!chosen) throw new Error('The manually selected model profile was not found.');
    validateConnection(chosen);
    return { profile: chosen, routed: !sameConnection(chosen, currentProfile), reason: 'Manual model selection takes precedence.' };
  }
  if (!enabled || task !== 'simple') return { profile: currentProfile, routed: false, reason: !enabled ? 'Automatic routing is disabled.' : 'The current model handles tasks not marked simple.' };
  const eligible = profile => requiredCapabilities.every(name => capabilityReport(profile).capabilities[name]?.supported === true);
  const candidates = [...profiles, currentProfile].filter(eligible);
  let chosen;
  if (mode === 'local') chosen = candidates.find(isLocal);
  else chosen = candidates.filter(profile => price(profile) !== null).sort((a, b) => price(a) - price(b))[0];
  return chosen ? { profile: chosen, routed: !sameConnection(chosen, currentProfile), reason: mode === 'local' ? 'Simple task routed to a configured loopback endpoint.' : 'Simple task routed using user-supplied token prices; actual cost depends on usage.' }
    : { profile: currentProfile, routed: false, reason: 'No eligible alternative has the required capability and routing metadata.' };
}
