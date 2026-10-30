import { credentialGeneration } from "./session-verification.js";
import { runtimeState } from "./runtime-state.js";
import { testDirect, testProxy, testProxyPool } from "./proxy.js";

export const dayKey = (now = Date.now()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.TZ || "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(now));
const previousDay = day => new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

export function confirmedAuthFailure(result) {
  if (result.success || result.details?.failureType === "challenge") return false;
  if (result.details?.failureType) return result.details.failureType === "auth_expired";
  const text = String(result.message || "");
  // Missing credentials, network failures and speculative page mismatches are not expiry evidence.
  if (/验证码|安全验证|人工|challenge|HTTP\s*[45]\d\d|未配置|可能|未识别|不完整/i.test(text)) return false;
  return /(?:Cookie|登录态|凭据).*(?:已过期|已失效|无效)|请先登录|请重新登录|未登录/i.test(text);
}

export function createFailurePolicy({ state = runtimeState, now = Date.now, direct = testDirect, proxied = testProxy, pool = testProxyPool } = {}) {
  function read(key, credential) {
    const saved = state.read().failurePolicy?.[key] || {};
    const generation = credentialGeneration(credential);
    // Credential changes reset authentication and daily execution limits, never an offline disable.
    return saved.generation === generation ? saved : { generation, authFailures: 0, offline: saved.offline };
  }
  function save(key, credential, patch) { return state.update("failurePolicy", key, { ...read(key, credential), ...patch }); }
  function status(key, credential) {
    const s = read(key, credential), today = dayKey(now());
    return { authPaused: s.authFailures >= 3, authFailures: s.authFailures || 0,
      dailyRuns: s.day === today ? s.dailyRuns || 0 : 0, dailyLimit: 3,
      offlineDays: s.offline?.streak || 0, autoDisabled: !!s.offline?.disabledAt,
      offlineCheckedDay: s.offline?.day || null, offlineOutcome: s.offline?.outcome || null };
  }
  function gate(key, credential, automatic) {
    const s = status(key, credential);
    if (s.autoDisabled) return "连续三天直连及健康代理均不可达，已自动禁用；请在管理中手动启用";
    if (automatic && s.authPaused) return "连续三次确认登录失效，已暂停自动执行；请更新 Cookie";
    if (automatic && s.dailyRuns >= 3) return "今日已执行三次，自动补跑暂停至明日";
    return "";
  }
  function start(key, credential, automatic) {
    if (!automatic) return;
    const s = status(key, credential);
    save(key, credential, { day: dayKey(now()), dailyRuns: s.dailyRuns + 1 });
  }
  function record(key, credential, result) {
    const s = read(key, credential);
    const auth = confirmedAuthFailure(result);
    // A non-auth failure breaks the sequence but cannot clear an already-established pause.
    save(key, credential, { authFailures: result.success ? 0 : auth ? Math.min(3, (s.authFailures || 0) + 1) : s.authFailures >= 3 ? 3 : 0,
      ...(result.success ? { offline: { day: dayKey(now()), outcome: "reachable", streak: 0 } } : {}) });
    if (auth) state.update("verification", key, { generation: credentialGeneration(credential), status: "invalid", checkedAt: new Date(now()).toISOString() });
  }
  async function checkOffline(site, credential, proxy) {
    const key = site.key || site.driver, today = dayKey(now());
    const saved = read(key, credential).offline || {};
    if (saved.disabledAt || (saved.day === today && saved.outcome === "reachable")) return;
    const prior = saved.target === site.base_url ? saved : {};
    if (prior.day === today || prior.disabledAt) return;
    // Claim once per local day before I/O. An interrupted check is inconclusive, not an offline day.
    save(key, credential, { offline: { ...prior, target: site.base_url, day: today, outcome: "checking", streak: 0 } });
    let outcome = "inconclusive", rounds = 0;
    try {
      const target = new URL(site.base_url);
      if (!["http:", "https:"].includes(target.protocol) || !proxy?.urls?.length) return;
      const health = await pool(proxy.urls, proxy.testUrls, 8000);
      const route = health.usableUrls?.[0];
      if (!health.ok || !route) return;
      for (let round = 0; round < 3; round++) {
        const [a, b] = await Promise.all([direct(target.href, 8000), proxied(route, target.href, 10000)]);
        // Any HTTP response (including 403/429/5xx) proves the endpoint exists.
        if ([a, b].some(r => r.ok || r.reachable || Number(r.status) >= 100)) { outcome = "reachable"; return; }
        // Revalidate this exact proxy each round. A broken exit cannot condemn the site.
        const stillHealthy = await pool([route], proxy.testUrls, 8000);
        if (!stillHealthy.ok || !stillHealthy.usableUrls?.includes(route)) return;
        rounds++;
      }
      outcome = "unreachable";
    } catch { /* Unknown transport/config/probe errors do not qualify as offline. */ }
    finally {
      const streak = outcome === "unreachable" && rounds === 3 ? (prior.day === previousDay(today) && prior.outcome === "unreachable" ? prior.streak || 0 : 0) + 1 : 0;
      const current = state.read().failurePolicy?.[key]?.offline;
      // A manual enable during the probe cancels its old decision.
      if (current?.day === today && current.outcome === "checking" && current.target === site.base_url) {
        save(key, credential, { offline: { target: site.base_url, day: today, outcome, rounds, streak, ...(streak >= 3 ? { disabledAt: new Date(now()).toISOString() } : {}) } });
      }
    }
  }
  function enable(key) {
    const s = state.read().failurePolicy?.[key] || {};
    state.update("failurePolicy", key, { ...s, offline: {} });
  }
  return { status, gate, start, record, checkOffline, enable };
}
export const failurePolicy = createFailurePolicy();
