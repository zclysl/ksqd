// 速启 · 面板窗口（设计档 2.2 / 4.4 / 4.5）
// 单窗口复用：创建一次，全程 show / hide（不销毁重建）；失焦隐藏与四类例外在此收口。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 面板尺寸（2.2） */
export const PANEL_WIDTH = 720;
export const PANEL_HEIGHT = 480;

/** 托盘守卫窗口（4.5 例外②） */
const TRAY_GUARD_MS = 300;
const FOCUS_GRACE_MS = 300; // 4.5 焦点复位宽限（组字结束时窗口无焦点 → 约 300ms 内归还）

let win = null;
let quitting = false;
let blurSuppressed = 0;
let imeComposing = false; // 组字标记（4.5 例外④ IME 组字期守卫）
let focusGraceTimer = null; // 焦点复位宽限计时（4.5）
let trayClickGuardUntil = 0;
let lastBlurHideAt = 0;

function isUsable() {
  return Boolean(win && !win.isDestroyed());
}

function isDevToolsOpen() {
  return isUsable() && win.webContents.isDevToolsOpened();
}

/** 4.5 例外：退出中 / 原生对话框抑制 / 组字期守卫 / 托盘守卫窗口 / DevTools 打开 —— 不隐藏 */
function shouldStayVisible() {
  return quitting || blurSuppressed > 0 || imeComposing || Date.now() < trayClickGuardUntil || isDevToolsOpen();
}

/** 创建面板窗口（2.2 配置）；启动只建窗不显示（F1.4 不显示常驻主窗口） */
export function createPanelWindow() {
  win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
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

  // 页面加载失败只告警（不产生未处理拒绝导致进程退出）
  win.loadFile(path.join(__dirname, '../renderer/index.html')).catch((err) => {
    console.warn('[速启] 面板页面加载失败：', err?.message || err);
  });

  // 4.5：窗口失去 OS 焦点即隐藏（例外见 shouldStayVisible）
  win.on('blur', () => {
    if (!isUsable() || !win.isVisible()) return;
    if (shouldStayVisible()) return;
    lastBlurHideAt = Date.now();
    hidePanel();
  });

  // 4.5 焦点复位宽限：焦点归还即取消宽限（宽限取消事件之一）
  win.on('focus', () => cancelFocusGrace());

  // 4.5：close 一律拦截为 hide（Alt+F4 / Ctrl+W 不退出应用）；退出唯一入口 = 托盘菜单「退出」
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hidePanel();
  });

  // 2.3#4：导航与新窗一律拒绝（同时防拖拽文件触发页面导航）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  return win;
}

/** 4.4：光标所在屏 workArea 内几何居中（每次显示前调用；多显示器与任务栏变化下次显示自然生效） */
export function positionPanel() {
  const point = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  const x = Math.round(workArea.x + (workArea.width - PANEL_WIDTH) / 2);
  const y = Math.round(workArea.y + (workArea.height - PANEL_HEIGHT) / 2);
  win.setPosition(x, y);
}

/** 4.5：显示 = 定位 → show → focus；未夺焦时按设计回退置顶刷新（待实测点，第十三节第 2 点） */
export function showPanel() {
  if (!isUsable()) return;
  imeComposing = false; // 组字标记自愈复位（4.5 失败与边界）
  cancelFocusGrace(); // 宽限取消事件之一
  positionPanel();
  win.show();
  win.focus();
  if (!win.isFocused()) {
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true);
    win.focus();
  }
  lastBlurHideAt = 0;
  win.webContents.send('panel:shown'); // 3.2：面板每次显示时发出
}

export function hidePanel() {
  imeComposing = false; // 组字标记自愈复位（4.5 失败与边界）
  cancelFocusGrace(); // 宽限取消事件之一
  if (isUsable() && win.isVisible()) win.hide();
}

/** 热键切换（4.2）：isVisible 语义；原生对话框打开期间忽略（见 4.5 例外①） */
export function togglePanel() {
  if (!isUsable()) return;
  if (blurSuppressed > 0) return;
  if (win.isVisible()) hidePanel();
  else showPanel();
}

/**
 * 托盘切换（4.3 / 4.5 例外②）：
 * ① click 后 300ms 内的 blur 不隐藏（先设守卫再判可见性）；
 * ② blur 先于 click 到达（点托盘使面板失焦）时，本次点击意图 = 收起 —— 不反向显示。
 */
export function togglePanelFromTray() {
  if (!isUsable()) return;
  if (blurSuppressed > 0) return; // 与热键同一 toggle 语义（4.3）：对话框打开期间忽略
  trayClickGuardUntil = Date.now() + TRAY_GUARD_MS;
  if (win.isVisible()) {
    hidePanel();
    return;
  }
  if (Date.now() - lastBlurHideAt < TRAY_GUARD_MS) {
    lastBlurHideAt = 0; // 消费标记：快速连点的下一次点击仍可正常唤起
    return;
  }
  showPanel();
}

/** 4.5 例外①：原生对话框期间抑制失焦隐藏；关闭后夺回焦点并复位 */
export async function withBlurSuppressed(task) {
  blurSuppressed += 1;
  try {
    return await task();
  } finally {
    blurSuppressed -= 1;
    if (isUsable()) win.focus();
  }
}

/** 4.5 例外④：IME 组字期守卫通报（IPC #17）——组字期 blur 不隐藏；组字结束按焦点归属收尾 */
export function setImeComposing(composing) {
  if (composing) {
    imeComposing = true;
    cancelFocusGrace(); // 宽限取消事件之一：新组字开始（compositionstart）
    return;
  }
  imeComposing = false;
  if (!isUsable()) return;
  if (win.isFocused()) {
    win.focus(); // 窗口仍有焦点 → 夺回（沿例外①「关闭后夺回焦点」形态）
    return;
  }
  if (win.isVisible()) startFocusGrace(); // 无焦点且面板可见 → 焦点复位宽限（4.5）
}

/** 4.5 焦点复位宽限：约 300ms 内焦点归还 → 不隐藏（命名继续）；期满仍未归还 → hidePanel()（防组字中真切走滞留） */
function startFocusGrace() {
  cancelFocusGrace();
  focusGraceTimer = setTimeout(() => {
    focusGraceTimer = null;
    if (isUsable() && win.isFocused()) return; // 宽限期内焦点归还 → 不隐藏
    hidePanel(); // 期满仍未归还 → 照 F1.3 隐藏
  }, FOCUS_GRACE_MS);
}

/** 宽限取消事件（4.5）：焦点归还 / 新组字开始（compositionstart）/ showPanel() / hidePanel() */
function cancelFocusGrace() {
  if (!focusGraceTimer) return;
  clearTimeout(focusGraceTimer);
  focusGraceTimer = null;
}

/** 退出中标记：close 拦截放行 + blur 不再隐藏 */
export function setQuitting(value) {
  quitting = Boolean(value);
}

export function getPanelWindow() {
  return win;
}
