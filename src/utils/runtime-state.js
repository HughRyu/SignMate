import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Synchronous read/modify/atomic rename keeps updates serialized within the
// single service process. Runtime data never rewrites user configuration.
export function createRuntimeState(directory) {
  const path = join(directory, "runtime-state.json");
  function read() {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }
  return {
    read,
    update(section, key, value) {
      const data = read();
      data[section] = { ...(data[section] || {}), [key]: value };
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      return value;
    },
  };
}
export const runtimeState = createRuntimeState(process.env.SIGNMATE_DATA_DIR || join(import.meta.dirname, "../../data"));
export function fresh(at, now = Date.now(), ttl = 3 * 3600000) {
  const age = now - new Date(at).getTime();
  return Number.isFinite(age) && age >= 0 && age < ttl;
}
