import assert from "node:assert/strict";
import { isNaixiAlreadySigned, isNaixiNotSigned } from "../src/utils/naixi-sign.js";

const notSignedPage = "奶昔论坛 » 奶昔签到 您今天还没有签到 HughRyu 连续签到 补签 天 签到等级 积分奖励 总天数 天";
assert.equal(isNaixiNotSigned(notSignedPage), true);
assert.equal(isNaixiAlreadySigned(notSignedPage), false);

assert.equal(isNaixiAlreadySigned("奶昔论坛 » 奶昔签到 您的签到排名：514 HughRyu 连续签到 18 天"), true);
assert.equal(isNaixiAlreadySigned("您今天已经签到，明天再来"), true);
assert.equal(isNaixiAlreadySigned("签到成功 恭喜获得奖励"), true);

console.log("[test-naixi-sign] OK");
