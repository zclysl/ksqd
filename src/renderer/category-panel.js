// 速启 · category-panel.js —— 分类管理编排（标签「⋯」菜单 / 分类行内输入 / 分类删除确认条）
// 承接自 components.js（6.8 #7）：控件级瞬态与交互编排同域；业务动作经 categoryOps 回调交回 renderer。
// 边界：不发 IPC、不读写业务数据、不做渲染——渲染由 renderer 驱动（renderTabs / renderContent）。
// 加载形态：经典脚本（file:// 下 Chromium 以 CORS 拦截 ES 模块脚本）；依赖 window.SuqiComponents（菜单 / toast）。
(function (global) {
  'use strict';

  const components = window.SuqiComponents;

  let categoryOps = null;
  let categoryEditing = null; // 分类行内输入 { mode:'create' } | { mode:'rename', id }
  let categoryPendingDelete = null; // 分类删除确认条 { id, name, count }

  // renderer 注入：{ renderTabs, renderContent, countApps, createCategory, renameCategory,
  //   deleteCategory, applyCategoryCommit, onCategoryCommitFailed }
  function initCategoryManagement(ops) { categoryOps = ops; }

  const getCategoryEditing = () => categoryEditing;
  const getPendingDelete = () => categoryPendingDelete;

  // 标签「⋯」菜单 / 标签右键等效入口——默认分类仅「重命名…」（删除入口不提供；F2.4）
  function openCategoryMenu(anchorEl, category) {
    const items = [{ label: '重命名…', action: 'rename' }];
    if (category.builtin !== true) items.push({ label: '删除', action: 'delete' });
    components.openMenu(anchorEl, items, (action) => {
      if (action === 'rename') startCategoryEdit({ mode: 'rename', id: category.id });
      else if (action === 'delete') openCategoryDeleteConfirm(category);
    });
  }

  // ---------- 分类行内输入（新建 / 重命名；回车确认、Esc / 失焦取消）----------

  function startCategoryEdit(editing) {
    categoryEditing = editing;
    categoryOps.renderTabs();
  }

  function cancelCategoryEdit() {
    if (!categoryEditing) return;
    categoryEditing = null;
    categoryOps.renderTabs();
  }

  // 输入框事件生命周期（节点由 ui.buildTabBar 构建、渲染后由 renderer 挂接）
  function attachCategoryInput(input) {
    input.addEventListener('keydown', async (e) => {
      if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; } // 4.5 ① 组字态 keydown 不作数（回车选词 / Esc 取消组字不误触提交；stopPropagation 不进 Esc 逐层）
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); await commitCategoryEdit(input); }
      else if (e.key === 'Escape') { e.stopPropagation(); cancelCategoryEdit(); }
    });
    input.addEventListener('blur', () => {
      if (categoryEditing && document.hasFocus()) cancelCategoryEdit(); // 4.5 ② 失焦 = 取消（仅文档持焦时执行；窗口级失焦不误取消）
    });
  }

  // 提交：空名拒绝（toast + 留在输入框）；落库经 categoryOps 交回 renderer
  async function commitCategoryEdit(input) {
    const editing = categoryEditing;
    if (!editing || !input) return;
    const name = input.value.trim();
    if (!name) { components.toast('分类名不能为空', true); input.focus(); return; }
    const res = editing.mode === 'create'
      ? await categoryOps.createCategory(name)
      : await categoryOps.renameCategory({ id: editing.id, name });
    if (!res.ok) {
      if (res.code === 'empty') { components.toast('分类名不能为空', true); input.focus(); }
      else { cancelCategoryEdit(); categoryOps.onCategoryCommitFailed(res.code); }
      return;
    }
    categoryEditing = null;
    categoryOps.applyCategoryCommit(res, { editing }); // 状态应用 / 渲染 / 新分类成为活动标签 / save_failed
  }

  // ---------- 分类删除确认条（内容区顶部）----------

  function openCategoryDeleteConfirm(category) {
    categoryPendingDelete = { id: category.id, name: category.name, count: categoryOps.countApps(category.id) };
    categoryOps.renderContent();
  }

  function cancelCategoryDeleteConfirm() {
    if (!categoryPendingDelete) return;
    categoryPendingDelete = null;
    categoryOps.renderContent();
  }

  // 删除：确认动作经 categoryOps 交回 renderer（状态应用含「删除当前分类 → 切回未分类」）
  async function confirmCategoryDelete() {
    if (!categoryPendingDelete) return;
    const id = categoryPendingDelete.id;
    categoryPendingDelete = null;
    const res = await categoryOps.deleteCategory(id);
    if (!res.ok) {
      categoryOps.renderContent();
      categoryOps.onCategoryCommitFailed(res.code);
      return;
    }
    categoryOps.applyCategoryCommit(res, { deletedCategoryId: id });
  }

  // 确认条事件（节点由 ui.buildConfirmBar 构建、渲染后由 renderer 挂接；
  // 焦点由 renderer.renderContent 在插入后落「删除」，4.20）
  function attachConfirmBar(bar) {
    // 4.20：确认动作只从 click 面产生——焦点 + 原生激活（焦点在「删除」上按 Enter / Space，
    // 由浏览器派发一次 click）；只删一次靠 click 收口幂等（categoryPendingDelete 准入，第二次激活早退）
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'cancel') cancelCategoryDeleteConfirm();
      else if (btn.dataset.action === 'confirm') confirmCategoryDelete();
    });
  }

  // 面板显示时重置（「隐藏即弃临时态」；渲染由 renderer 驱动）
  function resetCategoryUi() {
    categoryEditing = null;
    categoryPendingDelete = null;
  }

  global.SuqiCategoryPanel = {
    initCategoryManagement,
    getCategoryEditing,
    getPendingDelete,
    openCategoryMenu,
    startCategoryEdit,
    cancelCategoryEdit,
    attachCategoryInput,
    openCategoryDeleteConfirm,
    cancelCategoryDeleteConfirm,
    confirmCategoryDelete,
    attachConfirmBar,
    resetCategoryUi,
  };
})(window);
