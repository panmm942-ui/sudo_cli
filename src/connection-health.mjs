import { performance } from 'node:perf_hooks';

const finiteLatency = (value) => Number.isFinite(value) && value >= 0;
const validId = (id) => (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
const latencyScore = (latencyMs) => Math.max(0, Math.min(100, 100 - Math.max(0, latencyMs - 2000) / 400));

/**
 * Observed response-health heuristic, not network bandwidth or provider availability.
 * Requests <= 2 seconds score 100; each additional 400 ms costs one point.
 * Failures score zero in a bounded recent window. Cancellation is excluded.
 * Unfinished first requests remain unmeasured for 5 seconds, then expose a
 * latency-only estimate that falls as the real pending wait grows.
 */
export function createConnectionHealth({ clock = () => performance.now(), historySize = 10 } = {}) {
  if (typeof clock !== 'function' || !Number.isSafeInteger(historySize) || historySize < 1 || historySize > 1000) {
    throw new Error('Connection health needs a clock and a positive bounded history size.');
  }
  const requests = new Map();
  const history = [];
  let lastTime = 0;
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value)) throw new Error('Connection health clock must return finite milliseconds.');
    lastTime = Math.max(lastTime, value);
    return lastTime;
  };
  const finish = (id, success, suppliedLatency) => {
    if (!requests.has(id)) return false;
    const request = requests.get(id);
    requests.delete(id);
    const latencyMs = finiteLatency(suppliedLatency) ? suppliedLatency : request.respondedLatency ?? now() - request.started;
    history.push({ latencyMs, score: success ? latencyScore(latencyMs) : 0 });
    if (history.length > historySize) history.shift();
    return true;
  };

  return {
    requestStarted(id) {
      if (!validId(id) || requests.has(id)) return false;
      requests.set(id, { started: now(), respondedLatency: null });
      return true;
    },
    requestResponding(id, { latencyMs } = {}) {
      const request = requests.get(id);
      if (!request || request.respondedLatency !== null) return false;
      request.respondedLatency = finiteLatency(latencyMs) ? latencyMs : now() - request.started;
      return true;
    },
    requestSucceeded(id, { latencyMs } = {}) { return finish(id, true, latencyMs); },
    requestFailed(id) { return finish(id, false); },
    requestCancelled(id) { return requests.delete(id); },
    snapshot() {
      const time = now();
      let pendingLatency = null;
      let pending = 0;
      const responding = [];
      for (const request of requests.values()) {
        if (request.respondedLatency === null) {
          pending++;
          pendingLatency = Math.max(pendingLatency ?? 0, time - request.started);
        } else responding.push(request.respondedLatency);
      }
      const scores = [...history.map((sample) => sample.score), ...responding.map(latencyScore)];
      let percent = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
      let source = percent === null ? 'unmeasured' : 'response-latency-and-errors';
      if (responding.length) source = 'first-response-latency-estimate';
      if (pendingLatency !== null && pendingLatency >= 5000) {
        percent = Math.min(percent ?? 100, latencyScore(pendingLatency));
        source = 'pending-latency-estimate';
      }
      percent = percent === null ? null : Math.round(percent);
      return {
        percent, label: percent === null ? 'Unmeasured' : percent > 70 ? 'Good' : percent > 50 ? 'Fair' : 'Poor',
        latencyMs: pendingLatency ?? (responding.length ? Math.max(...responding) : history.at(-1)?.latencyMs ?? null),
        pending, active: requests.size, samples: history.length, source,
      };
    },
  };
}
