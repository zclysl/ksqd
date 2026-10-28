// 速启 · components.js —— 浮动交互组件层（弹出菜单 / 行内确认 / 添加编辑浮层 / 底部 toast）
// 职责：组件的节点生命周期、面板内定位、键盘与点外关闭，以及各组件的打开态（微状态）。
// 分类管理编排已迁出到 category-panel.js（6.8 #7）：本文件只留浮层 / 菜单 / 确认浮层与 toast。
// 边界：不发 IPC、不读写业务数据——动作经回调交回 renderer。
// 加载形态：经典脚本（file:// 下 Chromium 以 CORS 拦截 ES 模块脚本）；依赖 window.SuqiUI。
(function (global) {
  'use strict';

  const ui = window.SuqiUI;

  const TOAST_NORMAL_MS = 3000; // 常规提示 3s
  const TOAST_ERROR_MS = 5000; // 错误提示 5s

  let panelEl = null;
  let toastEl = null;
  let toastTimer = null;
  let menuEl = null; // 当前弹出菜单
  let menuAnchor = null;
  let confirmEl = null; // 当前行内确认
  let formEl = null; // 当前添加 / 编辑浮层
  let swallowItemClick = false; // 行内确认被点外关闭后，吞掉随后那一次条目点击（防误启动）
  const transientClosedCbs = []; // 浮层 / 菜单 / 行内确认关闭收口通知（4.5 抑制解除收尾的「抑制解除事件」）

  // ---------- 定位（面板内绝对定位；越界收边，下方放不下则翻到上方）----------

  function positionPopup(popup, anchorEl) {
    const panel = panelEl.getBoundingClientRect();
    const anchor = anchorEl.getBoundingClientRect();
    popup.style.visibility = 'hidden';
    popup.style.left = '0px';
    popup.style.top = '0px';
    const size = popup.getBoundingClientRect();
    let left = anchor.left - panel.left;
    let top = anchor.bottom - panel.top + 4;
    left = Math.max(8, Math.min(left, panel.width - size.width - 8));
    if (top + size.height > panel.height - 8) {
      top = Math.max(8, anchor.top - panel.top - size.height - 4);
    }
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.visibility = '';
  }

  // ---------- 弹出菜单 ----------

  function openMenu(anchorEl, items, onAction) {
    if (menuAnchor === anchorEl) {
      closeMenu(); // 再点同一入口 = 收起
      return;
    }
    closeMenu();
    const el = ui.buildMenu(items);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      closeMenu();
      onAction(btn.dataset.action);
    });
    panelEl.appendChild(el);
    positionPopup(el, anchorEl);
    menuEl = el;
    menuAnchor = anchorEl;
    anchorEl.classList.add('menu-open');
  }

  function closeMenu() {
    if (!menuEl) return;
    menuAnchor.classList.remove('menu-open');
    menuEl.remove();
    menuEl = null;
    menuAnchor = null;
    notifyTransientClosed();
  }

  // ---------- 行内确认（条目删除等）----------

  // opts: { anchorEl, text, onConfirm }
  function openConfirm(opts) {
    closeConfirm();
    const el = ui.buildConfirmPop(opts.text);
    // 4.20：确认动作只从 click 面产生——焦点 + 原生激活（焦点在「删除」上按 Enter / Space，
    // 由浏览器派发一次 click）；只删一次靠 click 收口幂等（先 closeConfirm 移除节点，再激活无落点）
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'cancel') {
        closeConfirm();
      } else if (btn.dataset.action === 'confirm') {
        closeConfirm();
        opts.onConfirm();
      }
    });
    panelEl.appendChild(el);
    positionPopup(el, opts.anchorEl);
    confirmEl = el;
    el.querySelector('[data-action="confirm"]').focus(); // 4.20 焦点落点：入文档后聚焦「删除」
  }

  function closeConfirm() {
    if (!confirmEl) return;
    confirmEl.remove();
    confirmEl = null;
    notifyTransientClosed();
  }

  // ---------- 添加 / 编辑浮层 ----------

  // opts: { mode, name, path, categoryId, categories, onSubmit }
  // onSubmit({name, categoryId}) -> Promise<boolean>：true = 校验未过、停留浮层；否则关闭。
  function openForm(opts) {
    closeForm();
    closeMenu();
    closeConfirm();
    const el = ui.buildAppForm({
      mode: opts.mode,
      name: opts.name,
      path: opts.path,
      categoryId: opts.categoryId,
      categories: opts.categories,
    });
    const nameInput = el.querySelector('.form-input');
    let busy = false;
    async function submit() {
      if (busy) return;
      busy = true;
      try {
        const keepOpen = await opts.onSubmit({
          name: nameInput.value.trim(),
          categoryId: el.querySelector('.form-select').value,
        });
        if (keepOpen) nameInput.focus();
        else closeForm();
      } finally {
        busy = false;
      }
    }
    el.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; } // 4.5 ① 组字态 keydown 不作数（回车选词 / Esc 取消组字不误触提交；stopPropagation 不进 Esc 逐层）
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        closeForm();
      }
    });
    el.addEventListener('mousedown', (e) => {
      if (e.target === el) closeForm(); // 点浮层背景 = 取消
    });
    panelEl.appendChild(el);
    formEl = el;
    nameInput.focus();
    nameInput.select();
  }

  function closeForm() {
    if (!formEl) return;
    formEl.remove();
    formEl = null;
    notifyTransientClosed();
  }

  function isFormOpen() {
    return Boolean(formEl);
  }

  // ---------- 底部 toast（单条；常规 3s、错误 5s 自动消失；新消息顶替旧消息）----------

  function toast(message, isError) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.hidden = false;
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
      toastTimer = null;
    }, isError ? TOAST_ERROR_MS : TOAST_NORMAL_MS);
  }

  function clearToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    toastEl.hidden = true;
  }

  // ---------- 统一收口 ----------

  // Esc 逐层：关最上一层，返回是否关掉了东西
  function dismissTop() {
    if (formEl) {
      closeForm();
      return true;
    }
    if (menuEl) {
      closeMenu();
      return true;
    }
    if (confirmEl) {
      closeConfirm();
      return true;
    }
    return false;
  }

  // 面板每次显示时重置全部临时组件（含 toast）
  function closeAll() {
    closeForm();
    closeMenu();
    closeConfirm();
    clearToast();
    swallowItemClick = false;
  }

  function consumeItemClickSwallow() {
    const swallow = swallowItemClick;
    swallowItemClick = false;
    return swallow;
  }

  // 统一打开态判定出口（4.5 抑制②「按 components.js 打开态统一判定」/ 4.6 悬停抑制读取）：
  // form = 添加 / 编辑浮层；menu = 面板内菜单；confirm = 行内确认。
  function getTransientState() {
    return { form: Boolean(formEl), menu: Boolean(menuEl), confirm: Boolean(confirmEl) };
  }

  // 抑制解除收尾信号（4.5：浮层 / 菜单 / 行内确认关闭 = 抑制解除事件）
  function onTransientClosed(cb) { transientClosedCbs.push(cb); }

  function notifyTransientClosed() {
    for (const cb of transientClosedCbs) {
      try { cb(); } catch (err) { console.warn('速启：瞬态关闭回调异常', err); }
    }
  }

  function init(opts) {
    panelEl = opts.panelEl;
    toastEl = opts.toastEl;
    // 点开外关闭（点锚点自身不收起，留给锚点切换；被点掉的行内确认吞掉那一次条目点击）
    document.addEventListener('mousedown', (e) => {
      swallowItemClick = false; // 每次按下重新起算，防「无配对 click 时残留」
      if (menuEl && !menuEl.contains(e.target) && !menuAnchor.contains(e.target)) closeMenu();
      if (confirmEl && !confirmEl.contains(e.target)) {
        closeConfirm();
        swallowItemClick = true;
      }
    });
    document.addEventListener('click', () => {
      swallowItemClick = false;
    });
  }

  global.SuqiComponents = {
    init,
    openMenu,
    closeMenu,
    openConfirm,
    closeConfirm,
    openForm,
    closeForm,
    isFormOpen,
    getTransientState,
    onTransientClosed,
    dismissTop,
    closeAll,
    consumeItemClickSwallow,
    toast,
  };
})(window);
