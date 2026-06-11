#!/usr/bin/env node

import assert from "node:assert/strict";
import FengDriver from "../src/drivers/feng.js";

function encodeUserInfo(token, userName = "tester") {
  return encodeURIComponent(JSON.stringify({
    accessToken: token,
    userInfo: { userName, userId: "1" },
  }));
}

function makeCookie(token) {
  const encoded = encodeUserInfo(token, "fresh-cookie-user");
  return `foo=bar; userInfo=${encoded}; userInfo-shared=${encoded}`;
}

function testCookieTokenWinsOverStaleLegacyFields() {
  const driver = new FengDriver({ key: "feng-com", note: "威锋论坛" }, {
    "feng-com": {
      cookie: makeCookie("fresh-token"),
      userInfo: encodeUserInfo("stale-token", "stale-user"),
      "userInfo-shared": encodeUserInfo("stale-token", "stale-user"),
      accessToken: "stale-access-token",
    },
  });

  const account = driver.getAccount();
  assert.equal(account.token, "fresh-token");
  assert.equal(account.profile.userName, "fresh-cookie-user");
  assert.equal(typeof account.cookie, "string");
  assert.ok(account.cookie.includes("userInfo="));
}

function testLegacyFieldsRemainFallback() {
  const driver = new FengDriver({ key: "feng-com", note: "威锋论坛" }, {
    "feng-com": {
      userInfo: encodeUserInfo("legacy-token", "legacy-user"),
    },
  });

  const account = driver.getAccount();
  assert.equal(account.token, "legacy-token");
  assert.equal(account.profile.userName, "legacy-user");
  assert.equal(account.cookie, "");
}

function testAccessTokenRemainsLastFallback() {
  const driver = new FengDriver({ key: "feng-com", note: "威锋论坛" }, {
    "feng-com": {
      accessToken: "plain-token",
    },
  });

  const account = driver.getAccount();
  assert.equal(account.token, "plain-token");
  assert.deepEqual(account.profile, {});
}

testCookieTokenWinsOverStaleLegacyFields();
testLegacyFieldsRemainFallback();
testAccessTokenRemainsLastFallback();

console.log("[test:feng] credential precedence OK");
