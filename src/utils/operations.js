import { randomUUID } from "node:crypto";
import { runtimeState } from "./runtime-state.js";

export function createOperations(state = runtimeState, now = Date.now) {
  const active = new Map();
  return {
    begin(site, source = "manual") {
      const run = { runId: randomUUID(), source, startedAt: new Date(now()).toISOString(), siteKey: site.key || site.driver };
      active.set(run.runId, run);
      return run;
    },
    finish(run, result, { record = true } = {}) {
      active.delete(run.runId);
      const endedAt = new Date(now()).toISOString();
      const previous = state.read().runs?.[run.siteKey] || {};
      const details = { ...result.details, ...run, endedAt, durationMs: Math.max(0, now() - Date.parse(run.startedAt)), retries: result.details?.retries || 0 };
      if (!record) return { ...result, details };
      state.update("runs", run.siteKey, {
        ...previous, ...run, endedAt, durationMs: details.durationMs, retries: details.retries, success: result.success === true,
        consecutiveFailures: result.success ? 0 : (previous.consecutiveFailures || 0) + 1,
        ...(result.success ? { lastSuccessAt: endedAt } : { lastFailureAt: endedAt }),
      });
      return { ...result, details };
    },
    active() { return [...active.values()].map(run => ({ ...run, stuck: now() - Date.parse(run.startedAt) > 30 * 60000 })); },
  };
}
export const operations = createOperations();

export function healthReport({ configOk, diskOk, browserOk, batch = {}, active = [], version, commit, startedAt }) {
  return {
    ok: Boolean(configOk && diskOk && browserOk), version, commit, startedAt,
    uptimeSeconds: Math.floor(process.uptime()), configOk, diskOk, browserOk,
    batchActive: batch.active === true, activeCount: active.length,
    stuckCount: active.filter(run => run.stuck).length,
  };
}
