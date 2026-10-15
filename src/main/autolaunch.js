// 速启 · 开机自启动（设计档 4.13 / F6）
// 封装 Electron 登录项 API：登记 / 移除 / 读回校验 / 启动时自愈。
// 仅打包版登记（app.isPackaged 门槛）——开发运行不写注册表（4.13 结论）。

import { app } from 'electron';

const AUTOSTART_ARGS = ['--autostart'];

export function isAutoLaunchSupported() {
  return app.isPackaged === true;
}

function loginItemOptions() {
  return { path: process.execPath, args: AUTOSTART_ARGS };
}

/** 系统侧当前登记状态（按本程序路径 + --autostart 读回） */
export function getSystemAutoLaunch() {
  const settings = app.getLoginItemSettings(loginItemOptions());
  return settings.openAtLogin === true;
}

/** 登记 / 取消并读回校验（4.13）；返回读回结果与目标是否一致 */
export function applyAutoLaunch(enabled) {
  const desired = enabled === true;
  const options = loginItemOptions();
  app.setLoginItemSettings({ openAtLogin: desired, path: options.path, args: options.args });
  return getSystemAutoLaunch() === desired;
}

/** 启动时自愈（4.13，仅打包版调用）：系统状态 ≠ 设置 → 按设置重登记；仍不一致 → 上报提示 */
export function reconcileAutoLaunch(desired, onMismatch) {
  const wanted = desired === true;
  if (getSystemAutoLaunch() === wanted) return true;
  const ok = applyAutoLaunch(wanted);
  if (!ok && typeof onMismatch === 'function') onMismatch();
  return ok;
}
