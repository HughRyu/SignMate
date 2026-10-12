import { createHash } from "node:crypto";
import { runtimeState } from "./runtime-state.js";
import ForumVisitDriver from "../drivers/forum-visit.js";
import TiebaDriver from "../drivers/tieba.js";

export const credentialGeneration = credential => createHash("sha256").update(JSON.stringify(credential || {})).digest("hex");
export function classifySessionResult(result) {
  if (result.success === true || result.ok === true) return "verified";
  const message = result.message || "";
  if (/安全验证|人工|验证码|challenge/i.test(message)) return "challenge";
  if (/未登录|已失效|过期|重新登录|未配置/.test(message)) return "invalid";
  return "unconfirmed";
}
export function publicVerification(value, credential) {
  if (!value || value.generation !== credentialGeneration(credential)) return { status: "unverified" };
  return { status: value.status, checkedAt: value.checkedAt || null, syncedAt: value.syncedAt || null };
}

export function createVerificationQueue({ state = runtimeState, resolveSite = async site => site, probe = safeProbe } = {}) {
  let queue = Promise.resolve();
  return {
    enqueue(site, secrets) {
      const key = site.key || site.driver;
      const generation = credentialGeneration(secrets[key]);
      const pending = { generation, status: "pending", syncedAt: new Date().toISOString() };
      state.update("verification", key, pending);
      queue = queue.catch(() => {}).then(async () => {
        if (state.read().verification?.[key]?.generation !== generation) return;
        let status = "unconfirmed";
        try {
          if (!["forum-visit", "tieba"].includes(site.driver)) status = "unsupported";
          else if (site.enabled === false) status = "disabled";
          else status = await probe(await resolveSite(site), secrets);
        } catch { /* Never store exception text which may contain credentials. */ }
        if (state.read().verification?.[key]?.generation === generation) {
          state.update("verification", key, { ...pending, status, checkedAt: new Date().toISOString() });
        }
      });
      return queue;
    },
    drain() { return queue; },
  };
}

async function safeProbe(site, secrets) {
  if (site.site_offline) return "unconfirmed";
  if (site.driver === "forum-visit") {
    // This driver performs only GET requests, never签到/回帖/领奖.
    return classifySessionResult(await new ForumVisitDriver({ ...site, timeout: 10000, verify_only: true }, secrets).signIn());
  }
  if (site.driver === "tieba") {
    const driver = new TiebaDriver({ ...site, timeout: 10000 }, secrets);
    const cookie = driver.getCookie();
    return cookie ? classifySessionResult(await driver.validateLogin(cookie)) : "invalid";
  }
  return "unsupported";
}
