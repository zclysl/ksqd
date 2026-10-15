// 速启 · IPC 通道面（设计档 3.1 / 3.2 / 2.3#5）—— 唯一 renderer→main 契约实现。
// 变更通道统一收口：校验类失败 → {ok:false, code}；保存失败 → {ok:true, state, warning:'save_failed'}
//（父侧裁定 2026-10-06：内存态保留、UI 按新状态重渲染，warning 承载「保存失败」toast）。

import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain, shell } from 'electron';

import * as catalog from './catalog.js';
import { normalizeAccelerator } from './accelerator.js';
import { getAppIconDataUrl, getIconDataUrl } from './icons.js';
import { launchApp } from './launcher.js';
import { setImeComposing } from './window.js';

const PICK_FILTERS = [{ name: '程序', extensions: ['exe', 'lnk'] }];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 4.7 统一校验（存在 → 扩展名 → 判重）；不信任 renderer 传来的路径（2.3#5） */
function validatePath(state, rawPath) {
  const filePath = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!filePath) return { ok: false, code: 'missing' };
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return { ok: false, code: 'missing' };
  if (!catalog.isSupportedFile(resolved)) return { ok: false, code: 'unsupported' };
  if (catalog.findAppByPath(state, resolved)) return { ok: false, code: 'duplicate' };
  return { ok: true, path: resolved };
}

/** .lnk 真实目标解析（F3.9 / 4.16 采集）：解析抛错 / 无 target → null（不阻断添加）；非空 → resolve 后登记 */
function resolveShortcutTarget(resolved) {
  if (!catalog.isShortcutPath(resolved)) return null;
  try {
    const target = shell.readShortcutLink(resolved)?.target;
    return typeof target === 'string' && target.trim() ? path.resolve(target) : null;
  } catch (err) {
    console.warn('[速启] 快捷方式目标解析失败：', resolved, err);
    return null;
  }
}

export function registerIpcHandlers({
  store,
  getWindow,
  withBlurSuppressed,
  hidePanel,
  registerHotkey,
  unregisterHotkey,
  displayBalloon,
  closeSettingsWindow,
}) {
  const mutate = (compute) => {
    const result = compute(store.state);
    if (!result.ok) return result;
    try {
      store.save(result.state);
      return result;
    } catch (err) {
      console.warn('[速启] 数据保存失败：', err); // 4.10：保留内存态，下次变更重试
      return { ...result, warning: 'save_failed' };
    }
  };

  // #1 state:load —— 启动时全量加载
  ipcMain.handle('state:load', () => ({
    categories: store.state.categories,
    apps: store.state.apps,
    settings: store.state.settings,
  }));

  // #2 app:pick —— 文件选择器（限 exe/lnk）+ 校验；期间抑制失焦隐藏（4.5 例外①）
  ipcMain.handle('app:pick', async () => {
    const win = getWindow();
    const options = { properties: ['openFile'], filters: PICK_FILTERS };
    let result = null;
    try {
      result = await withBlurSuppressed(() => (
        win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
      ));
    } catch (err) {
      console.warn('[速启] 文件选择器打开失败：', err);
      return { ok: false, code: 'canceled' };
    }
    if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { ok: false, code: 'canceled' };
    }
    const check = validatePath(store.state, result.filePaths[0]);
    if (!check.ok) return { ok: false, code: check.code };
    return { ok: true, path: check.path, defaultName: catalog.defaultNameOf(check.path) };
  });

  // #3 app:validatePath —— 拖拽路径校验（存在 / 扩展名 / 判重）
  ipcMain.handle('app:validatePath', (event, payload) => {
    if (!isRecord(payload) || typeof payload.path !== 'string') return { ok: false, code: 'invalid' };
    const check = validatePath(store.state, payload.path);
    if (!check.ok) return { ok: false, code: check.code };
    return { ok: true, defaultName: catalog.defaultNameOf(check.path) };
  });

  // #4 app:create —— 再校验（存在 / 扩展名 / 判重，防两次拖拽竞态）后落库；
  // .lnk 条目落库前解析一次真实目标登记 realPath（F3.9 / 4.16；解析失败不影响落库）
  ipcMain.handle('app:create', (event, payload) => {
    if (!isRecord(payload) || typeof payload.path !== 'string' || typeof payload.name !== 'string') {
      return { ok: false, code: 'invalid' };
    }
    const check = validatePath(store.state, payload.path);
    if (!check.ok) return { ok: false, code: check.code };
    return mutate((state) => catalog.createApp(state, {
      path: check.path,
      name: payload.name,
      categoryId: typeof payload.categoryId === 'string' ? payload.categoryId : undefined,
      realPath: resolveShortcutTarget(check.path),
    }));
  });

  // #5 app:update —— 编辑（改名 / 换分类）
  ipcMain.handle('app:update', (event, payload) => {
    if (!isRecord(payload) || typeof payload.id !== 'string'
      || typeof payload.name !== 'string' || typeof payload.categoryId !== 'string') {
      return { ok: false, code: 'invalid' };
    }
    return mutate((state) => catalog.updateApp(state, {
      id: payload.id,
      name: payload.name,
      categoryId: payload.categoryId,
    }));
  });

  // #6 app:delete —— 仅移除条目（F3.5）
  ipcMain.handle('app:delete', (event, payload) => {
    if (!isRecord(payload) || typeof payload.id !== 'string') return { ok: false, code: 'invalid' };
    return mutate((state) => catalog.deleteApp(state, payload.id));
  });

  // #7 app:launch —— 启动（两道失败检测）；成功 → renderer 侧收起面板
  ipcMain.handle('app:launch', async (event, payload) => {
    if (!isRecord(payload) || typeof payload.id !== 'string') {
      return { ok: false, message: '启动失败：目标文件不存在' };
    }
    const entry = catalog.findAppById(store.state, payload.id);
    if (!entry) return { ok: false, message: '启动失败：目标文件不存在' };
    return launchApp({ path: entry.path, realPath: entry.realPath }); // 三级目标选择（4.9 / 4.16 自愈）
  });

  // #8 icon:get —— dataUrl 或 null（renderer 用占位图）；契约不变（renderer 仍只传 {id}），
  // main 侧按条目自行选源（4.16）：getIconDataUrl 收完整条目 {path, realPath}，失效 .lnk 自愈用 realPath
  ipcMain.handle('icon:get', async (event, payload) => {
    if (!isRecord(payload) || typeof payload.id !== 'string') return { dataUrl: null };
    const entry = catalog.findAppById(store.state, payload.id);
    if (!entry) return { dataUrl: null };
    return { dataUrl: await getIconDataUrl(entry) };
  });

  // #9 category:create
  ipcMain.handle('category:create', (event, payload) => {
    if (!isRecord(payload) || typeof payload.name !== 'string') return { ok: false, code: 'invalid' };
    return mutate((state) => catalog.createCategory(state, payload.name));
  });

  // #10 category:rename —— code ∈ empty
  ipcMain.handle('category:rename', (event, payload) => {
    if (!isRecord(payload) || typeof payload.id !== 'string' || typeof payload.name !== 'string') {
      return { ok: false, code: 'invalid' };
    }
    return mutate((state) => catalog.renameCategory(state, payload.id, payload.name));
  });

  // #11 category:delete —— code ∈ builtin；moved = 迁入「未分类」的条目数
  ipcMain.handle('category:delete', (event, payload) => {
    if (!isRecord(payload) || typeof payload.id !== 'string') return { ok: false, code: 'invalid' };
    return mutate((state) => catalog.deleteCategory(state, payload.id));
  });

  // #12 panel:hide —— Esc 隐藏面板（send，无返回）
  ipcMain.on('panel:hide', () => {
    hidePanel();
  });

  // #14 app:reorder —— 条目重排与跨分类移动（F3.8 / 4.15）；categoryId = 目标分类（可异于条目当前分类）；code ∈ missing / invalid
  ipcMain.handle('app:reorder', (event, payload) => {
    if (!isRecord(payload) || typeof payload.id !== 'string'
      || typeof payload.categoryId !== 'string' || !Number.isInteger(payload.toIndex)) {
      return { ok: false, code: 'invalid' };
    }
    return mutate((state) => catalog.reorderApp(state, payload));
  });

  // #15 hotkey:set —— 唤起快捷键改录（F1.5 / 4.14，决策 #24）：校验 → 无变化短路 →
  // 先注册新组合 → 落盘 → 注销旧组合（暂停态下空操作）→ 气球 → 自动关窗
  ipcMain.handle('hotkey:set', (event, payload) => {
    if (!isRecord(payload) || typeof payload.accelerator !== 'string') return { ok: false, code: 'invalid' };
    const next = normalizeAccelerator(payload.accelerator);
    if (!next) return { ok: false, code: 'invalid' };
    const prev = store.state.settings.hotkey;
    if (next === prev) return { ok: true, accelerator: next, state: store.state }; // 组合未变，不重复注册
    if (!registerHotkey(next)) {
      // 4.14 失败路径：settings 不变、旧组合保留；录制窗留开可重试
      displayBalloon('速启', `快捷键 ${next} 注册失败（可能被其他软件占用），已保留原快捷键`);
      return { ok: false, code: 'occupied' };
    }
    const settings = { ...store.state.settings, hotkey: next };
    let warning;
    try {
      store.save({ ...store.state, settings });
    } catch (err) {
      console.warn('[速启] 快捷键设置保存失败：', err); // 4.10：内存态保留，新组合已生效
      warning = 'save_failed';
    }
    unregisterHotkey(prev); // 暂停态（录制窗开）旧组合未持有 → 空操作（4.14）
    displayBalloon('速启', `唤起快捷键已更新为 ${next}`); // 4.14 成功路径
    if (!warning) closeSettingsWindow(); // save_failed → 录制窗留开（消息行可见）；成功 → 自动关窗
    return warning
      ? { ok: true, accelerator: next, state: store.state, warning }
      : { ok: true, accelerator: next, state: store.state };
  });

  // #16 hotkeyWindow:close —— 录制窗关闭（Esc / 关闭按钮，send，无返回）
  ipcMain.on('hotkeyWindow:close', () => {
    closeSettingsWindow();
  });

  // #17 panel:composing —— 组字态通报（send，无返回，3.1）；入参非布尔 → 忽略（防御，send 通道无返回面）
  ipcMain.on('panel:composing', (event, payload) => {
    if (!isRecord(payload) || typeof payload.composing !== 'boolean') return;
    setImeComposing(payload.composing);
  });

  // #18 appIcon:get —— 本应用图标（顶栏，F7.3 / 4.17）：无入参、只读、main 侧会话内缓存；null → renderer 隐藏顶栏图标
  ipcMain.handle('appIcon:get', async () => ({ dataUrl: await getAppIconDataUrl() }));
}
