// 速启 · 托盘（设计档 4.3 / F1.2 / F1.4 / F6.2）
// 内嵌 base64 图标（32×32 橙色底板 + 白闪电，不落资产文件 → 开发 / 打包无路径差异）；
// 单击切换面板；右键菜单（显示面板 / 开机自启动勾选 / 快捷键设置… / 退出）随状态重建。

import { Menu, Tray, nativeImage } from 'electron';

/** 内嵌托盘图标：32×32 PNG（#F5A623 橙色圆角底板 + 白色闪电，外圈透明）
 *  用「实色底板 + 高对比前景」而非单色前景：Windows 托盘区底色随系统主题在浅灰 / 深灰之间切换，
 *  透明底的单色图形必然在其中一种下丢掉对比度。底板自带色块轮廓，两种主题下都立得住。
 *  闪电顶点已按 32 网格重绘（比原 glyph 更粗、更短），保证缩到 16px 时仍是清晰的闪电而非一团糊。 */
const ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABPElEQVR42s2XPQ6CQBCFPQqJJ/AensCKU3gBD7DxElb0JsZeG0NiYWljZaOx8Af/1n0Gkg0u7I4DCy+ZEt7nOG8ydDpt03nSDVQJVbEqWVHF6TsDm3mo6lihcb7w7rDMXHqq0NR29i+/RD1KJwIdQHDNH9tIXqd9yjNCB2ANXLIYSog6mDoA2/ydnMjPsgHQchhDz/3SL4Bu/gXYzfwBYNpfh43UdV+P/QCYzKFkNfIDgLiZdJsP6gcoMoeIO4AOkMWtSEjBT6nBLNuOzgA2c5OQEFtXnADycXMVoNl/AdqHNprayzVn7QF0pUgY1NoXESLHNWcBYOnkheVEuAd4AFi7XHMWAAaTErfqAdIUcMxZANlecI2bCwDpJKvCPH+SCcoOoMbN5Sh1Psv/mXbrWd74h0krPs1a8XHahD7/luDaWC1cFAAAAABJRU5ErkJggg==';

let tray = null;
let handlers = null;

/** 右键菜单（4.3）：显示面板 / 开机自启动勾选 / 快捷键设置… / 退出；随状态重建 */
export function rebuildTrayMenu() {
  if (!tray || !handlers) return;
  const autoLaunch = handlers.getAutoLaunchItem();
  const menu = Menu.buildFromTemplate([
    { label: '显示面板', click: () => handlers.onShow() },
    {
      label: autoLaunch.label,
      type: 'checkbox',
      checked: autoLaunch.checked,
      enabled: autoLaunch.enabled,
      click: (item) => handlers.onToggleAutoLaunch(item.checked),
    },
    // 4.3 / 4.14：唤起按键录制小窗（与面板可见性无关）
    { label: '快捷键设置…', click: () => handlers.onHotkeySettings() },
    { type: 'separator' },
    { label: '退出', click: () => handlers.onQuit() },
  ]);
  tray.setContextMenu(menu);
}

/** 启动即创建、全生命周期常驻（4.3 / F1.4）；单击 = 切换面板（守卫见 4.5 例外②） */
export function createTray(trayHandlers) {
  handlers = trayHandlers;
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_BASE64}`);
  tray = new Tray(image);
  tray.setToolTip('速启');
  tray.on('click', () => handlers.onToggle());
  rebuildTrayMenu();
  return tray;
}

/** 气球提示（4.2 热键注册失败 / 4.13 自启未生效） */
export function displayBalloon(title, content) {
  if (!tray) return;
  tray.displayBalloon({ title, content });
}
