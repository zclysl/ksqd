// 速启 · 启动执行与失败检测（设计档 4.9 / 4.16 / F3.3 / F3.9 / F4.3）
// 启动目标选择三级（F3.9 自愈）：① 条目路径 ② .lnk 条目登记的 realPath ③ 无目标 → 固定文案（不发起 openPath）。
// 两道失败检测：① 上列目标选择落第③级 ② openPath 返回非空。

import fs from 'node:fs';
import { shell } from 'electron';

import { isShortcutPath } from './catalog.js';

/**
 * shell.openPath 走 Windows ShellExecute：.exe 与 .lnk 统一处理（.lnk 由系统解析目标）。
 * 入参为条目对象 {path, realPath}（4.16）；返回 {ok:true} 或 {ok:false, message}（message 为 4.11 固定文案）。
 */
export async function launchApp(entry) {
  const target = pickLaunchTarget(entry);
  if (!target) {
    return { ok: false, message: '启动失败：目标文件不存在' };
  }
  const error = await shell.openPath(target);
  if (error) {
    console.warn(`[速启] 启动失败：${target} → ${error}`); // 原始信息记 console（4.9）
    return { ok: false, message: '启动失败：无法启动该程序' };
  }
  return { ok: true };
}

/** 三级目标选择（4.9 / 4.16）：条目路径存在 → 用之；.lnk 条目 realPath 存在 → 自愈用之；否则 null */
function pickLaunchTarget(entry) {
  const filePath = typeof entry?.path === 'string' ? entry.path : '';
  if (filePath && fs.existsSync(filePath)) return filePath; // ①
  const realPath = typeof entry?.realPath === 'string' ? entry.realPath : '';
  if (filePath && isShortcutPath(filePath) && realPath && fs.existsSync(realPath)) return realPath; // ②
  return null; // ③
}
