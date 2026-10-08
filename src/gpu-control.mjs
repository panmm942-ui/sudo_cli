const controls = /[\u0000-\u001f\u007f]/;
const abortError = () => new DOMException('GPU operation was cancelled.', 'AbortError');
const states = ['running', 'stopped', 'deallocated', 'transitioning', 'unknown'];
const billingStates = ['active', 'storage-only', 'stopped', 'unknown'];
export function validateGpuHook(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || controls.test(value.url)) throw new Error('GPU hook configuration is invalid.');
  let url; try { url = new URL(value.url); } catch { throw new Error('GPU hook URL is invalid.'); }
  const loopback = ['localhost', '[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.username || url.password || value.url.includes('?') || value.url.includes('#') || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) throw new Error('GPU hook requires HTTPS or loopback HTTP without URL credentials, queries or fragments.');
  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || !value.apiKey || value.apiKey.length > 16384 || controls.test(value.apiKey))) throw new Error('GPU hook API key is invalid.');
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 120000)) throw new Error('GPU hook timeout is invalid.');
  return { url: url.toString(), ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }), ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }) };
}
export function validateGpuConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GPU controller configuration is invalid.');
  return Object.fromEntries(['wake', 'sleep', 'status'].map(name => [name, validateGpuHook(value[name])]).filter(([, hook]) => hook));
}
async function request(hook, { action, signal, fetchImpl = fetch } = {}) {
  if (signal?.aborted) throw abortError();
  hook = validateGpuHook(hook); if (!hook) throw new Error('No GPU hook is configured for this operation.');
  try {
    const timeout = AbortSignal.timeout(hook.timeoutMs ?? 15000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(hook.url, { method: action ? 'POST' : 'GET', redirect: 'error', signal: combined,
      headers: { ...(action ? { 'content-type': 'application/json' } : {}), ...(hook.apiKey ? { authorization: `Bearer ${hook.apiKey}` } : {}) }, ...(action ? { body: JSON.stringify({ action }) } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP'); }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 65536) { await response.body?.cancel().catch(() => {}); throw new Error('limit'); } chunks.push(Buffer.from(chunk)); }
    if (action) return { ok: true, status: response.status, acknowledged: true, verified: false, state: 'unknown', billing: 'unknown' };
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body) || !states.includes(body.state) || !billingStates.includes(body.billing ?? 'unknown')) throw new Error('status');
    return { state: body.state, billing: body.billing ?? 'unknown', verified: body.state !== 'unknown', ...(body.resourceId !== undefined && typeof body.resourceId === 'string' && body.resourceId.length <= 256 && !controls.test(body.resourceId) ? { resourceId: body.resourceId } : {}) };
  } catch { if (signal?.aborted) throw abortError(); throw new Error('GPU hook failed, timed out or returned invalid bounded state data. Check the configured service.'); }
}
export async function gpuCommand({ action = 'wake', signal, fetchImpl, ...hook } = {}) {
  if (!['wake', 'sleep'].includes(action)) throw new Error('GPU command action is invalid.');
  return request(hook, { action, signal, fetchImpl });
}
function pause(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => { const cancel = () => { clearTimeout(timer); reject(abortError()); }; const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms); signal?.addEventListener('abort', cancel, { once: true }); });
}

/** A command acknowledgement never becomes verified state. Only an explicit provider status does. */
export function createGpuController({ wake, sleep, status: statusHook, clock = Date.now, wait = pause, fetchImpl = fetch, pollMs = 1000, verifyTimeoutMs = 30000 } = {}) {
  const hooks = validateGpuConfig({ wake, sleep, status: statusHook });
  if (typeof clock !== 'function' || typeof wait !== 'function' || typeof fetchImpl !== 'function' || !Number.isSafeInteger(pollMs) || pollMs < 1 || !Number.isSafeInteger(verifyTimeoutMs) || verifyTimeoutMs < 1 || verifyTimeoutMs > 120000) throw new Error('GPU verification configuration is invalid.');
  let state = { state: 'unknown', billing: 'unknown', verified: false, observedAt: null }, transition;
  const snapshot = () => ({ ...state });
  async function status({ signal } = {}) {
    if (!hooks.status) return snapshot();
    try { const observed = await request(hooks.status, { signal, fetchImpl }); state = { ...observed, observedAt: new Date(clock()).toISOString() }; return snapshot(); }
    catch (error) { state = { state: 'unknown', billing: 'unknown', verified: false, observedAt: null }; throw error; }
  }
  async function command(action, { signal } = {}) {
    if (transition) throw new Error('A GPU lifecycle transition is already in progress.');
    transition = action; state = { state: 'unknown', billing: 'unknown', verified: false, observedAt: null };
    try {
      await request(hooks[action], { action, signal, fetchImpl });
      if (!hooks.status) return snapshot();
      const deadline = clock() + verifyTimeoutMs;
      const timed = AbortSignal.timeout(verifyTimeoutMs), combined = signal ? AbortSignal.any([signal, timed]) : timed;
      while (true) {
        const observed = await status({ signal: combined });
        if (action === 'wake' ? observed.state === 'running' : ['stopped', 'deallocated'].includes(observed.state)) return observed;
        if (clock() >= deadline) throw new Error('GPU transition was acknowledged but its actual resource state could not be verified.');
        await wait(Math.min(pollMs, Math.max(1, deadline - clock())), combined);
      }
    } catch (error) { state = { state: 'unknown', billing: 'unknown', verified: false, observedAt: null }; if (signal?.aborted) throw abortError(); throw error; }
    finally { transition = undefined; }
  }
  return { snapshot, status, wake: options => command('wake', options), sleep: options => command('sleep', options) };
}
