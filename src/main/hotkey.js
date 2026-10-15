// 速启 · 全局热键（设计档 4.2 / 4.14 / F1.1 / F1.5）
// 注册来源参数化（settings.hotkey）+ 三态（未注册 / 已注册 / 暂停）；
// 注册替换 = 先注册新、成功再注销旧（4.14）；注册失败仅气球提示（不换键、不重试），托盘路径全程可用。

import { globalShortcut } from 'electron';

// 三态（4.2）：unregistered 未注册 / registered 已注册 / paused 暂停（录制窗开启期间无任何注册）
let state = 'unregistered';
let current = null; // 当前持有的注册组合
let trigger = null;

function tryRegister(accelerator) {
  if (!trigger || !accelerator) return false;
  try {
    return globalShortcut.register(accelerator, trigger);
  } catch (err) {
    console.warn(`[速启] 全局热键 ${accelerator} 注册异常：`, err);
    return false;
  }
}

function reportFailure(onFailure, accelerator) {
  console.warn(`[速启] 全局热键 ${accelerator} 注册失败（可能被其他软件占用），可点击托盘图标唤出面板`);
  if (typeof onFailure === 'function') onFailure(accelerator);
}

/** ready 且托盘创建完成后调用（4.2 注册来源参数化）；返回是否注册成功 */
export function registerToggleHotkey({ accelerator, onTrigger, onFailure }) {
  trigger = onTrigger;
  if (tryRegister(accelerator)) {
    state = 'registered';
    current = accelerator;
    return true;
  }
  state = 'unregistered';
  reportFailure(onFailure, accelerator);
  return false;
}

/** 录制窗开窗调用（4.14）：注销当前注册、置暂停态；重复调用幂等（暂停态不持有注册） */
export function pauseToggleHotkey() {
  if (state === 'registered' && current) {
    try {
      globalShortcut.unregister(current);
    } catch (err) {
      console.warn('[速启] 全局热键注销异常：', err);
    }
  }
  state = 'paused';
}

/**
 * 录制窗关窗调用（4.2 三态判定）：已注册（录制期改键成功后新组合已保持注册）→ 跳过重注册；
 * 否则按 settings.hotkey 注册（失败照 4.2 气球）。
 */
export function resumeToggleHotkey({ accelerator, onFailure } = {}) {
  if (state === 'registered') return true;
  if (!accelerator || !tryRegister(accelerator)) {
    state = 'unregistered';
    if (accelerator) reportFailure(onFailure, accelerator);
    return false;
  }
  state = 'registered';
  current = accelerator;
  return true;
}

/** hotkey:set（#15）：注册新组合（4.14 先注册新）；成功 → 持有并置已注册态 */
export function registerHotkey(accelerator) {
  if (!tryRegister(accelerator)) return false;
  state = 'registered';
  current = accelerator;
  return true;
}

/** hotkey:set（#15）：注销旧组合（4.14）——未持有该组合（暂停态）时空操作 */
export function unregisterHotkey(accelerator) {
  if (!accelerator) return;
  try {
    globalShortcut.unregister(accelerator);
  } catch (err) {
    console.warn('[速启] 全局热键注销异常：', err);
  }
  if (state === 'registered' && current === accelerator) {
    state = 'unregistered';
    current = null;
  }
}

/** will-quit 时调用 */
export function unregisterAllHotkeys() {
  globalShortcut.unregisterAll();
}
