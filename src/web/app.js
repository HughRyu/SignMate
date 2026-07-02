// =============================================================
// signmate · Dashboard App
// =============================================================

// ---- State ----
let isLoading = false;
let autoRefreshTimer = null;
let batchStateRefreshTimer = null;
let activeSiteCategory = "all";
let activeSiteKind = "all";
let activeSiteSearch = "";
let activeSiteResultFilter = "all";
let latestAllSites = [];
let batchRunState = { active: false };
const dismissedInterruptedBatchIds = new Set(JSON.parse(localStorage.getItem("dismissedInterruptedBatchIds") || "[]"));
const DEFAULT_CATEGORIES = [
  { key: "forum", label: "论坛", emoji: "💬" },
  { key: "pt", label: "PT站点", emoji: "📀" },
];
let siteCategories = [...DEFAULT_CATEGORIES];
let appSettings = { auth: {}, branding: { title: "SignMate" } };
const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const modalFocusState = new WeakMap();
let modalObserver = null;

function orderedCategories() {
  const homeOrder = ["forum", "pt"];
  const idx = key => {
    const i = homeOrder.indexOf(key);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...siteCategories].sort((a, b) => {
    const byHome = idx(a.key) - idx(b.key);
    if (byHome) return byHome;
    return String(a.label || a.key).localeCompare(String(b.label || b.key), "zh-Hans-CN", { sensitivity: "base" });
  });
}
const runningSites = new Map();

// ---- Init ----
document.addEventListener("DOMContentLoaded", () => {
  initModalAccessibility();
  loadAppSettings().catch(() => {});
  updateClock();
  refreshNavTimeTooltip();
  setInterval(updateClock, 1000);
  setInterval(refreshNavTimeTooltip, 60000);

  document.querySelector(".nav-brand")?.addEventListener("dblclick", () => {
    window.open("https://github.com/HughRyu/SignMate", "_blank", "noopener,noreferrer");
  });

  // Tab switching
  document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Manual trigger
  document.querySelector(".site-category-actions")?.addEventListener("click", event => {
    const kindBtn = event.target.closest(".site-kind-filter");
    if (kindBtn) {
      const kind = kindBtn.dataset.kind || "all";
      activeSiteKind = activeSiteKind === kind ? "all" : kind;
      loadSites(true);
      return;
    }
    const btn = event.target.closest(".site-category-filter");
    if (!btn) return;
    activeSiteCategory = btn.dataset.category || "all";
    if (activeSiteCategory === "all") activeSiteKind = "all";
    loadSites(true);
  });
  document.getElementById("homeSiteSearch")?.addEventListener("input", event => {
    activeSiteSearch = event.target.value || "";
    updateHomeSearchClear();
    loadSites(true);
  });
  document.getElementById("homeSiteSearchClear")?.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const search = document.getElementById("homeSiteSearch");
    if (!search) return;
    search.value = "";
    activeSiteSearch = "";
    updateHomeSearchClear();
    search.focus();
    loadSites(true);
  });
  document.getElementById("navSuccessFilter")?.addEventListener("click", (event) => {
    const nextFilter = activeSiteResultFilter === "success" ? "all" : "success";
    const cls = nextFilter === "success" ? "clicked" : "unclicked";
    event.currentTarget?.classList.add(cls);
    window.setTimeout(() => event.currentTarget?.classList.remove(cls), 220);
    activeSiteResultFilter = nextFilter;
    switchTab("sites");
    loadSites(true);
  });
  document.getElementById("navFailedFilter")?.addEventListener("click", (event) => {
    const nextFilter = activeSiteResultFilter === "failed" ? "all" : "failed";
    const cls = nextFilter === "failed" ? "clicked" : "unclicked";
    event.currentTarget?.classList.add(cls);
    window.setTimeout(() => event.currentTarget?.classList.remove(cls), 220);
    activeSiteResultFilter = nextFilter;
    switchTab("sites");
    loadSites(true);
  });
  document.querySelectorAll(".nav-kind-filter").forEach(btn => {
    btn.addEventListener("click", (event) => {
      const kind = event.currentTarget?.dataset.kind || "all";
      const nextKind = activeSiteKind === kind ? "all" : kind;
      const cls = nextKind === kind ? "clicked" : "unclicked";
      event.currentTarget?.classList.add(cls);
      window.setTimeout(() => event.currentTarget?.classList.remove(cls), 220);
      activeSiteKind = nextKind;
      switchTab("sites");
      loadSites(true);
    });
  });
  document.querySelector(".nav-stats-strip")?.addEventListener("click", event => {
    const allBtn = event.target.closest(".nav-all-filter");
    if (!allBtn) return;
    event.preventDefault();
    event.stopPropagation();
    allBtn.classList.add("clicked");
    window.setTimeout(() => allBtn.classList.remove("clicked"), 220);
    resetSiteViewToAll();
  });
  document.addEventListener("mousedown", event => {
    if (event.detail >= 2 && isBlankSiteFilterResetTarget(event.target)) {
      event.preventDefault();
      clearTextSelectionSoon();
    }
  }, true);
  document.addEventListener("dblclick", event => {
    if (isBlankSiteFilterResetTarget(event.target)) {
      event.preventDefault();
      clearTextSelectionSoon();
      resetSiteViewToAll({ clearSearch: true });
    }
  });
  document.addEventListener("click", event => {
    const dismissBtn = event.target.closest("#btnDismissBatchProgress");
    if (dismissBtn) {
      if (batchRunState?.id) {
        dismissedInterruptedBatchIds.add(batchRunState.id);
        localStorage.setItem("dismissedInterruptedBatchIds", JSON.stringify([...dismissedInterruptedBatchIds]));
      }
      batchRunState = { active: false };
      renderBatchProgress(latestAllSites);
      return;
    }
    if (event.target.closest("#btnCancelBatchProgress")) {
      cancelBatchRun();
      return;
    }
    if (event.target.closest("#btnResumeBatchProgress")) {
      resumeInterruptedBatch();
      return;
    }
  });
  document.getElementById("btnRunAll")?.addEventListener("click", triggerAll);
  document.getElementById("btnQuickCookieSync")?.addEventListener("click", quickCookieCloudSync);
  document.getElementById("btnQuickCookieSyncMobile")?.addEventListener("click", quickCookieCloudSync);
  document.getElementById("btnManageSites")?.addEventListener("click", () => openSiteManageModal("all"));
  document.getElementById("btnRefreshHistory")?.addEventListener("click", () => loadHistory());
  document.getElementById("btnClearHistory")?.addEventListener("click", clearHistory);
  document.getElementById("btnRefreshLogs")?.addEventListener("click", () => loadLogs());
  document.getElementById("btnRefreshCredentials")?.addEventListener("click", () => loadCredentials());
  document.getElementById("proxyForm")?.addEventListener("submit", saveProxySettings);
  document.getElementById("btnReloadProxy")?.addEventListener("click", () => loadProxySettings());
  document.getElementById("btnTestProxy")?.addEventListener("click", testProxySettings);
  document.getElementById("proxyTestClose")?.addEventListener("click", closeProxyTestModal);
  document.getElementById("proxyTestModal")?.addEventListener("click", (event) => { if (event.target.id === "proxyTestModal") closeProxyTestModal(); });
  document.getElementById("notifyForm")?.addEventListener("submit", saveNotifySettings);
  document.getElementById("btnReloadNotify")?.addEventListener("click", () => loadNotifySettings());
  document.getElementById("btnTestNotify")?.addEventListener("click", testNotifySettings);

  // Load initial data
  loadCategories().finally(async () => {
    await loadSites();
    await refreshBackendBatchState();
  });
  autoRefreshTimer = setInterval(() => {
    if (document.getElementById("tab-sites").classList.contains("active")) {
      loadSites(true).finally(() => refreshBackendBatchState(true));
    }
    if (document.getElementById("tab-logs")?.classList.contains("active")) {
      loadLogs(true);
    }
  }, 30000);
  batchStateRefreshTimer = setInterval(() => {
    refreshBackendBatchState(true);
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshBackendBatchState(true);
  });
});


function updateHomeSearchClear() {
  const search = document.getElementById("homeSiteSearch");
  const clear = document.getElementById("homeSiteSearchClear");
  if (!clear) return;
  clear.hidden = !String(search?.value || activeSiteSearch || "").trim();
}

function clearSiteFilters({ clearSearch = false } = {}) {
  activeSiteKind = "all";
  activeSiteCategory = "all";
  activeSiteResultFilter = "all";
  if (clearSearch) {
    activeSiteSearch = "";
    const search = document.getElementById("homeSiteSearch");
    if (search) search.value = "";
    updateHomeSearchClear();
  }
}

function clearTextSelectionSoon() {
  const clear = () => {
    try { window.getSelection?.()?.removeAllRanges?.(); } catch {}
  };
  clear();
  window.setTimeout(clear, 0);
  window.setTimeout(clear, 60);
}

function isBlankSiteFilterResetTarget(target) {
  return !target?.closest?.(".site-card, .modal, .nav, .nav-status-area, .home-site-search-bar, .batch-progress, button, input, select, textarea, a, label, [contenteditable='true']");
}

function resetSiteViewToAll({ clearSearch = false } = {}) {
  clearSiteFilters({ clearSearch });
  clearTextSelectionSoon();
  switchTab("sites");
  loadSites(true);
}

function initModalAccessibility() {
  if (modalObserver) return;
  document.querySelectorAll(".modal-backdrop").forEach(enhanceModalAccessibility);
  modalObserver = new MutationObserver(records => {
    records.forEach(record => {
      record.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(".modal-backdrop")) enhanceModalAccessibility(node);
        node.querySelectorAll?.(".modal-backdrop").forEach(enhanceModalAccessibility);
      });
      record.removedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(".modal-backdrop")) restoreModalFocus(node);
        node.querySelectorAll?.(".modal-backdrop").forEach(restoreModalFocus);
      });
    });
  });
  modalObserver.observe(document.body, { childList: true, subtree: true });
}

function enhanceModalAccessibility(modal) {
  if (!modal || modalFocusState.has(modal)) return;
  const dialog = modal.querySelector('[role="dialog"], .modal-card');
  if (!dialog) return;
  if (!dialog.hasAttribute("role")) dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");

  modalFocusState.set(modal, { previouslyFocused: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  window.setTimeout(() => focusFirstModalElement(modal), 0);
}

function modalStack() {
  return Array.from(document.querySelectorAll(".modal-backdrop"));
}

function isTopModal(modal) {
  const stack = modalStack();
  return stack[stack.length - 1] === modal;
}

function modalFocusableElements(modal) {
  return Array.from(modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR))
    .filter(element => {
      if (element.hasAttribute("hidden")) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    });
}

function focusFirstModalElement(modal) {
  const focusable = modalFocusableElements(modal);
  const preferred = modal.querySelector("[autofocus], .modal-close, .site-manage-search, input, select, textarea, button");
  const target = focusable.includes(preferred) ? preferred : (focusable[0] || modal.querySelector('[role="dialog"], .modal-card'));
  target?.focus?.({ preventScroll: true });
}

function restoreModalFocus(modal) {
  const state = modalFocusState.get(modal);
  modalFocusState.delete(modal);
  if (!state?.previouslyFocused?.isConnected) return;
  window.setTimeout(() => state.previouslyFocused.focus?.({ preventScroll: true }), 0);
}

document.addEventListener("keydown", event => {
  const stack = modalStack();
  const modal = stack[stack.length - 1];
  if (!modal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    modal.querySelector(".modal-close")?.click?.() || modal.remove();
    return;
  }
  if (event.key !== "Tab" || !isTopModal(modal)) return;
  const focusable = modalFocusableElements(modal);
  if (!focusable.length) {
    event.preventDefault();
    modal.querySelector('[role="dialog"], .modal-card')?.focus?.({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}, true);

// ---- Clock ----
function updateClock() {
  const el = document.getElementById("navTime");
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function formatShortDateTime(value, { withYear = false } = {}) {
  if (!value) return "暂无";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "暂无";
  return d.toLocaleString("zh-CN", { hour12: false, ...(withYear ? { year: "numeric" } : {}), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}


function formatDuration(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "暂无";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
}

function scheduleModeLabel(mode = "") {
  if (mode === "fixed" || mode === "batch") return "自动";
  if (mode === "random") return "自动随机";
  if (mode === "manual") return "手动";
  return "最近";
}

function batchSettingText(data = {}, actualMode = "") {
  const configuredMode = data?.mode || actualMode || "";
  if (configuredMode === "fixed") return `${data?.fixed?.dueTime || "--:--"}`;
  if (configuredMode === "random") {
    const due = data?.random?.dueTime && !String(data.random.dueTime).includes("跳过") ? `；今日 ${data.random.dueTime}` : "";
    return `${data?.randomStart || "02:00"} - ${data?.randomEnd || "22:00"} 随机${due}`;
  }
  if (configuredMode === "independent") return "独立执行";
  return "暂无";
}

function signinPauseText(value = "") {
  if (value === "manual") return "，手动暂停";
  if (value === "unexpected") return "，意外暂停";
  return "";
}

function executionMethodShort(site = {}) {
  const method = String(site.executionMethod || "").toLowerCase();
  if (method === "hybrid") return "A+B";
  if (method === "api") return "API";
  if (method === "browser") return "BR";
  if (method === "api-first") return "A→B";
  const label = site.executionMethodLabel || "Auto";
  if (/API\+Browser/i.test(label)) return "A+B";
  if (/Browser/i.test(label)) return "BR";
  if (/API-first|API 优先/i.test(label)) return "A→B";
  return label;
}

function executionMethodFullLabel(site = {}) {
  const method = String(site.executionMethod || "").toLowerCase();
  if (method === "hybrid") return "API+Browser";
  if (method === "api") return "API";
  if (method === "browser") return "Browser";
  if (method === "api-first") return "API-first";
  return site.executionMethodLabel || executionMethodShort(site) || "Auto";
}

function executionMethodTitle(site = {}) {
  const shortLabel = executionMethodShort(site);
  const fullLabel = executionMethodFullLabel(site);
  const alias = shortLabel !== fullLabel ? `${shortLabel} = ${fullLabel}` : fullLabel;
  const action = site.details?.checkinAction ? `；本次动作：${site.details.checkinAction}` : "";
  return `执行方式：${alias}${action}`;
}

function lastRunScheduleTitle(site = {}, recentLabel = "最近执行") {
  if (!site.lastTime) return `暂无${recentLabel.replace(/^最近/, "")}记录`;
  const mode = site.details?.scheduleMode || site.scheduleMode || "";
  const time = new Date(site.lastTime).toLocaleString("zh-CN", { hour12: false });
  return `${scheduleModeLabel(mode)}时间：${time}`;
}

async function refreshNavTimeTooltip() {
  const el = document.getElementById("navTime");
  if (!el) return;
  const emptyTitle = ["签到/保活状态：已签到 0", "批量执行时间：暂无", "批量执行设定：暂无", "总签到用时：暂无", "成功 0", "失败 0"].join("\n");
  try {
    const { data } = await api("/api/batch-summary");
    const latest = data?.activeBatch?.active ? data.activeBatch : (data?.latestBatch || data?.latestScheduled || data?.latest?.signin || data?.latest?.visit || null);
    if (!latest?.time && !latest?.startedAt) {
      el.title = emptyTitle;
      return;
    }
    const actualMode = latest.mode || data?.mode || "";
    const modeLabel = scheduleModeLabel(actualMode);
    const eventTime = latest.time || latest.completedAt || latest.startedAt;
    const success = Number(latest.success ?? 0);
    const failed = Number(latest.failed ?? 0);
    const signed = Number(data?.signinStatus?.signed ?? latest.signinSuccess ?? 0);
    const signedTotal = Number(data?.signinStatus?.total ?? latest.signinTotal ?? 0);
    const pause = data?.activeBatch?.pause || data?.signinStatus?.pause || latest.signinPause || "";
    const signedText = Number.isFinite(signedTotal) && signedTotal > 0 ? `${signed}/${signedTotal}` : `${Number.isFinite(signed) ? signed : 0}`;
    el.title = [
      `签到/保活状态：已签到 ${signedText}${signinPauseText(pause)}`,
      `批量执行时间：${formatShortDateTime(eventTime, { withYear: true })}（${modeLabel}）`,
      `批量执行设定：${batchSettingText(data, actualMode)}`,
      `总签到用时：${formatDuration(latest.durationMs)}`,
      `成功 ${Number.isFinite(success) ? success : 0}`,
      `失败 ${Number.isFinite(failed) ? failed : 0}`,
    ].join("\n");
  } catch {
    el.title = emptyTitle;
  }
}

// ---- Tabs ----
function switchTab(tab) {
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));

  const btn = document.querySelector(`[data-tab="${tab}"]`);
  const content = document.getElementById(`tab-${tab}`);
  if (btn) btn.classList.add("active");
  if (content) content.classList.add("active");

  if (tab === "sites") loadSites(true);
  if (tab === "history") loadHistory();
  if (tab === "proxy") loadProxySettings();
  if (tab === "notify") loadNotifySettings();
  if (tab === "logs") loadLogs();
  if (tab === "maintenance") loadMaintenancePage();
}

// ---- API helpers ----
async function loadAppSettings() {
  const { data } = await api("/api/app-settings");
  appSettings = data || appSettings;
  applyBranding(appSettings.branding || {});
}

function applyBranding(branding = {}) {
  const title = branding.title || "SignMate";
  const titleEl = document.querySelector(".nav-title");
  if (titleEl) titleEl.textContent = title;
  document.title = `${title} · 自动签到中心`;
  const logoEl = document.querySelector(".nav-logo");
  if (logoEl && !logoEl.querySelector("img")) logoEl.innerHTML = '<img src="/logo.jpg?v=20260702-logo-jpg" alt="SignMate Logo">';
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("请先登录");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function postJsonFireAndForget(url, body = null) {
  const options = { method: "POST", keepalive: true };
  if (body !== null) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  fetch(url, options).catch(() => {});
}

// ---- Toast ----
let toastTimer;
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  clearTimeout(toastTimer);
  el.textContent = msg;
  el.className = `toast ${type}`;
  // Force reflow
  void el.offsetWidth;
  el.classList.add("show");
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

// ---- Load Sites ----
async function loadSites(silent = false) {
  const grid = document.getElementById("sitesGrid");
  const summary = document.getElementById("sitesSummary");
  const btnAll = document.getElementById("btnRunAll");

  try {
    const { data } = await api("/api/sites");
    const allSites = data || [];
    latestAllSites = allSites;
    renderBatchProgress(allSites);
    if (allSites.length === 0) {
      const navSiteTotal = document.getElementById("navSiteTotal");
      const navSiteEnabled = document.getElementById("navSiteEnabled");
      if (navSiteTotal) navSiteTotal.textContent = "0";
      if (navSiteEnabled) navSiteEnabled.textContent = "0";
      const navSigninTotal = document.getElementById("navSigninTotal");
      const navVisitTotal = document.getElementById("navVisitTotal");
      const navSuccessCount = document.getElementById("navSuccessCount");
      const navFailedCount = document.getElementById("navFailedCount");
      const navSuccessFilter = document.getElementById("navSuccessFilter");
      const navFailedFilter = document.getElementById("navFailedFilter");
      const navSigninFilter = document.getElementById("navSigninFilter");
      const navVisitFilter = document.getElementById("navVisitFilter");
      if (navSigninTotal) navSigninTotal.textContent = "0";
      if (navVisitTotal) navVisitTotal.textContent = "0";
      if (navSuccessCount) navSuccessCount.textContent = "0";
      if (navFailedCount) navFailedCount.textContent = "0";
      if (navSuccessFilter) navSuccessFilter.classList.remove("active");
      if (navFailedFilter) navFailedFilter.classList.remove("active");
      if (navSigninFilter) navSigninFilter.classList.remove("active");
      if (navVisitFilter) navVisitFilter.classList.remove("active");
      if (grid) grid.innerHTML = `<div class="card"><div class="empty-cell">暂未配置站点</div></div>`;
      if (btnAll) btnAll.disabled = true;
      return;
    }

    const siteKindOf = site => site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin");
    const enabledSites = allSites.filter(site => site.enabled);
    const signinSites = enabledSites.filter(site => siteKindOf(site) === "signin");
    const keepaliveSites = enabledSites.filter(site => siteKindOf(site) === "visit");
    const enabled = enabledSites.length;
    const total = allSites.length;
    const failedCount = enabledSites.filter(s => s.lastSuccess === false).length;
    const successCount = enabledSites.filter(s => s.lastSuccess === true).length;
    const navSiteTotal = document.getElementById("navSiteTotal");
    const navSiteEnabled = document.getElementById("navSiteEnabled");
    const navSigninTotal = document.getElementById("navSigninTotal");
    const navVisitTotal = document.getElementById("navVisitTotal");
    const navSuccessCount = document.getElementById("navSuccessCount");
    const navFailedCount = document.getElementById("navFailedCount");
    const navSuccessFilter = document.getElementById("navSuccessFilter");
    const navFailedFilter = document.getElementById("navFailedFilter");
    const navSigninFilter = document.getElementById("navSigninFilter");
    const navVisitFilter = document.getElementById("navVisitFilter");
    if (navSiteTotal) navSiteTotal.textContent = String(total);
    if (navSiteEnabled) navSiteEnabled.textContent = total > 0 && enabled === total ? "ALL" : String(enabled);
    if (navSigninTotal) navSigninTotal.textContent = String(signinSites.length);
    if (navVisitTotal) navVisitTotal.textContent = String(keepaliveSites.length);
    if (navSuccessCount) navSuccessCount.textContent = enabled > 0 && failedCount === 0 && successCount === enabled ? "ALL" : String(successCount);
    if (navFailedCount) navFailedCount.textContent = String(failedCount);
    if (navSuccessFilter) {
      navSuccessFilter.classList.toggle("active", activeSiteResultFilter === "success");
      navSuccessFilter.disabled = false;
    }
    if (navFailedFilter) {
      navFailedFilter.classList.toggle("active", activeSiteResultFilter === "failed");
      navFailedFilter.disabled = false;
    }
    if (navSigninFilter) {
      navSigninFilter.classList.toggle("active", activeSiteKind === "signin");
      navSigninFilter.disabled = false;
    }
    if (navVisitFilter) {
      navVisitFilter.classList.toggle("active", activeSiteKind === "visit");
      navVisitFilter.disabled = false;
    }
    if (summary) summary.textContent = "";

    const sortByName = (a, b) => displaySiteName(a.name).localeCompare(displaySiteName(b.name), "zh-Hans-CN", { sensitivity: "base" });
    const sortedSites = [...allSites].sort(sortByName);
    const sortedVisibleSites = allSites.filter(site => site.enabled).sort(sortByName);
    const kindFilteredSites = activeSiteKind === "all" ? sortedVisibleSites : sortedVisibleSites.filter(site => site.enabled && siteKindOf(site) === activeSiteKind);
    const categoryFilteredSites = activeSiteCategory === "all" ? kindFilteredSites : kindFilteredSites.filter(site => (site.category || "forum") === activeSiteCategory);
    const resultFilteredSites = activeSiteResultFilter === "failed"
      ? categoryFilteredSites.filter(site => site.enabled && site.lastSuccess === false)
      : (activeSiteResultFilter === "success" ? categoryFilteredSites.filter(site => site.enabled && site.lastSuccess === true) : categoryFilteredSites);
    const query = String(activeSiteSearch || "").trim().toLowerCase();
    const visibleSites = !query ? resultFilteredSites : resultFilteredSites.filter(site => {
      const haystack = [site.key, site.name, site.note, categoryLabel(site.category || "forum"), site.baseUrl || site.base_url, site.driver].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
    document.querySelectorAll(".site-category-filter").forEach(btn => btn.classList.toggle("active", (btn.dataset.category || "all") === activeSiteCategory));
    document.querySelectorAll(".site-kind-filter").forEach(btn => btn.classList.toggle("active", (btn.dataset.kind || "all") === activeSiteKind));
    const renderSiteForCard = site => runningSites.get(site.key) ? { ...site, _running: true, lastSuccess: null, lastMessage: runningSites.get(site.key).text || "执行中…" } : site;
    const emptyMessage = activeSiteResultFilter === "failed" ? "当前没有失败站点" : (activeSiteResultFilter === "success" ? "当前没有成功站点" : (query ? "没有匹配的站点" : "当前分类暂无站点"));
    if (grid) grid.innerHTML = visibleSites.length ? visibleSites.map(site => buildSiteCard(renderSiteForCard(site))).join("") : `<div class="card"><div class="empty-cell">${emptyMessage}</div></div>`;

    sortedSites.forEach(site => {
      const siteKind = siteKindOf(site);
      const btn = document.getElementById(`signin-${site.key}`);
      if (btn && site.enabled) btn.addEventListener("click", () => triggerSingle(site.key, site.name, siteKind));

      const toggle = document.getElementById(`toggle-${site.key}`);
      if (toggle) toggle.addEventListener("click", () => toggleSite(site.key, !site.enabled));

      const credentialBtn = document.getElementById(`credential-${site.key}`);
      if (credentialBtn) {
        credentialBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          openCredentialModal(site.key, site.name);
        });
      }

      const card = document.getElementById(`card-${site.key}`);
      if (card && Array.isArray(site.steps) && site.steps.length) {
        card.querySelectorAll(".aggregate-metrics, .site-card-status").forEach(area => {
          area.classList.add("process-click-area");
          area.addEventListener("click", (event) => {
            if (event.target.closest("button, a, input, select, textarea, form")) return;
            event.stopPropagation();
            openProcessModal(site);
          });
        });
      }
      const title = card?.querySelector(".site-card-name");
      if (title) {
        title.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          const url = title.dataset.siteUrl || site.baseUrl || site.base_url;
          if (url) window.open(url, "_blank", "noopener,noreferrer");
        });
      }
    });

    if (btnAll) btnAll.disabled = signinSites.length === 0;
  } catch (err) {
    if (!silent) showToast(`加载失败: ${err.message}`, "error");
    if (grid) grid.innerHTML = `<div class="card"><div class="empty-cell">加载失败: ${esc(err.message)}</div></div>`;
  }
}

async function getProxySummaryText() {
  try {
    const { data } = await api("/api/proxy");
    if (!data.enabled) return "代理：全局关闭";
    const autoCount = data.sites.filter(s => s.proxyMode === "auto").length;
    const onCount = data.sites.filter(s => s.proxyMode === "on").length;
    const offCount = data.sites.filter(s => s.proxyMode === "off").length;
    return `代理：已开启（自动 ${autoCount} / 强制 ${onCount} / 直连 ${offCount}）`;
  } catch {
    return "代理：状态未知";
  }
}

function formatStepList(steps = [], overallSuccess = false) {
  if (!Array.isArray(steps) || !steps.length) {
    return `<div class="empty-cell">暂无执行过程</div>`;
  }
  const laterConfirmed = overallSuccess && steps.some(step => step?.ok !== false && /执行签到|检查签到状态|读取 PT 账号信息/.test(`${step?.label || ""}`) && /签到|本次获得|魔力|已确认/.test(`${step?.detail || ""}`));
  const visibleSteps = laterConfirmed
    ? steps.filter(step => !(step?.ok === false && /Cloudflare Turnstile|验证 token/.test(`${step.label || ""} ${step.detail || ""}`)))
    : steps;
  if (!visibleSteps.length) return `<div class="empty-cell">暂无执行过程</div>`;
  return `<div class="site-steps detail-steps">
    ${visibleSteps.map((step, index) => `
      <div class="site-step ${step.ok === false ? "fail" : "ok"}">
        <span>${step.ok === false ? "❌" : "✅"}</span>
        <div>
          <strong>${index + 1}. ${esc(step.label || "执行步骤")}</strong>
          ${step.status ? `<small>HTTP 状态：${esc(String(step.status))}</small>` : ""}
          ${step.detail ? `<small>${esc(step.detail)}</small>` : ""}
        </div>
      </div>
    `).join("")}
  </div>`;
}

function formatDetailValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function formatDetailHtml(value) {
  const text = formatDetailValue(value);
  const linkOnly = String(text).match(/^\[([^\]]{1,80})\]\((https?:\/\/[^\s)]+)\)$/);
  if (linkOnly) return `<a href="${escAttr(linkOnly[2])}" target="_blank" rel="noopener noreferrer">${esc(linkOnly[1])}</a>`;
  const raw = String(text);
  const re = /\[([^\]]{1,80})\]\((https?:\/\/[^\s)]+)\)/g;
  let html = "";
  let last = 0;
  let match;
  while ((match = re.exec(raw))) {
    html += esc(raw.slice(last, match.index));
    html += `<a href="${escAttr(match[2])}" target="_blank" rel="noopener noreferrer">${esc(match[1])}</a>`;
    last = match.index + match[0].length;
  }
  return html ? html + esc(raw.slice(last)) : esc(raw);
}

function detailLabel(key = "") {
  const labels = {
    signTime: "签到时间", pageTitle: "页面标题", alreadySigned: "已签到", reward: "奖励", rewardPoints: "奖励积分", rewardPbCoins: "奖励 PB币",
    streakDays: "连续签到", totalDays: "累计签到/访问", totalPoints: "总积分", totalPbCoins: "PB币", dailyTask: "每日打卡", replyTask: "回帖打卡", rewardCopper: "奖励铜币",
    totalGold: "金币", totalSilver: "银币", totalCopper: "铜币", rewardChickenLegs: "奖励鸡腿", totalChickenLegs: "总鸡腿",
    nodeSeekLevel: "NodeSeek 等级", nodeSeekLevelProgress: "等级进度", attendanceRank: "签到排名", attendanceTotalParticipants: "参与人数",
    username: "用户名", totalEnergy: "总能量", rewardEnergy: "今日能量", postCount: "帖子", likesReceived: "获赞", trustLevel: "信任等级",
    proxyModeUsed: "代理模式", proxyUsed: "是否使用代理", proxyReason: "代理原因", verificationBlocked: "需要验证",
    totalForums: "贴吧总数", tiebaTotalForums: "贴吧总数", successCount: "贴吧签到成功", tiebaSuccessCount: "贴吧签到成功", alreadySignedCount: "贴吧已签到", tiebaAlreadySignedCount: "贴吧已签到", shieldedCount: "贴吧屏蔽", tiebaShieldedCount: "贴吧屏蔽", failedCount: "贴吧失败", tiebaFailedCount: "贴吧失败",
    bonus: "魔力值", bonusGain: "签到获得", ratio: "分享率", upload: "上传", download: "下载", invite: "邀请", rewardName: "奖励名称",
    qianmojuPoints: "铜币总数", qianmojuRewardAmount: "签到铜币", qianmojuRewardUnit: "奖励单位", qianmojuLevel: "用户组", monthDays: "月签到", signText: "SignText", checkinAction: "签到动作", addup: "总签到", cons: "连续签到", rewardAmount: "签到奖励", rewardUnit: "奖励单位", nextRewardAmount: "明日奖励", userGroup: "用户组", experience: "总经验", totalExp: "总经验", vitality: "活力"
  };
  return labels[key] || key;
}

function detailVisualLineCount(value = "") {
  const text = String(formatDetailValue(value) || "").trim();
  if (!text) return 0;
  const explicitLines = text.split(String.fromCharCode(10)).length;
  const punctuationLines = text.split(/[。；;]/).filter(Boolean).length;
  const estimatedWrapLines = Math.ceil(text.length / 42);
  return Math.max(explicitLines, punctuationLines, estimatedWrapLines);
}

function formatDetailsPanel(details = {}) {
  const entries = Object.entries(details || {}).filter(([key, value]) => !["rawStatsText"].includes(key) && value !== undefined && value !== null && value !== "");
  if (!entries.length) return "";
  const folded = entries.length > 12;
  const rows = entries.map(([key, value], index) => {
    const lineCount = detailVisualLineCount(value);
    const isLongText = lineCount > 3 || String(value).length > 420;
    const extraClass = index >= 12 ? "extra-detail-row" : "";
    return `<div class="process-detail-row ${extraClass} ${isLongText ? "long-text-row" : ""}" data-lines="${lineCount}"><span>${esc(detailLabel(key))}</span><code class="${isLongText ? "collapsible-detail" : ""}" title="${isLongText ? "双击展开/收起全部内容" : ""}">${formatDetailHtml(value)}</code></div>`;
  }).join("");
  return `<div class="process-details-panel ${folded ? "is-folded" : ""}"><div class="process-details-title-row"><h4>详细信息</h4>${folded ? `<button class="detail-expand-btn" type="button" data-action="toggle-details">展开全部 ${entries.length} 项</button>` : ""}</div><div class="process-detail-grid">${rows}</div></div>`;
}

function displaySiteName(name = "") {
  return String(name || "")
    .replace(/\s*每日签到\s*/g, "")
    .replace(/\s*每日访问\s*/g, "")
    .trim();
}


function siteKindOf(site = {}) {
  if (site.enforced_kind === "visit" || site.enforcedKind === "visit") return "visit";
  return site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin");
}

function adaptedKindOf(site = {}) {
  if (site.enforced_kind === "visit" || site.enforcedKind === "visit") return "visit";
  if (site.adaptedKind) return site.adaptedKind;
  if (site.kind === "visit") return "visit";
  if (site.driver === "website" || site.driver === "visit") return "visit";
  if (/保活|访问|每日访问|Cookie\s*检查/i.test(`${site.note || ""} ${site.name || ""}`)) return "visit";
  return "signin";
}

function driverKindIcon(site = {}) {
  return adaptedKindOf(site) === "visit" ? "🌤️" : "✅";
}

function kindLabel(kind = "signin") {
  if (kind === "visit") return "保活";
  if (kind === "disabled") return "禁用";
  return "签到";
}

function siteSortName(site = {}) {
  return displaySiteName(site.name || site.note || site.key || "");
}

function sortSitesForManage(sites = [], sortKey = "name", dir = "asc") {
  const factor = dir === "desc" ? -1 : 1;
  const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
  const valueOf = (site) => {
    if (sortKey === "kind") {
      const kind = site.enabled ? siteKindOf(site) : "disabled";
      return kind === "signin" ? "0-签到" : kind === "visit" ? "1-保活" : "2-禁用";
    }
    if (sortKey === "category") return categoryLabel(site.category || "forum");
    return siteSortName(site);
  };
  return [...sites].sort((a, b) => {
    const primary = collator.compare(valueOf(a), valueOf(b));
    if (primary) return primary * factor;
    return collator.compare(siteSortName(a), siteSortName(b));
  });
}

function siteKindTabsHtml(active = "all") {
  const items = [
    { key: "signin", label: "签到站点", icon: "✅" },
    { key: "visit", label: "保活站点", icon: "🌤️" },
  ];
  return items.map(item => `<button class="category-pill manage-kind-tab ${active === item.key ? "active" : ""}" type="button" data-kind="${escAttr(item.key)}">${item.icon ? `<span aria-hidden="true">${item.icon}</span> ` : ""}${esc(item.label)}</button>`).join("");
}

function cleanCardMessage(message = "") {
  return String(message || "")
    .replace(/[；;，,]?\s*(签到时间|检查时间)[:：]\s*[^；;，,]+/g, "")
    .replace(/[；;，,]\s*$/g, "")
    .trim();
}

function scheduleToTime(schedule = "") {
  const parts = String(schedule || "").trim().split(/\s+/);
  if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    return `${String(parts[1]).padStart(2, "0")}:${String(parts[0]).padStart(2, "0")}`;
  }
  return schedule || "未设置";
}


async function loadCategories() {
  try {
    const { data } = await api("/api/categories");
    siteCategories = Array.isArray(data) && data.length ? data : [...DEFAULT_CATEGORIES];
  } catch {
    siteCategories = [...DEFAULT_CATEGORIES];
  }
  renderMainCategoryFilters();
}

function categoryAbbr(category = "forum") {
  const raw = String(category || "forum").trim();
  const map = { forum: "FORUM", pt: "PT" };
  return map[raw] || raw.replace(/[^a-z0-9]+/gi, "").slice(0, 6).toUpperCase() || "CAT";
}

function categoryLabel(category = "forum") {
  const item = siteCategories.find(c => c.key === category) || DEFAULT_CATEGORIES.find(c => c.key === category) || { emoji: "🏷️", label: category };
  return `${item.emoji || "🏷️"} ${item.label || item.key}`;
}

function categoryOptionHtml(selected = "forum") {
  return orderedCategories().map(c => `<option value="${escAttr(c.key)}" ${selected === c.key ? "selected" : ""}>${esc(c.emoji || "🏷️")} ${esc(c.label || c.key)}</option>`).join("");
}

function categoryEmojiOptions(selected = "🏷️") {
  const icons = ["💬", "📀", "🌐", "🎮", "🎬", "🎵", "📚", "⭐", "🔥", "🏷️"];
  return icons.map(icon => `<option value="${escAttr(icon)}" ${icon === selected ? "selected" : ""}>${esc(icon)}</option>`).join("");
}

function categoryTabsHtml(active = "all") {
  return `<button class="category-tab ${active === "all" ? "active" : ""}" type="button" data-category="all">全部</button>` +
    orderedCategories().map(c => `<button class="category-tab ${active === c.key ? "active" : ""}" type="button" data-category="${escAttr(c.key)}">${esc(c.emoji || "🏷️")} ${esc(c.label || c.key)}</button>`).join("");
}

function renderMainCategoryFilters() {
  const box = document.querySelector(".site-category-actions");
  if (!box) return;
  box.innerHTML = `<button class="category-pill site-kind-filter ${activeSiteKind === "signin" ? "active" : ""}" type="button" data-kind="signin" title="只看签到站点；再次点击取消"><span class="category-pill-icon" aria-hidden="true">✅</span><span>签到</span></button>` +
    `<button class="category-pill site-kind-filter ${activeSiteKind === "visit" ? "active" : ""}" type="button" data-kind="visit" title="只看保活站点；再次点击取消"><span class="category-pill-icon" aria-hidden="true">🌤️</span><span>保活</span></button>` +
    `<button class="category-pill site-category-filter ${activeSiteCategory === "all" && activeSiteKind === "all" ? "active" : ""}" type="button" data-category="all">全部</button>` +
    orderedCategories().map(c => `<button class="category-pill site-category-filter ${activeSiteCategory === c.key ? "active" : ""}" type="button" data-category="${escAttr(c.key)}">${esc(c.emoji || "🏷️")} ${esc(c.label || c.key)}</button>`).join("");
}

function finiteNumber(value) {
  if (typeof value === "string") value = value.replace(/,/g, "").trim();
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function badge(text, className, title = text) {
  return `<span class="${className}" title="${escAttr(title)}">${esc(text)}</span>`;
}

function metricItem(html, className = "metric-chip", title = "") {
  if (!html) return "";
  return `<span class="${className}"${title ? ` title="${escAttr(title)}"` : ""}>${html}</span>`;
}

function formatInviteMetric(details = {}, siteKey = "") {
  const rawInvite = String(details.invite ?? "").trim();
  const rawTemp = String(details.tempInvite ?? "").trim();
  const rawDisplay = String(details.inviteDisplay ?? "").trim();
  const firstInt = value => String(value || "").match(/\d+/)?.[0] || "";
  let normal = firstInt(rawInvite || rawDisplay);
  let temp = rawTemp === "0" ? "0" : firstInt(rawTemp);
  if (temp === "") {
    const pair = (rawDisplay || rawInvite).match(/^\s*(\d+)\s*(?:\+|\/|\(|（)\s*(\d+)/);
    if (pair) {
      normal = pair[1];
      temp = pair[2];
    }
  }
  if (!normal && !temp) return null;
  const tempNumber = temp === "" ? null : Number(temp);
  const showTemp = Number.isFinite(tempNumber) && tempNumber > 0;
  const text = showTemp ? `邀请数 x${normal || 0}（+${temp}）` : `邀请数 x${normal || 0}`;
  const siteName = siteKey === "audiences-me" ? "Audiences " : "";
  const title = showTemp
    ? `${siteName}邀请数：普通邀请 ${normal || 0}，临时邀请 +${temp}`
    : `${siteName}邀请数：${normal || 0}`;
  return { text, title };
}

function ptBonusGain(details = {}) {
  let raw = details.bonusGain
    || String(details.signText || "").match(/(?:已得|获得)\s*([0-9,.]+)/)?.[1]
    || String(details.signText || "").match(/魔力值?\s*\+?\s*([0-9,.]+)/)?.[1]
    || String(details.message || "").match(/签到获得魔力值?\s*\+?\s*([0-9,.]+)/)?.[1]
    || "";
  return String(raw || "").replace(/[，,。；;]+$/g, "");
}

function signedDelta(value, prefix = "+") {
  const n = finiteNumber(value);
  if (n === null || n === 0) return "";
  return `(${n > 0 ? prefix : ""}${n})`;
}

function coinIcon(kind) {
  if (kind === "gold") return "🟡";
  if (kind === "silver") return "⚪";
  return "🟤";
}

function buildAggregateMetrics(details = {}, siteKey = "") {
  const items = [];
  const totalChickenLegs = finiteNumber(details.totalChickenLegs);
  const rewardChickenLegs = finiteNumber(details.rewardChickenLegs);
  const rewardExp = finiteNumber(details.rewardExp);
  const rewardPoints = finiteNumber(details.rewardPoints);
  const rewardCoins = finiteNumber(details.rewardWuAiCoins);
  const rewardEnergy = finiteNumber(details.rewardEnergy) ?? finiteNumber(details.todayEnergy);
  const rewardCopper = finiteNumber(details.rewardCopper);
  const totalCoins = finiteNumber(details.totalWuAiCoins);
  const totalPoints = finiteNumber(details.totalPoints);
  const totalPbCoins = finiteNumber(details.totalPbCoins);
  const rewardPbCoins = finiteNumber(details.rewardPbCoins);
  const totalEnergy = finiteNumber(details.totalEnergy) ?? (siteKey === "nodeloc" ? totalPoints : null);
  const explicitPointSites = new Set(["right", "pojie52", "pceva", "pcbeta"]);
  const totalDays = finiteNumber(details.totalDays);
  const streakDays = finiteNumber(details.streakDays);
  const totalGold = finiteNumber(details.totalGold);
  const totalSilver = finiteNumber(details.totalSilver);
  const totalCopper = finiteNumber(details.totalCopper);
  const totalSmzdmGold = siteKey === "smzdm" ? null : finiteNumber(details.totalSmzdmGold);
  const totalSmzdmSilver = siteKey === "smzdm" ? null : finiteNumber(details.totalSmzdmSilver);
  const totalExp = finiteNumber(details.totalExp) ?? finiteNumber(details.totalExperience)
    ?? (siteKey !== "smzdm" && rewardExp !== null && totalDays !== null ? rewardExp * totalDays : null);

  if (details.bonus && siteKey === "audiences-me") items.push(metricItem(`🍿爆米花 ${esc(String(details.bonus))}`, "metric-chip metric-reward", "Audiences 爆米花"));
  else if (details.bonus && ["pt-btschool-club", "carpt-net", "hhanclub-net", "pt-0ff-cc", "hdfans-org", "hdhome-org", "hdsky-me", "open-cd", "ourbits-club", "piggo-me", "pttime-org", "pterclub-net", "hddolby-com", "mteam"].includes(siteKey)) items.push(metricItem(`🪄魔力值 ${esc(String(details.bonus))}${esc(signedDelta(ptBonusGain(details)))}`, "metric-chip metric-reward", "PT 魔力值（括号内为本次获得）"));
  else if (siteKey === "hhanclub-net" && ptBonusGain(details)) items.push(metricItem(`🪄魔力值 ?${esc(signedDelta(ptBonusGain(details)))}`, "metric-chip metric-reward", "HHanClub 憨豆（等同魔力值）"));
  if (!details.bonus && ptBonusGain(details) && ["hhanclub-net", "pt-0ff-cc", "hdfans-org", "hdhome-org", "hdsky-me", "open-cd", "ourbits-club", "piggo-me", "pttime-org", "pterclub-net", "hddolby-com", "mteam"].includes(siteKey)) {
    const rewardName = String(details.rewardName || "").replace(/^[,，。；;)）\]】]+|[,，。；;)）\]】]+$/g, "");
    items.push(metricItem(`🎁签到 +${esc(String(ptBonusGain(details)))}${rewardName && !/^[0]+$/.test(rewardName) ? ` ${esc(rewardName)}` : ""}`, "metric-chip metric-reward", "本次签到获得"));
  }
  if (details.seedPoints && siteKey === "audiences-me") items.push(metricItem(`🌱做种积分 ${esc(String(details.seedPoints))}`, "metric-chip metric-points", "Audiences 做种积分"));
  if (details.ratio && ["audiences-me", "pt-btschool-club", "carpt-net", "hhanclub-net", "pt-0ff-cc", "hdfans-org", "hdhome-org", "hdsky-me", "open-cd", "ourbits-club", "piggo-me", "pttime-org", "pterclub-net", "hddolby-com", "mteam"].includes(siteKey)) items.push(metricItem(`⚖️分享率 ${esc(String(details.ratio))}`, "metric-chip metric-level", "PT 分享率"));
  if ((details.upload || details.download) && ["audiences-me", "pt-btschool-club", "carpt-net", "hhanclub-net", "pt-0ff-cc", "hdfans-org", "hdhome-org", "hdsky-me", "open-cd", "ourbits-club", "piggo-me", "pttime-org", "pterclub-net", "hddolby-com", "mteam"].includes(siteKey)) {
    const transfer = [details.upload ? `U: ${esc(String(details.upload))}` : "", details.download ? `D: ${esc(String(details.download))}` : ""].filter(Boolean).join(" / ");
    items.push(metricItem(`↕️${transfer}`, "metric-chip metric-points metric-transfer", "PT 上传/下载量"));
  }
  if ((details.inviteDisplay || details.invite || details.tempInvite) && ["audiences-me", "pt-btschool-club", "carpt-net", "hhanclub-net", "pt-0ff-cc", "hdfans-org", "hdhome-org", "hdsky-me", "open-cd", "ourbits-club", "piggo-me", "pttime-org", "pterclub-net", "hddolby-com", "mteam"].includes(siteKey)) {
    const inviteMetric = formatInviteMetric(details, siteKey);
    if (inviteMetric) items.push(metricItem(`🎟️${esc(inviteMetric.text)}`, "metric-chip metric-level", inviteMetric.title));
  }
  if (details.points && siteKey === "chiphell-com") items.push(metricItem(`💎积分 ${esc(String(details.points))}${esc(signedDelta(finiteNumber(details.pointsGain) ?? finiteNumber(details.todayPoints)))}`, "metric-chip metric-points", "Chiphell 积分（括号内为本次增加）"));
  if (details.userGroup && siteKey === "chiphell-com") items.push(metricItem(`🏷️用户组 ${esc(String(details.userGroup))}`, "metric-chip metric-level", "Chiphell 用户组"));
  if (siteKey === "kafan") {
    const totalExperience = finiteNumber(details.experience) ?? finiteNumber(details.totalExp);
    const signExperience = String(details.rewardUnit || "") === "经验" ? finiteNumber(details.rewardAmount) : finiteNumber(details.rewardExp);
    const totalSign = finiteNumber(details.addup) ?? finiteNumber(details.totalDays);
    const continuousSign = finiteNumber(details.cons) ?? finiteNumber(details.streakDays);
    if (totalExperience !== null || signExperience !== null) items.push(metricItem(`⭐${esc(String(totalExperience ?? "?"))}${esc(signedDelta(signExperience))}`, "metric-chip metric-reward", "卡饭总经验（括号内为本次签到经验）"));
    if (totalSign !== null) items.push(metricItem(`📅${esc(String(totalSign))}`, "metric-chip metric-days", "卡饭总签到"));
    if (continuousSign !== null) items.push(metricItem(`🔥${esc(String(continuousSign))}`, "metric-chip metric-streak", "卡饭连续签到"));
    if (details.userGroup) items.push(metricItem(`🏷️${esc(String(details.userGroup))}`, "metric-chip metric-level", "卡饭用户组"));
  }
  if (siteKey === "qianmoju") {
    const qmCoins = finiteNumber(details.qianmojuPoints) ?? finiteNumber(details.points);
    const qmReward = finiteNumber(details.qianmojuRewardAmount) ?? finiteNumber(details.qianmojuSignReward) ?? finiteNumber(details.rewardCopper);
    const legacyRewardCoins = finiteNumber(details.rewardCoins);
    const qmRewardValue = qmReward ?? (legacyRewardCoins && legacyRewardCoins > 0 ? legacyRewardCoins : null);
    const qmTotalDays = finiteNumber(details.totalDays);
    const qmMonthDays = finiteNumber(details.monthDays);
    const rewardText = qmRewardValue !== null ? `(+${esc(String(qmRewardValue))})` : "";
    if (qmCoins !== null) items.push(metricItem(`🪙${esc(String(qmCoins))}${rewardText}`, "metric-chip metric-coin", "阡陌居铜币总数（括号内为本次/上次签到铜币）"));
    if (qmTotalDays !== null && qmTotalDays > 0) items.push(metricItem(`📅${esc(String(qmTotalDays))}`, "metric-chip metric-days", "阡陌居总签到"));
    if (qmMonthDays !== null && qmMonthDays > 0) items.push(metricItem(`🗓️${esc(String(qmMonthDays))}`, "metric-chip metric-days", "阡陌居月签到"));
  }
  if (siteKey === "baidu-tieba") {
    const totalForums = finiteNumber(details.tiebaTotalForums) ?? finiteNumber(details.totalForums);
    const successCount = finiteNumber(details.tiebaSuccessCount) ?? finiteNumber(details.successCount);
    const alreadySignedCount = finiteNumber(details.tiebaAlreadySignedCount) ?? finiteNumber(details.alreadySignedCount);
    const shieldedCount = finiteNumber(details.tiebaShieldedCount) ?? finiteNumber(details.shieldedCount);
    const failedCount = finiteNumber(details.tiebaFailedCount) ?? finiteNumber(details.failedCount);
    if (totalForums !== null) items.push(metricItem(`📌贴吧 ${esc(String(totalForums))}`, "metric-chip metric-days", "关注贴吧总数"));
    if (successCount !== null || alreadySignedCount !== null) {
      const parts = [];
      if (successCount !== null) parts.push(`成功 ${successCount}`);
      if (alreadySignedCount !== null) parts.push(`已签 ${alreadySignedCount}`);
      items.push(metricItem(`✅${esc(parts.join(" / "))}`, "metric-chip metric-reward", "百度贴吧签到结果"));
    }
    if (shieldedCount !== null && shieldedCount > 0) items.push(metricItem(`🛡️屏蔽 ${esc(String(shieldedCount))}`, "metric-chip metric-level", "被屏蔽贴吧数量"));
    if (failedCount !== null && failedCount > 0) items.push(metricItem(`⚠️失败 ${esc(String(failedCount))}`, "metric-chip metric-error", "签到失败贴吧数量"));
    return items.join("");
  }

  if (siteKey === "pcbeta") {
    if (totalPoints !== null || rewardPoints !== null) {
      const base = totalPoints !== null ? totalPoints : "?";
      items.push(metricItem(`💎积分 ${esc(String(base))}${esc(signedDelta(rewardPoints))}`, "metric-chip metric-points", "PCBeta 积分（括号内为本次获得）"));
    }
    if (totalPbCoins !== null || rewardPbCoins !== null) {
      const base = totalPbCoins !== null ? totalPbCoins : "?";
      items.push(metricItem(`🪙PB币 ${esc(String(base))}${esc(signedDelta(rewardPbCoins))}`, "metric-chip metric-coin", "PCBeta PB币（括号内为本次获得）"));
    }
    return items.join("");
  }

  if (siteKey === "feng-com") {
    const fengCoins = finiteNumber(details.fengCoins) ?? finiteNumber(details.totalCoins) ?? finiteNumber(details.coins);
    const levelNo = finiteNumber(details.level);
    const fengLevel = details.fengLevel || (levelNo !== null ? `Lv${levelNo}` : null);
    const joinDays = finiteNumber(details.joinDays) ?? finiteNumber(details.totalDays);
    const signInDays = finiteNumber(details.signInDays) ?? finiteNumber(details.streakDays);
    if (fengCoins !== null) items.push(metricItem(`🪙${esc(String(fengCoins))}`, "metric-chip metric-coin", "威锋威币"));
    if (fengLevel) items.push(metricItem(`🏅${esc(String(fengLevel))}`, "metric-chip metric-level", "威锋等级"));
    if (joinDays !== null) items.push(metricItem(`📅${esc(String(joinDays))}`, "metric-chip metric-days", "威锋总天数"));
    return items.join("");
  }
  const nsLevel = finiteNumber(details.nodeSeekLevel);
  const nsProgress = finiteNumber(details.nodeSeekLevelProgress);
  const genericLevel = details.pcevaLevel || details.level || null;
  if (nsLevel !== null) items.push(metricItem(`🏅Lv${esc(String(nsLevel))}${nsProgress !== null ? ` ${esc(String(nsProgress))}%` : ""}`, "metric-chip metric-level", "NodeSeek 等级进度"));
  else if (genericLevel && (siteKey !== "smzdm" || /^Lv\d+$/i.test(String(genericLevel)))) items.push(metricItem(`🏅${esc(String(genericLevel).replace(/^\[LV\.?([^\]]+)\].*$/i, "Lv$1").replace(/^LV\.?/i, "Lv"))}`, "metric-chip metric-level", "等级"));
  if (totalChickenLegs !== null || rewardChickenLegs !== null) {
    const base = totalChickenLegs !== null ? totalChickenLegs : "?";
    items.push(metricItem(`🍗${esc(String(base))}${esc(signedDelta(rewardChickenLegs))}`, "metric-chip metric-reward", "总鸡腿（括号内为今日获得）"));
  }
  if (siteKey !== "smzdm" && siteKey !== "kafan" && (totalExp !== null || rewardExp !== null)) {
    const base = totalExp !== null ? totalExp : "?";
    items.push(metricItem(`⭐${esc(String(base))}${esc(signedDelta(rewardExp))}`, "metric-chip metric-reward", "累计经验/积分（括号内为今日获得）"));
  }
  if (siteKey === "pojie52") {
    const poJieCoins = finiteNumber(details.totalCoins);
    const poJieRewardCoins = finiteNumber(details.rewardCoins);
    if (poJieCoins !== null || poJieRewardCoins !== null) {
      const base = poJieCoins !== null ? poJieCoins : "?";
      items.push(metricItem(`🪙吾爱币 ${esc(String(base))}${esc(signedDelta(poJieRewardCoins))}`, "metric-chip metric-coin", "吾爱币（括号内为今日获得）"));
    }
  } else if (totalCoins !== null || rewardCoins !== null) {
    const base = totalCoins !== null ? totalCoins : "?";
    items.push(metricItem(`🪙${esc(String(base))}${esc(signedDelta(rewardCoins))}`, "metric-chip metric-coin", "站点货币（括号内为今日获得）"));
  }
  if (totalEnergy !== null || rewardEnergy !== null) {
    const base = totalEnergy !== null ? totalEnergy : "?";
    items.push(metricItem(`⚡${esc(String(base))}${esc(signedDelta(rewardEnergy))}`, "metric-chip metric-energy", "能量（括号内为今日获得）"));
  } else if ((totalPoints !== null || rewardPoints !== null) && explicitPointSites.has(siteKey)) {
    const base = totalPoints !== null ? totalPoints : "?";
    items.push(metricItem(`💎${esc(String(base))}${esc(signedDelta(rewardPoints))}`, "metric-chip metric-points", "总积分（括号内为今日获得）"));
  }
  if (siteKey !== "smzdm") {
    if (totalSmzdmGold !== null) items.push(metricItem(`🪙${esc(String(totalSmzdmGold))}`, "metric-chip metric-coin", "什么值得买金币"));
    if (totalSmzdmSilver !== null) items.push(metricItem(`🥈${esc(String(totalSmzdmSilver))}`, "metric-chip metric-coin", "什么值得买碎银子"));
  }
  if (totalGold !== null) items.push(metricItem(`${coinIcon("gold")}${esc(String(totalGold))}`, "metric-chip metric-coin", "V2EX 金币总数"));
  if (totalSilver !== null) items.push(metricItem(`${coinIcon("silver")}${esc(String(totalSilver))}`, "metric-chip metric-coin", "V2EX 银币总数"));
  if (totalCopper !== null || rewardCopper !== null) {
    const base = totalCopper !== null ? totalCopper : "?";
    items.push(metricItem(`${coinIcon("bronze")}${esc(String(base))}${esc(signedDelta(rewardCopper))}`, "metric-chip metric-coin", "V2EX 铜币总数（括号内为今日获得）"));
  }
  if (siteKey !== "qianmoju" && siteKey !== "kafan" && totalDays !== null) items.push(metricItem(`📅${esc(String(totalDays))}`, "metric-chip metric-days", "总签到天数"));
  if (siteKey !== "qianmoju" && siteKey !== "kafan" && streakDays !== null) items.push(metricItem(`🔥${esc(String(streakDays))}`, "metric-chip metric-streak", "连续签到天数"));
  return items.join("");
}

function buildMetricBadges(site, details = {}) {
  return buildAggregateMetrics(details, site?.key || "");
}

function statusBadgeFor(site, details = {}) {
  if (details?.verificationBlocked && site.hasCookie) return `<span class="warning-badge" title="Cookie 有效，但签到需要验证">◐</span>`;
  const action = String(details?.checkinAction || "");
  const externalAlreadySigned = action === "already_signed_before_run" || (details?.alreadySigned === true && details?.clickedSignIn !== true);
  const actionLabel = siteKindOf(site) === "visit" ? "保活" : "签到";
  if (site.lastSuccess === true && externalAlreadySigned) return `<span class="success-badge success-badge-external" title="运行时已是${actionLabel}状态（非 SignMate 本次完成）">✓</span>`;
  if (site.lastSuccess === true) return `<span class="success-badge" title="最近${actionLabel}成功">✓</span>`;
  if (site.lastSuccess === false) return `<span class="fail-badge" title="最近${actionLabel}失败">×</span>`;
  return "";
}

function deriveVerificationType(site = {}, details = {}) {
  if (site.verificationType) return site.verificationType;
  const joined = [site.lastMessage || "", ...(Array.isArray(site.steps) ? site.steps.map(step => `${step.label || ""} ${step.detail || ""}`) : [])].join(" ");
  if (/Cloudflare|Turnstile/i.test(joined)) return "Cloudflare Turnstile";
  if (/SafeLine|雷池|客户端异常|请确认您是合法用户/i.test(joined)) return "SafeLine 雷池 WAF";
  if (/滑动认证|拖动滑块|简单滑块|滑块/i.test(joined)) return "简单滑块认证";
  if (/验证码|captcha/i.test(joined)) return "验证码";
  if (/验证/i.test(joined)) return "验证措施";
  return "";
}

function siteNeedsTotpBadge(site = {}, details = {}) {
  if (site.hasTotpSecret) return true;
  const joined = [
    site.verificationType || site.verification_type || "",
    site.lastMessage || "",
    details?.pageTitle || "",
    ...(Array.isArray(site.steps) ? site.steps.map(step => `${step.label || ""} ${step.detail || ""}`) : []),
  ].join(" ");
  return /2FA|TOTP|两步验证|二步验证|两步验证码|take2fa|异地登录提醒/i.test(joined);
}

function twoFaCornerHtml(site = {}, details = {}) {
  if (!siteNeedsTotpBadge(site, details)) return "";
  const title = site.hasTotpSecret ? "已维护 2FA Secret，可自动处理两步验证" : "该站可能需要维护 2FA Secret 才能稳定通过验证";
  return `<span class="site-2fa-corner ${site.hasTotpSecret ? "is-ready" : "is-needed"}" title="${escAttr(title)}">2FA</span>`;
}

function verificationLockHtml(site = {}, details = {}) {
  const siteKind = site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin");
  const verificationType = deriveVerificationType(site, details);
  const hasVerificationMethod = Boolean(verificationType || site.verificationAuto === true || site.signinBlockedByVerification === true);
  const stepsText = Array.isArray(site.steps) ? site.steps.map(step => `${step.label || ""} ${step.detail || ""}`).join(" ") : "";
  const passedBySteps = site.lastSuccess === true && /通过.*(滑块|验证)|验证.*(通过|token 已生成|页面已继续)|TOTP|2FA|两步验证/i.test(stepsText);
  const autoPassed = siteKind === "signin" && hasVerificationMethod && (site.verificationAuto === true || passedBySteps || site.lastSuccess === true);
  const blocked = site.signinBlockedByVerification === true || details?.verificationBlocked === true || /Cloudflare\s*Turnstile|SafeLine|雷池|客户端异常|请确认您是合法用户|验证措施/.test(site.lastMessage || "");
  if (autoPassed) {
    return `<span class="verification-lock verification-lock-pass" title="有验证手段，且最近可自动通过${verificationType ? `：${escAttr(verificationType)}` : ""}" aria-label="验证可自动通过"></span>`;
  }
  if (siteKind === "visit" && hasVerificationMethod && (blocked || site.signinBlockedByVerification === true)) {
    return `<span class="verification-lock verification-lock-blocked" title="该保活站点有签到功能，但当前自动化无法通过验证${verificationType ? `：${escAttr(verificationType)}` : ""}" aria-label="有签到功能但自动化无法通过验证"></span>`;
  }
  return "";
}

function formatStatusMessageLines(message = "") {
  return String(message || "")
    .split(/[；;]+/)
    .map(part => part.replace(/^\s*[✓✔✅❌◐-]+\s*/g, "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("\n");
}

function cleanDailyMessage(message = "", siteKey = "") {
  const cleaned = cleanCardMessage(message).replace(/；?签到时间[:：].*$/g, "").trim();

  // 什么值得买的卡片正文需要保留「连续签到 + 总签到」。
  // 通用清洗逻辑会把这两段当作累计指标删掉，所以这里单独保留。
  if (siteKey === "smzdm" || /什么值得买/.test(cleaned)) {
    const continuous = cleaned.match(/连续签到\s*\d+\s*天/)?.[0];
    const total = cleaned.match(/总签到\s*\d+\s*天/)?.[0] || cleaned.match(/总签到\s*\d+天/)?.[0]?.replace(/(\d+)天/, "$1 天");
    const parts = [continuous, total].filter(Boolean);
    if (parts.length) return parts.join("；");
  }

  if (siteKey === "qianmoju") {
    const reward = cleaned.match(/(?:上次奖励|签到奖励|奖励)\s*(\d+)\s*铜币/)?.[1]
      || cleaned.match(/上次获得的奖励为[:：]?\s*铜币\s*(\d+)/)?.[1]
      || cleaned.match(/签到\s*(\d+)\s*铜币/)?.[1];
    if (reward) return `签到铜币 +${reward}`;
    return cleaned.replace(/积分\s*\d+[；;]?/g, "").replace(/用户组\s*[^；;]+[；;]?/g, "").replace(/本月\s*\d+\s*天[；;]?/g, "").trim() || cleaned;
  }

  if (siteKey === "baidu-tieba") {
    const total = cleaned.match(/贴吧总数\s*(\d+)/)?.[1];
    const success = cleaned.match(/签到成功\s*(\d+)/)?.[1];
    const already = cleaned.match(/已经签到\s*(\d+)/)?.[1];
    const shielded = cleaned.match(/被屏蔽\s*(\d+)/)?.[1];
    const failed = cleaned.match(/签到失败\s*(\d+)/)?.[1];
    const parts = [];
    if (success) parts.push(`成功 ${success}`);
    if (already) parts.push(`已签 ${already}`);
    if (shielded && Number(shielded) > 0) parts.push(`屏蔽 ${shielded}`);
    if (failed && Number(failed) > 0) parts.push(`失败 ${failed}`);
    if (total && !parts.length) parts.push(`贴吧总数 ${total}`);
    return parts.join("；") || cleaned;
  }

  if (siteKey === "kafan") {
    const reward = cleaned.match(/签到经验\s*\+?\s*(\d+)/)?.[1]
      || cleaned.match(/签到奖励\s*\+?\s*(\d+)/)?.[1]
      || cleaned.match(/奖励\s*(\d+)\s*经验/)?.[1];
    const continuous = cleaned.match(/连续签到\s*\d+\s*次/)?.[0];
    const parts = [];
    if (reward) parts.push(`签到经验 +${reward}`);
    if (continuous) parts.push(continuous);
    return parts.join("；") || cleaned.replace(/^卡饭签到状态正常[；;]?/g, "").replace(/^今日已签到[；;]?/g, "").trim() || cleaned;
  }

  if (["audiences-me", "pt-btschool-club", "carpt-net", "hhanclub-net", "hddolby-com", "pt-0ff-cc", "hdfans-org", "hdhome-org", "hdsky-me", "open-cd", "ourbits-club", "piggo-me", "pttime-org", "pterclub-net"].includes(siteKey)) {
    const normalized = cleaned
      .replace(/签到检查完成[；;]?/g, "")
      .replace(/登录保活完成[；;]?/g, "")
      .replace(/用户\s*[^；;]+[；;]?/g, "")
      .replace(/上传\s*[^；;]+[；;]?/g, "")
      .replace(/下载\s*[^；;]+[；;]?/g, "");
    if (/Cloudflare\s*Turnstile|Turnstile/i.test(normalized)) return "Cloudflare Turnstile 未通过";
    if (/验证措施|验证码|验证中/.test(normalized)) return "签到遇到验证措施";
    const signText = normalized.match(/这是您的第\s*\d+\s*次签到[^；;]*/)?.[0]
      || normalized.match(/本次签到获得[^；;]*/)?.[0]
      || normalized.match(/签到(?:已得|获得|成功)[^；;]*/)?.[0];
    const gain = normalized.match(/签到获得魔力值\s*\+?[0-9,.]+/)?.[0];
    const parts = [];
    if (signText) parts.push(signText.replace(/,/g, "，"));
    else if (gain) parts.push(gain);
    const bonus = normalized.match(/魔力值?\s*([0-9,.]+)/)?.[1];
    const ratio = normalized.match(/分享率\s*([0-9.]+)/)?.[1];
    if (bonus) parts.push(`魔力值 ${bonus}`);
    if (ratio) parts.push(`分享率 ${ratio}`);
    return [...new Set(parts)].join("；") || normalized.trim() || cleaned;
  }

  // Chiphell 的保活卡片正文保留关键账号信息。
  if (siteKey === "chiphell-com" || /用户名.*积分.*用户组/.test(cleaned)) {
    const username = cleaned.match(/用户名\s*([^；;]+)/)?.[1]?.trim();
    const points = cleaned.match(/积分\s*([0-9]+)/)?.[1]?.trim();
    const userGroup = cleaned.match(/用户组\s*([^；;]+)/)?.[1]?.trim();
    const parts = [];
    if (username) parts.push(`用户名 ${username}`);
    if (points) parts.push(`积分 ${points}`);
    if (userGroup) parts.push(`用户组 ${userGroup}`);
    if (parts.length) return parts.join("；");
  }

  return cleaned
    .replace(/；?今天已完成签到，请勿重复操作/g, "")
    .replace(/今天已完成签到，?/g, "")
    .replace(/签到成功，?/g, "")
    .replace(/；?连续签到\s*\d+\s*天/g, "")
    .replace(/；?总签到\s*\d+\s*天/g, "")
    .replace(/；?今日积分\s*\d+/g, "")
    .replace(/今天已完成签到；?/g, "")
    .replace(/；?金币\s*\d+\s*\/\s*银币\s*\d+\s*\/\s*铜币\s*\d+/g, "")
    .replace(/；?总鸡腿\s*\d+/g, "")
    .replace(/；?等级\s*Lv\d+(?:\s*\(\d+%\))?/g, "")
    .replace(/^\s*[✓✔]\s*[；;]?\s*/g, "")
    .replace(/^；|；$/g, "")
    .trim() || cleaned;
}

function hasMissedTodaySignin(site = {}) {
  if (!site?.enabled || siteKindOf(site) !== "signin") return false;
  if (site._running || site.lastSuccess === true || !site.lastTime) return false;
  const batchMode = appSettings?.batch?.mode || site.scheduleMode || site.schedule_mode || "fixed";
  if (batchMode !== "fixed") return false;
  const t = appSettings?.batch?.signinTime || "09:00";
  const [hour = 9, minute = 0] = String(t).split(":").map(n => Number.parseInt(n, 10));
  const due = new Date();
  due.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0);
  if (Date.now() <= due.getTime()) return false;
  return localDateKey(site.lastTime) !== localDateKey(new Date());
}

function buildSiteCard(site) {
  const hasStatus = site.lastSuccess !== null;
  const details = site.details || {};
  const verificationBlocked = !!(details?.verificationBlocked && site.hasCookie);
  const statusClass = verificationBlocked ? "status-warning" : (hasStatus
    ? (site.lastSuccess ? "status-success" : "status-error")
    : "status-pending");
  const dotClass = verificationBlocked ? "dot-warning" : (hasStatus
    ? (site.lastSuccess ? "dot-success" : "dot-error")
    : "dot-pending");
  const siteKind = siteKindOf(site);
  const isVisit = siteKind === "visit";
  const actionText = isVisit ? "保活" : "签到";
  const statusText = verificationBlocked ? "需要验证" : (hasStatus
    ? (site.lastSuccess ? `最近${actionText}成功` : `最近${actionText}失败`)
    : `尚未${actionText}`);
  const tagClass = site.enabled ? "tag-active" : "tag-disabled";
  const tagText = site.enabled ? "启用" : "停用";
  const steps = Array.isArray(site.steps) ? site.steps : [];
  const statusBadge = statusBadgeFor(site, details);
  const aggregateMetrics = buildAggregateMetrics(details, site.key);
  const cardMessage = formatStatusMessageLines(cleanDailyMessage(site.lastMessage || statusText, site.key));
  const cardMessageTitle = cleanCardMessage(site.lastMessage || statusText);
  const displayName = displaySiteName(site.name);
  const isPtSite = ["audiences-me", "pt-btschool-club", "carpt-net", "hhanclub-net", "hddolby-com", "pt-0ff-cc", "hdfans-org", "hdhome-org", "hdsky-me", "open-cd", "ourbits-club", "piggo-me", "pttime-org", "pterclub-net"].includes(site.key);
  const categoryKey = site.category || "forum";
  const isRunning = !!site._running;
  const actionLabel = isVisit ? "🌤 保 活" : "↻ 签 到";
  const verificationLock = verificationLockHtml(site, details);
  const recentLabel = isVisit ? "最近保活" : "最近签到";
  const lastRunTime = site.lastTime ? new Date(site.lastTime).toLocaleString("zh-CN", { hour12: false }) : "";
  const timeLineText = lastRunTime || `暂无${actionText}记录`;
  const missedTodaySignin = hasMissedTodaySignin(site);
  const timeLineClass = missedTodaySignin ? "site-card-time missed-today-signin" : "site-card-time";
  const executionMethod = executionMethodShort(site);
  const scheduleTitle = missedTodaySignin ? `已过今日设定签到时间，尚未完成今日签到；${lastRunScheduleTitle(site, recentLabel)}` : lastRunScheduleTitle(site, recentLabel);

  const showStatusBand = (!isVisit || isRunning) && (!isPtSite || verificationBlocked);
  const ptStatusClass = isPtSite && showStatusBand ? "has-pt-status" : "";

  return `
    <div class="card site-card ${isVisit ? "visit-card" : "signin-card"} ${isPtSite ? "pt-card" : ""} ${ptStatusClass} ${hasStatus && !site.lastSuccess ? "is-running" : ""}" id="card-${escAttr(site.key)}" data-category="${escAttr(site.category || 'forum')}">
      <span class="site-category-corner cat-${escAttr(categoryKey)}" title="分类：${escAttr(categoryLabel(categoryKey))}">${esc(categoryAbbr(categoryKey))}</span>
      <div class="site-card-header">
        <span class="site-card-name proxy-name-${escAttr(details.proxyModeUsed || (site.proxyMode === "on" ? "proxy" : site.proxyMode === "off" ? "direct" : "auto"))}" data-site-url="${escAttr(site.baseUrl || site.base_url || "")}" title="双击打开签到站点" tabindex="-1">${esc(displayName)}<span class="site-exec-badge" title="${escAttr(executionMethodTitle(site))}">${esc(executionMethod)}</span></span>
        <div class="site-card-header-right">
          ${verificationLock}${statusBadge}
          <button class="site-card-tag ${tagClass} tag-button" id="toggle-${escAttr(site.key)}" title="点击切换启用/禁用；禁用后刷新页面才会从当前列表隐藏">${tagText}</button>
        </div>
      </div>

      <div class="site-card-metrics aggregate-metrics">
        ${aggregateMetrics || `<span class="metric-empty">暂无累计信息</span>`}
      </div>

      ${showStatusBand ? `<div class="site-card-status ${statusClass} ${hasStatus && !site.lastSuccess ? "is-running" : ""}">
        <span class="status-dot ${dotClass}"></span>
        <div class="status-content">
          <div id="status-${escAttr(site.key)}" class="status-message" title="${escAttr(cardMessageTitle)}">${esc(cardMessage)}</div>
        </div>
      </div>` : ""}

      <div class="site-card-actions">
        <button class="btn btn-secondary" id="credential-${escAttr(site.key)}" title="${credentialPrimaryLabel(site)}：${site.hasCookie ? "已维护" : "未维护"}">
          ${site.hasCookie ? "🔑" : "🔒"} ${credentialPrimaryLabel(site)}
        </button>
        <button class="btn btn-secondary" id="signin-${escAttr(site.key)}" ${!site.enabled ? "disabled" : ""}>
          ${actionLabel}
        </button>
      </div>

      <div class="site-card-schedule" title="${escAttr(scheduleTitle)}"><span>🕘 ${recentLabel}</span><span class="${timeLineClass}">${timeLineText}</span></div>
    </div>
  `;
}


// ---- Enable / Disable Site ----
async function toggleSite(key, enabled) {
  try {
    await api(`/api/sites/${encodeURIComponent(key)}/enabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    showToast(`${enabled ? "✅ 已启用" : "⏸ 已禁用，刷新页面后从当前列表隐藏"}`, enabled ? "success" : "");
    if (document.getElementById("tab-credentials")?.classList.contains("active")) {
      await loadCredentials();
    }
    const card = document.getElementById(`card-${key}`);
    if (card) {
      const tag = document.getElementById(`toggle-${key}`);
      if (tag) {
        tag.textContent = enabled ? "启用" : "禁用";
        tag.classList.toggle("tag-active", enabled);
        tag.classList.toggle("tag-disabled", !enabled);
        tag.onclick = () => toggleSite(key, !enabled);
      }
      const runBtn = document.getElementById(`signin-${key}`);
      if (runBtn) runBtn.disabled = !enabled;
      card.classList.toggle("is-card-disabled", !enabled);
    }
  } catch (err) {
    showToast(`切换失败: ${err.message}`, "error");
  }
}

// ---- Credential labels ----
function isTokenCredentialSite(item = {}) {
  const key = String(item.key || "").toLowerCase();
  const driver = String(item.driver || "").toLowerCase();
  const name = String(item.name || "").toLowerCase();
  return key === "mteam" || driver === "mteam" || name.includes("m-team");
}

function credentialPrimaryLabel(item = {}) {
  return isTokenCredentialSite(item) ? "Token" : "Cookie";
}

function credentialPairLabel(item = {}) {
  return `${credentialPrimaryLabel(item)}/2FA`;
}

function credentialSavedText(item = {}) {
  return isTokenCredentialSite(item) ? "Token" : "Cookie";
}

// ---- Cookie / Credentials ----
async function loadCredentials() {
  const grid = document.getElementById("credentialsGrid");
  if (!grid) return;
  grid.innerHTML = `<div class="card"><div class="empty-cell"><span class="spinner"></span>加载中…</div></div>`;

  try {
    const { data } = await api("/api/credentials");
    if (!data.length) {
      grid.innerHTML = `<div class="card"><div class="empty-cell">暂无站点</div></div>`;
      return;
    }

    grid.innerHTML = data.map(item => buildCredentialCard(item)).join("");
    data.forEach(item => {
      const form = document.getElementById(`credential-form-${item.key}`);
      form?.addEventListener("submit", (event) => saveCredential(event, item.key, item.name));
      document.getElementById(`cookie-title-${item.key}`)?.addEventListener("dblclick", () => markCookieClear(form, form?.elements.cookie, document.getElementById(`cookie-help-${item.key}`), item.name || item.key));
      form?.elements.cookie?.addEventListener("input", () => { if (form.elements.cookie.value.trim()) delete form.dataset.clearCookie; });
      document.getElementById(`clear-${item.key}-credential`)?.addEventListener("click", () => clearCredentialForm(form, item.name || item.key));
    });
  } catch (err) {
    grid.innerHTML = `<div class="card"><div class="empty-cell">加载失败: ${esc(err.message)}</div></div>`;
  }
}

function buildCredentialCard(item) {
  const cookieValue = "";
  const primaryLabel = credentialPrimaryLabel(item);
  const savedType = credentialSavedText(item);
  const emptyPlaceholder = isTokenCredentialSite(item) ? "粘贴 M-Team 存取令牌" : "session=你的session值; colors=dark;";
  const savedHint = item.hasCookie ? `已保存：${esc(item.cookieMasked || item.sessionOnlyMasked || "******")}` : `未保存 ${savedType}`;
  const status = item.hasCookie ? "已配置" : "未配置";
  const statusClass = item.hasCookie ? "tag-active" : "tag-disabled";

  return `
    <div class="card credential-card">
      <div class="site-card-header">
        <span class="site-card-name">${esc(displaySiteName(item.name))}</span>
        <span class="site-card-tag ${statusClass}">${status}</span>
      </div>
      <form id="credential-form-${escAttr(item.key)}" class="credential-form">
        <label class="field-label cookie-clear-title" id="cookie-title-${escAttr(item.key)}" for="cookie-${escAttr(item.key)}" title="双击标记清除已保存 ${savedType}，保存后生效">${primaryLabel}</label>
        <textarea id="cookie-${escAttr(item.key)}" class="field-textarea" name="cookie" rows="4" placeholder="${escAttr(item.hasCookie ? `${savedHint}；粘贴新 ${savedType} 才会更新` : emptyPlaceholder)}">${cookieValue}</textarea>
        <div class="field-help" id="cookie-help-${escAttr(item.key)}">${savedHint}。为避免泄露，页面不回显完整 ${savedType}；留空保存不会覆盖已有 ${savedType}；双击“${primaryLabel}”可标记清除，保存后生效。</div>


        <div class="credential-actions">
          <button class="btn btn-secondary" type="button" id="clear-${escAttr(item.key)}-credential">清空</button>
          <button class="btn btn-primary" type="submit">保存</button>
        </div>
      </form>
    </div>
  `;
}

function clearCredentialForm(form, name = "该站点") {
  if (!form) return;
  const cookie = form.elements.cookie;
  const sessionOnly = form.elements.sessionOnly;
  const totpSecret = form.elements.totpSecret;
  if (cookie) cookie.value = "";
  if (sessionOnly) sessionOnly.value = "";
  if (totpSecret) totpSecret.value = "";
  form.dataset.clearCookie = "1";
  const cookieHelp = form.querySelector("#modalCookieHelp") || form.querySelector("[id^='cookie-help-']");
  const totpHelp = form.querySelector("#modalTotpHelp");
  if (cookieHelp) cookieHelp.innerHTML = `${esc(name)} 已标记清除已保存 Cookie；点击“保存”后生效。粘贴新 Cookie 会覆盖清除标记。`;
  if (totpSecret || totpHelp) {
    form.dataset.clearTotpSecret = "1";
    if (totpHelp) totpHelp.innerHTML = `${esc(name)} 已标记清除已保存 2FA Secret；点击“保存”后生效。`;
    showToast("已标记清空凭据/2FA，保存后生效", "info");
  } else {
    showToast("已标记清空 Cookie，保存后生效", "info");
  }
}

async function saveCredential(event, key, name) {
  event.preventDefault();
  const form = event.currentTarget;
  const btn = form.querySelector('button[type="submit"]');
  const cookie = form.elements.cookie?.value || "";
  const sessionOnly = form.elements.sessionOnly?.value || "";
  const totpSecret = form.elements.totpSecret?.value || "";
  const clearCookie = form.dataset.clearCookie === "1" && !cookie.trim() && !sessionOnly.trim();
  const clearTotpSecret = form.dataset.clearTotpSecret === "1" && !totpSecret.trim();

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>保存中…';
  }

  try {
    await api(`/api/credentials/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie, sessionOnly, clearCookie, totpSecret, clearTotpSecret }),
    });
    const savedWhat = clearCookie ? "Cookie 已清除" : (clearTotpSecret ? "2FA Secret 已清除" : (totpSecret.trim() ? "凭据/2FA 已保存" : "Cookie 已保存"));
    showToast(`✅ ${name} ${savedWhat}`, "success");
    await loadCredentials();
    await loadSites(true);
  } catch (err) {
    showToast(`保存失败: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "保存";
    }
  }
}


async function openSiteManageModal(kind = "signin", options = {}) {
  try {
    if (!siteCategories.length) await loadCategories();
    const cachedSites = Array.isArray(latestAllSites) ? latestAllSites : [];
    const shouldFetchSites = options.forceRefresh === true || cachedSites.length === 0;
    const [{ data: proxy }, { data: batch }, sitesResult] = await Promise.all([
      api("/api/proxy"),
      api("/api/batch-settings"),
      shouldFetchSites ? api("/api/sites") : Promise.resolve({ data: cachedSites }),
    ]);
    const allSites = sitesResult?.data || cachedSites;
    if (shouldFetchSites) latestAllSites = allSites;
    const sites = allSites.filter(site => kind === "all" || siteKindOf(site) === kind);
    showSiteManageModal(sites, proxy, kind, batch || {}, options);
  } catch (err) {
    showToast(`加载站点维护失败: ${err.message}`, "error");
  }
}


function splitTime(value = "09:00") {
  const m = String(value || "09:00").match(/^([01][0-9]|2[0-3]):([0-5][0-9])$/);
  return { hour: m ? m[1] : "09", minute: m ? m[2] : "00" };
}

function normalizeTime(value = "09:00", fallback = "09:00") {
  const m = String(value || fallback).match(/^(\d{1,2}):(\d{1,2})$/) || String(fallback).match(/^(\d{1,2}):(\d{1,2})$/);
  const hour = Math.max(0, Math.min(23, Number(m?.[1] || 9)));
  const minute = Math.max(0, Math.min(59, Number(m?.[2] || 0)));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function hourOptions(selected = "09") {
  return Array.from({ length: 24 }, (_, i) => {
    const h = String(i).padStart(2, "0");
    return `<option value="${h}" ${h === selected ? "selected" : ""}>${h}</option>`;
  }).join("");
}

function minuteOptions(selected = "00", stepMinutes = 15) {
  const allowed = [];
  for (let m = 0; m < 60; m += stepMinutes) allowed.push(String(m).padStart(2, "0"));
  if (!allowed.includes(selected)) allowed.unshift(selected);
  return allowed.map(m => `<option value="${m}" ${m === selected ? "selected" : ""}>${m}</option>`).join("");
}

function timePairHtml(value = "09:00", { kind = "generic", site = "", driver = "", disabled = false, name = "" } = {}) {
  const { hour, minute } = splitTime(value);
  const data = site ? ` data-site="${escAttr(site)}"` : (driver ? ` data-driver="${escAttr(driver)}"` : "");
  const nameAttr = name ? ` data-name="${escAttr(name)}"` : "";
  const disabledAttr = disabled ? " disabled" : "";
  return `<span class="time-pair time-pair-${escAttr(kind)}"${data}${nameAttr}>` +
    `<select class="field-input time-hour ${escAttr(kind)}-hour"${data}${nameAttr}${disabledAttr}>${hourOptions(hour)}</select>` +
    `<span class="time-separator">:</span>` +
    `<select class="field-input time-minute ${escAttr(kind)}-minute"${data}${nameAttr}${disabledAttr}>${minuteOptions(minute)}</select>` +
    `</span>`;
}

function getTimePairValue(scope, kind, key = null) {
  const suffix = key ? `[data-site="${CSS.escape(key)}"]` : "";
  const hour = scope.querySelector(`.${kind}-hour${suffix}`)?.value || "09";
  const minute = scope.querySelector(`.${kind}-minute${suffix}`)?.value || "00";
  return `${hour}:${minute}`;
}

function setTimePairValue(scope, kind, value, key = null) {
  const { hour, minute } = splitTime(value);
  const suffix = key ? `[data-site="${CSS.escape(key)}"]` : "";
  const h = scope.querySelector(`.${kind}-hour${suffix}`);
  const m = scope.querySelector(`.${kind}-minute${suffix}`);
  if (h) h.value = hour;
  if (m) m.value = minute;
}

function setTimePairDisabled(scope, kind, disabled, key = null) {
  const suffix = key ? `[data-site="${CSS.escape(key)}"]` : "";
  scope.querySelector(`.${kind}-hour${suffix}`)?.toggleAttribute("disabled", disabled);
  scope.querySelector(`.${kind}-minute${suffix}`)?.toggleAttribute("disabled", disabled);
}

function randomRangeHtml(start = "02:00", end = "22:00", { kind = "random", disabled = false } = {}) {
  const disabledAttr = disabled ? " disabled" : "";
  const startText = normalizeTime(start || "02:00", "02:00");
  const endText = normalizeTime(end || "22:00", "22:00");
  const { hour: sh, minute: sm } = splitTime(startText);
  const { hour: eh, minute: em } = splitTime(endText);
  return `<span class="random-range random-range-${escAttr(kind)}" title="时间范围内，动态随机批量签到/保活" role="button" aria-label="随机执行时间范围 ${escAttr(startText)} 到 ${escAttr(endText)}">
    <span class="random-range-display"><span>${esc(startText)}</span><span class="range-tilde">~</span><span>${esc(endText)}</span></span>
    <select class="field-input random-range-hidden ${escAttr(kind)}-start-hour"${disabledAttr}>${hourOptions(sh)}</select>
    <select class="field-input random-range-hidden ${escAttr(kind)}-start-minute"${disabledAttr}>${minuteOptions(sm)}</select>
    <select class="field-input random-range-hidden ${escAttr(kind)}-end-hour"${disabledAttr}>${hourOptions(eh)}</select>
    <select class="field-input random-range-hidden ${escAttr(kind)}-end-minute"${disabledAttr}>${minuteOptions(em)}</select>
  </span>`;
}

function getRandomRangeValue(scope, kind = "batch-random") {
  return { start: getTimePairValue(scope, `${kind}-start`) || "02:00", end: getTimePairValue(scope, `${kind}-end`) || "22:00" };
}

function setRandomRangeDisabled(scope, kind = "batch-random", disabled = false) {
  setTimePairDisabled(scope, `${kind}-start`, disabled);
  setTimePairDisabled(scope, `${kind}-end`, disabled);
}


function closeRandomRangePopover() {
  document.querySelector(".random-range-popover")?.remove();
}

function setRandomRangeValues(range, kindName, startValue, endValue) {
  const setValue = (suffix, value) => {
    const { hour, minute } = splitTime(value);
    const h = range.querySelector(`.${CSS.escape(kindName)}-${suffix}-hour`);
    const min = range.querySelector(`.${CSS.escape(kindName)}-${suffix}-minute`);
    if (h) h.value = hour;
    if (min) min.value = minute;
  };
  setValue("start", startValue);
  setValue("end", endValue);
  const display = range.querySelector(".random-range-display");
  if (display) display.innerHTML = `<span>${esc(startValue)}</span><span class="range-tilde">~</span><span>${esc(endValue)}</span>`;
}

function openRandomRangePopover(range, scope, kindName, onSave) {
  closeRandomRangePopover();
  const current = getRandomRangeValue(scope, kindName);
  const pop = document.createElement("div");
  pop.className = "random-range-popover";
  pop.innerHTML = `
    <div class="range-pop-title">随机执行时间范围</div>
    <div class="range-pop-row">
      <label><span>开始</span>${timePairHtml(current.start, { kind: "range-pop-start" })}</label>
      <label><span>结束</span>${timePairHtml(current.end, { kind: "range-pop-end" })}</label>
    </div>
    <div class="range-pop-help">每天在该时间范围内动态随机批量签到/保活</div>
    <div class="range-pop-actions">
      <button class="btn btn-secondary btn-compact" type="button" data-action="cancel">取消</button>
      <button class="btn btn-primary btn-compact" type="button" data-action="save">保存</button>
    </div>`;
  document.body.appendChild(pop);
  const rect = range.getBoundingClientRect();
  const top = Math.min(window.innerHeight - pop.offsetHeight - 12, rect.bottom + 8);
  const left = Math.min(window.innerWidth - pop.offsetWidth - 12, Math.max(12, rect.left + rect.width / 2 - pop.offsetWidth / 2));
  pop.style.top = `${Math.max(12, top)}px`;
  pop.style.left = `${left}px`;
  const closeOnOutside = (event) => {
    if (!pop.contains(event.target) && !range.contains(event.target)) {
      closeRandomRangePopover();
      document.removeEventListener("mousedown", closeOnOutside, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closeOnOutside, true), 0);
  pop.querySelector('[data-action="cancel"]')?.addEventListener("click", () => {
    closeRandomRangePopover();
    document.removeEventListener("mousedown", closeOnOutside, true);
  });
  pop.querySelector('[data-action="save"]')?.addEventListener("click", async () => {
    const startValue = normalizeTime(getTimePairValue(pop, "range-pop-start"), "02:00");
    const endValue = normalizeTime(getTimePairValue(pop, "range-pop-end"), "22:00");
    setRandomRangeValues(range, kindName, startValue, endValue);
    try {
      await onSave?.();
      showToast("✅ 随机执行范围已保存", "success");
      closeRandomRangePopover();
      document.removeEventListener("mousedown", closeOnOutside, true);
    } catch (err) {
      showToast(`保存随机范围失败: ${err.message}`, "error");
    }
  });
}

function showSiteManageModal(sites, proxy, kind = "signin", batch = {}, options = {}) {
  const manageSort = options.sort || { key: "name", dir: "asc" };
  const manageKindFilter = options.kindFilter || "all";
  const manageSearch = options.search || "";
  const managedSites = sortSitesForManage(sites, manageSort.key, manageSort.dir);
  const isKeepaliveManage = kind === "visit";
  const batchValue = isKeepaliveManage ? batch.visitTime : batch.signinTime;
  const batchMode = batch.mode === "independent" ? "independent" : (batch.mode === "fixed" ? "fixed" : "random");
  const batchAuto = !batchValue || batchValue === "auto";
  const effectiveBatchTime = batchAuto ? (isKeepaliveManage ? "09:30" : "09:00") : batchValue;
  const randomStart = batch.randomStart || "02:00";
  const randomEnd = batch.randomEnd || "22:00";
  closeSiteManageModal();
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "siteManageModal";
  modal.innerHTML = `
    <div class="modal-card site-manage-modal-card" role="dialog" aria-modal="true">
      <div class="modal-header site-manage-header-row">
        <div class="site-manage-title-wrap">
          <h2>站点配置</h2>
        </div>
        <label class="site-manage-search-wrap site-manage-search-header" title="搜索站点名称、Key 或分类">
          <span>🔎</span>
          <input class="field-input site-manage-search" id="siteManageSearch" type="search" placeholder="搜索站点" value="${escAttr(manageSearch)}">
        </label>
        <button class="modal-close" type="button" id="siteManageClose">×</button>
      </div>
      <div class="site-manage-toolbar">
        <div class="batch-time-inline">
          <select class="field-input" id="batchScheduleMode" title="批量/随机/独立执行">
            <option value="fixed" ${batchMode === "fixed" ? "selected" : ""}>批量执行</option>
            <option value="random" ${batchMode === "random" ? "selected" : ""}>随机执行</option>
            <option value="independent" ${batchMode === "independent" ? "selected" : ""}>独立执行</option>
          </select>
          <span id="batchFixedTimeWrap" class="batch-time-mode-wrap ${batchMode === "fixed" ? "" : "is-hidden"}">${timePairHtml(effectiveBatchTime, { kind: "batch", disabled: false })}</span>
          <span id="batchRandomRangeWrap" class="batch-time-mode-wrap ${batchMode === "random" ? "" : "is-hidden"}">${randomRangeHtml(randomStart, randomEnd, { kind: "batch-random", disabled: false })}</span>
        </div>
        <div class="site-category-actions site-manage-category-actions">
          <div class="site-manage-category-group" id="siteCategoryTabs">${categoryTabsHtml("all").replace(/category-tab/g, "category-pill")}</div>
        </div>
        <div class="site-manage-toolbar-actions">
          <button class="btn btn-primary" type="button" id="btnAddSite">＋ 添加站点</button>

          <button class="btn btn-secondary" type="button" id="siteManageRefresh">刷新</button>
          <button class="btn btn-primary" type="button" id="siteManageDone">完成</button>
        </div>
      </div>
      <div class="site-manage-column-head">
        <button class="manage-sort-head" type="button" data-sort="name">站点<span class="sort-indicator">${manageSort.key === "name" ? (manageSort.dir === "asc" ? "↑" : "↓") : ""}</span></button>
        <button class="manage-sort-head" type="button" data-sort="kind">执行方式<span class="sort-indicator">${manageSort.key === "kind" ? (manageSort.dir === "asc" ? "↑" : "↓") : ""}</span></button>
        <button class="manage-sort-head" type="button" data-sort="category">分类<span class="sort-indicator">${manageSort.key === "category" ? (manageSort.dir === "asc" ? "↑" : "↓") : ""}</span></button>
        <span class="manage-batch-head"><em>触发</em><input type="checkbox" id="manageBatchAll" title="按当前左上模式全选/取消触发"></span>
        <span>时间 / 随机范围</span>
        <span>代理</span>
        <span>凭据维护</span>
        <span>操作</span>
      </div>
      <div class="site-manage-list">
        ${managedSites.length ? managedSites.map(site => {
          const cron = site.schedule || "auto";
          const siteScheduleModeRaw = site.scheduleMode || site.schedule_mode || batchMode || "fixed";
          const siteScheduleMode = siteScheduleModeRaw === "independent" ? "fixed" : siteScheduleModeRaw;
          const isAutoTime = !cron || cron === "auto";
          const isRandomTime = isAutoTime && siteScheduleMode === "random";
          const timeMatch = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
          const timeValue = timeMatch ? `${String(timeMatch[2]).padStart(2, "0")}:${String(timeMatch[1]).padStart(2, "0")}` : (kind === "visit" ? "09:30" : "09:00");
          const siteRandomStart = batchMode === "random" ? normalizeTime(randomStart || "02:00", "02:00") : normalizeTime(site.randomStart || site.random_start || randomStart || "02:00", "02:00");
          const siteRandomEnd = batchMode === "random" ? normalizeTime(randomEnd || "22:00", "22:00") : normalizeTime(site.randomEnd || site.random_end || randomEnd || "22:00", "22:00");
          const fixedKind = siteKindOf(site);
          const effectiveKind = site.enabled ? fixedKind : "disabled";
          const lockedVisit = site.enforced_kind === "visit" || site.enforcedKind === "visit";
          const manageTwoFaBadge = twoFaCornerHtml(site, site.details || {});
          return `
            <div class="site-manage-row site-manage-grid-row mode-${escAttr(effectiveKind)}" data-site="${escAttr(site.key)}" data-kind="${escAttr(effectiveKind)}" data-category="${escAttr(site.category || 'forum')}">
              <div class="site-manage-main compact">
                ${manageTwoFaBadge}
                <strong class="manage-site-name" data-site="${escAttr(site.key)}" title="双击修改站点名"><span class="manage-driver-kind-icon" title="Driver 默认适配：${escAttr(kindLabel(adaptedKindOf(site)))}">${driverKindIcon(site)}</span>${esc(displaySiteName(site.name))}<span class="site-exec-badge manage-exec-badge" title="${escAttr(executionMethodTitle(site))}">${esc(executionMethodShort(site))}</span></strong>
                <small class="manage-site-summary" aria-hidden="true"></small>
              </div>
              <span class="mobile-field-label">执行方式</span>
              <select class="field-input manage-mode" data-site="${escAttr(site.key)}" data-fixed-kind="${escAttr(fixedKind)}" data-current-mode="${escAttr(effectiveKind)}" data-site-name="${escAttr(displaySiteName(site.name))}" title="${lockedVisit ? "该站点已适配为保活，不支持切回签到" : "执行方式"}">
                <option value="${escAttr(fixedKind)}" ${site.enabled ? "selected" : ""}>${fixedKind === "visit" ? "🌤️" : "✅"} ${esc(kindLabel(fixedKind))}${lockedVisit ? "（固定）" : ""}</option>
                <option value="disabled" ${!site.enabled ? "selected" : ""}>⛔ 禁用</option>
              </select>
              <span class="mobile-field-label">分类</span>
              <select class="field-input manage-category" data-site="${escAttr(site.key)}" title="分类">
                ${categoryOptionHtml(site.category || "forum")}
              </select>
              <span class="mobile-field-label">执行计划</span>
              <select class="field-input manage-exec-mode" data-site="${escAttr(site.key)}" title="执行计划">
                ${batchMode === "random" ? `<option value="random" ${isAutoTime && isRandomTime ? "selected" : ""}>随机执行</option>` : ""}
                ${batchMode === "fixed" ? `<option value="batch" ${isAutoTime && !isRandomTime ? "selected" : ""}>批量执行</option>` : ""}
                <option value="fixed" ${!isAutoTime ? "selected" : ""}>独立执行</option>
              </select>
              <span class="mobile-field-label">时间范围</span>
              <label class="time-field">
                <span class="manage-fixed-time ${isRandomTime ? "is-hidden" : ""}">${timePairHtml(isAutoTime ? effectiveBatchTime : timeValue, { kind: "manage", site: site.key, disabled: isAutoTime })}</span>
                <span class="manage-random-time ${isRandomTime ? "" : "is-hidden"}">${randomRangeHtml(siteRandomStart, siteRandomEnd, { kind: `manage-random-${site.key}`, disabled: true }).replace('<span class="random-range ', `<span data-site="${escAttr(site.key)}" data-readonly="true" class="random-range is-readonly `)}</span>
              </label>
              <span class="mobile-field-label">代理</span>
              <select class="field-input manage-proxy" data-site="${escAttr(site.key)}">
                <option value="auto" ${site.proxyMode === "auto" ? "selected" : ""}>自动判断</option>
                <option value="on" ${site.proxyMode === "on" ? "selected" : ""}>代理</option>
                <option value="off" ${site.proxyMode === "off" ? "selected" : ""}>直连</option>
              </select>
              <span class="mobile-field-label">凭据维护</span>
              <button class="btn btn-secondary btn-compact manage-cookie credential-state ${isTokenCredentialSite(site) ? "token-credential" : ""} ${site.hasCookie ? "has-cookie" : ""} ${site.hasTotpSecret ? "has-2fa" : ""}" type="button" data-site="${escAttr(site.key)}" data-name="${escAttr(site.name)}" title="${credentialPrimaryLabel(site)}：${site.hasCookie ? "已维护" : "未维护"}；2FA：${site.hasTotpSecret ? "已维护" : "未维护"}"><span class="credential-cookie">${credentialPrimaryLabel(site)}</span><span class="credential-slash">/</span><span class="credential-2fa">2FA</span></button>
              <span class="mobile-field-label">操作</span>
              <button class="btn btn-danger btn-compact manage-delete" type="button" data-site="${escAttr(site.key)}" data-name="${escAttr(site.name)}">删除</button>
            </div>
          `;
        }).join("") : `<div class="empty-cell">暂无站点</div>`}
      </div>

    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("siteManageClose")?.addEventListener("click", closeSiteManageModal);
  document.getElementById("siteManageDone")?.addEventListener("click", closeSiteManageModal);
  document.getElementById("siteManageRefresh")?.addEventListener("click", () => openSiteManageModal(kind, { sort: manageSort, kindFilter: manageKindFilter, search: document.getElementById("siteManageSearch")?.value || manageSearch, forceRefresh: true }));
  document.getElementById("btnAddSite")?.addEventListener("click", () => openAddSiteModal(kind));
  const batchScheduleModeEl = document.getElementById("batchScheduleMode");
  const batchFixedTimeWrap = document.getElementById("batchFixedTimeWrap");
  const batchRandomRangeWrap = document.getElementById("batchRandomRangeWrap");
  const syncBatchModeUi = () => {
    const mode = batchScheduleModeEl?.value || "fixed";
    const random = mode === "random";
    const independent = mode === "independent";
    batchFixedTimeWrap?.classList.toggle("is-hidden", random || independent);
    batchRandomRangeWrap?.classList.toggle("is-hidden", !random);
    setRandomRangeDisabled(modal, "batch-random", !random);
  };
  syncBatchModeUi();
  const globalTriggerValueForMode = (mode = "fixed") => mode === "random" ? "random" : (mode === "independent" ? "fixed" : "batch");
  const refreshTriggerSelectOptions = (select, mode, { preserveManualFixed = true } = {}) => {
    const previous = select.value || select.dataset.triggerValue || "fixed";
    const globalValue = globalTriggerValueForMode(mode);
    if (mode === "random") {
      select.innerHTML = `<option value="random">随机执行</option><option value="fixed">独立执行</option>`;
    } else if (mode === "fixed") {
      select.innerHTML = `<option value="batch">批量执行</option><option value="fixed">独立执行</option>`;
    } else {
      select.innerHTML = `<option value="fixed">独立执行</option>`;
    }
    const nextValue = previous === "fixed" && preserveManualFixed ? "fixed" : globalValue;
    select.value = [...select.options].some(option => option.value === nextValue) ? nextValue : (select.options[0]?.value || "fixed");
    select.dataset.triggerValue = select.value;
  };
  const saveBatchSettings = async () => {
    const mode = batchScheduleModeEl?.value === "independent" ? "independent" : (batchScheduleModeEl?.value === "fixed" ? "fixed" : "random");
    const fixedTime = getTimePairValue(modal, "batch") || (kind === "visit" ? "09:30" : "09:00");
    const range = getRandomRangeValue(modal, "batch-random");
    // 切换左上模式时，只在“参与全局触发”的行之间转换 batch/random；手动独立执行的行保持独立。
    modal.querySelectorAll(".manage-exec-mode").forEach(select => {
      refreshTriggerSelectOptions(select, mode, { preserveManualFixed: true });
      applyExecModeUi(select);
    });
    await api("/api/batch-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(kind === "visit" ? { mode, visitTime: fixedTime, randomStart: normalizeTime(range.start, "02:00"), randomEnd: normalizeTime(range.end, "22:00") } : { mode, signinTime: fixedTime, randomStart: normalizeTime(range.start, "02:00"), randomEnd: normalizeTime(range.end, "22:00") }) });
    showToast(mode === "independent" ? "✅ 已切换为独立执行" : (mode === "random" ? "✅ 随机执行范围已保存" : "✅ 批量执行时间已保存"), "success");
    for (const select of modal.querySelectorAll(".manage-exec-mode")) {
      await saveExecMode(select);
    }
    // 重新渲染弹窗，确保行内只读时间/随机范围也完全按最新总模式显示。
    await openSiteManageModal(kind, {
      sort: manageSort,
      kindFilter: manageKindFilter,
      search: document.getElementById("siteManageSearch")?.value || manageSearch,
      forceRefresh: true,
    });
  };
  const triggerBulkValue = () => {
    const mode = batchScheduleModeEl?.value || "fixed";
    if (mode === "random") return "random";
    if (mode === "independent") return "fixed";
    return "batch";
  };
  const triggerBulkLabel = () => {
    const mode = batchScheduleModeEl?.value || "fixed";
    if (mode === "random") return "随机执行";
    if (mode === "independent") return "独立执行";
    return "批量执行";
  };
  const setSelectValueSafely = (select, value) => {
    if (!select) return;
    if (![...select.options].some(option => option.value === value)) {
      refreshTriggerSelectOptions(select, batchScheduleModeEl?.value || "fixed", { preserveManualFixed: value === "fixed" });
    }
    select.value = [...select.options].some(option => option.value === value) ? value : (select.options[0]?.value || "fixed");
    select.dataset.triggerValue = select.value;
  };
  const applyExecModeUi = (select) => {
    const row = select.closest(".site-manage-row");
    const site = select.dataset.site;
    let mode = select.value;
    if (![...select.options].some(option => option.value === mode)) {
      setSelectValueSafely(select, triggerBulkValue());
      mode = select.value;
    }
    row?.querySelector(".manage-fixed-time")?.classList.toggle("is-hidden", mode === "random");
    row?.querySelector(".manage-random-time")?.classList.toggle("is-hidden", mode !== "random");
    setTimePairDisabled(row || modal, "manage", mode !== "fixed", site);
    row?.querySelectorAll(`.manage-random-${CSS.escape(site)}-start-hour,.manage-random-${CSS.escape(site)}-start-minute,.manage-random-${CSS.escape(site)}-end-hour,.manage-random-${CSS.escape(site)}-end-minute`).forEach(el => el.toggleAttribute("disabled", true));
  };
  const saveExecMode = async (select) => {
    const site = select.dataset.site;
    const mode = select.value;
    const row = select.closest(".site-manage-row");
    const rowKind = row?.dataset.kind === "visit" ? "visit" : "signin";
    const fixedTime = getTimePairValue(modal, "manage", site) || (rowKind === "visit" ? "09:30" : "09:00");
    const [hour, minute] = fixedTime.split(":").map(v => parseInt(v, 10));
    const schedule = mode === "fixed" ? `${Number.isFinite(minute) ? minute : 0} ${Number.isFinite(hour) ? hour : 9} * * *` : "auto";
    const rangeStart = normalizeTime(getTimePairValue(modal, `manage-random-${site}-start`) || randomStart, "02:00");
    const rangeEnd = normalizeTime(getTimePairValue(modal, `manage-random-${site}-end`) || randomEnd, "22:00");
    await api(`/api/sites/${encodeURIComponent(site)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schedule, scheduleMode: mode === "random" ? "random" : "fixed", randomStart: rangeStart, randomEnd: rangeEnd }) });
  };
  batchScheduleModeEl?.addEventListener("change", async () => { syncBatchModeUi(); await saveBatchSettings(); });
  modal.querySelectorAll(".batch-hour,.batch-minute,.batch-random-start-hour,.batch-random-start-minute,.batch-random-end-hour,.batch-random-end-minute").forEach(sel => sel.addEventListener("change", saveBatchSettings));
  modal.querySelectorAll(".random-range").forEach(range => {
    range.addEventListener("click", () => {
      const site = range.dataset.site || "";
      if (site || range.dataset.readonly === "true") return;
      const kindName = "batch-random";
      openRandomRangePopover(range, modal, kindName, async () => {
        await saveBatchSettings();
      });
    });
  });
  let syncManageBatchAll = () => {};
  modal.querySelectorAll(".manage-exec-mode").forEach(select => {
    applyExecModeUi(select);
    select.addEventListener("change", async () => {
      select.disabled = true;
      try { applyExecModeUi(select); await saveExecMode(select); syncManageBatchAll(); showToast(select.value === "random" ? "✅ 已设为随机执行" : (select.value === "batch" ? "✅ 已设为批量执行" : "✅ 已设为独立执行"), "success"); await loadSites(true); }
      catch (err) { showToast(`执行计划保存失败: ${err.message}`, "error"); }
      finally { select.disabled = false; syncManageBatchAll(); }
    });
  });
  modal.querySelectorAll(".manage-hour,.manage-minute").forEach(sel => sel.addEventListener("change", async () => {
    const site = sel.dataset.site;
    const select = modal.querySelector(`.manage-exec-mode[data-site="${CSS.escape(site)}"]`);
    if (!select || select.value !== "fixed") return;
    try { await saveExecMode(select); showToast("✅ 签到时间已保存", "success"); await loadSites(true); }
    catch (err) { showToast(`保存签到时间失败: ${err.message}`, "error"); }
  }));
  // 行内随机范围只读展示左上角随机执行设置，不做单站编辑。
  const manageBatchAll = document.getElementById("manageBatchAll");
  if (manageBatchAll) {
    syncManageBatchAll = () => {
      const boxes = [...modal.querySelectorAll(".manage-exec-mode")];
      const bulk = triggerBulkValue();
      manageBatchAll.checked = boxes.length > 0 && boxes.every(box => box.value === bulk);
      manageBatchAll.indeterminate = boxes.some(box => box.value === bulk) && !manageBatchAll.checked;
      manageBatchAll.title = `全选/取消全选${triggerBulkLabel()}`;
    };
    syncManageBatchAll();
    manageBatchAll.addEventListener("change", async () => {
      const selects = [...modal.querySelectorAll(".manage-exec-mode")];
      if (!manageBatchAll.checked) {
        manageBatchAll.indeterminate = false;
        manageBatchAll.title = `应用${triggerBulkLabel()}到全部站点`;
        showToast("已保持当前触发方式不变", "info");
        return;
      }
      const bulk = triggerBulkValue();
      const label = triggerBulkLabel();
      manageBatchAll.disabled = true;
      try {
        for (const select of selects) {
          setSelectValueSafely(select, bulk);
          applyExecModeUi(select);
          await saveExecMode(select);
        }
        showToast(`✅ 已全选${label}`, "success");
        await loadSites(true);
      } catch (err) { showToast(`批量设置失败: ${err.message}`, "error"); }
      finally { manageBatchAll.disabled = false; syncManageBatchAll(); }
    });
  }

  modal.querySelectorAll(".manage-sort-head").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort || "name";
      const dir = manageSort.key === key && manageSort.dir === "asc" ? "desc" : "asc";
      showSiteManageModal(sites, proxy, kind, batch, { sort: { key, dir }, kindFilter: manageKindFilter, search: document.getElementById("siteManageSearch")?.value || manageSearch });
    });
  });
  modal.querySelectorAll(".manage-kind-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const nextKind = tab.dataset.kind || "all";
      showSiteManageModal(sites, proxy, kind, batch, { sort: manageSort, kindFilter: nextKind, search: document.getElementById("siteManageSearch")?.value || manageSearch });
    });
  });

  let activeManageCategory = "all";
  const applyManageFilters = (category = activeManageCategory) => {
    activeManageCategory = category || "all";
    const query = String(document.getElementById("siteManageSearch")?.value || "").trim().toLowerCase();
    const rows = [...modal.querySelectorAll(".site-manage-grid-row")];
    let visibleCount = 0;
    rows.forEach(row => {
      const categoryMatched = activeManageCategory === "all" || row.dataset.category === activeManageCategory;
      const kindMatched = manageKindFilter === "all" || row.dataset.kind === manageKindFilter;
      const textMatched = !query || String(row.textContent || "").toLowerCase().includes(query) || String(row.dataset.site || "").toLowerCase().includes(query);
      const matched = categoryMatched && kindMatched && textMatched;
      row.classList.toggle("is-hidden-by-category", !matched);
      if (matched) visibleCount += 1;
    });
    let empty = modal.querySelector(".site-manage-empty-filter");
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "site-manage-empty-filter empty-cell";
      empty.textContent = "没有匹配的站点";
      modal.querySelector(".site-manage-list")?.appendChild(empty);
    }
    empty.classList.toggle("show", visibleCount === 0);
  };
  modal.querySelectorAll("#siteCategoryTabs .category-pill").forEach(tab => {
    tab.addEventListener("click", () => {
      modal.querySelectorAll("#siteCategoryTabs .category-pill").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      applyManageFilters(tab.dataset.category || "all");
    });
  });
  applyManageFilters("all");
  document.getElementById("siteManageSearch")?.addEventListener("input", () => applyManageFilters(activeManageCategory));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeSiteManageModal();
  });



  modal.querySelectorAll(".manage-site-name").forEach(nameEl => {
    const finishEdit = async (commit = true) => {
      if (!nameEl.isContentEditable) return;
      const site = nameEl.dataset.site;
      const oldName = nameEl.dataset.originalName || "";
      const name = nameEl.textContent.trim();
      nameEl.contentEditable = "false";
      nameEl.classList.remove("is-editing");
      if (!commit || !name || name === oldName) {
        nameEl.textContent = oldName;
        return;
      }
      nameEl.classList.add("is-saving");
      try {
        await api(`/api/sites/${encodeURIComponent(site)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: name }),
        });
        nameEl.textContent = name;
        nameEl.dataset.originalName = name;
        await loadSites(true);
        showToast("✅ 站点名已更新", "success");
      } catch (err) {
        nameEl.textContent = oldName;
        showToast(`站点名更新失败: ${err.message}`, "error");
      } finally {
        nameEl.classList.remove("is-saving");
      }
    };
    nameEl.addEventListener("dblclick", () => {
      nameEl.dataset.originalName = nameEl.textContent.trim();
      nameEl.contentEditable = "true";
      nameEl.classList.add("is-editing");
      const range = document.createRange();
      range.selectNodeContents(nameEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      nameEl.focus();
    });
    nameEl.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        finishEdit(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finishEdit(false);
      }
    });
    nameEl.addEventListener("blur", () => finishEdit(true));
  });

  modal.querySelectorAll(".manage-mode").forEach(select => {
    select.addEventListener("change", async () => {
      const site = select.dataset.site;
      const mode = select.value;
      const previousMode = select.dataset.currentMode || select.dataset.fixedKind || "signin";
      const fixedKind = select.dataset.fixedKind || "signin";
      const payload = mode === "disabled" ? { enabled: false } : { enabled: true, kind: fixedKind };
      select.disabled = true;
      try {
        await api(`/api/sites/${encodeURIComponent(site)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        showToast(mode === "disabled" ? "✅ 已设为禁用站点" : `✅ 已启用${kindLabel(fixedKind)}`, "success");
        await loadSites(true);
        await openSiteManageModal(kind, { sort: manageSort, kindFilter: manageKindFilter });
      } catch (err) {
        select.value = previousMode;
        showToast(`切换启用状态失败: ${err.message}`, "error");
      } finally {
        select.disabled = false;
      }
    });
  });

  modal.querySelectorAll(".manage-category").forEach(select => {
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await api(`/api/sites/${encodeURIComponent(select.dataset.site)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: select.value }),
        });
        showToast("✅ 分类已保存", "success");
        await loadSites(true);
        await openSiteManageModal(kind, { sort: manageSort, kindFilter: manageKindFilter });
      } catch (err) {
        showToast(`保存分类失败: ${err.message}`, "error");
      } finally {
        select.disabled = false;
      }
    });
  });


  modal.querySelectorAll(".manage-proxy").forEach(select => {
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await api(`/api/sites/${encodeURIComponent(select.dataset.site)}/proxy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: select.value }),
        });
        if (select.value === "auto") {
          showToast("正在判断直连/代理…");
          await api(`/api/sites/${encodeURIComponent(select.dataset.site)}/proxy-check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: true }),
          });
        }
        showToast("✅ 代理策略已保存", "success");
        await Promise.all([loadProxySettings(), loadSites(true)]);
      } catch (err) {
        showToast(`保存代理策略失败: ${err.message}`, "error");
      } finally {
        select.disabled = false;
      }
    });
  });

  modal.querySelectorAll(".manage-cookie").forEach(btn => {
    btn.addEventListener("click", () => {
      const site = btn.dataset.site;
      const name = btn.dataset.name || site;
      // 保留站点配置弹窗，Cookie 维护作为上层弹窗叠加；关闭后自然回到站点配置。
      openCredentialModal(site, name);
    });
  });

  modal.querySelectorAll(".manage-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      const site = btn.dataset.site;
      const name = btn.dataset.name || site;
      if (!confirm(`确认删除站点「${name}」？\n\n只会删除站点配置，不会删除历史记录。`)) return;
      btn.disabled = true;
      try {
        await api(`/api/sites/${encodeURIComponent(site)}`, { method: "DELETE" });
        showToast("✅ 站点已删除", "success");
        await loadSites(true);
        await openSiteManageModal(kind, { sort: manageSort, kindFilter: manageKindFilter });
      } catch (err) {
        showToast(`删除失败: ${err.message}`, "error");
      } finally {
        btn.disabled = false;
      }
    });
  });
}



async function openTelegramSettingsModal() {
  const modal = document.getElementById("siteManageModal");
  const card = modal?.querySelector(".site-manage-modal-card");
  if (!card) return;
  let box = document.getElementById("telegramSettingsBox");
  if (box) { box.remove(); return; }
  document.getElementById("addSiteBox")?.remove();
  box = document.createElement("div");
  box.id = "telegramSettingsBox";
  box.className = "add-site-box";
  box.innerHTML = `<div class="empty-cell"><span class="spinner"></span>读取 Telegram 通知配置…</div>`;
  card.querySelector(".site-manage-list")?.after(box);
  try {
    const { data } = await api("/api/telegram");
    box.innerHTML = `
      <div class="manual-website-box telegram-box">
        <h3>Telegram 通知</h3>
        <form id="telegramSettingsForm" class="credential-form">
          <label><span class="field-label">Bot Token</span><input class="field-input" name="botToken" type="password" value="${data.hasBotToken ? "••••••••••••••••" : ""}" data-has-token="${data.hasBotToken ? "1" : "0"}" placeholder="123456:ABC..."></label>
          <label><span class="field-label">Chat ID</span><input class="field-input" name="chatId" value="${escAttr(data.chatId || "")}" placeholder="例如 1010290845" required></label>
          <div class="credential-actions">
            <button class="btn btn-primary" type="submit">保存通知设置</button>
            <button class="btn btn-secondary" type="button" id="telegramTestBtn">测试发送</button>
          </div>
          <div class="field-help">${data.hasBotToken ? "Bot Token 已保存；不修改可保持默认占位。" : "请填写 Bot Token。"} 配置会保存到 config/notify.yaml。</div>
        </form>
      </div>`;
    const form = box.querySelector("#telegramSettingsForm");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await api("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: form.elements.botToken.value.includes("•") ? "" : form.elements.botToken.value, chatId: form.elements.chatId.value }),
      });
      form.elements.botToken.value = "••••••••••••••••";
      form.elements.botToken.dataset.hasToken = "1";
      showToast("✅ Telegram 通知设置已保存", "success");
    });
    box.querySelector("#telegramTestBtn")?.addEventListener("click", async () => {
      try {
        await api("/api/telegram/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botToken: form.elements.botToken.value.includes("•") ? "" : form.elements.botToken.value, chatId: form.elements.chatId.value }),
        });
        showToast("✅ 测试通知已发送", "success");
      } catch (err) {
        showToast(`测试失败: ${err.message}`, "error");
      }
    });
  } catch (err) {
    box.innerHTML = `<div class="empty-cell error">读取失败：${esc(err.message)}</div>`;
  }
}


async function triggerVisitAll() {
  const btn = document.getElementById("btnRunVisits") || document.getElementById("btnRunVisitsPage");
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>保活中…'; }
  try {
    const res = await api("/api/visit/run", { method: "POST" });
    const results = res.data || [];
    const ok = results.filter(r => r.success).length;
    showToast(`保活完成: ${ok}/${results.length} 成功`, ok === results.length ? "success" : "error");
    await loadSites(true);
    if (document.getElementById("siteManageModal")) await openSiteManageModal("visit");
  } catch (err) {
    showToast(`保活失败: ${err.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn.id === "btnRunVisitsPage" ? "🌤 批量保活" : "🌤 保活"; }
  }
}

async function openAddSiteModal(kind = "signin") {
  document.getElementById("addSiteModal")?.remove();
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "addSiteModal";
  modal.innerHTML = `<div class="modal-card add-site-modal-card" role="dialog" aria-modal="true"><div class="modal-header"><div><h2>添加站点</h2><p>从 SignMate 已适配站点列表中选择添加</p></div><button class="modal-close" type="button" id="addSiteClose">×</button></div><div id="addSiteBox" class="add-site-box"><div class="empty-cell centered"><span class="spinner"></span>读取已适配站点列表…</div></div></div>`;
  document.body.appendChild(modal);
  document.getElementById("addSiteClose")?.addEventListener("click", () => modal.remove());
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
  const box = document.getElementById("addSiteBox");

  const refreshAvailableSites = async () => {
    box.innerHTML = `<div class="empty-cell centered"><span class="spinner"></span>读取已适配站点列表…</div>`;
    await loadCategories();
    const { data } = await api("/api/available-sites");
    const pending = (data || []).filter(item => !item.added);
    box.innerHTML = `
      <div class="available-site-toolbar">
        <label class="mini-switch"><input type="checkbox" id="availableSelectAll" ${pending.length ? "" : "disabled"}><span>全选可添加站点</span></label>
        <button class="btn btn-primary btn-compact" type="button" id="addSelectedSites" ${pending.length ? "" : "disabled"}>添加选中</button>
        <small>${pending.length ? `可添加 ${pending.length} / 已适配 ${data.length}` : `已适配 ${data.length} 个站点均已添加`}</small>
      </div>
      <div class="available-site-list">
        ${pending.length ? pending.map(item => `
          <div class="available-site-row" data-key="${escAttr(item.key)}">
            <label class="available-site-check"><input type="checkbox" class="available-site-select" data-key="${escAttr(item.key)}"></label>
            <div class="available-site-info">
              <strong>${esc(displaySiteName(item.name))}</strong>
              <small>${esc(item.kind === "visit" ? "保活" : "签到")} · Driver: ${esc(item.driver)} · ${esc(item.baseUrl || "未配置 URL")}</small>
            </div>
            <div class="available-site-actions">
              ${timePairHtml("09:00", { kind: "available", driver: item.key })}
              <button class="btn btn-primary btn-compact add-maintained-site" type="button"
                data-driver="${escAttr(item.driver)}"
                data-key="${escAttr(item.key)}"
                data-name="${escAttr(item.name)}"
                data-base-url="${escAttr(item.baseUrl)}"
                data-kind="${escAttr(item.kind || "signin")}"
                data-signin-mode="${escAttr(item.signinMode || "")}" data-category="${escAttr(item.category || "forum")}">添加</button>
            </div>
          </div>
        `).join("") : `<div class="empty-cell centered add-site-empty"><strong>暂无可添加站点。</strong><span>这里只显示 SignMate 已适配且尚未添加的站点；如需支持新站点，需要先新增 Driver 适配。</span></div>`}
      </div>
      ${pending.length ? `<div class="field-help centered-help">这里只显示 SignMate 已适配且尚未添加的站点；如需支持新站点，需要先新增 Driver 适配。</div>` : ""}
    `;

    const payloadForButton = (btn) => {
      const availablePair = box.querySelector(`.time-pair-available[data-driver="${CSS.escape(btn.dataset.key)}"]`);
      const hourVal = availablePair?.querySelector(".available-hour")?.value || "09";
      const minuteVal = availablePair?.querySelector(".available-minute")?.value || "00";
      const [hour, minute] = [`${hourVal}`, `${minuteVal}`].map(v => parseInt(v, 10));
      return {
        key: btn.dataset.key,
        note: btn.dataset.name,
        driver: btn.dataset.driver,
        baseUrl: btn.dataset.baseUrl,
        schedule: `${Number.isFinite(minute) ? minute : 0} ${Number.isFinite(hour) ? hour : 9} * * *`,
        proxyMode: "auto",
        signinMode: btn.dataset.signinMode || "",
        category: btn.dataset.category || "forum",
        kind: btn.dataset.kind || "signin",
      };
    };

    const addButtons = [...box.querySelectorAll(".add-maintained-site")];
    const addOne = async (btn, { quiet = false } = {}) => {
      btn.disabled = true;
      const row = btn.closest(".available-site-row");
      try {
        await api("/api/sites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadForButton(btn)),
        });
        row?.classList.add("is-added");
        if (!quiet) showToast("✅ 站点已添加", "success");
        return true;
      } catch (err) {
        showToast(`添加 ${btn.dataset.name || btn.dataset.key} 失败: ${err.message}`, "error");
        btn.disabled = false;
        return false;
      }
    };

    addButtons.forEach(btn => {
      btn.addEventListener("click", async () => {
        const ok = await addOne(btn);
        if (ok) {
          await loadSites(true);
          await openSiteManageModal(kind, { forceRefresh: true });
          await refreshAvailableSites();
        }
      });
    });

    const selectAll = box.querySelector("#availableSelectAll");
    const selectedBtn = box.querySelector("#addSelectedSites");
    const syncSelectAll = () => {
      const boxes = [...box.querySelectorAll(".available-site-select")].filter(input => !input.disabled);
      const checked = boxes.filter(input => input.checked);
      if (selectAll) {
        selectAll.checked = boxes.length > 0 && checked.length === boxes.length;
        selectAll.indeterminate = checked.length > 0 && checked.length < boxes.length;
      }
      if (selectedBtn) selectedBtn.disabled = checked.length === 0;
    };
    selectAll?.addEventListener("change", () => {
      box.querySelectorAll(".available-site-select").forEach(input => { if (!input.disabled) input.checked = selectAll.checked; });
      syncSelectAll();
    });
    box.querySelectorAll(".available-site-select").forEach(input => input.addEventListener("change", syncSelectAll));
    syncSelectAll();

    selectedBtn?.addEventListener("click", async () => {
      const checkedKeys = [...box.querySelectorAll(".available-site-select:checked")].map(input => input.dataset.key);
      const buttons = checkedKeys.map(key => box.querySelector(`.add-maintained-site[data-key="${CSS.escape(key)}"]`)).filter(Boolean);
      if (!buttons.length) return;
      selectedBtn.disabled = true;
      selectedBtn.innerHTML = '<span class="spinner"></span>添加中…';
      let ok = 0;
      for (const btn of buttons) if (await addOne(btn, { quiet: true })) ok += 1;
      showToast(`✅ 已添加 ${ok}/${buttons.length} 个站点`, ok === buttons.length ? "success" : "error");
      await loadSites(true);
      await openSiteManageModal(kind, { forceRefresh: true });
      await refreshAvailableSites();
    });
  };

  try {
    await refreshAvailableSites();
  } catch (err) {
    box.innerHTML = `<div class="empty-cell centered">读取失败：${esc(err.message)}</div>`;
  }
}


async function loadMaintenancePage() {
  const root = document.getElementById("maintenancePageRoot");
  if (!root) return;
  root.innerHTML = maintenanceInnerHtml();
  bindMaintenanceControls();
  await hydrateMaintenanceData();
}

function maintenanceInnerHtml() {
  return `
      <div class="maintenance-grid maintenance-grid-two-col maintenance-grid-four-cards">
        <div class="maintenance-column">
          <section class="card inner-card app-settings-card maintenance-equal-card">
            <div class="card-title-row"><h3>面板设置</h3><small id="appSettingsSummary" class="card-title-meta">读取中…</small></div>
            <form id="appSettingsForm" class="credential-form compact-form">
              <label class="field-label" for="appAuthUsername">管理员用户名</label><input id="appAuthUsername" class="field-input" autocomplete="username" value="admin">
              <label class="field-label" for="appAuthPassword">新密码</label><input id="appAuthPassword" class="field-input" type="password" autocomplete="new-password" placeholder="留空不修改；至少 8 位">
              <label class="field-label" for="appBrandTitle">标题</label><input id="appBrandTitle" class="field-input" value="SignMate">
              <label class="mini-switch"><input type="checkbox" id="appAuthDisabled"><span>关闭登录认证（不推荐）</span></label>
              <div class="credential-actions"><button class="btn btn-primary" type="submit">保存面板设置</button><button class="btn btn-secondary" id="btnLogout" type="button">退出登录</button></div>
            </form>
          </section>
          <section class="card inner-card user-data-card maintenance-equal-card">
            <h3>用户数据</h3>
            <div class="maintenance-checklist" id="exportSelectionBox">
              <label class="mini-switch"><input type="checkbox" value="sites" checked><span>站点配置</span></label>
              <label class="mini-switch"><input type="checkbox" value="secrets" checked><span>Cookie / Token / 凭据</span></label>
              <label class="mini-switch"><input type="checkbox" value="notify" checked><span>通知配置</span></label>
              <label class="mini-switch"><input type="checkbox" value="proxy" checked><span>代理设置</span></label>
              <label class="mini-switch"><input type="checkbox" value="cookiecloud" checked><span>CookieCloud</span></label>
              <label class="mini-switch"><input type="checkbox" value="webdav" checked><span>WebDAV</span></label>
              <label class="mini-switch"><input type="checkbox" value="history" checked><span>签到历史</span></label>
              <label class="mini-switch"><input type="checkbox" value="logs"><span>日志</span></label>
            </div>
            <div class="credential-actions"><button class="btn btn-secondary" id="btnExportData" type="button">导出用户数据</button><label class="btn btn-secondary file-button">导入用户数据<input type="file" id="importDataFile" accept="application/json" hidden></label></div>
          </section>
          <section class="card inner-card cookiecloud-card maintenance-equal-card">
            <div class="card-title-row"><div class="card-title-with-meta"><h3 class="help-title" title="从自建 CookieCloud 拉取浏览器 Cookie，按站点域名匹配后写入本地凭据。预览/结果不会显示完整 Cookie。">CookieCloud 同步</h3><small id="cookieCloudStatusMeta" class="card-title-meta">最近同步：-</small></div><label class="mini-switch"><input type="checkbox" id="cookieCloudEnabled"><span>开启</span></label></div>
            <form id="cookieCloudForm" class="credential-form compact-form">
              <label class="field-label" for="cookieCloudHost">服务地址</label><input id="cookieCloudHost" class="field-input" name="host" placeholder="https://cookie.example.com 或 http://host:8088">
              <label class="field-label" for="cookieCloudUuid">UUID</label><input id="cookieCloudUuid" class="field-input" name="uuid" placeholder="CookieCloud UUID">
              <label class="field-label" for="cookieCloudPassword">密码</label><input id="cookieCloudPassword" class="field-input" name="password" type="password" autocomplete="current-password" placeholder="不填则使用已保存密码">
              <div class="maintenance-checklist cookiecloud-options"><label class="mini-switch"><input type="checkbox" id="cookieCloudIncludeDisabled"><span>含停用站点</span></label><label class="mini-switch"><input type="checkbox" id="cookieCloudAutoSync"><span>自动同步</span></label></div>
              <label class="field-label" for="cookieCloudAutoInterval">自动同步间隔（分钟）</label><input id="cookieCloudAutoInterval" class="field-input" name="autoInterval" type="number" min="15" step="15" value="180" placeholder="180">
              <div class="field-help">开启：允许 CookieCloud 预览/同步；点击预览/同步时会自动保存；自动同步开启后由服务端定时同步。</div>
              <div class="credential-actions"><button class="btn btn-secondary" id="btnCookieCloudPreview" type="button">预览匹配</button></div>
            </form>
          </section>
        </div>
        <div class="maintenance-column">
          <section class="card inner-card category-card maintenance-equal-card"><h3>分类维护</h3><div id="categoryMaintenanceBox" class="category-maintenance-list field-help">正在读取…</div></section>
          <section class="card inner-card webdav-card maintenance-equal-card">
            <div class="card-title-row"><div class="card-title-with-meta"><h3 class="help-title" title="备份配置、凭据、通知、代理和历史数据到 WebDAV；最多保留 99 个备份，超出后自动滚动删除最旧备份。">WebDAV 备份</h3><small id="webDavStatusMeta" class="card-title-meta">最近备份：-；下次：-</small></div><label class="mini-switch"><input type="checkbox" id="webDavEnabled"><span>开启</span></label></div>
            <form id="webDavForm" class="credential-form compact-form">
              <label class="field-label" for="webDavUrl">WebDAV 地址</label><input id="webDavUrl" class="field-input" placeholder="https://dav.example.com/signmate">
              <label class="field-label" for="webDavUsername">用户名</label><input id="webDavUsername" class="field-input" autocomplete="username">
              <label class="field-label" for="webDavPassword">密码</label><input id="webDavPassword" class="field-input" type="password" autocomplete="current-password" placeholder="不填则使用已保存密码">
              <div class="webdav-inline-row"><button class="btn btn-secondary" id="btnWebDavTest" type="button">测试连接</button><label class="mini-switch"><input type="checkbox" id="webDavAutoBackup"><span>自动备份</span></label></div>
              <label class="field-label" for="webDavAutoInterval">自动备份间隔（小时）</label><div class="webdav-inline-row"><input id="webDavAutoInterval" class="field-input" type="number" min="1" step="1" value="24"><span class="field-help inline-unit">小时</span></div>
              <div class="credential-actions webdav-bottom-actions"><button class="btn btn-primary" id="btnWebDavBackup" type="button">立即备份</button><button class="btn btn-secondary" id="btnWebDavRestore" type="button">恢复最新</button><button class="btn btn-secondary" id="btnWebDavHistory" type="button">恢复历史</button></div>
            </form>
          </section>
        </div>
      </div>`;
}

function bindMaintenanceControls() {
  document.getElementById("appSettingsForm")?.addEventListener("submit", saveAppSettings);
  document.getElementById("btnLogout")?.addEventListener("click", logoutApp);
  document.getElementById("btnExportData")?.addEventListener("click", exportUserData);
  document.getElementById("importDataFile")?.addEventListener("change", importUserData);
  document.getElementById("btnCookieCloudPreview")?.addEventListener("click", previewCookieCloud);
  document.getElementById("btnWebDavTest")?.addEventListener("click", testWebDav);
  document.getElementById("btnWebDavBackup")?.addEventListener("click", backupWebDav);
  document.getElementById("btnWebDavRestore")?.addEventListener("click", restoreWebDav);
  document.getElementById("btnWebDavHistory")?.addEventListener("click", openWebDavHistoryModal);
  document.getElementById("cookieCloudEnabled")?.addEventListener("change", updateMaintenanceCardStates);
  document.getElementById("webDavEnabled")?.addEventListener("change", updateMaintenanceCardStates);
  ["cookieCloudHost","cookieCloudUuid","cookieCloudPassword","webDavUrl","webDavUsername","webDavPassword"].forEach(id => document.getElementById(id)?.addEventListener("dblclick", event => unlockSavedField(event.currentTarget)));
}

async function hydrateMaintenanceData() {
  try {
    const [{ data: sites }, { data: proxy }, { data: notify }, { data: meta }, { data: cookieCloud }, { data: webdav }] = await Promise.all([api("/api/sites"), api("/api/proxy"), api("/api/notify"), api("/api/meta"), api("/api/cookiecloud/config"), api("/api/webdav/config")]);
    const versionEl = document.getElementById("signmateVersion"); if (versionEl) versionEl.textContent = `SignMate v${meta.version || "unknown"}`;
    await loadAppSettings().catch(() => {});
    updateAppSettingsSummary();
    renderCategoryMaintenance(sites); hydrateCookieCloudForm(cookieCloud); hydrateWebDavForm(webdav); updateMaintenanceCardStates();
  } catch (err) { showToast(`维护页读取失败: ${err.message}`, "error"); }
}



function updateAppSettingsSummary() {
  const el = document.getElementById("appSettingsSummary");
  const auth = appSettings.auth || {};
  const branding = appSettings.branding || {};
  if (el) el.textContent = `认证：${auth.disabled ? "已关闭" : (auth.passwordSet ? "已启用" : "未配置")}`;
  const username = document.getElementById("appAuthUsername"); if (username) username.value = auth.username || "admin";
  const disabled = document.getElementById("appAuthDisabled"); if (disabled) disabled.checked = auth.disabled === true;
  const title = document.getElementById("appBrandTitle"); if (title) title.value = branding.title || "SignMate";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

async function saveAppSettings(event) {
  event.preventDefault();
  try {
    const username = document.getElementById("appAuthUsername")?.value || "admin";
    const password = document.getElementById("appAuthPassword")?.value || "";
    const disabled = document.getElementById("appAuthDisabled")?.checked === true;
    await api("/api/app-settings/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, disabled }) });
    const title = document.getElementById("appBrandTitle")?.value || "SignMate";
    await api("/api/app-settings/branding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    document.getElementById("appAuthPassword").value = "";
    await loadAppSettings();
    updateAppSettingsSummary();
    showToast("✅ 面板设置已保存", "success");
  } catch (err) { showToast(`保存面板设置失败: ${err.message}`, "error"); }
}

async function logoutApp() {
  await fetch("/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
}

function setSavedField(el, saved = false) {
  if (!el) return;
  el.readOnly = saved;
  el.classList.toggle("is-saved-field", saved);
  el.title = saved ? "已保存，双击可编辑" : "";
}
function unlockSavedField(el) {
  if (!el) return;
  setSavedField(el, false);
  el.focus();
  try { el.select(); } catch {}
}
function setCardControlsEnabled(cardSelector, enabled, keepIds = []) {
  const card = document.querySelector(cardSelector);
  if (!card) return;
  card.classList.toggle("is-card-disabled", !enabled);
  card.querySelectorAll("input, button, select, textarea").forEach(el => {
    if (keepIds.includes(el.id)) return;
    el.disabled = !enabled;
  });
}
function updateMaintenanceCardStates() {
  const cookieEnabled = document.getElementById("cookieCloudEnabled")?.checked === true;
  const webdavEnabled = document.getElementById("webDavEnabled")?.checked === true;
  setCardControlsEnabled(".cookiecloud-card", cookieEnabled, ["cookieCloudEnabled"]);
  setCardControlsEnabled(".webdav-card", webdavEnabled, ["webDavEnabled"]);
  const hasCookiePreview = Number(document.querySelector(".cookiecloud-card")?.dataset.previewOk || 0) === 1;
  const hasWebDavSaved = Number(document.querySelector(".webdav-card")?.dataset.testOk || 0) === 1;
  ["btnWebDavBackup", "btnWebDavRestore", "btnWebDavHistory"].forEach(id => { const btn = document.getElementById(id); if (btn) btn.disabled = !webdavEnabled || !hasWebDavSaved; });
}
function lockCookieCloudFields() {
  ["cookieCloudHost", "cookieCloudUuid", "cookieCloudPassword"].forEach(id => setSavedField(document.getElementById(id), true));
}
function lockWebDavFields() {
  ["webDavUrl", "webDavUsername", "webDavPassword"].forEach(id => setSavedField(document.getElementById(id), true));
}

function hydrateWebDavForm(config = {}) {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ""; };
  set("webDavUrl", config.url); set("webDavUsername", config.username); set("webDavAutoInterval", String(Math.max(1, Math.round((config.autoIntervalMinutes || 1440) / 60))));
  const enabled = document.getElementById("webDavEnabled"); if (enabled) enabled.checked = config.enabled === true;
  const auto = document.getElementById("webDavAutoBackup"); if (auto) auto.checked = config.autoBackup === true;
  const pwd = document.getElementById("webDavPassword"); if (pwd) pwd.placeholder = config.passwordSaved ? "已保存；双击可编辑" : "WebDAV 密码";
  document.querySelector(".webdav-card")?.setAttribute("data-test-ok", config.enabled && config.url ? "1" : "0");
  if (config.url || config.username || config.passwordSaved) lockWebDavFields();
  updateWebDavStatusMeta(config);
}
function webDavPayload() {
  const hours = Math.max(1, Number(document.getElementById("webDavAutoInterval")?.value || 24) || 24);
  return { enabled: document.getElementById("webDavEnabled")?.checked === true, url: document.getElementById("webDavUrl")?.value || "", username: document.getElementById("webDavUsername")?.value || "", password: document.getElementById("webDavPassword")?.value || "", saveConfig: true, autoBackup: document.getElementById("webDavAutoBackup")?.checked === true, autoIntervalHours: hours, autoIntervalMinutes: hours * 60 };
}
async function testWebDav() {
  const btn = document.getElementById("btnWebDavTest");
  try {
    const payload = webDavPayload();
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>测试中…'; }
    const { data } = await api("/api/webdav/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await api("/api/webdav/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    document.querySelector(".webdav-card")?.setAttribute("data-test-ok", "1");
    lockWebDavFields();
    updateMaintenanceCardStates();
    showToast(`✅ WebDAV 连接成功${data.backups?.length ? `，已有 ${data.backups.length} 个备份` : ""}`, "success");
  } catch (err) {
    document.querySelector(".webdav-card")?.setAttribute("data-test-ok", "0");
    updateMaintenanceCardStates();
    showToast(`WebDAV 测试失败: ${err.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "测试连接"; }
    updateMaintenanceCardStates();
  }
}
async function backupWebDav() {
  try {
    const payload = webDavPayload();
    await api("/api/webdav/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const { data } = await api("/api/webdav/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    lockWebDavFields();
    document.querySelector(".webdav-card")?.setAttribute("data-test-ok", "1");
    updateMaintenanceCardStates();
    const cfg = await api("/api/webdav/config").catch(() => null);
    if (cfg?.data) hydrateWebDavForm(cfg.data);
    showToast(`✅ WebDAV 备份完成：${data.name}${data.prune?.removed ? `；清理旧备份 ${data.prune.removed} 个` : ""}`, "success");
  } catch (err) { showToast(`WebDAV 备份失败: ${err.message}`, "error"); }
}
async function restoreWebDav() {
  try {
    if (!confirm("确认从 WebDAV 最新备份恢复？会覆盖本地配置/凭据/历史。")) return;
    const { data } = await api("/api/webdav/restore-latest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(webDavPayload()) });
    showToast(`✅ 恢复完成：${data.name}`, "success");
  } catch (err) { showToast(`WebDAV 恢复失败: ${err.message}`, "error"); }
}
async function openWebDavHistoryModal() {
  try {
    const { data } = await api("/api/webdav/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(webDavPayload()) });
    const backups = data.backups || [];
    const modal = document.createElement("div");
    modal.className = "modal-backdrop"; modal.id = "webDavHistoryModal";
    modal.innerHTML = `<div class="modal-card webdav-history-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><h3>选择 WebDAV 历史备份</h3><small>最多显示最近 99 个备份</small></div><button class="modal-close" type="button" id="webDavHistoryClose">×</button></div><div class="webdav-history-list">${backups.length ? backups.map((name, index) => `<button class="webdav-history-row" data-name="${escAttr(name)}"><strong>${index + 1}. ${esc(name)}</strong><small>点击恢复此备份</small></button>`).join("") : `<div class="empty-cell">暂无历史备份</div>`}</div></div>`;
    document.body.appendChild(modal);
    document.getElementById("webDavHistoryClose")?.addEventListener("click", () => modal.remove());
    modal.addEventListener("click", async event => {
      if (event.target === modal) return modal.remove();
      const row = event.target.closest(".webdav-history-row"); if (!row) return;
      const name = row.dataset.name;
      if (!confirm(`确认恢复备份 ${name}？会覆盖本地配置/凭据/历史。`)) return;
      row.disabled = true; row.innerHTML = `<span class="spinner"></span>恢复中…`;
      const { data: restored } = await api("/api/webdav/restore-latest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...webDavPayload(), name }) });
      document.getElementById("webDavResult").textContent = `恢复完成：${restored.name}；已覆盖 ${restored.changed.join("、")}`;
      modal.remove(); showToast("✅ WebDAV 历史备份恢复完成，请刷新页面", "success");
    });
  } catch (err) { showToast(`读取 WebDAV 历史失败: ${err.message}`, "error"); }
}

async function openMaintenanceModal() {
  document.getElementById("maintenanceModal")?.remove();
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "maintenanceModal";
  modal.innerHTML = `
    <div class="modal-card site-manage-modal-card" role="dialog" aria-modal="true">
      <div class="modal-header"><div><h2>维护</h2><p>用户数据导入/导出、站点分析与分类维护 · <span id="signmateVersion">版本读取中…</span></p></div><button class="modal-close" type="button" id="maintenanceClose">×</button></div>
      <div class="maintenance-grid maintenance-grid-two-col maintenance-grid-four-cards">
        <div class="maintenance-column">
          <section class="card inner-card app-settings-card maintenance-equal-card">
            <div class="card-title-row"><h3>面板设置</h3><small id="appSettingsSummary" class="card-title-meta">读取中…</small></div>
            <form id="appSettingsForm" class="credential-form compact-form">
              <label class="field-label" for="appAuthUsername">管理员用户名</label><input id="appAuthUsername" class="field-input" autocomplete="username" value="admin">
              <label class="field-label" for="appAuthPassword">新密码</label><input id="appAuthPassword" class="field-input" type="password" autocomplete="new-password" placeholder="留空不修改；至少 8 位">
              <label class="field-label" for="appBrandTitle">标题</label><input id="appBrandTitle" class="field-input" value="SignMate">
              <label class="mini-switch"><input type="checkbox" id="appAuthDisabled"><span>关闭登录认证（不推荐）</span></label>
              <div class="credential-actions"><button class="btn btn-primary" type="submit">保存面板设置</button><button class="btn btn-secondary" id="btnLogout" type="button">退出登录</button></div>
            </form>
          </section>
          <section class="card inner-card user-data-card maintenance-equal-card">
            <h3>用户数据</h3>
            <div class="maintenance-checklist" id="exportSelectionBox">
              <label class="mini-switch"><input type="checkbox" value="sites" checked><span>站点配置</span></label>
              <label class="mini-switch"><input type="checkbox" value="secrets" checked><span>Cookie / Token / 凭据</span></label>
              <label class="mini-switch"><input type="checkbox" value="notify" checked><span>通知配置</span></label>
              <label class="mini-switch"><input type="checkbox" value="proxy" checked><span>代理设置</span></label>
              <label class="mini-switch"><input type="checkbox" value="history" checked><span>签到历史</span></label>
              <label class="mini-switch"><input type="checkbox" value="logs"><span>日志</span></label>
            </div>
            <div class="credential-actions"><button class="btn btn-secondary" id="btnExportData" type="button">导出用户数据</button><label class="btn btn-secondary file-button">导入用户数据<input type="file" id="importDataFile" accept="application/json" hidden></label></div>
          </section>
          <section class="card inner-card cookiecloud-card maintenance-equal-card">
            <h3>CookieCloud 同步</h3>
            <p class="field-help">从自建 CookieCloud 拉取浏览器 Cookie，按站点域名匹配后写入本地凭据。预览/结果不会显示完整 Cookie。</p>
            <form id="cookieCloudForm" class="credential-form compact-form">
              <label class="field-label" for="cookieCloudHost">服务地址</label>
              <input id="cookieCloudHost" class="field-input" name="host" placeholder="https://cookie.example.com 或 http://host:8088">
              <label class="field-label" for="cookieCloudUuid">UUID</label>
              <input id="cookieCloudUuid" class="field-input" name="uuid" placeholder="CookieCloud UUID">
              <label class="field-label" for="cookieCloudPassword">密码</label>
              <input id="cookieCloudPassword" class="field-input" name="password" type="password" autocomplete="current-password" placeholder="不填则使用已保存密码">
              <div class="maintenance-checklist cookiecloud-options">
                <label class="mini-switch"><input type="checkbox" id="cookieCloudIncludeDisabled"><span>含停用站点</span></label>

                <label class="mini-switch"><input type="checkbox" id="cookieCloudAutoSync"><span>自动同步</span></label>
              </div>
              <label class="field-label" for="cookieCloudAutoInterval">自动同步间隔（分钟）</label>
              <input id="cookieCloudAutoInterval" class="field-input" name="autoInterval" type="number" min="15" step="15" value="180" placeholder="180">
              <div class="field-help">含停用站点：也匹配站点配置里已停用/禁用的站点；点击预览/同步时会保存地址、UUID、密码和自动同步选项；自动同步：保存配置后由服务端定时同步。</div>
              <div class="credential-actions"><button class="btn btn-secondary" id="btnCookieCloudPreview" type="button">预览匹配</button></div>
            </form>
            <div id="cookieCloudResult" class="cookiecloud-result field-help">尚未预览。</div>
          </section>
        </div>
        <section class="card inner-card category-card"><h3>分类维护</h3><div id="categoryMaintenanceBox" class="category-maintenance-list field-help">正在读取…</div></section>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById("maintenanceClose")?.addEventListener("click", () => modal.remove());
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
  document.getElementById("appSettingsForm")?.addEventListener("submit", saveAppSettings);
  document.getElementById("btnLogout")?.addEventListener("click", logoutApp);
  document.getElementById("btnExportData")?.addEventListener("click", exportUserData);
  document.getElementById("importDataFile")?.addEventListener("change", importUserData);
  document.getElementById("btnCookieCloudPreview")?.addEventListener("click", previewCookieCloud);
  try {
    const [{ data: sites }, { data: proxy }, { data: notify }, { data: meta }, { data: cookieCloud }] = await Promise.all([
      api("/api/sites"),
      api("/api/proxy"),
      api("/api/notify"),
      api("/api/meta"),
      api("/api/cookiecloud/config"),
    ]);
    const versionEl = document.getElementById("signmateVersion");
    if (versionEl) versionEl.textContent = `SignMate v${meta.version || "unknown"}`;
    const total = sites.length;
    const signin = sites.filter(s => (s.kind || "signin") === "signin").length;
    const visit = sites.filter(s => (s.kind || (s.driver === "website" || s.driver === "visit" ? "visit" : "signin")) === "visit").length;
    const cats = sites.reduce((m, s) => { const c = s.category || "forum"; m[c] = (m[c] || 0) + 1; return m; }, {});
    const proxySummary = `代理地址 ${proxy.urls?.length || 0} 条 · 测试 URL ${proxy.testUrls?.length || 0} 条`;
    const notifySummary = `Telegram ${notify.telegram?.enabled ? "已配置" : "未配置"} · Bark ${notify.bark?.enabled ? "已配置" : "未配置"}`;
    const analysisBox = document.getElementById("siteAnalysisBox");
    if (analysisBox) analysisBox.innerHTML = `共 ${total} 个站点 · 签到 ${signin} · 保活 ${visit}<br>${Object.entries(cats).map(([k,v]) => `${esc(categoryLabel(k))}: ${v}`).join(" · ")}<br>${esc(proxySummary)}<br>${esc(notifySummary)}`;
    renderCategoryMaintenance(sites);
    hydrateCookieCloudForm(cookieCloud);
  } catch (err) {
    const analysisBox = document.getElementById("siteAnalysisBox");
    if (analysisBox) analysisBox.textContent = `读取失败：${err.message}`;
    const box = document.getElementById("categoryMaintenanceBox");
    if (box) box.textContent = `读取失败：${err.message}`;
  }
}


let lastCookieCloudPreview = [];

function formatMaintenanceTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { hour12: false });
}

function updateCookieCloudStatusMeta(config = {}) {
  const el = document.getElementById("cookieCloudStatusMeta");
  if (!el) return;
  const updated = Number(config.lastUpdatedCount || 0);
  const skipped = Number(config.lastSkippedCount || 0);
  const source = config.lastSource === "auto" ? "自动" : (config.lastSource === "manual" ? "手动" : "");
  const parts = [];
  if (source) parts.push(source);
  if (updated || config.lastSuccessAt) parts.push(`更新 ${updated}`);
  if (skipped) parts.push(`跳过 ${skipped}`);
  const error = config.lastError ? ` · 最近错误：${config.lastError}` : "";
  const summary = parts.length ? ` · ${parts.join(" · ")}` : "";
  el.textContent = `最近同步：${formatMaintenanceTime(config.lastSuccessAt)}${summary}${error}`;
  const skippedItems = Array.isArray(config.lastSkippedItems) ? config.lastSkippedItems : [];
  const skippedText = skippedItems.map(item => item.reason).filter(Boolean).join("\n");
  const nextText = config.nextSyncAt ? `下次自动同步：${formatMaintenanceTime(config.nextSyncAt)}` : "";
  el.title = [nextText, skippedText].filter(Boolean).join("\n");
}

function updateWebDavStatusMeta(config = {}) {
  const el = document.getElementById("webDavStatusMeta");
  if (!el) return;
  const error = config.lastError ? ` · 最近错误：${config.lastError}` : "";
  const backupAt = config.lastSuccessAt || config.lastKnownBackupAt || "";
  const nextAt = config.nextBackupAt || (config.autoBackup && backupAt ? new Date(new Date(backupAt).getTime() + Math.max(60, Number(config.autoIntervalMinutes || 1440) || 1440) * 60 * 1000).toISOString() : "");
  el.textContent = `最近备份：${formatMaintenanceTime(backupAt)}；下次：${formatMaintenanceTime(nextAt)}${error}`;
  el.title = config.lastBackupName || config.lastKnownBackupName || "";
}

function hydrateCookieCloudForm(config = {}) {
  const host = document.getElementById("cookieCloudHost");
  const uuid = document.getElementById("cookieCloudUuid");
  const password = document.getElementById("cookieCloudPassword");
  const autoSync = document.getElementById("cookieCloudAutoSync");
  const interval = document.getElementById("cookieCloudAutoInterval");
  const enabled = document.getElementById("cookieCloudEnabled");
  if (host) host.value = config.host || "";
  if (uuid) uuid.value = config.uuid || "";
  if (password) password.placeholder = config.passwordSaved ? "已保存；双击可编辑" : "CookieCloud 密码";
  if (enabled) enabled.checked = Boolean(config.host || config.uuid || config.autoSync);
  document.querySelector(".cookiecloud-card")?.setAttribute("data-preview-ok", "0");
  if (config.host || config.uuid || config.passwordSaved) lockCookieCloudFields();
  if (autoSync) autoSync.checked = config.autoSync === true;
  if (interval) interval.value = String(config.autoIntervalMinutes || 180);
  const includeDisabled = document.getElementById("cookieCloudIncludeDisabled");
  if (includeDisabled) includeDisabled.checked = config.includeDisabled === true;
  updateCookieCloudStatusMeta(config);
}

function cookieCloudPayload() {
  return {
    enabled: document.getElementById("cookieCloudEnabled")?.checked === true,
    host: document.getElementById("cookieCloudHost")?.value || "",
    uuid: document.getElementById("cookieCloudUuid")?.value || "",
    password: document.getElementById("cookieCloudPassword")?.value || "",
    includeDisabled: document.getElementById("cookieCloudIncludeDisabled")?.checked === true,
    saveConfig: true,
    autoSync: document.getElementById("cookieCloudAutoSync")?.checked === true,
    autoIntervalMinutes: Number(document.getElementById("cookieCloudAutoInterval")?.value || 180),
  };
}

function closeCookieCloudPreviewModal() { document.getElementById("cookieCloudPreviewModal")?.remove(); }

function renderCookieCloudMatches(matches = [], mode = "preview") {
  const modalBtn = document.getElementById("cookieCloudModalSync");
  lastCookieCloudPreview = matches;
  document.querySelector(".cookiecloud-card")?.setAttribute("data-preview-ok", matches.length ? "1" : "0");
  updateMaintenanceCardStates();
  if (mode === "sync" || !matches.length) { if (mode === "sync") closeCookieCloudPreviewModal(); return; }
  closeCookieCloudPreviewModal();
  const modal = document.createElement("div");
  modal.className = "modal-backdrop"; modal.id = "cookieCloudPreviewModal";
  modal.innerHTML = `<div class="modal-card cookiecloud-preview-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><h3>CookieCloud 预览匹配</h3><small>默认勾选已在 SignMate 维护 Cookie 的站点，可手动调整；缺少站点必需 Cookie 时同步会保护已有完整 Cookie。</small></div><button class="modal-close" type="button" id="cookieCloudPreviewClose">×</button></div><div class="cookiecloud-match-list modal-match-list">${matches.map(item => { const missing = item.missingRequiredCookieNames?.length ? ` · 缺少 ${item.missingRequiredCookieNames.join(", ")}` : ""; return `<label class="cookiecloud-match-row"><input type="checkbox" class="cookiecloud-site-choice" value="${escAttr(item.key)}" ${item.signmateHasCookie ? "checked" : ""}><span><strong>${esc(displaySiteName(item.name || item.key))}</strong><small>${esc(item.host || "-")} · ${esc((item.matchedDomains || []).join(", ") || "-")} · ${item.cookieCount || 0} 枚 · ${esc(item.cookieMasked || "******")}${item.signmateHasCookie ? " · 已维护" : " · 未维护"}${esc(missing)}</small></span></label>`; }).join("")}</div><div class="credential-actions modal-actions"><button class="btn btn-secondary" id="cookieCloudSelectAll" type="button">全选</button><button class="btn btn-secondary" id="cookieCloudSelectMaintained" type="button">只选已维护</button><button class="btn btn-primary" id="cookieCloudModalSync" type="button">同步选中 Cookie</button></div></div>`;
  document.body.appendChild(modal);
  document.getElementById("cookieCloudPreviewClose")?.addEventListener("click", closeCookieCloudPreviewModal);
  document.getElementById("cookieCloudSelectAll")?.addEventListener("click", () => modal.querySelectorAll(".cookiecloud-site-choice").forEach(el => el.checked = true));
  document.getElementById("cookieCloudSelectMaintained")?.addEventListener("click", () => modal.querySelectorAll(".cookiecloud-site-choice").forEach((el, i) => { el.checked = !!matches[i]?.signmateHasCookie; }));
  document.getElementById("cookieCloudModalSync")?.addEventListener("click", syncCookieCloud);
  modal.addEventListener("click", event => { if (event.target === modal) closeCookieCloudPreviewModal(); });
}


async function quickCookieCloudSync(event) {
  const btn = event?.currentTarget || document.getElementById("btnQuickCookieSync") || document.getElementById("btnQuickCookieSyncMobile");
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>同步中…'; }
  try {
    const { data } = await api("/api/cookiecloud/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const skippedItems = data.skippedItems || [];
    if (skippedItems.length) {
      showToast(`✅ 已同步 ${data.updated?.length || 0} 个站点 Cookie，跳过 ${skippedItems.length} 个不完整 Cookie`, "warning");
    } else {
      showToast(`✅ 已同步 ${data.updated?.length || 0} 个站点 Cookie`, "success");
    }
    await loadSites(true);
  } catch (err) {
    showToast(`Cookie 同步失败: ${err.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "🔄 Cookie 同步"; }
  }
}

async function previewCookieCloud() {
  const btn = document.getElementById("btnCookieCloudPreview");
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>预览中…'; }
  try {
    const payload = cookieCloudPayload();
    if (payload.saveConfig) await api("/api/cookiecloud/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const { data } = await api("/api/cookiecloud/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    lockCookieCloudFields();
    renderCookieCloudMatches(data.matched || [], "preview");
    showToast(`✅ CookieCloud 匹配到 ${data.matched?.length || 0} 个站点`, "success");
  } catch (err) {
    document.querySelector(".cookiecloud-card")?.setAttribute("data-preview-ok", "0");
    updateMaintenanceCardStates();
    showToast(`CookieCloud 预览失败: ${err.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "预览匹配"; }
    updateMaintenanceCardStates();
  }
}

async function syncCookieCloud() {
  const scope = document.getElementById("cookieCloudPreviewModal") || document;
  const choices = [...scope.querySelectorAll(".cookiecloud-site-choice:checked")].map(el => el.value);
  if (!choices.length) { showToast("请至少选择一个站点", "error"); return; }
  const modalBtn = document.getElementById("cookieCloudModalSync");
  if (modalBtn) { modalBtn.disabled = true; modalBtn.innerHTML = '<span class="spinner"></span>同步中…'; }
  try {
    const payload = { ...cookieCloudPayload(), sites: choices };
    const { data } = await api("/api/cookiecloud/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    renderCookieCloudMatches(data.updated || [], "sync");
    const skippedItems = data.skippedItems || [];
    if (skippedItems.length) {
      showToast(`✅ 已同步 ${data.updated?.length || 0} 个站点 Cookie，跳过 ${skippedItems.length} 个不完整 Cookie`, "warning");
    } else {
      showToast(`✅ 已同步 ${data.updated?.length || 0} 个站点 Cookie`, "success");
    }
    await loadSites(true);
  } catch (err) {
    showToast(`CookieCloud 同步失败: ${err.message}`, "error");
  } finally {
    if (modalBtn) { modalBtn.disabled = false; modalBtn.innerHTML = "同步选中 Cookie"; }
    updateMaintenanceCardStates();
  }
}

function renderCategoryMaintenance(sites = []) {
  const box = document.getElementById("categoryMaintenanceBox");
  if (!box) return;
  const used = sites.reduce((m, s) => { const c = s.category || "forum"; m[c] = (m[c] || 0) + 1; return m; }, {});
  box.innerHTML = `
    <div class="category-maintenance-head">
      <span>图标</span><span>分类名称</span><span>内部标识</span><span>使用</span><span>操作</span>
    </div>
    <div class="category-dictionary-list">
      ${siteCategories.map(c => {
        const count = used[c.key] || 0;
        const locked = count > 0 || c.key === "forum";
        return `
        <div class="category-dictionary-row" data-key="${escAttr(c.key)}">
          <select class="field-input category-emoji-input" data-field="emoji" title="分类图标">${categoryEmojiOptions(c.emoji || "🏷️")}</select>
          <input class="field-input category-label-input" data-field="label" value="${escAttr(c.label || c.key)}" title="分类名称" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" readonly>
          <code class="category-key-badge" title="内部标识：配置文件保存用">${esc(c.key)}</code>
          <span class="category-use-count" title="当前使用该分类的站点数量">${count} 个</span>
          <button class="btn ${c.key === "forum" ? "btn-secondary" : "btn-danger"} category-delete" type="button" data-key="${escAttr(c.key)}" data-count="${count}" ${c.key === "forum" ? "disabled" : ""} title="${c.key === "forum" ? "默认分类不能删除" : (count ? `删除后 ${count} 个站点会改为论坛` : "删除分类")}">删除</button>
        </div>`;
      }).join("")}
    </div>
    <div class="category-add-head"><span>图标</span><span>分类名称</span><span>内部标识</span><span>操作</span></div>
    <form id="categoryAddForm" class="category-add-form" autocomplete="off">
      <select class="field-input category-emoji-input" name="emoji" title="分类图标">${categoryEmojiOptions("🎮")}</select>
      <input class="field-input category-label-input" name="label" placeholder="例如 游戏" required title="页面显示的中文分类名" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true">
      <input class="field-input category-key-input" name="key" placeholder="game" required title="内部标识：用于保存配置，建议英文小写，例如 game">
      <button class="btn btn-primary" type="submit">添加</button>
    </form>
    <div class="field-help">内部标识用于配置保存，建议英文小写，例如 <code>game</code>；页面筛选和下拉会显示中文分类名。</div>
  `;
  box.querySelectorAll(".category-label-input[readonly]").forEach(input => {
    input.addEventListener("focus", () => { input.readOnly = false; }, { once: true });
  });
  box.querySelectorAll(".category-dictionary-row input, .category-dictionary-row select").forEach(input => {
    input.dataset.userEdited = "0";
    input.addEventListener("input", () => { input.dataset.userEdited = "1"; });
    input.addEventListener("change", async () => {
      // Password managers may fire change events when autofilling nearby password fields.
      // Never persist category labels unless the user actually edited this control.
      if (input.dataset.userEdited !== "1") return;
      const row = input.closest(".category-dictionary-row");
      const key = row?.dataset.key;
      const emoji = row?.querySelector('[data-field="emoji"]')?.value || "🏷️";
      const label = row?.querySelector('[data-field="label"]')?.value || key;
      try {
        await api(`/api/categories/${encodeURIComponent(key)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emoji, label }) });
        input.dataset.userEdited = "0";
        await loadCategories();
        renderCategoryMaintenance(sites);
    hydrateCookieCloudForm(cookieCloud);
        showToast("✅ 分类已更新", "success");
      } catch (err) { showToast(`分类更新失败: ${err.message}`, "error"); }
    });
  });
  box.querySelectorAll(".category-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      const count = parseInt(btn.dataset.count || "0", 10) || 0;
      if (count > 0 && !confirm(`这个分类正在被 ${count} 个站点使用。删除后这些站点会改为「论坛」。是否继续？`)) return;
      try {
        const { data } = await api(`/api/categories/${encodeURIComponent(btn.dataset.key)}`, { method: "DELETE" });
        await loadCategories();
        const { data: refreshedSites } = await api("/api/sites");
        renderCategoryMaintenance(refreshedSites || sites);
        await loadSites(true);
        showToast(data?.moved ? `✅ 分类已删除，${data.moved} 个站点已改为论坛` : "✅ 分类已删除", "success");
      } catch (err) { showToast(`删除失败: ${err.message}`, "error"); }
    });
  });
  box.querySelector("#categoryAddForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api("/api/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emoji: form.elements.emoji.value, label: form.elements.label.value, key: form.elements.key.value }) });
      await loadCategories();
      renderCategoryMaintenance(sites);
    hydrateCookieCloudForm(cookieCloud);
      showToast("✅ 分类已添加", "success");
      form.reset();
    } catch (err) { showToast(`添加失败: ${err.message}`, "error"); }
  });
}

async function exportUserData() {
  try {
    const selected = Array.from(document.querySelectorAll('#exportSelectionBox input[type="checkbox"]:checked')).map(el => el.value);
    if (!selected.length) throw new Error("请至少勾选一项导出内容");
    const { data } = await api("/api/maintenance/export");
    const files = {};
    if (selected.includes("sites") && data.files["config/site-overrides.yaml"] != null) files["config/site-overrides.yaml"] = data.files["config/site-overrides.yaml"];
    if (selected.includes("secrets") && data.files["config/secrets.yaml"] != null) files["config/secrets.yaml"] = data.files["config/secrets.yaml"];
    if (selected.includes("notify") && data.files["config/notify.yaml"] != null) files["config/notify.yaml"] = data.files["config/notify.yaml"];
    if (selected.includes("proxy") && data.files["config/proxy-settings.json"] != null) files["config/proxy-settings.json"] = data.files["config/proxy-settings.json"];
    if (selected.includes("cookiecloud") && data.files["config/cookiecloud-settings.json"] != null) files["config/cookiecloud-settings.json"] = data.files["config/cookiecloud-settings.json"];
    if (selected.includes("webdav") && data.files["config/webdav-settings.json"] != null) files["config/webdav-settings.json"] = data.files["config/webdav-settings.json"];
    if (selected.includes("history") && data.files["data/history.json"] != null) files["data/history.json"] = data.files["data/history.json"];
    if (selected.includes("logs") && data.files["logs/latest.log"] != null) files["logs/latest.log"] = data.files["logs/latest.log"];
    const blob = new Blob([JSON.stringify({ exportedAt: data.exportedAt, version: data.version, selected, files }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `signmate-user-data-${new Date().toISOString().slice(0,10)}.json`; a.click();
    URL.revokeObjectURL(url);
    showToast("✅ 用户数据已导出", "success");
  } catch (err) { showToast(`导出失败: ${err.message}`, "error"); }
}

async function importUserData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!confirm("导入会覆盖当前配置/历史，并先在 backups 下自动备份。是否继续？")) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    await api("/api/maintenance/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    showToast("✅ 用户数据已导入，请重启/刷新服务生效", "success");
    await loadSites(true);
  } catch (err) { showToast(`导入失败: ${err.message}`, "error"); }
}

function closeSiteManageModal() {
  document.getElementById("siteManageModal")?.remove();
}


async function openCredentialModal(key, name) {
  try {
    const { data } = await api("/api/credentials");
    const item = data.find(x => x.key === key) || { key, name, cookie: "", sessionOnly: "" };
    showCredentialModal(item);
  } catch (err) {
    showToast(`加载凭据配置失败: ${err.message}`, "error");
  }
}

function showCredentialModal(item) {
  closeCredentialModal();
  const primaryLabel = credentialPrimaryLabel(item);
  const savedType = credentialSavedText(item);
  const pairLabel = credentialPairLabel(item);
  const emptyPlaceholder = isTokenCredentialSite(item) ? "粘贴 M-Team 存取令牌" : "session=你的session值; colors=dark;";
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "credentialModal";
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <div>
          <h2 id="modalCredentialTitle">${pairLabel}</h2>
          <p>${esc(item.name || item.key)}</p>
        </div>
        <button class="modal-close" type="button" id="modalClose">×</button>
      </div>
      <form id="modalCredentialForm" class="credential-form">
        <label class="field-label cookie-clear-title" id="modalCookieLabel" for="modalCookie" title="双击标记清除已保存 ${savedType}，保存后生效">${primaryLabel}</label>
        <textarea id="modalCookie" class="field-textarea" name="cookie" rows="5" placeholder="${escAttr(item.hasCookie ? `已保存：${item.cookieMasked || item.sessionOnlyMasked || "******"}；粘贴新 ${savedType} 才会更新` : emptyPlaceholder)}"></textarea>
        <div class="field-help" id="modalCookieHelp">${item.hasCookie ? `已保存：${esc(item.cookieMasked || item.sessionOnlyMasked || "******")}。` : `当前未保存 ${savedType}。`}为避免泄露，页面不回显完整 ${savedType}；留空保存不会覆盖已有 ${savedType}；双击标题“${primaryLabel}”可标记清除，保存后生效。</div>

        <label class="field-label cookie-clear-title" id="modalTotpLabel" for="modalTotpSecret" title="双击标记清除已保存 2FA Secret，保存后生效">2FA Secret</label>
        <input id="modalTotpSecret" class="field-input" name="totpSecret" type="password" autocomplete="one-time-code" placeholder="${escAttr(item.hasTotpSecret ? `已保存：${item.totpSecretMasked || "******"}；填写新 Secret 才会更新` : "Base32 TOTP Secret")}">
        <div class="field-help" id="modalTotpHelp">${item.hasTotpSecret ? `已保存：${esc(item.totpSecretMasked || "******")}。` : "当前未保存 2FA Secret。"}这里填写站点提供的 Base32 TOTP 密钥/种子，用于自动生成 6 位两步验证码；不是当前动态验证码。留空保存不会覆盖已有 Secret。</div>

        <div class="credential-actions">
          <button class="btn btn-secondary" type="button" id="modalClearCredential">清空</button>
          <button class="btn btn-primary" type="submit">保存</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  const modalForm = document.getElementById("modalCredentialForm");
  const modalCookie = document.getElementById("modalCookie");
  const modalHelp = document.getElementById("modalCookieHelp");
  const modalTotpSecret = document.getElementById("modalTotpSecret");
  const modalTotpHelp = document.getElementById("modalTotpHelp");
  document.getElementById("modalClose")?.addEventListener("click", closeCredentialModal);
  document.getElementById("modalClearCredential")?.addEventListener("click", () => clearCredentialForm(modalForm, item.name || item.key));
  document.getElementById("modalCookieLabel")?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    markCookieClear(modalForm, modalCookie, modalHelp, item.name || item.key);
  });
  modalCookie?.addEventListener("input", () => { if (modalCookie.value.trim()) delete modalForm.dataset.clearCookie; });
  modalTotpSecret?.addEventListener("input", () => {
    modalTotpSecret.value = modalTotpSecret.value.replace(/\s+/g, "").toUpperCase();
    if (modalTotpSecret.value.trim()) delete modalForm.dataset.clearTotpSecret;
  });
  document.getElementById("modalTotpLabel")?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    modalForm.dataset.clearTotpSecret = "1";
    if (modalTotpSecret) {
      modalTotpSecret.value = "";
      modalTotpSecret.placeholder = "已标记清除 2FA Secret；点击保存后生效";
    }
    if (modalTotpHelp) modalTotpHelp.innerHTML = `${esc(item.name || item.key)} 已标记清除已保存 2FA Secret；点击“保存”后才会生效。`;
    showToast("已标记清除 2FA Secret，保存后生效", "info");
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeCredentialModal();
  });
  document.getElementById("modalCredentialForm")?.addEventListener("submit", async (event) => {
    await saveCredential(event, item.key, item.name || item.key);
    closeCredentialModal();
  });
}

function closeCredentialModal() {
  document.getElementById("credentialModal")?.remove();
}

function markCookieClear(form, textarea, helpEl, name = "该站点") {
  if (!form) return;
  form.dataset.clearCookie = "1";
  if (textarea) {
    textarea.value = "";
    textarea.placeholder = "已标记清除 Cookie；点击保存后生效";
  }
  if (helpEl) helpEl.innerHTML = `${esc(name)} 已标记清除已保存 Cookie；点击“保存”后才会生效。粘贴新 Cookie 会覆盖清除标记。`;
  showToast("已标记清除 Cookie，保存后生效", "info");
}

function openProcessModal(site) {
  const existing = document.getElementById("processModal");
  if (existing) existing.remove();
  const lastTime = site.lastTime
    ? new Date(site.lastTime).toLocaleString("zh-CN", { hour12: false })
    : "暂无";
  const details = site.details || {};
  const reward = buildMetricBadges(site, details);
  const rawStats = details.rawStatsText ? `<div class="process-raw-stats">${esc(details.rawStatsText)}</div>` : "";
  const processKind = siteKindOf(site);
  const processAction = processKind === "visit" ? "保活" : "签到";
  const baseProcessTitle = displaySiteName(site.name || site.key);
  const processTitle = processKind === "visit" ? `${baseProcessTitle} 保活` : baseProcessTitle;
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "processModal";
  modal.innerHTML = `
    <div class="modal-card process-modal-card" role="dialog" aria-modal="true">
      <div class="modal-header">
        <div>
          <h3>${esc(processTitle)} · 执行过程</h3>
          <small>${esc(processAction)}时间：${esc(lastTime)}</small>
        </div>
        <button class="modal-close" type="button" id="processModalClose">×</button>
      </div>
      <div class="process-summary">
        ${reward}
        ${rawStats}
      </div>
      <div class="process-two-col">
        <section class="process-col process-steps-col">
          <h4>执行过程</h4>
          ${formatStepList(site.steps || [], site.lastSuccess === true)}
        </section>
        <section class="process-col process-details-col">
          ${formatDetailsPanel(details)}
        </section>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById("processModalClose")?.addEventListener("click", closeProcessModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeProcessModal();
  });
  modal.querySelectorAll(".collapsible-detail").forEach(el => {
    el.addEventListener("dblclick", () => el.classList.toggle("expanded"));
  });
  modal.querySelector('[data-action="toggle-details"]')?.addEventListener("click", event => {
    const panel = modal.querySelector(".process-details-panel");
    panel?.classList.toggle("is-expanded");
    const expanded = panel?.classList.contains("is-expanded");
    const total = panel?.querySelectorAll(".process-detail-row").length || 0;
    event.currentTarget.textContent = expanded ? "收起详细信息" : `展开全部 ${total} 项`;
  });
}

function closeProcessModal() {
  document.getElementById("processModal")?.remove();
}


function setSiteProgress(key, text, percent = 10) {
  const state = runningSites.get(key);
  if (state && typeof state === "object") state.text = text;
  const status = document.getElementById(`status-${key}`);
  const card = document.getElementById(`card-${key}`);
  if (status) status.textContent = text;
  updateBatchCurrentStep(key, text);
  if (card) card.classList.add("is-running");
}

function clearSiteProgress(key, delay = 3000) {
  setTimeout(() => {
    if (runningSites.get(key)) return;
    const card = document.getElementById(`card-${key}`);
    if (card) card.classList.remove("is-running");
  }, delay);
}



// ---- Notify Settings ----
async function loadNotifySettings() {
  const form = document.getElementById("notifyForm");
  if (!form) return;
  try {
    const { data } = await api("/api/notify");
    form.elements.consolidated.checked = data.signin?.consolidated !== false;
    form.elements.onlyFailures.checked = data.signin?.onlyFailures === true;
    form.elements.telegramEnabled.checked = data.telegram?.enabled === true;
    form.elements.telegramBotToken.value = data.telegram?.hasBotToken ? "••••••••••••••••" : "";
    form.elements.telegramChatId.value = data.telegram?.chatId || "";
    form.elements.telegramSignin.checked = data.telegram?.signin !== false;
    form.elements.telegramCookie.checked = data.telegram?.cookie !== false;
    form.elements.telegramProxy.checked = data.telegram?.proxy !== false;
    form.elements.barkEnabled.checked = data.bark?.enabled === true;
    form.elements.barkServer.value = data.bark?.server || "https://api.day.app";
    form.elements.barkKey.value = data.bark?.key || "";
    form.elements.barkSignin.checked = data.bark?.signin !== false;
    form.elements.barkCookie.checked = data.bark?.cookie !== false;
    form.elements.barkProxy.checked = data.bark?.proxy !== false;
  } catch (err) { showToast(`读取通知设置失败: ${err.message}`, "error"); }
}

async function saveNotifySettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await api("/api/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    signin: { consolidated: form.elements.consolidated.checked, onlyFailures: form.elements.onlyFailures.checked },
    telegram: { enabled: form.elements.telegramEnabled.checked, botToken: form.elements.telegramBotToken.value.includes("•") ? "" : form.elements.telegramBotToken.value, chatId: form.elements.telegramChatId.value, signin: form.elements.telegramSignin.checked, cookie: form.elements.telegramCookie.checked, proxy: form.elements.telegramProxy.checked },
    bark: { enabled: form.elements.barkEnabled.checked, server: form.elements.barkServer.value, key: form.elements.barkKey.value, signin: form.elements.barkSignin.checked, cookie: form.elements.barkCookie.checked, proxy: form.elements.barkProxy.checked },
  }) });
  showToast("✅ 通知设置已保存", "success");
  await loadNotifySettings();
}

async function testNotifySettings() {
  try {
    await api("/api/notify/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "proxy" }) });
    showToast("✅ 测试通知已发送", "success");
  } catch (err) { showToast(`测试通知失败: ${err.message}`, "error"); }
}

function proxyDisplayMode(site = {}) {
  if (site.proxyMode === "on") return "proxy";
  if (site.proxyMode === "off") return "direct";
  return site.proxyLastMode || (site.proxyDirectOk === true ? "direct" : site.proxyDirectOk === false ? "proxy" : "auto");
}

function proxyModeHint(site = {}) {
  const checked = site.proxyCheckedAt ? new Date(site.proxyCheckedAt).toLocaleString("zh-CN", { hour12: false }) : "未检测";
  if (site.proxyMode === "auto") {
    if (site.proxyCacheFresh) return `${site.proxyDirectOk ? "缓存：可直连" : "缓存：走代理/离线"} · ${checked}`;
    return `自动模式：待检测 · ${checked}`;
  }
  return `${formatProxyMode(site.proxyMode, true)} · ${checked}`;
}

function openProxyTestModal() {
  const modal = document.getElementById("proxyTestModal");
  if (modal) modal.style.display = "flex";
}

function closeProxyTestModal() {
  const modal = document.getElementById("proxyTestModal");
  if (modal) modal.style.display = "none";
}

// ---- Proxy Settings ----
async function loadProxySettings() {
  const form = document.getElementById("proxyForm");
  const siteBox = document.getElementById("proxySites");
  if (!form || !siteBox) return;
  siteBox.innerHTML = `<div class="empty-cell"><span class="spinner"></span>加载中…</div>`;
  try {
    const { data } = await api("/api/proxy");
    if (form.elements.enabled) form.elements.enabled.checked = data.enabled === true;
    form.elements.url.value = (data.urls && data.urls.length ? data.urls : [data.url || ""]).filter(Boolean).join("\n");
    form.elements.testUrl.value = (data.testUrls && data.testUrls.length ? data.testUrls : [data.testUrl || "https://www.youtube.com"]).filter(Boolean).join("\n");
    form.elements.autoFallback.checked = data.autoFallback !== false;
    if (form.elements.telegramNotifyProxy) form.elements.telegramNotifyProxy.checked = data.telegramNotifyProxy !== false;

    siteBox.innerHTML = data.sites.map(site => {
      const displayMode = proxyDisplayMode(site);
      return `
      <div class="proxy-site-row proxy-row-${escAttr(displayMode)}" id="proxy-row-${escAttr(site.driver)}">
        <div class="proxy-site-meta">
          <strong class="proxy-name-${escAttr(displayMode)}">${esc(displaySiteName(site.name))}</strong>
          <small>${esc(site.driver)} · <span class="proxy-mode-hint">${esc(proxyModeHint(site))}</span></small>
        </div>
        <select class="field-input proxy-mode-select" data-site="${escAttr(site.driver)}">
          <option value="auto" ${site.proxyMode === "auto" ? "selected" : ""}>自动</option>
          <option value="on" ${site.proxyMode === "on" ? "selected" : ""}>代理</option>
          <option value="off" ${site.proxyMode === "off" ? "selected" : ""}>直连</option>
        </select>
      </div>`;
    }).join("");

    siteBox.querySelectorAll(".proxy-mode-select").forEach(select => {
      select.addEventListener("change", async () => {
        await api(`/api/sites/${encodeURIComponent(select.dataset.site)}/proxy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: select.value }),
        });
        if (select.value === "auto") {
          const row = document.getElementById(`proxy-row-${select.dataset.site}`);
          row?.querySelector(".proxy-mode-hint") && (row.querySelector(".proxy-mode-hint").textContent = "正在判断直连/代理…");
          try { await api(`/api/sites/${encodeURIComponent(select.dataset.site)}/proxy-check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }); } catch (err) { showToast(`自动代理判断失败: ${err.message}`, "error"); }
        }
        showToast("✅ 站点代理策略已保存", "success");
        await Promise.all([loadSites(true), loadProxySettings()]);
      });
    });
  } catch (err) {
    siteBox.innerHTML = `<div class="empty-cell">加载失败: ${esc(err.message)}</div>`;
  }
}

async function saveProxySettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const btn = form.querySelector('button[type="submit"]');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>保存中…';
  }
  try {
    await api("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls: form.elements.url.value,
        testUrls: form.elements.testUrl.value,
        autoFallback: form.elements.autoFallback.checked,
        telegramNotifyProxy: form.elements.telegramNotifyProxy ? form.elements.telegramNotifyProxy.checked : true,
      }),
    });
    showToast("✅ 代理设置已保存", "success");
    await loadProxySettings();
    await loadSites(true);
  } catch (err) {
    showToast(`保存代理失败: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "保存代理设置";
    }
  }
}

async function testProxySettings() {
  const form = document.getElementById("proxyForm");
  const resultBox = document.getElementById("proxyTestResult");
  const btn = document.getElementById("btnTestProxy");
  if (!form || !resultBox) return;

  const proxies = String(form.elements.url.value || "").split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean);
  const urls = String(form.elements.testUrl.value || "").split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean);
  const required = Math.min(2, Math.max(urls.length, 1));
  const total = proxies.length * urls.length;

  openProxyTestModal();
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>测试中…'; }

  if (!proxies.length || !urls.length) {
    resultBox.innerHTML = `<div class="test-result fail">请至少填写 1 条代理地址和 1 条测试 URL。</div>`;
    if (btn) { btn.disabled = false; btn.innerHTML = "测试代理"; }
    return;
  }

  const state = proxies.map((proxy, index) => ({ proxy, index, passCount: 0, done: 0, tests: urls.map(testUrl => ({ testUrl, status: "pending" })) }));
  let completed = 0;

  function render() {
    const percent = total ? Math.round((completed / total) * 100) : 0;
    resultBox.innerHTML = `
      <h2 class="section-title">测试进度</h2>
      <div class="progress-box" style="display:block">
        <div class="progress-line"><span class="spinner"></span><span>已完成 ${completed}/${total} 项；每条代理至少通过 ${required} 条测试 URL 才算有效</span></div>
        <div class="progress-bar"><div class="progress-bar-inner" style="width:${percent}%"></div></div>
      </div>
      <div class="proxy-test-grid">
        ${state.map(item => {
          const finished = item.done === urls.length;
          const ok = item.passCount >= required;
          const cls = finished ? (ok ? "ok" : "fail") : "pending";
          return `<div class="test-result ${cls}">
            <strong>#${item.index + 1} ${esc(item.proxy)}：${finished ? (ok ? "可用" : "不可用") : "测试中"}</strong> · 通过 ${item.passCount}/${urls.length}，要求 ≥ ${required}
            <div class="proxy-url-tests">
              ${item.tests.map(t => {
                const mark = t.status === "ok" ? "✅" : t.status === "fail" ? "❌" : "⏳";
                const detail = t.status === "pending" ? "等待中" : `${t.httpStatus || t.error || "失败"} · ${t.ms || 0}ms`;
                return `<div>${mark} ${esc(t.testUrl)} · ${esc(String(detail))}</div>`;
              }).join("")}
            </div>
          </div>`;
        }).join("")}
      </div>`;
  }

  render();
  try {
    const jobs = [];
    state.forEach((item, pi) => {
      item.tests.forEach((test, ti) => {
        jobs.push(api("/api/proxy/test-one", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proxyUrl: item.proxy, testUrl: test.testUrl, timeoutMs: 5000 }),
        }).then(({ data }) => {
          test.status = data.ok ? "ok" : "fail";
          test.httpStatus = data.status;
          test.error = data.error;
          test.ms = data.ms;
          if (data.ok) item.passCount += 1;
        }).catch(err => {
          test.status = "fail";
          test.error = err.message;
        }).finally(() => {
          item.done += 1;
          completed += 1;
          render();
        }));
      });
    });
    await Promise.all(jobs);
    showToast(`✅ 代理测试完成：${state.filter(x => x.passCount >= required).length}/${state.length} 条可用`, "success");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "测试代理"; }
  }
}

function formatProxyMode(mode = "auto", _globalEnabled = true) {
  if (mode === "on") return "代理";
  if (mode === "off") return "直连";
  return "自动判断";
}



function renderStepProgress(steps = []) {
  if (!Array.isArray(steps) || !steps.length) return "";
  return `<div class="inline-step-list">${steps.map((step, index) => `
    <div class="inline-step ${step.ok ? "ok" : "fail"}">
      <span class="inline-step-mark">${step.ok ? "✓" : "×"}</span>
      <span class="inline-step-body"><b>${index + 1}. ${esc(step.label || "步骤")}</b>${step.status ? `<small>HTTP 状态：${esc(String(step.status))}</small>` : ""}${step.detail ? `<small>${esc(step.detail)}</small>` : ""}</span>
    </div>`).join("")}</div>`;
}

function setTrustedSiteProgressHtml(key, html, text = "") {
  // Only pass HTML produced by local renderers that escape API/user-controlled fields.
  const state = runningSites.get(key);
  if (state && typeof state === "object") state.text = text || "执行中…";
  const status = document.getElementById(`status-${key}`);
  const card = document.getElementById(`card-${key}`);
  if (status) status.innerHTML = html;
  updateBatchCurrentStep(key, text || status?.textContent || "");
  if (card) card.classList.add("is-running");
}

function siteLogNeedles(key = "", name = "") {
  const display = displaySiteName(name || key);
  const needles = new Set([key, name, display]);
  if (/nodeseek/i.test(key + name)) needles.add("NodeSeek");
  if (/v2ex/i.test(key + name)) needles.add("V2EX");
  if (/naixi|奶昔/i.test(key + name)) needles.add("奶昔");
  if (/right|恩山/i.test(key + name)) needles.add("恩山");
  if (/chiphell/i.test(key + name)) needles.add("Chiphell");
  return [...needles].filter(Boolean);
}

function cleanLogProgress(line = "") {
  return String(line || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/^\[[^\]]+\]\s*\[[^\]]+\]\s*/, "")
    .trim();
}

function startSiteLogProgress(key, name, startedAt = Date.now()) {
  const needles = siteLogNeedles(key, name);
  let last = "";
  const tick = async () => {
    try {
      const { data } = await api("/api/logs?limit=120");
      const fresh = (Array.isArray(data) ? data : []).filter(item => {
        const t = Date.parse(item?.time || "");
        return Number.isFinite(t) ? t >= startedAt - 500 : true;
      });
      const lines = fresh.map(item => item.message || item.msg || item.line || String(item || ""));
      const hit = [...lines].reverse().find(line => needles.some(n => String(line).includes(n)) && /步骤|代理|签到|访问|HTTP|失败|完成|打开|读取|提交/.test(String(line)));
      const text = cleanLogProgress(hit || "");
      if (text && text !== last) {
        last = text;
        if (!document.getElementById(`status-${key}`)?.querySelector(".inline-step-list")) setSiteProgress(key, text.length > 90 ? `${text.slice(0, 90)}…` : text, 82);
      }
    } catch {}
  };
  const timer = setInterval(tick, 900);
  return () => clearInterval(timer);
}

function conciseResultMessage(data = {}) {
  const details = data.details || {};
  if (data.site === "卡饭论坛") return cleanDailyMessage(data.message || "签到完成", "kafan");
  if (details.rewardChickenLegs !== undefined && details.rewardChickenLegs !== null) return `此次签到获得 ${details.rewardChickenLegs} 个鸡腿`;
  if (details.rewardExp !== undefined && details.rewardExp !== null) return `奖励 ${details.rewardExp} 经验`;
  if (details.rewardPoints !== undefined && details.rewardPoints !== null) return `奖励 ${details.rewardPoints} 积分`;
  if (data.site === "什么值得买" || details.rawStatsText) return cleanDailyMessage(data.message || "签到完成", data.key || (data.site === "什么值得买" ? "smzdm" : ""));
  if (details.bonusGain) return `签到获得魔力值 +${details.bonusGain}`;
  if (details.signText) return String(details.signText).replace(/,/g, "，");
  if (details.rewardCopper !== undefined && details.rewardCopper !== null) return `奖励 ${details.rewardCopper} 个铜币`;
  return cleanDailyMessage(data.message || "签到完成");
}


// ---- Batch Sign-In Progress ----
function localDateKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todaySuccessfulSigninCount(sites = latestAllSites) {
  const today = localDateKey();
  return (sites || []).filter(site => {
    if (!site?.enabled || siteKindOf(site) !== "signin") return false;
    if (site.lastSuccess !== true || !site.lastTime) return false;
    return localDateKey(site.lastTime) === today;
  }).length;
}

function batchProgressPercent() {
  if (!batchRunState?.total) return 0;
  if (!batchRunState.active && (batchRunState.done || 0) >= batchRunState.total) return 100;
  const currentBump = batchRunState.active && batchRunState.currentKey ? 0.35 : 0;
  return Math.max(0, Math.min(100, Math.round(((batchRunState.done || 0) + currentBump) / batchRunState.total * 100)));
}

function renderBatchProgress(sites = latestAllSites) {
  const el = document.getElementById("batchProgress");
  if (!el) return;
  if (!batchRunState?.active && !batchRunState?.summary) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const total = batchRunState.total || 0;
  const done = batchRunState.done || 0;
  const ok = batchRunState.ok || 0;
  const failed = batchRunState.failed || 0;
  const today = todaySuccessfulSigninCount(sites);
  const percent = batchProgressPercent();
  const interrupted = batchRunState.interrupted === true;
  const current = batchRunState.active
    ? `${batchRunState.currentName ? `正在签到：${batchRunState.currentName}` : "准备批量签到"}${batchRunState.currentStep ? ` · ${batchRunState.currentStep}` : ""}`
    : (batchRunState.summary || `批量签到完成：${ok}/${total} 成功`);
  const notice = batchRunState.notice || current;
  const noticeType = batchRunState.noticeType || (batchRunState.active ? "info" : (failed ? "error" : "success"));
  const longNoticeClass = notice.length > 28 || /中断|未完成|服务重启/.test(notice) ? "is-plain" : "";
  const stopping = batchRunState.stopping === true;
  const titleText = interrupted ? "上次批量任务已中断" : (batchRunState.cancelled ? "批量任务已终止" : (stopping ? "正在终止批量任务" : "全部签到进度"));
  const actionHtml = interrupted
    ? `<button class="btn btn-primary btn-compact batch-progress-action" id="btnResumeBatchProgress" type="button">继续剩余站点</button><button class="btn btn-secondary btn-compact batch-progress-action" id="btnDismissBatchProgress" type="button">知道了</button>`
    : (batchRunState.active && !stopping ? `<button class="btn btn-danger btn-compact batch-progress-action" id="btnCancelBatchProgress" type="button">终止签到</button>` : (batchRunState.cancelled ? `<button class="btn btn-secondary btn-compact batch-progress-action" id="btnDismissBatchProgress" type="button">知道了</button>` : ""));
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="batch-progress-head">
      <div class="batch-progress-title"><span class="spinner ${batchRunState.active ? "" : "hidden"}"></span><span>${titleText}</span>${actionHtml}</div>
      <div class="batch-progress-inline-toast ${escAttr(noticeType)} ${longNoticeClass}" title="${escAttr(notice)}">${esc(notice)}</div>
      <div class="batch-progress-counts"><span>今日已签到 ${today}</span><span>本次 ${done}/${total}</span><span class="ok">成功 ${ok}</span><span class="fail">失败 ${failed}</span></div>
    </div>
    <div class="batch-progress-bar"><span style="width:${percent}%"></span></div>
    <div class="batch-progress-step" title="${escAttr(current)}">${esc(current)}</div>
  `;
}

function updateBatchCurrentStep(key, text = "") {
  if (!batchRunState?.active || batchRunState.currentKey !== key) return;
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (cleaned) {
    batchRunState.currentStep = cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
    batchRunState.notice = `${batchRunState.currentName || key}：${batchRunState.currentStep}`;
    batchRunState.noticeType = "info";
  }
  renderBatchProgress(latestAllSites);
}

function setBatchNotice(message = "", type = "info") {
  if (!batchRunState?.active && !batchRunState?.summary) return;
  batchRunState.notice = String(message || "").trim();
  batchRunState.noticeType = type || "info";
  renderBatchProgress(latestAllSites);
}

function applyBackendBatchState(state = {}) {
  if (!state) return false;
  const results = Array.isArray(state.results) ? state.results : [];
  const hasInterruptedState = !state.completedAt && !!state.interruptedNotifiedAt && Number(state.total || 0) > 0;
  const cancelled = !state.active && (!!state.cancelRequestedAt || !!state.cancelledAt);
  const notifyFailed = !!state.notifyFailedAt || !!state.notifyError;
  if ((hasInterruptedState || cancelled || notifyFailed) && state.id && dismissedInterruptedBatchIds.has(state.id)) {
    if (batchRunState.stopping && (cancelled || !state.active)) {
      batchRunState = { active: false };
      renderBatchProgress(latestAllSites);
    }
    return false;
  }
  if (state.active === false && !hasInterruptedState && !cancelled && !notifyFailed) return false;
  const active = state.active === true;
  const localStopping = batchRunState.stopping === true;
  if (state.cancelRequestedAt && state.id && dismissedInterruptedBatchIds.has(state.id)) return false;
  batchRunState.id = state.id || "";
  batchRunState.active = active;
  batchRunState.stopping = localStopping || !!state.cancelRequestedAt;
  batchRunState.interrupted = !active && hasInterruptedState;
  batchRunState.cancelled = cancelled;
  batchRunState.notifyFailed = notifyFailed;
  batchRunState.startedAt = state.startedAt ? Date.parse(state.startedAt) || batchRunState.startedAt : batchRunState.startedAt;
  batchRunState.total = Number(state.total || batchRunState.total || 0);
  batchRunState.done = Number(state.done || 0);
  batchRunState.ok = Number(state.successCount || 0);
  batchRunState.failed = Number(state.failureCount || Math.max(0, batchRunState.done - batchRunState.ok));
  batchRunState.currentKey = active ? (state.currentKey || "") : "";
  batchRunState.currentName = active ? (state.currentSite || "") : "";
  const last = results[results.length - 1];
  if (active) {
    const cancelPending = !!state.cancelRequestedAt;
    batchRunState.currentStep = state.currentSite
      ? `${cancelPending ? "终止请求已收到；当前站点结束后停止" : "后端执行中"}；最近完成 ${batchRunState.done}/${batchRunState.total}${last?.site ? `，上一个：${last.success ? "✅" : "❌"} ${last.site}` : ""}`
      : (cancelPending ? "终止请求已收到；等待当前批量任务停止…" : "后端正在执行批量签到并生成统一通知…");
    batchRunState.notice = state.currentSite ? `${state.currentSite}：${cancelPending ? "正在终止" : "执行中"}（${batchRunState.done}/${batchRunState.total}）` : batchRunState.currentStep;
    batchRunState.noticeType = cancelPending ? "warning" : "info";
  } else if (cancelled) {
    batchRunState.currentStep = `已终止：${batchRunState.done}/${batchRunState.total}${last?.site ? `；最近完成：${last.success ? "✅" : "❌"} ${last.site}` : ""}`;
    batchRunState.summary = `批量任务已终止：${batchRunState.done}/${batchRunState.total}`;
    batchRunState.notice = `${batchRunState.summary}；不会继续执行；${state.cancelReason || "用户手动终止"}`;
    batchRunState.noticeType = "warning";
  } else if (notifyFailed) {
    batchRunState.currentStep = `批量任务已完成：${batchRunState.done}/${batchRunState.total}${last?.site ? `；最后完成：${last.success ? "✅" : "❌"} ${last.site}` : ""}`;
    batchRunState.summary = `批量任务已完成：${batchRunState.ok}/${batchRunState.done || batchRunState.total} 成功`;
    batchRunState.notice = `${batchRunState.summary}；但通知发送失败：${state.notifyError || "未知错误"}`;
    batchRunState.noticeType = "warning";
  } else {
    const stoppedAt = state.currentSite ? `；中断时正在处理：${state.currentSite}` : "";
    const reason = state.interruptReason || state.interruptSignal || "服务重启/任务中断";
    batchRunState.currentStep = `已中断，不会继续执行：${batchRunState.done}/${batchRunState.total}${last?.site ? `；最近完成：${last.success ? "✅" : "❌"} ${last.site}` : ""}${stoppedAt}`;
    batchRunState.summary = `批量任务已中断：${batchRunState.done}/${batchRunState.total}`;
    batchRunState.notice = `${batchRunState.summary}；已停止，不会继续执行；${reason}`;
    batchRunState.noticeType = "error";
  }
  renderBatchProgress(latestAllSites);
  return true;
}

async function refreshBackendBatchState(silent = false) {
  try {
    const { data } = await api("/api/batch-state");
    if (data?.active || data?.cancelRequestedAt || data?.cancelledAt || data?.notifyFailedAt || data?.notifyError || (!data?.completedAt && data?.interruptedNotifiedAt && Number(data?.total || 0) > 0)) {
      applyBackendBatchState(data);
      return true;
    }
    if (batchRunState?.active) {
      batchRunState.active = false;
      batchRunState.summary = batchRunState.summary || "批量任务已结束";
      batchRunState.notice = batchRunState.notice || "后端批量任务已结束；正在刷新最新状态";
      batchRunState.noticeType = batchRunState.noticeType || "success";
      renderBatchProgress(latestAllSites);
    } else if (!batchRunState?.summary && !silent) {
      renderBatchProgress(latestAllSites);
    }
  } catch (err) {
    if (!silent) console.debug?.("batch-state refresh failed", err);
  }
  return false;
}

async function waitForBatchCompletion(maxWaitMs = 30 * 60 * 1000) {
  const started = Date.now();
  let lastDone = -1;
  while (Date.now() - started < maxWaitMs) {
    await sleep(2000);
    const { data } = await api("/api/batch-state");
    if (!data?.active) {
      if (data && (data.completedAt || (data.total && (data.done || 0) >= data.total))) return data;
      const inferredDone = batchRunState?.done || batchRunState?.total || 0;
      return { ...(data || {}), active: false, completedAt: data?.completedAt || new Date().toISOString(), total: batchRunState?.total || inferredDone, done: inferredDone, successCount: batchRunState?.ok || inferredDone, failureCount: batchRunState?.failed || 0 };
    }
    applyBackendBatchState(data);
    if ((data.done || 0) !== lastDone) {
      lastDone = data.done || 0;
      await loadSites(true).catch(() => {});
    }
  }
  throw new Error("等待批量签到完成超时，请查看后端日志/通知");
}

// ---- Trigger Sign-In ----
async function triggerSingle(key, name, kind = "signin") {
  if (runningSites.get(key)) return;
  const resultFilterWasActive = activeSiteResultFilter !== "all";
  const startedAt = Date.now();
  runningSites.set(key, { startedAt, text: kind === "visit" ? "准备保活…" : "准备签到…" });

  const btn = document.getElementById(`signin-${key}`);
  const credentialBtn = document.getElementById(`credential-${key}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = kind === "visit" ? '<span class="spinner"></span>保 活中…' : '<span class="spinner"></span>签 到中…';
  }
  if (credentialBtn) credentialBtn.disabled = true;

  setSiteProgress(key, "读取站点配置与代理策略…", 10);
  const stopLogProgress = startSiteLogProgress(key, name, startedAt);
  const actionText = kind === "visit" ? "保活" : "签到";
  if (batchRunState?.active && batchRunState.currentKey === key) setBatchNotice(`${displaySiteName(name)}：开始${actionText}`, "info");
  else showToast(`正在${actionText} ${name}…`);

  try {
    const { data } = await api(`/api/signin/${key}`, { method: "POST" });
    const verificationBlocked = !!data.details?.verificationBlocked;
    const icon = data.success ? "✅" : (verificationBlocked ? "◐" : "❌");
    const finalMessage = conciseResultMessage(data);
    const finalStatusText = data.success ? `${kind === "visit" ? "访问" : "签到"}完成：${finalMessage}` : `${kind === "visit" ? "访问" : "签到"}失败：${data.message}`;
    const stepHtml = renderStepProgress(data.steps || []);
    if (stepHtml) setTrustedSiteProgressHtml(key, stepHtml, finalStatusText);
    else setSiteProgress(key, finalStatusText, 100);
    const toastText = `${icon} ${displaySiteName(name)}：${finalMessage}`;
    if (batchRunState?.active && batchRunState.currentKey === key) setBatchNotice(toastText, data.success ? "success" : (verificationBlocked ? "warning" : "error"));
    else showToast(toastText, data.success ? "success" : (verificationBlocked ? "warning" : "error"));
    await sleep(1800);
    if (resultFilterWasActive) activeSiteResultFilter = "all";
    await loadSites(true);
  } catch (err) {
    const isFetchBreak = /Failed to fetch|NetworkError|Load failed|fetch/i.test(err.message || "");
    setSiteProgress(key, isFetchBreak ? "请求连接中断，正在读取后端最新签到状态…" : `请求失败：${err.message}`, 100);
    await sleep(1200);
    try {
      if (resultFilterWasActive) activeSiteResultFilter = "all";
      await loadSites(true);
      const toastText = isFetchBreak ? `请求连接中断，但已刷新后端最新状态；如果状态已更新则${actionText}已完成。` : `${actionText}失败: ${err.message}`;
      if (batchRunState?.active && batchRunState.currentKey === key) setBatchNotice(`${displaySiteName(name)}：${toastText}`, isFetchBreak ? "info" : "error");
      else showToast(toastText, isFetchBreak ? "" : "error");
    } catch {
      if (batchRunState?.active && batchRunState.currentKey === key) setBatchNotice(`${displaySiteName(name)}：${actionText}失败 ${err.message}`, "error");
      else showToast(`${actionText}失败: ${err.message}`, "error");
    }
  } finally {
    stopLogProgress();
    runningSites.delete(key);
    clearSiteProgress(key, 5000);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = kind === "visit" ? "🌤 保活" : "↻ 签到";
    }
    if (credentialBtn) credentialBtn.disabled = false;
  }
}


async function cancelBatchRun() {
  if (!batchRunState?.active) return;
  if (!confirm("确定终止当前批量签到？当前正在执行的站点会先结束，后续站点不会继续执行。")) return;
  try {
    const { data } = await api("/api/batch-cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "用户在前台点击终止签到" }),
    });
    const stateId = data?.state?.id || batchRunState?.id;
    if (stateId) {
      dismissedInterruptedBatchIds.add(stateId);
      localStorage.setItem("dismissedInterruptedBatchIds", JSON.stringify([...dismissedInterruptedBatchIds]));
    }
    batchRunState = {
      ...batchRunState,
      active: true,
      stopping: true,
      currentStep: "终止请求已收到；当前站点执行完后停止，前台不再安排后续站点。",
      notice: "正在终止；等待当前站点收尾…",
      noticeType: "warning",
    };
    renderBatchProgress(latestAllSites);
    showToast(data?.message || "已请求终止；当前站点结束后停止后续站点", "warning");
    await refreshBackendBatchState(true);
  } catch (err) {
    showToast(`终止失败: ${err.message}`, "error");
  }
}

async function resumeInterruptedBatch() {
  if (!batchRunState?.interrupted) return;
  if (!confirm("继续执行上次未完成的剩余站点？已经完成过的站点会跳过，避免重复签到。")) return;
  try {
    if (batchRunState?.id) {
      dismissedInterruptedBatchIds.add(batchRunState.id);
      localStorage.setItem("dismissedInterruptedBatchIds", JSON.stringify([...dismissedInterruptedBatchIds]));
    }
    batchRunState.active = true;
    batchRunState.interrupted = false;
    batchRunState.cancelled = false;
    batchRunState.currentStep = "正在继续执行剩余站点…";
    batchRunState.notice = "正在继续执行剩余站点…";
    batchRunState.noticeType = "info";
    renderBatchProgress(latestAllSites);
    await api("/api/batch-resume", { method: "POST" });
    const finalState = await waitForBatchCompletion();
    await loadSites(true).catch(() => {});
    if (finalState?.cancelRequestedAt || finalState?.cancelledAt) {
      applyBackendBatchState(finalState);
      showToast("批量任务已终止", "warning");
      return;
    }
    batchRunState.done = Number(finalState.done || batchRunState.done || 0);
    batchRunState.ok = Number(finalState.successCount ?? batchRunState.ok ?? 0);
    batchRunState.failed = Number(finalState.failureCount ?? Math.max(0, batchRunState.done - batchRunState.ok));
    batchRunState.active = false;
    batchRunState.summary = `剩余站点执行完成：${batchRunState.ok}/${batchRunState.done} 成功`;
    batchRunState.notice = `${batchRunState.summary}；统一通知已由后端发送`;
    batchRunState.noticeType = batchRunState.failed ? "error" : "success";
    renderBatchProgress(latestAllSites);
    showToast(batchRunState.notice, batchRunState.failed ? "error" : "success");
  } catch (err) {
    batchRunState.active = false;
    batchRunState.summary = `继续执行失败：${err.message}`;
    batchRunState.notice = batchRunState.summary;
    batchRunState.noticeType = "error";
    renderBatchProgress(latestAllSites);
    showToast(`继续执行失败: ${err.message}`, "error");
  } finally {
    isLoading = false;
    const btn = document.getElementById("btnRunAll");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">🔁</span> 全部签到';
    }
  }
}

async function triggerAll() {
  if (isLoading) return;
  const batchSites = (latestAllSites || []).filter(site => site.enabled);
  const signinSites = batchSites.filter(site => siteKindOf(site) === "signin");
  const keepaliveSites = batchSites.filter(site => siteKindOf(site) === "visit");
  if (!batchSites.length) {
    showToast("没有启用站点", "error");
    return;
  }
  isLoading = true;

  const btn = document.getElementById("btnRunAll");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>全部签到中…';
  }

  batchRunState = {
    active: true,
    startedAt: Date.now(),
    total: batchSites.length,
    done: 0,
    ok: 0,
    failed: 0,
    currentKey: "",
    currentName: "",
    currentStep: "后端正在执行批量签到/保活并生成统一通知…",
    notice: "后端正在执行批量签到/保活并生成统一通知…",
    noticeType: "info",
    summary: "",
  };
  renderBatchProgress(latestAllSites);
  showToast(`正在执行全部签到/保活（签到 ${signinSites.length}，保活 ${keepaliveSites.length}）…`);

  try {
    postJsonFireAndForget("/api/signin");
    const finalState = await waitForBatchCompletion();
    await loadSites(true).catch(() => {});
    if (finalState?.cancelRequestedAt || finalState?.cancelledAt) {
      applyBackendBatchState(finalState);
      showToast("批量任务已终止", "warning");
      return;
    }
    batchRunState.done = Number(finalState.done || batchRunState.total || batchSites.length);
    const inferredOk = batchRunState.ok || Math.max(0, batchRunState.done - (batchRunState.failed || 0));
    batchRunState.ok = Number(finalState.successCount ?? inferredOk);
    batchRunState.failed = Number(finalState.failureCount ?? Math.max(0, batchRunState.done - batchRunState.ok));
    batchRunState.active = false;
    batchRunState.currentKey = "";
    batchRunState.currentName = "";
    batchRunState.currentStep = "";
    batchRunState.summary = `批量签到/保活完成：${batchRunState.ok}/${batchRunState.done || batchRunState.total} 成功`;
    batchRunState.notice = `${batchRunState.summary}；统一通知已由后端发送`;
    batchRunState.noticeType = batchRunState.failed ? "error" : "success";
    renderBatchProgress(latestAllSites);
    showToast(batchRunState.notice, batchRunState.failed ? "error" : "success");
  } catch (err) {
    batchRunState.active = false;
    batchRunState.summary = `批量任务中断：${err.message}`;
    batchRunState.notice = `${batchRunState.summary}；后端会在重启后检测并发送中断告警`;
    batchRunState.noticeType = "error";
    renderBatchProgress(latestAllSites);
    showToast(`全部任务失败: ${err.message}`, "error");
    await loadSites(true).catch(() => {});
  } finally {
    isLoading = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">🔁</span> 全部签到';
    }
  }
}

async function clearHistory() {
  if (!confirm("确定清除全部签到记录？此操作不可恢复。")) return;
  try {
    await api("/api/history", { method: "DELETE" });
    showToast("✅ 签到记录已清除", "success");
    await loadHistory();
  } catch (err) {
    showToast(`清除失败: ${err.message}`, "error");
  }
}

// ---- Load History ----
async function loadHistory() {
  const tbody = document.getElementById("historyBody");
  tbody.innerHTML = `<tr><td colspan="4" class="empty-cell"><span class="spinner"></span>加载中…</td></tr>`;

  try {
    const { data } = await api("/api/history?limit=50");

    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">暂无记录</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(entry => `
      <tr>
        <td><span style="white-space:nowrap">${formatTime(entry.timestamp)}</span></td>
        <td>${esc(entry.site)}</td>
        <td>
          <span class="badge ${entry.success ? "badge-ok" : "badge-fail"}">
            <span class="badge-dot ${entry.success ? "ok" : "fail"}"></span>
            ${entry.success ? "成功" : "失败"}
          </span>
        </td>
        <td><span title="${esc(entry.message)}">${esc(truncate(entry.message, 60))}</span></td>
      </tr>
    `).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">加载失败: ${esc(err.message)}</td></tr>`;
  }
}

// ---- Load Logs ----
async function loadLogs(silent = false) {
  const viewer = document.getElementById("logViewer");
  if (!silent || !viewer.innerHTML.trim()) viewer.innerHTML = `<span class="loading-text"><span class="spinner"></span>加载中…</span>`;

  try {
    const { data } = await api("/api/logs?limit=200");

    if (data.length === 0) {
      viewer.innerHTML = `<span class="empty-cell">暂无日志</span>`;
      return;
    }

    viewer.innerHTML = data.map(l => {
      const time = l.time ? new Date(l.time).toLocaleTimeString("zh-CN", { hour12: false }) : "";
      return `<div class="log-line"><span class="log-time">${time}</span>${esc(l.msg)}</div>`;
    }).join("");

    viewer.scrollTop = viewer.scrollHeight;
  } catch (err) {
    viewer.innerHTML = `<span class="empty-cell">加载失败: ${esc(err.message)}</span>`;
  }
}

// ---- Utils ----
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function escAttr(str) {
  return String(str ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  if (isToday) {
    return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
