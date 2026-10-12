import fs from "node:fs";
const env = { ...process.env };
for (const path of [".env", "config/.env", "config/settings.env"]) {
  if (!fs.existsSync(path)) continue;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}
const base = `http://127.0.0.1:${process.env.WEB_PORT || 9999}`;
const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
  body: new URLSearchParams({ username: env.SIGNMATE_AUTH_USERNAME || "admin", password: env.SIGNMATE_AUTH_PASSWORD || "" }) });
const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
const response = await fetch(`${base}/api/batch-state`, { headers: { Cookie: cookie }, redirect: "manual", signal: AbortSignal.timeout(10000) });
if (!response.ok) throw new Error("无法确认服务空闲：身份认证失败");
const batch = await response.json();
if (!batch.ok || batch.data?.active !== false) throw new Error("批量任务正在执行或状态未知，暂不部署");
const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) }).then(response => response.json());
if (health.activeCount > 0) throw new Error("单站任务正在执行，暂不部署");
console.log("idle");
