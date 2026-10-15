// 速启 · 图标兜底纯逻辑（设计档 4.8 / 4.16 / F3.7 / F3.10）
// 本模块不 import electron / fs —— 可脱离 Electron 直接 node --test（8.1 / 8.6）；
// Electron 面（getFileIcon / shell / nativeImage）归 icons.js 编排层，子进程与临时物低层归 icon-direct.js。
// v1.1 归档单测被测面的既有导出原地保留、不随拆分迁出（icon-direct.js 从本模块导入使用；
// 迁出会使冻结单测新增导入级红、全量基线漂移）。

import path from 'node:path';

/**
 * PowerShell 直读脚本（4.8；代码内常量——候选路径与输出路径只经环境变量传入，
 * 任何路径文本都进不了被解析的脚本 / 命令行）。
 */
export const DIRECT_READ_SCRIPT = [
  'try {',
  '  Add-Type -AssemblyName System.Drawing',
  '  $i = [System.Drawing.Icon]::ExtractAssociatedIcon($env:SUQI_ICON_SRC)',
  '  if ($null -eq $i) { exit 2 }',
  '  $i.ToBitmap().Save($env:SUQI_ICON_OUT, [System.Drawing.Imaging.ImageFormat]::Png)',
  '  exit 0',
  '} catch { exit 1 }',
].join('\n');

/** 脚本常量按 -EncodedCommand 口径编码一次（utf16le base64） */
const ENCODED_SCRIPT = Buffer.from(DIRECT_READ_SCRIPT, 'utf16le').toString('base64');

/** 字节级比对：两者均为 Buffer 且长度相等、逐字节相等 → true；null 参与 / 长度不同 / 内容不同 → false */
export function compareBytes(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  return a.length === b.length && a.equals(b);
}

/** 候选图是否命中任一参照：缺失参照（null）不产生命中、也不遮蔽其余参照；候选 null / 空数组 → false；不抛错 */
export function matchesAny(candidate, refs) {
  if (!candidate || !Array.isArray(refs) || refs.length === 0) return false;
  return refs.some((ref) => compareBytes(candidate, ref));
}

/** 是否 .lnk 条目路径（大小写不敏感；4.8 兜底链分派） */
export function isShortcutPath(filePath) {
  return typeof filePath === 'string' && filePath.toLowerCase().endsWith('.lnk');
}

/**
 * PowerShell 直读调用构造（4.8 安全）：-NoProfile -NonInteractive -EncodedCommand；
 * 候选路径与输出路径只进 env（数据通道）。返回 { command, args, env, windowsHide }。
 */
export function buildPowerShellInvocation(srcPath, outPath) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT],
    env: { ...process.env, SUQI_ICON_SRC: srcPath, SUQI_ICON_OUT: outPath },
    windowsHide: true,
  };
}

/**
 * 串行队列（4.8 性能）：同一时刻至多一个任务执行；返回 enqueue(task)。
 * 返回值透传；任务拒绝隔离——前一任务失败不阻断后续任务。
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const result = tail.then(() => task());
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// ---------------------------------------------------------------------------
// 候选源判据与结算（v1.5 图标自愈，4.16 / 4.8 / 8.6）
// ---------------------------------------------------------------------------

/**
 * 来源键规范化（4.8）：path.resolve + 小写化，Windows 路径大小写 / 斜杠等价。
 * 非字符串 / 空串 → null（无键即不入缓存）。
 */
export function normalizeSourceKey(p) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  return path.resolve(p).toLowerCase();
}

/**
 * 候选源判据（4.16 钉死表；observations 由调用方探测后传入，本函数不 import fs / electron）：
 * - 非 .lnk → direct / entry.path（既有 .exe 链）
 * - .lnk 路径存在且解析出非空 target → shortcutTarget / target（realPath 不覆盖可解析的快捷方式）
 * - .lnk 路径存在但解析抛错 / 无 target，或路径不存在 → registeredRealPath / source = entry.realPath
 * - 上述失效情形 realPath 为空 → originalFallback / 无来源
 * 「realPath 非空」只看登记值本身，不以存在性为选源门槛（4.16）。
 * 返回 { branch, source }；originalFallback 的 source 为 null。
 */
export function pickIconSource(entry, observations) {
  const filePath = typeof entry?.path === 'string' ? entry.path : '';
  const realPath = typeof entry?.realPath === 'string' && entry.realPath.trim() !== '' ? entry.realPath : null;
  const pathExists = observations?.pathExists === true;
  const shortcutTarget = typeof observations?.shortcutTarget === 'string' && observations.shortcutTarget.trim() !== ''
    ? observations.shortcutTarget
    : null;

  if (!isShortcutPath(filePath)) return { branch: 'direct', source: filePath };
  if (pathExists && shortcutTarget) return { branch: 'shortcutTarget', source: shortcutTarget };
  if (realPath) return { branch: 'registeredRealPath', source: realPath };
  return { branch: 'originalFallback', source: null };
}

/**
 * 来源结果结算（4.8 降级 + 4.16 收口，顺序由 8.6 用例 1/2/5/6/8 元组钉死）。
 * branch ∈ direct / shortcutTarget / registeredRealPath / originalFallback；
 * sourceResult = { resolvedDataUrl, platformDataUrl, platformUnverified? }——
 * platformUnverified = 参照物全失效退化态（4.16 :437）：来源平台结果不可验证，不当真图替换、
 * 一律结算回原条目平台结果 / null（direct 分支保留值即第③级，同义重合）；
 * original = 原条目路径的平台结果 / null（originalFallback 分支的唯一结果源）。
 */
export function settleIconResult(branch, sourceResult, original) {
  const resolved = typeof sourceResult?.resolvedDataUrl === 'string' ? sourceResult.resolvedDataUrl : null;
  const platform = typeof sourceResult?.platformDataUrl === 'string' ? sourceResult.platformDataUrl : null;
  const originalDataUrl = typeof original === 'string' ? original : null;

  if (branch === 'originalFallback') return originalDataUrl;
  if (sourceResult?.platformUnverified === true) return originalDataUrl;
  if (resolved) return resolved;

  if (branch === 'registeredRealPath') return originalDataUrl; // 只在真图时替换（4.16 收口）；否则回原表现
  if (branch === 'shortcutTarget') return originalDataUrl ?? platform; // ③ 原 .lnk 平台结果优先、目标平台结果次之
  return platform; // direct：② 直读真图 → ③ 来源平台结果（可能为通用图）/ null
}

/**
 * 来源结果缓存工厂（4.8 两层缓存的来源层）：键由调用方用 normalizeSourceKey 给出
 * （等价来源同一键）。Promise 在 loader 启动前即入缓存——先后 / 并发请求共享同一次加载，
 * 不重复进入平台判定或直读。成功、降级与 null 均缓存；loader 拒绝时不悬挂在途项，
 * 后续请求按未缓存重新加载（该键会话内未被「定案」，与 4.8「失败结果缓存」语义区分）。
 */
export function createIconSourceCache(loader) {
  const sourceCache = new Map();
  return function loadSource(sourcePath) {
    const key = normalizeSourceKey(sourcePath);
    if (key && sourceCache.has(key)) return sourceCache.get(key);
    const promise = (async () => loader(sourcePath))().catch((err) => {
      if (key && sourceCache.get(key) === promise) sourceCache.delete(key);
      console.warn('[速启] 图标来源加载失败：', sourcePath, err);
      return null;
    });
    if (key) sourceCache.set(key, promise);
    return promise;
  };
}

