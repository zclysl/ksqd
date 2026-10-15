// 速启 · 图标直读低层（设计档 4.8 直读兜底 / 6.7 v1.5 拆分，决策 #45）
// 从 icons.js 抽出：PowerShell 直读执行、超时、串行队列、输出临时物、refDirect 参照与会话临时目录清理。
// 与纯逻辑层的边界：脚本常量 / 调用构造 / 串行队列从 icon-fallback.js 导入（既有导出原地保留）；
// Electron 面（nativeImage）与子进程 / 临时物归本模块；候选源判据与结算归 icons.js 编排层。

import { nativeImage } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPowerShellInvocation, compareBytes, createSerialQueue } from './icon-fallback.js';

/** 直读超时（4.8 失败处理：10s → kill 子进程） */
const DIRECT_TIMEOUT_MS = 10_000;

/** 直读串行队列（4.8 性能：同一时刻至多一个 PowerShell 进程） */
const directQueue = createSerialQueue();

/** 直读在途并合表 Map<候选路径, Promise<Buffer | null>>（4.8：进行中与已入队未完成均算） */
const directInflight = new Map();

/** 会话级临时目录 Promise（mkdtemp 独占创建；ref 文件会话保留 / out.png 读后即删；will-quit 清理） */
let sessionDirPromise = null;

/** 直读参照 refDirect（4.8：懒加载，首次直读判定前调用一次） */
let refDirectPromise = null;

/** 会话级临时目录（创建失败 → Promise 拒绝；调用方降级为「判定不触发 / 维持现状」，不向用户报错） */
export function ensureSessionDir() {
  if (!sessionDirPromise) {
    sessionDirPromise = fs.promises.mkdtemp(path.join(os.tmpdir(), 'suqi-icons-')).catch((err) => {
      console.warn('[速启] 图标临时目录创建失败：', err);
      throw err;
    });
  }
  return sessionDirPromise;
}

/** 直读参照 refDirect（直读 ref.exe 的输出；与候选直读输出相等 → 「直读也取不到」） */
export function ensureRefDirect() {
  if (!refDirectPromise) {
    refDirectPromise = (async () => {
      try {
        const dir = await ensureSessionDir();
        const refExePath = path.join(dir, 'ref.exe');
        if (!fs.existsSync(refExePath)) fs.writeFileSync(refExePath, Buffer.alloc(0));
        return await directReadPng(refExePath);
      } catch (err) {
        console.warn('[速启] refDirect 直读参照构造失败：', err);
        return null;
      }
    })();
  }
  return refDirectPromise;
}

/** PowerShell 子进程（在串行队列内执行）；返回退出码，启动失败 / 超时 → null */
function spawnDirectRead(invocation, candidatePath) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };

    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        env: invocation.env,
        windowsHide: invocation.windowsHide,
        stdio: 'ignore', // 父进程不读 stdout/stderr（成功判定不依赖 stderr）——避免管道缓冲写阻塞
      });
    } catch (err) {
      console.warn('[速启] 图标直读子进程启动失败：', candidatePath, err);
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      console.warn(`[速启] 图标直读超时（${DIRECT_TIMEOUT_MS}ms），终止子进程：${candidatePath}`);
      child.kill();
      finish(null); // 不等 close：结果按失败定案，不阻塞串行队列
    }, DIRECT_TIMEOUT_MS);

    child.on('error', (err) => {
      console.warn('[速启] 图标直读子进程启动失败：', candidatePath, err);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * 单次直读（整段在串行队列内：预清理 → 子进程 → 读取 → 删除——out.png 单文件跨条目互斥）；
 * 退出码 0 + 输出文件存在 + nativeImage 非空 → PNG Buffer；否则 null。
 */
function runDirectReadOnce(candidatePath) {
  return directQueue(async () => {
    try {
      const dir = await ensureSessionDir();
      const outPath = path.join(dir, 'out.png');
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath); // 上轮残留（超时被 kill 等）
      } catch (err) {
        console.warn('[速启] 直读输出预清理失败：', err);
      }

      const invocation = buildPowerShellInvocation(candidatePath, outPath);
      const exitCode = await spawnDirectRead(invocation, candidatePath);

      let buf = null;
      if (exitCode === 0 && fs.existsSync(outPath)) buf = fs.readFileSync(outPath);
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath); // out.png 读取后即删（失败 / 超时同样清理）
      } catch (err) {
        console.warn('[速启] 直读输出清理失败：', err);
      }

      if (!buf) {
        console.warn(`[速启] 图标直读失败（exit ${exitCode}）：${candidatePath}`);
        return null;
      }
      if (nativeImage.createFromBuffer(buf).isEmpty()) {
        console.warn('[速启] 直读输出不可解码（nativeImage 为空）：', candidatePath);
        return null;
      }
      return buf;
    } catch (err) {
      console.warn('[速启] 图标直读异常：', candidatePath, err);
      return null;
    }
  });
}

/** 直读（按候选路径在途并合：进行中与已入队未完成共享同一 Promise，不重复起子进程） */
function directReadPng(candidatePath) {
  const inflight = directInflight.get(candidatePath);
  if (inflight) return inflight;
  const task = runDirectReadOnce(candidatePath);
  directInflight.set(candidatePath, task);
  task.then(() => {
    if (directInflight.get(candidatePath) === task) directInflight.delete(candidatePath);
  });
  return task;
}

/** 触发后的直读（含「直读也取不到」判定）；返回 dataUrl 或 null（null → 落下一级兜底） */
export async function directIconDataUrl(candidatePath) {
  const buf = await directReadPng(candidatePath);
  if (!buf) return null;

  const refDirect = await ensureRefDirect();
  if (!refDirect) {
    console.warn('[速启] refDirect 不可用，直读结果不作为兜底：', candidatePath);
    return null;
  }
  if (compareBytes(buf, refDirect)) return null; // 直读输出与 ref.exe 直读一致 → 仍是通用图

  try {
    const image = nativeImage.createFromBuffer(buf);
    return image.isEmpty() ? null : image.toDataURL();
  } catch (err) {
    console.warn('[速启] 直读结果解码失败：', candidatePath, err);
    return null;
  }
}

/** 会话级临时物清理（4.8；经 icons.js 重导出，main.js will-quit 挂载）——尽力而为，失败仅留痕 */
export function cleanupIconTemp() {
  if (!sessionDirPromise) return; // 从未创建 → 无清理面
  sessionDirPromise.then(
    (dir) => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[速启] 图标临时目录清理失败：', err);
      }
    },
    () => {}, // 目录从未创建成功 → 无清理面
  );
}
