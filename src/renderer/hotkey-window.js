// 速启 · hotkey-window.js —— 按键录制小窗逻辑（F1.5 / 4.14）
// 职责：keydown → 组合串映射（仅修饰键按下不算组合、继续等待）、当前组合显示（settings.hotkey 唯一来源，3.1 #1）、
// 提示行兼消息行渲染（拒绝 / 落盘失败文案）、hotkey:set 调用、关闭（Esc /「关闭」按钮，不产生变更）。
// 成功路径的关窗在 main 侧（#15 成功且无 warning 时自动关闭），此处不重复关（4.14）。
// 加载形态：经典脚本（与面板同制式）。
(function () {
  'use strict';

  const api = window.api;

  const PROMPT = '按下新的组合…'; // 初值与「下一次 keydown 恢复」提示语（4.14）
  const ERR_NO_MODIFIER = '快捷键须含 Ctrl / Alt / Shift / Win 之一';
  const ERR_UNSUPPORTED_KEY = '不支持的按键';
  const MSG_SAVE_FAILED = '保存失败';

  const currentEl = document.getElementById('hotkey-current');
  const hintEl = document.getElementById('hotkey-hint');
  const closeBtn = document.getElementById('hotkey-close');

  // keydown → 组合串（修饰键 + 键名）；串形态与键名白名单判定在 main（accelerator.js 纯逻辑归一化）
  function acceleratorFromEvent(e) {
    const key = e.key;
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta' || key === 'OS') return null; // 仅修饰键 → 不算组合
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const name = key === ' ' ? 'Space' : key;
    return { accelerator: [...mods, name].join('+'), hasModifier: mods.length > 0 };
  }

  // 拒绝文案二选一（4.14）：无修饰键 → 须含修饰键；有修饰键而校验不过 → 键名不可识别
  function showRejection(hasModifier) {
    hintEl.textContent = hasModifier ? ERR_UNSUPPORTED_KEY : ERR_NO_MODIFIER;
  }

  async function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      api.closeHotkeyWindow(); // Esc = 关闭且不产生变更（4.14）
      return;
    }
    if (e.repeat) return;
    hintEl.textContent = PROMPT; // 下一次 keydown 恢复提示语（4.14）
    const combo = acceleratorFromEvent(e);
    if (!combo) return; // 仅修饰键按下 → 继续等待
    e.preventDefault();
    let res;
    try {
      res = await api.setHotkey(combo.accelerator);
    } catch (err) {
      console.error('速启：快捷键设置调用失败', err);
      res = { ok: false, code: 'rejected' };
    }
    if (!res || !res.ok) {
      // invalid → 两枚拒绝文案就地显示（4.14）；occupied（被占用）→ main 气球「…已保留原快捷键」+ 留开可重试（4.14），
      // 消息行无固定文案（4.11 文案表仅两枚拒绝文案 +「保存失败」）
      if (res && res.code === 'invalid') showRejection(combo.hasModifier);
      return;
    }
    if (res.accelerator) currentEl.textContent = res.accelerator; // save_failed 留开时按内存态新值显示当前组合
    if (res.warning === 'save_failed') hintEl.textContent = MSG_SAVE_FAILED; // 落盘失败 → 消息行 + 留开（4.14）
    // 成功且无 warning：main 侧自动关窗（4.14），此处不重复关
  }

  async function init() {
    try {
      const loaded = await api.loadState();
      const hotkey = loaded && loaded.settings ? loaded.settings.hotkey : '';
      if (hotkey) currentEl.textContent = hotkey; // 当前组合显示（3.1 #1 唯一来源）
    } catch (err) {
      console.error('速启：状态加载失败', err);
    }
    document.addEventListener('keydown', onKeyDown);
    closeBtn.addEventListener('click', () => api.closeHotkeyWindow()); // 「关闭」= 关闭且不产生变更（4.14）
  }

  init();
})();
