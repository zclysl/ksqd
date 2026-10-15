// 速启 · 入口（设计档 4.1 / 4.10 / 4.2 / 4.3 / 4.13 —— 装配与生命周期）
// 单实例锁 → 装配（窗口 / 托盘 / 热键 / IPC / 自启）→ 生命周期。

import { app, shell } from 'electron';
import path from 'node:path';

import { isShortcutPath } from './catalog.js';
import { createStore } from './store.js';
import {
  createPanelWindow,
  getPanelWindow,
  hidePanel,
  setQuitting,
  showPanel,
  togglePanel,
  togglePanelFromTray,
  withBlurSuppressed,
} from './window.js';
import { createTray, displayBalloon, rebuildTrayMenu } from './tray.js';
import { registerHotkey, registerToggleHotkey, unregisterAllHotkeys, unregisterHotkey } from './hotkey.js';
import { closeSettingsWindow, openSettingsWindow } from './settings-window.js';
import { registerIpcHandlers } from './ipc.js';
import { cleanupIconTemp } from './icons.js';
import { applyAutoLaunch, isAutoLaunchSupported, reconcileAutoLaunch } from './autolaunch.js';

const AUTOSTART_FLAG = '--autostart';

// 4.10 + 4.1 取锁前提：先 setName / setPath('userData')（锁按取锁时刻的 userData 归并）
app.setName('速启');
app.setPath('userData', path.join(app.getPath('appData'), '速启'));

if (!app.requestSingleInstanceLock()) {
  // 4.1：未获得锁 → 直接退出（不建窗口、不建托盘）
  app.quit();
} else {
  boot();
}

function boot() {
  const store = createStore(app.getPath('userData'));

  // 4.1：第二实例唤出已有实例；登录自启产生的第二实例静默忽略（--autostart）
  app.on('second-instance', (event, commandLine) => {
    if (commandLine.includes(AUTOSTART_FLAG)) return;
    showPanel();
  });

  // 4.2：退出时注销全局热键；4.8：清理图标会话临时物（尽力而为，失败仅留痕）
  app.on('will-quit', () => {
    unregisterAllHotkeys();
    cleanupIconTemp();
  });

  // 4.3：常驻托盘 —— 窗口全部关闭也不退出（退出唯一入口 = 托盘菜单「退出」）
  app.on('window-all-closed', () => {});

  // 4.13：托盘勾选变更 —— 先写设置落盘 → 再 apply → 重建菜单；两条失败路径均保留用户意图值并气球提示
  function setAutoLaunch(enabled) {
    const desired = enabled === true;
    try {
      store.save({ ...store.state, settings: { ...store.state.settings, autoLaunch: desired } });
    } catch (err) {
      console.warn('[速启] 自启设置保存失败：', err);
      displayBalloon('速启', '开机自启动设置未保存');
    }
    if (isAutoLaunchSupported() && !applyAutoLaunch(desired)) {
      displayBalloon('速启', '开机自启动设置未生效');
    }
    rebuildTrayMenu();
  }

  // 4.16 存量迁移（F3.9）：realPath 未登记的 .lnk 条目补登记真实目标（缺多少补多少）；补到任一 → 落盘一次；
  // 解析失败 → 保持 null；失败仅留痕、不打断启动（纯逻辑不进 store.js，store 保持可单测形态）
  function backfillShortcutRealPaths() {
    const apps = [];
    let changed = false;
    for (const entry of store.state.apps) {
      if (entry.realPath || !isShortcutPath(entry.path)) {
        apps.push(entry);
        continue;
      }
      let realPath = null;
      try {
        const target = shell.readShortcutLink(entry.path)?.target;
        if (typeof target === 'string' && target.trim()) realPath = path.resolve(target);
      } catch (err) {
        console.warn('[速启] 存量快捷方式目标解析失败：', entry.path, err);
      }
      if (realPath) changed = true;
      apps.push(realPath ? { ...entry, realPath } : entry);
    }
    if (!changed) return;
    try {
      store.save({ ...store.state, apps });
    } catch (err) {
      console.warn('[速启] 存量快捷方式 realPath 落盘失败：', err);
    }
  }

  app.whenReady().then(() => {
    store.load();
    backfillShortcutRealPaths(); // 4.16：载入后一次性补登记（补到即落盘）
    console.log(`[速启] 数据文件：${store.filePath}`);

    createPanelWindow();

    // 4.3：启动即创建托盘，全生命周期常驻
    createTray({
      onToggle: () => togglePanelFromTray(),
      onShow: () => showPanel(),
      onQuit: () => {
        setQuitting(true);
        app.quit();
      },
      getAutoLaunchItem: () => {
        const supported = isAutoLaunchSupported();
        return {
          label: supported ? '开机自启动' : '开机自启动（仅安装版可用）',
          checked: store.state.settings.autoLaunch === true,
          enabled: supported,
        };
      },
      onToggleAutoLaunch: (enabled) => setAutoLaunch(enabled),
      // 4.3 / 4.14：「快捷键设置…」→ 打开按键录制小窗（与面板可见性无关）
      onHotkeySettings: () => openSettingsWindow({
        getAccelerator: () => store.state.settings.hotkey,
        onResumeFailure: (accel) => displayBalloon('速启', `全局热键 ${accel} 注册失败（可能被其他软件占用），可点击托盘图标唤出面板`),
      }),
    });

    // 4.2：托盘创建完成后按 settings.hotkey 注册热键；失败仅气球提示（不换键、不重试）
    registerToggleHotkey({
      accelerator: store.state.settings.hotkey,
      onTrigger: () => togglePanel(),
      onFailure: (accel) => displayBalloon('速启', `全局热键 ${accel} 注册失败（可能被其他软件占用），可点击托盘图标唤出面板`),
    });

    registerIpcHandlers({
      store,
      getWindow: getPanelWindow,
      withBlurSuppressed,
      hidePanel,
      registerHotkey,
      unregisterHotkey,
      displayBalloon,
      closeSettingsWindow,
    });

    // 4.13：启动时自愈（仅打包版）
    if (isAutoLaunchSupported()) {
      reconcileAutoLaunch(store.state.settings.autoLaunch, () => {
        displayBalloon('速启', '开机自启动设置未生效');
      });
    }

    console.log(`[速启] 已就绪：常驻托盘，${store.state.settings.hotkey} 或托盘单击唤出面板`);
  }).catch((err) => {
    // 初始化异常不静默：留痕 → 可见提示（托盘已建时生效，未建自动跳过）→ 退出
    console.error('[速启] 初始化失败：', err);
    displayBalloon('速启', '初始化失败，程序即将退出');
    setQuitting(true); // 窗口已建时必须先标记退出中——否则 close 拦截（window.js）会把 quit 拦成 hide
    app.quit();
  });
}
