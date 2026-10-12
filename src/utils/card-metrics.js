// Shared policy for all built-in and custom site summary preferences.
const LABELS = {
  username: "用户名", userName: "用户名", nickname: "昵称", userId: "用户 ID", uid: "用户 ID", email: "邮箱",
  levelTitle: "等级", level: "等级", userGroup: "用户组", trustLevel: "信任等级", fengLevel: "威锋等级", pcevaLevel: "等级",
  totalPoints: "总积分", points: "积分", pointsGain: "本次积分增加", todayPoints: "今日积分", totalCoins: "站点货币",
  totalExp: "总经验", experience: "经验", totalExperience: "总经验", vitality: "活力",
  joinDays: "注册天数", totalDays: "累计签到/访问", streakDays: "连续签到", signInDays: "签到天数", monthDays: "月签到", addup: "总签到", cons: "连续签到",
  postCount: "帖子", likesReceived: "获赞", featuredCount: "精华", followingCount: "关注", followersCount: "粉丝",
  bankBalance: "存款", gameCoins: "游戏币", totalEnergy: "总能量", todayEnergy: "今日能量", rewardEnergy: "奖励能量",
  totalChickenLegs: "总鸡腿", rewardChickenLegs: "奖励鸡腿", totalWuAiCoins: "吾爱币", rewardWuAiCoins: "奖励吾爱币",
  totalPbCoins: "PB币", rewardPbCoins: "奖励 PB币", totalGold: "金币", totalSilver: "银币", totalCopper: "铜币", rewardCopper: "奖励铜币",
  totalSmzdmGold: "金币", totalSmzdmSilver: "碎银子", fengCoins: "威币", coins: "货币",
  bonus: "魔力值", bonusGain: "本次魔力", seedPoints: "做种积分", ratio: "分享率", upload: "上传量", download: "下载量",
  invite: "邀请", tempInvite: "临时邀请", inviteDisplay: "邀请额度", rewardName: "奖励名称", reward: "奖励",
  rewardPoints: "奖励积分", rewardExp: "奖励经验", rewardCoins: "奖励货币", rewardAmount: "奖励数量", rewardUnit: "奖励单位", nextRewardAmount: "明日奖励",
  nodeSeekLevel: "NodeSeek 等级", nodeSeekLevelProgress: "等级进度", attendanceRank: "签到排名", attendanceTotalParticipants: "参与人数",
  totalForums: "贴吧总数", tiebaTotalForums: "贴吧总数", successCount: "成功数量", tiebaSuccessCount: "贴吧签到成功",
  alreadySignedCount: "已签数量", tiebaAlreadySignedCount: "贴吧已签到", shieldedCount: "屏蔽数量", tiebaShieldedCount: "贴吧屏蔽",
  failedCount: "失败数量", tiebaFailedCount: "贴吧失败", dailyTask: "每日打卡", replyTask: "回帖打卡",
  qianmojuPoints: "铜币总数", qianmojuRewardAmount: "奖励铜币", qianmojuSignReward: "签到铜币", qianmojuRewardUnit: "奖励单位", qianmojuLevel: "用户组",
  status: "HTTP 状态", authenticated: "已登录", alreadySigned: "已签到", signTime: "执行时间", visitTime: "访问时间",
};
const PRIVATE = /(?:user.?name|nick.?name|(?:^|_)uid$|user.?id|email|mail|phone|mobile|avatar|address|ip(?:address)?$|account|real.?name)/i;
const INTERNAL = /^(?:proxy|verification|tcaptcha|captcha|dryRun|checkinAction|clickedSignIn|source$|runId$|kind$|category$|schedule|retry|retryable|attempt|step|pageTitle$)/i;
const SECRET = /cookie|token|secret|password|passwd|authorization|credential|session|api.?key|passkey|csrf|raw|html|header|debug|stack|url/i;
const PRIORITY = ["levelTitle", "nodeSeekLevel", "fengLevel", "pcevaLevel", "level", "bonus", "totalChickenLegs", "totalEnergy", "fengCoins", "qianmojuPoints", "totalCoins", "totalWuAiCoins", "totalPoints", "points", "totalPbCoins", "totalExp", "totalExperience", "experience", "totalGold", "totalSilver", "totalCopper", "ratio", "upload", "download", "totalDays", "joinDays", "streakDays", "userGroup"];
const SITE_PRIORITY = {
  "sb-sb": ["totalCoins", "levelTitle", "totalExp", "joinDays"],
  "linux-sb": ["totalPoints", "totalCoins"],
  "baidu-tieba": ["tiebaTotalForums", "tiebaSuccessCount", "tiebaAlreadySignedCount", "tiebaFailedCount", "totalForums", "successCount", "alreadySignedCount", "failedCount"],
  "v2ex": ["totalGold", "totalSilver", "totalCopper", "totalDays"],
  "kafan": ["experience", "totalDays", "streakDays", "userGroup"],
  "smzdm": ["level", "totalDays", "streakDays", "rewardPoints"],
};
function label(key, siteKey) {
  if (key === "totalCoins" && ["linux-sb", "sb-sb"].includes(siteKey)) return "烧饼";
  if (key === "totalCoins" && siteKey === "pojie52") return "吾爱币";
  if (key === "totalExp" && siteKey === "sb-sb") return "成长值";
  if (key === "bonus" && siteKey === "audiences-me") return "爆米花";
  return LABELS[key] || key;
}
export function cardMetricOptions(details = {}, siteKey = "") {
  return Object.entries(details || {}).filter(([key, value]) => {
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(key) || SECRET.test(key) || INTERNAL.test(key)) return false;
    return typeof value === "number" ? Number.isFinite(value)
      : typeof value === "boolean" || (typeof value === "string" && value.trim() !== "" && value.length <= 160 && !/[\r\n]/.test(value));
  }).map(([key]) => {
    const personal = PRIVATE.test(key);
    const defaultEligible = Object.hasOwn(LABELS, key) && !personal && !["status", "authenticated", "alreadySigned", "signTime", "visitTime", "pointsGain"].includes(key);
    const style = /level|group/i.test(key) ? "level" : /days|count/i.test(key) ? "days" : /coin|gold|silver|copper|bonus|balance/i.test(key) ? "coin" : "points";
    return { key, label: label(key, siteKey), icon: personal ? "👤" : style === "level" ? "🏅" : style === "days" ? "📅" : style === "coin" ? "🪙" : "💎", style, personal, defaultEligible };
  });
}
export function defaultCardMetrics(options, siteKey = "") {
  const priority = [...(SITE_PRIORITY[siteKey] || []), ...PRIORITY];
  const aliases = { totalExperience: "experience", totalExp: "experience", points: "totalPoints", addup: "totalDays", cons: "streakDays", fengLevel: "level", pcevaLevel: "level", levelTitle: "level", nodeSeekLevel: "level", totalForums: "tiebaTotalForums", successCount: "tiebaSuccessCount", alreadySignedCount: "tiebaAlreadySignedCount", failedCount: "tiebaFailedCount", shieldedCount: "tiebaShieldedCount" };
  const used = new Set();
  return [...options].filter(option => option.defaultEligible).sort((a, b) => {
    const rank = key => priority.includes(key) ? priority.indexOf(key) : priority.length;
    return rank(a.key) - rank(b.key);
  }).filter(option => {
    const group = aliases[option.key] || option.key;
    if (used.has(group)) return false;
    used.add(group); return true;
  }).slice(0, 4).map(option => option.key);
}
export function selectedCardMetrics(saved, options, siteKey = "") {
  // Retain valid saved slots even if a later run temporarily omits a value.
  return Array.isArray(saved) ? [...new Set(saved)].filter(key => typeof key === "string" && /^[a-zA-Z][\w-]{0,63}$/.test(key) && !SECRET.test(key)).slice(0, 4)
    : defaultCardMetrics(options, siteKey);
}
export function validCardMetricSelection(selected, options) {
  return Array.isArray(selected) && selected.length <= 4 && new Set(selected).size === selected.length
    && selected.every(key => options.some(option => option.key === key));
}
