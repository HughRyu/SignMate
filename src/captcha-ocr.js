/**
 * captcha-ocr.js — 简单验证码 OCR
 *
 * 使用 sharp 生成多组预处理图片，再用 tesseract.js 识别。
 * 针对 OpenCD 等第一代文本验证码设计。
 */

import sharp from "sharp";
import { createWorker } from "tesseract.js";

let _worker = null;
let _workerReady = false;
let _workerKey = "";

async function getWorker(options = {}) {
  const whitelist = options.whitelist || "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const psm = String(options.psm || "8");
  const key = `${whitelist}|${psm}`;
  if (_worker && _workerReady && _workerKey === key) return _worker;
  if (_worker) { try { await _worker.terminate(); } catch {} }
  _worker = await createWorker("eng", 1, { logger: () => {} });
  await _worker.setParameters({
    tessedit_char_whitelist: whitelist,
    tessedit_pageseg_mode: psm,
  });
  _workerReady = true;
  _workerKey = key;
  return _worker;
}

function cleanText(text = "", options = {}) {
  const preserveCase = options.preserveCase === true;
  let cleaned = String(text || "").replace(/[^A-Za-z0-9]+/g, "").trim();
  if (!preserveCase) cleaned = cleaned.toUpperCase();
  cleaned = cleaned.replace(/[|]/g, preserveCase ? "l" : "I");
  const maxLen = Number(options.maxLen || 6);
  if (cleaned.length > maxLen) cleaned = cleaned.slice(-maxLen);
  return cleaned;
}

function scoreCandidate(text = "", options = {}) {
  if (!text) return -100;
  const len = text.length;
  const minLen = Number(options.minLen || 4);
  const maxLen = Number(options.maxLen || 6);
  let score = 0;
  if (len >= minLen && len <= maxLen) score += 100;
  else score -= Math.min(80, Math.abs(((minLen + maxLen) / 2) - len) * 24);
  score += Math.min(len, maxLen);
  if (/^[A-Za-z0-9]+$/.test(text)) score += 10;
  if (options.preferLowercase && /[a-z]/.test(text)) score += 4;
  if (!options.preserveCase && /^[A-Z]{4,6}$/.test(text)) score += 6;
  return score;
}

async function preprocessVariants(input, options = {}) {
  const width = Number(options.width || 220);
  const base = sharp(input).ensureAlpha().flatten({ background: "#ffffff" }).grayscale().resize({ width, withoutEnlargement: false });
  const variants = [];
  const thresholds = [96, 112, 128, 144, 160, 176];
  for (const threshold of thresholds) {
    variants.push(base.clone().normalize().threshold(threshold).png().toBuffer());
    variants.push(base.clone().median(1).sharpen().normalize().threshold(threshold).png().toBuffer());
  }
  variants.push(base.clone().normalize().png().toBuffer());
  variants.push(base.clone().negate().normalize().threshold(128).png().toBuffer());
  return Promise.all(variants);
}

export async function ocr(imageBuffer, options = {}) {
  const worker = await getWorker(options);
  const processedVariants = await preprocessVariants(imageBuffer, options);
  const seen = new Set();
  let best = "";
  let bestScore = -Infinity;

  for (const processed of processedVariants) {
    const { data: { text } } = await worker.recognize(processed);
    const cleaned = cleanText(text, options);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    const score = scoreCandidate(cleaned, options);
    if (score > bestScore) {
      best = cleaned;
      bestScore = score;
    }
    if (score >= Number(options.earlyScore || 116)) break;
  }
  return best;
}

export async function destroy() {
  if (_worker) {
    try { await _worker.terminate(); } catch {}
    _worker = null;
    _workerReady = false;
    _workerKey = "";
  }
}
