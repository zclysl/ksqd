// 速启 · 快捷键录制小窗（设计档 4.14 / 决策 #22 / 6.3 #3）
// 独立瞬态小窗：创建 / 单例复用（重复打开 = 聚焦既有窗）/ 居中于光标所在屏 / 关闭；
// 开窗 = 暂停热键注册（4.2 暂停态），关窗按三态判定恢复注册（4.2）；与面板可见性无关（4.14）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';

import { pauseToggleHotkey, resumeToggleHotkey } from './hotkey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 录制窗尺寸（4.14） */
const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 160;

let win = null;

function isUsable() {
  return Boolean(win && !win.isDestroyed());
}

/** 4.14：居中于光标所在屏（同 4.4 面板定位口径） */
function positionSettingsWindow() {
  const point = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  const x = Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2);
  const y = Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 2);
  win.setPosition(x, y);
}

/**
 * 打开录制小窗（4.14）：单例复用 = 聚焦既有窗；新建 = 暂停热键 + 加载录制页。
 * getAccelerator / onResumeFailure 由 main 注入 —— 关窗恢复注册按 settings.hotkey，
 * 失败照 4.2 气球文案。
 */
export function openSettingsWindow({ getAccelerator, onResumeFailure } = {}) {
  if (isUsable()) {
    positionSettingsWindow();
    win.show();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 开窗 = 暂停热键（4.2 / 4.14：录制窗开启期间无任何注册）
  pauseToggleHotkey();

  win.loadFile(path.join(__dirname, '../renderer/hotkey.html')).catch((err) => {
    console.warn('[速启] 录制窗页面加载失败：', err?.message || err);
  });

  win.once('ready-to-show', () => {
    if (!isUsable()) return;
    positionSettingsWindow();
    win.show();
    win.focus();
  });

  // 关窗 = 按三态判定恢复注册（4.2 / 4.14）
  win.on('closed', () => {
    win = null;
    const accelerator = typeof getAccelerator === 'function' ? getAccelerator() : null;
    resumeToggleHotkey({ accelerator, onFailure: onResumeFailure });
  });

  // 2.3#4 同口径：导航与新窗一律拒绝
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  return win;
}

/** 关闭录制窗（#16 hotkeyWindow:close / 4.14 成功改键自动关窗） */
export function closeSettingsWindow() {
  if (isUsable()) win.close();
}
