// 速启 · item-actions.js —— 条目右键菜单动作面（打开安装位置 / 编辑… / 删除）
// 承接自 renderer.js（6.8 #8）：菜单项构成与动作分派同域；业务动作经 ops 回调交回 renderer
// （openAppForm / guard / applyMutation），本层不持业务状态、不读写 state。
// 加载形态：经典脚本（file:// 下 Chromium 以 CORS 拦截 ES 模块脚本）；依赖 window.SuqiComponents。
(function (global) {
  'use strict';

  const components = window.SuqiComponents;
  const api = window.api;

  let ops = null; // { openAppForm, guard, applyMutation }

  function init(options) { ops = options; }

  // 条目右键菜单（4.6）：打开安装位置 / 编辑… / 删除——菜单顺序见 4.19（无确认步、无图标）
  function openItemMenu(itemEl, app) {
    components.openMenu(itemEl, [
      { label: '打开安装位置', action: 'reveal' },
      { label: '编辑…', action: 'edit' },
      { label: '删除', action: 'delete' },
    ], (action) => {
      if (action === 'reveal') revealApp(app);
      else if (action === 'edit') editApp(app);
      else if (action === 'delete') confirmDelete(itemEl, app);
    });
  }

  // 打开安装位置（4.19 / F3.11）：main 侧解析目标（realPath 优先 → 条目路径）并打开选中；
  // 目标不存在 → main 回 4.11 固定文案（"打开失败：目标文件不存在" 的唯一源在 ipc.js），本层直接 toast（错误态 5s，
  // AC-26 第三种情形不静默）；rejected（main 已留痕）/ invalid（防御分支）不冒领「目标不存在」
  async function revealApp(app) {
    const res = await ops.guard(() => api.revealApp(app.id));
    if (res && res.ok) return;
    if (res && res.message) {
      components.toast(res.message, true);
      return;
    }
    console.warn('速启：打开安装位置失败', res && res.code);
  }

  function editApp(app) {
    ops.openAppForm({
      mode: 'edit',
      appId: app.id,
      path: app.path,
      name: app.name,
      categoryId: app.categoryId,
    });
  }

  // 删除（F3.5）：行内确认 → 移除 + toast「已移除」（不删除软件本体）
  function confirmDelete(itemEl, app) {
    components.openConfirm({
      anchorEl: itemEl,
      text: '移除该条目？（不删除软件本体）',
      onConfirm: async () => {
        const res = await ops.guard(() => api.deleteApp(app.id));
        if (res.ok) ops.applyMutation(res, '已移除');
      },
    });
  }

  global.SuqiItemActions = { init, openItemMenu };
})(window);
