// 速启 · 图标编排层（设计档 4.8 / 4.16 / F3.2 / F3.7 / F3.10）
// 常规：app.getFileIcon('large') → dataURL；触发判定（双参照字节比对 + 空结果）失灵 → 直读兜底链；
// 全失败维持现状（平台结果或 null）。v1.5 图标自愈（F3.10）：候选源判据 / 来源链 / 条目结算改由
// pickIconSource / settleIconResult 纯函数承载，getIconDataUrl 入参从路径串扩为条目对象 {path, realPath}。
// 公开出口：getIconDataUrl（IPC #8 条目图标）、getAppIconDataUrl（IPC #18 顶栏本应用图标，F7.3 / 4.17）、
// cleanupIconTemp（重导出，main.js will-quit 挂载——main.js 调用点不变）。

import { app, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { cleanupIconTemp, directIconDataUrl, ensureSessionDir } from './icon-direct.js';
import {
  createIconSourceCache,
  isShortcutPath,
  matchesAny,
  normalizeSourceKey,
  pickIconSource,
  settleIconResult,
} from './icon-fallback.js';

export { cleanupIconTemp };

/** 会话缓存 Map<规范化 entry.path, dataUrl | null>（4.8：含失败与降级，会话内不重试；图标不落盘） */
const cache = new Map();

/** 来源结果缓存（4.8 来源层；键 = 规范化实际来源，等价来源共享一次平台判定 / 直读） */
const loadSource = createIconSourceCache(loadSourceOnce);

/** 参照物懒加载（4.8：首次取图标时构造一次；并发请求合并到同一 Promise） */
let refsPromise = null;

/** 平台路径图标（PNG Buffer 或 null；异常上抛给调用方） */
async function platformPng(filePath) {
  const image = await app.getFileIcon(filePath, { size: 'large' });
  return image && !image.isEmpty() ? image.toPNG() : null;
}

/** 参照物构造（单侧失败不影响另一侧；整体失败 → 双 null = 判定整体不触发、行为等同现状） */
async function buildRefs() {
  let dir;
  try {
    dir = await ensureSessionDir();
  } catch {
    return { refExe: null, refLnk: null };
  }
  const refExePath = path.join(dir, 'ref.exe');
  const refLnkPath = path.join(dir, 'ref.lnk');

  let refExe = null;
  try {
    fs.writeFileSync(refExePath, Buffer.alloc(0));
    refExe = await platformPng(refExePath); // 0 字节 exe → 通用 exe 图
  } catch (err) {
    console.warn('[速启] refExe 参照构造失败：', err);
  }

  let refLnk = null;
  try {
    if (shell.writeShortcutLink(refLnkPath, { target: refExePath })) {
      refLnk = await platformPng(refLnkPath); // 任意 .lnk → 通用快捷图（与目标无关）
    }
  } catch (err) {
    console.warn('[速启] refLnk 参照构造失败：', err);
  }

  return { refExe, refLnk };
}

/** 参照物懒加载（并发请求合并到同一 Promise） */
function ensureRefs() {
  if (!refsPromise) refsPromise = buildRefs();
  return refsPromise;
}

/**
 * 来源加载（4.8 来源链，按选定来源执行；结果 = {resolvedDataUrl, platformDataUrl, platformUnverified}）。
 * ① 来源平台图标；② 触发判定失灵（命中参照 / 平台结果为空）→ 直读来源；③ 降级装平台结果。
 * 参照物全失效退化态（4.16）→ platformUnverified = true（结算一律回原条目平台结果 / null）。
 * 嵌套 .lnk 不再走候选源判据，只按该路径做一次平台 / 参照 / 直读（4.8 边界）。
 */
async function loadSourceOnce(sourcePath) {
  const refsLoading = ensureRefs(); // 参照物懒加载一次；与平台提取并行

  let platformImage = null;
  try {
    platformImage = await app.getFileIcon(sourcePath, { size: 'large' });
  } catch (err) {
    console.warn('[速启] 来源平台图标提取失败：', sourcePath, err);
  }
  const sourcePng = platformImage && !platformImage.isEmpty() ? platformImage.toPNG() : null;
  const platformDataUrl = sourcePng ? platformImage.toDataURL() : null;

  const { refExe, refLnk } = await refsLoading;
  if (!refExe && !refLnk) {
    // 参照物全部获取失败 → 判定整体不触发（4.16）：平台结果不可验证，不装真图槽位；
    // 但「平台结果为空」的触发不依赖参照物（4.16）——空结果仍直读，直读真图按各分支既有降级结算
    if (sourcePng) return { resolvedDataUrl: null, platformDataUrl, platformUnverified: true };
  }
  const refs = [refExe, refLnk];
  if (sourcePng && !matchesAny(sourcePng, refs)) {
    return { resolvedDataUrl: platformDataUrl, platformDataUrl, platformUnverified: false }; // 非通用结果一律保留
  }

  const direct = await directIconDataUrl(sourcePath); // ② 直读来源（输出即通用图 → null）
  if (direct) return { resolvedDataUrl: direct, platformDataUrl, platformUnverified: false };

  // ③ 全失败：direct / shortcutTarget 分支装平台结果（各自第③级语义），registeredRealPath 由结算丢弃
  return { resolvedDataUrl: null, platformDataUrl, platformUnverified: false };
}

/**
 * 单条目加载（4.16 编排）：探测（存在性 / .lnk target）→ pickIconSource 选源 → 来源链 → settleIconResult 结算。
 * 探测失败按「无 target / 路径不存在」处理，选源与降级不受影响。
 */
async function loadIcon(entry) {
  const filePath = typeof entry?.path === 'string' ? entry.path : '';

  const observations = { pathExists: false, shortcutTarget: null };
  try {
    observations.pathExists = fs.existsSync(filePath);
  } catch {
    observations.pathExists = false; // stat 失败等同不存在（自愈语义按失效处理）
  }
  if (observations.pathExists && isShortcutPath(filePath)) {
    try {
      const target = shell.readShortcutLink(filePath)?.target;
      if (typeof target === 'string' && target.trim() !== '') observations.shortcutTarget = path.resolve(target);
    } catch (err) {
      console.warn('[速启] 快捷方式目标解析失败：', filePath, err); // 解析抛错 / 无 target → 不设 target
    }
  }

  const { branch, source } = pickIconSource(entry, observations);
  if (branch === 'originalFallback') {
    // 无新增来源：无来源链可走，直接维持原路径的平台结果 / null（4.16 判据表第五分支）
    return platformDataUrlOf(filePath);
  }

  const sourceResult = await loadSource(source);
  // direct 分支：来源即条目路径，original 与来源平台结果同源同值（4.8），免第二次平台提取；
  // 其余分支 original = 原 .lnk 条目自身的平台结果（与来源不同路径，须单独提取）。
  const original = branch === 'direct' ? sourceResult.platformDataUrl : await platformDataUrlOf(filePath);
  return settleIconResult(branch, sourceResult, original);
}

/** 原条目平台结果（结算 original 入参；单次 getFileIcon + dataURL，不触发判定） */
async function platformDataUrlOf(filePath) {
  try {
    const image = await app.getFileIcon(filePath, { size: 'large' });
    return image && !image.isEmpty() ? image.toDataURL() : null;
  } catch (err) {
    console.warn('[速启] 条目平台图标提取失败：', filePath, err);
    return null;
  }
}

/** 返回 dataUrl 字符串或 null；结果（含 null / 降级）按规范化条目路径缓存，同一会话不重试 */
export async function getIconDataUrl(entry) {
  const filePath = typeof entry?.path === 'string' ? entry.path : '';
  const key = normalizeSourceKey(filePath);
  if (key && cache.has(key)) return cache.get(key);
  let dataUrl = null;
  try {
    dataUrl = await loadIcon(entry);
  } catch (err) {
    console.warn('[速启] 图标提取失败：', filePath, err);
  }
  if (key) cache.set(key, dataUrl);
  return dataUrl;
}

/** 本应用图标 Promise（F7.3 / 4.17；会话内缓存，首次构造后复用） */
let appIconPromise = null;

/**
 * 顶栏本应用图标 dataUrl（IPC #18，F7.3 / 4.17）：
 * 打包态取 exe 内嵌图标（= win.icon 编译进 exe 那一档，build/icon.ico 不在包内）；
 * 开发态读源码目录 build/icon.ico（process.execPath 是 electron.exe，不可用作本应用图标）；
 * 失败 / 空结果 → 回落 app.getFileIcon(process.execPath)；仍失败 → null（renderer 隐藏顶栏图标）。
 * 不改 getIconDataUrl 现有行为（条目图标链不受影响）。
 */
export function getAppIconDataUrl() {
  if (!appIconPromise) appIconPromise = loadAppIconDataUrl();
  return appIconPromise;
}

async function loadAppIconDataUrl() {
  try {
    if (app.isPackaged) {
      const image = await app.getFileIcon(process.execPath, { size: 'large' }); // large = 32px，renderer 按 20×20 显示
      if (image && !image.isEmpty()) return image.toDataURL();
    } else {
      const image = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.ico'));
      if (image && !image.isEmpty()) return image.toDataURL();
    }
  } catch (err) {
    console.warn('[速启] 本应用图标提取失败：', err);
  }
  try {
    const image = await app.getFileIcon(process.execPath); // 回落（4.17 兜底）
    return image && !image.isEmpty() ? image.toDataURL() : null;
  } catch (err) {
    console.warn('[速启] 本应用图标回落失败：', err);
    return null;
  }
}
