import test from "node:test";
import assert from "node:assert/strict";
import { classifyKafanLoginFailure } from "../src/drivers/kafan.js";
test("Kafan requires an actual login page, never a challenge or HTTP failure, to confirm expiry", () => {
  assert.equal(classifyKafanLoginFailure(200, "卡饭", "登录 注册"), "auth_expired");
  assert.equal(classifyKafanLoginFailure(200, "卡饭", "", '<form id="lsform">'), "auth_expired");
  assert.equal(classifyKafanLoginFailure(403, "", "请先登录"), "unconfirmed");
  assert.equal(classifyKafanLoginFailure(200, "Just a moment", "请先登录"), "challenge");
  assert.equal(classifyKafanLoginFailure(200, "卡饭", "页面维护中"), "unconfirmed");
  assert.equal(classifyKafanLoginFailure(200, "卡饭", "请先登录", '<script src="captcha.js"></script>'), "auth_expired");
});
