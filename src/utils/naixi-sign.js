function normalizedText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function isNaixiNotSigned(text = "") {
  const normalized = normalizedText(text);
  return /您今天还没有签到|今天还没有签到|今日还没有签到|还没有签到|立即签到|点击签到/.test(normalized);
}

export function isNaixiAlreadySigned(text = "") {
  const normalized = normalizedText(text);
  if (!normalized || isNaixiNotSigned(normalized)) return false;
  return /您的签到排名|您今天已经签到|今天已经签到|今日已经签到|今天已签|今日已签|今天已完成签到|今日已完成签到|签到成功|签到完毕|明天再来|下次再来/.test(normalized);
}
