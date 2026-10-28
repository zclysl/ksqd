// 速启 · renderer —— 会话状态与编排
// 应用级状态（数据副本 / 活动标签）+ 事件绑定 + IPC 调用 + 整面板重渲染；
// 控件级瞬态（菜单 / 行内确认 / 浮层 / toast）在 components.js，分类管理编排在 category-panel.js，
// 条目右键菜单动作面在 item-actions.js，指针交互编排（悬停切标签 / 鼠标离开延迟隐藏 / 拖动排序）在
// interactions.js（拖动核心在 drag-core.js），节点构建在 ui.js。
// 加载形态：经典脚本（file:// 下 Chromium 以 CORS 拦截 ES 模块脚本）。
(function () {
  'use strict';

  const ui = window.SuqiUI;
  const components = window.SuqiComponents;
  const categoryPanel = window.SuqiCategoryPanel;
  const itemActions = window.SuqiItemActions;
  const interactions = window.SuqiInteractions;
  const api = window.api;

  const UNCATEGORIZED = 'uncategorized'; // 「未分类」固定 id

  // ---------- 应用级状态（面板每次显示时临时 UI 重置；数据副本与活动标签保留）----------
  const state = {
    data: { categories: [], apps: [], settings: {} }, // main 返回的状态副本（单一数据源）
    activeCategoryId: UNCATEGORIZED, // 活动标签（会话内状态，不落盘）
    icons: new Map(), // appId -> dataUrl | null（会话内缓存）
    launching: false, // 启动进行中（防连点重复启动）
  };

  const panelEl = document.getElementById('panel');
  const tabbarEl = document.getElementById('tabbar');
  const contentEl = document.getElementById('content');
  const toastEl = document.getElementById('toast');
  const addBtnEl = document.getElementById('btn-add');
  const appIconEl = document.getElementById('app-icon');

  // ---------- 查询与提示 ----------

  const findApp = (id) => state.data.apps.find((a) => a.id === id);
  const findCategory = (id) => state.data.categories.find((c) => c.id === id);
  const appsOf = (categoryId) => state.data.apps.filter((a) => a.categoryId === categoryId);

  // 失败码 → 固定文案（§4.11）；canceled（用户取消）与 rejected（main 侧异常，已留痕）不再提示。
  function toastForCode(code, kind) {
    if (code === 'canceled' || code === 'rejected') return;
    if (code === 'duplicate') components.toast('已存在', true);
    else if (code === 'unsupported') components.toast('仅支持 .exe / .lnk 文件', true);
    else if (code === 'missing') components.toast('文件不存在', true);
    else if (code === 'empty') components.toast(kind === 'category' ? '分类名不能为空' : '软件名不能为空', true);
    else console.warn('速启：未处理的失败码', code);
  }

  // IPC 兜底：main 侧异常（invoke 拒绝）不静默逸出——留痕并给出形状化失败结果，交调用点分支处理
  async function guard(fn) {
    try {
      return await fn();
    } catch (err) {
      console.error('速启：IPC 调用失败', err);
      return { ok: false, code: 'rejected' };
    }
  }

  // 落库成功统一收口：应用新状态 → 整面板重渲染 → 提示（保存失败优先于成功提示）
  function applyMutation(res, okMessage) {
    state.data = res.state;
    renderAll();
    if (res.warning === 'save_failed') components.toast('保存失败', true); // 不打断：状态按内存态应用
    else if (okMessage) components.toast(okMessage);
  }

  // ---------- 渲染 ----------

  function renderAll() {
    if (!findCategory(state.activeCategoryId)) state.activeCategoryId = UNCATEGORIZED;
    components.closeMenu(); // 重渲染后锚点节点失效，收掉浮动层
    components.closeConfirm();
    renderTabs();
    renderContent();
  }

  function renderTabs() {
    tabbarEl.replaceChildren(ui.buildTabBar(state.data.categories, state.activeCategoryId, categoryPanel.getCategoryEditing()));
    const input = tabbarEl.querySelector('.tab-input');
    if (input) {
      categoryPanel.attachCategoryInput(input);
      input.focus();
      if (input.value) input.select();
    } else {
      scrollTabbarTo('.tab.active');
      scrollTabbarTo('.tab-new'); // 4.6 多标签溢出：活动标签与末尾「＋」按钮均可见
    }
  }

  function scrollTabbarTo(selector) {
    const el = tabbarEl.querySelector(selector);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderContent() {
    const nodes = [];
    const pendingDelete = categoryPanel.getPendingDelete();
    if (pendingDelete) {
      const target = findCategory(UNCATEGORIZED); // 迁移目标名取默认分类当前名（4.6 ③）
      const bar = ui.buildConfirmBar(
        `删除分类「${pendingDelete.name}」？其下 ${pendingDelete.count} 个软件将移入${target ? target.name : '未分类'}`,
      );
      categoryPanel.attachConfirmBar(bar);
      nodes.push(bar);
    }
    if (!state.data.apps.length) nodes.push(ui.buildEmptyGuide()); // 全部为空 → 两行引导（F4.4）
    else {
      const apps = appsOf(state.activeCategoryId);
      if (apps.length) {
        const grid = ui.buildGrid(apps, iconFor);
        grid.dataset.catId = state.activeCategoryId; // 拖动记录取来源分类的锚点（4.15：item.closest('[data-cat-id]')）
        nodes.push(grid);
      } else {
        nodes.push(ui.buildEmptyCategory()); // 分类空 → 虚线占位
      }
    }
    contentEl.replaceChildren(...nodes);
    // 4.20：确认条入文档后聚焦「删除」——焦点 + 原生激活（Enter / Space 派发一次 click）
    if (pendingDelete) contentEl.querySelector('.confirm-bar [data-action="confirm"]').focus();
  }

  // 图标：先渲染首字符占位，取到后原位替换；结果缓存于会话内，避免重渲染时重复取用
  function iconFor(app) {
    if (state.icons.has(app.id)) return state.icons.get(app.id);
    state.icons.set(app.id, null);
    api.getIcon(app.id).then((res) => {
      const dataUrl = res && res.dataUrl ? res.dataUrl : null;
      if (!dataUrl) return;
      state.icons.set(app.id, dataUrl);
      ui.setItemIcon(contentEl.querySelector(`.item[data-app-id="${app.id}"]`), dataUrl);
    }).catch(() => {});
    return null;
  }

  // 分类管理落库收口（category-panel 编排动作经回调交回）：状态应用 / 渲染 / save_failed 提示
  // info: { editing }（新建 / 重命名成功）| { deletedCategoryId }（删除成功）
  function applyCategoryCommit(res, info) {
    if (info.editing) {
      const before = new Set(state.data.categories.map((c) => c.id));
      state.data = res.state;
      if (info.editing.mode === 'create') {
        const created = state.data.categories.find((c) => !before.has(c.id));
        if (created) state.activeCategoryId = created.id; // 新分类成为活动标签
      }
      renderAll(); // 滚动保证（活动标签与末尾「＋」按钮可见）随 renderTabs 收口
      if (res.warning === 'save_failed') components.toast('保存失败', true);
      return;
    }
    if (info.deletedCategoryId && state.activeCategoryId === info.deletedCategoryId) {
      state.activeCategoryId = UNCATEGORIZED; // 删除当前分类 → 切回「未分类」
    }
    applyMutation(res, null);
  }

  // ---------- 添加 / 编辑浮层 ----------

  function openAppForm(form) {
    components.openForm({
      mode: form.mode,
      name: form.name,
      path: form.path,
      categoryId: form.categoryId,
      categories: state.data.categories,
      onSubmit: async ({ name, categoryId }) => {
        if (!name) { components.toast('软件名不能为空', true); return true; } // 停留浮层
        const res = form.mode === 'add'
          ? await guard(() => api.createApp({ path: form.path, name, categoryId }))
          : await guard(() => api.updateApp({ id: form.appId, name, categoryId }));
        if (!res.ok) { toastForCode(res.code, 'app'); return true; } // 停留浮层
        state.activeCategoryId = categoryId; // 落库后切到该条目所属分类
        applyMutation(res, form.mode === 'add' ? '已添加' : null);
        return false; // 关闭浮层（由组件执行）
      },
    });
  }

  // ---------- 操作 ----------

  async function launchApp(app) {
    if (state.launching) return;
    state.launching = true;
    try {
      const res = await guard(() => api.launchApp(app.id));
      if (res.ok) api.hidePanel(); // 启动成功即收起面板
      else components.toast(res.message || '启动失败：无法启动该程序', true); // 失败留驻
    } finally {
      state.launching = false;
    }
  }

  async function onAddClick() {
    interactions.setPicking(true); // 4.5 抑制④：「＋」pickApp 在途
    try {
      const res = await guard(() => api.pickApp());
      if (!res.ok) { toastForCode(res.code, 'app'); return; }
      // 「＋ 添加软件」入口：分类默认「未分类」
      openAppForm({ mode: 'add', path: res.path, name: res.defaultName, categoryId: UNCATEGORIZED });
    } finally {
      interactions.setPicking(false); // 对话框关闭 → 抑制解除收尾（4.5）
    }
  }

  async function handleDroppedFile(file) {
    let path = '';
    try { path = api.getDroppedFilePath(file) || ''; }
    catch (err) { console.warn('速启：拖拽取路径失败', err); }
    const res = await guard(() => api.validateDroppedPath(path));
    if (!res.ok) { toastForCode(res.code, 'app'); return; }
    // 拖拽入口：分类预选 = 当前活动标签对应分类
    openAppForm({ mode: 'add', path, name: res.defaultName, categoryId: state.activeCategoryId });
  }

  function switchCategory(id) {
    if (!findCategory(id)) return;
    if (id === state.activeCategoryId) {
      components.closeMenu(); // 点活动标签本体时也收起其「⋯」菜单
      scrollTabbarTo('.tab.active');
      return;
    }
    state.activeCategoryId = id;
    renderAll();
  }

  // 拖动落位（4.15）：同分类重排 / 跨分类移动落库（categoryId = 目标分类）；
  // 跨分类移动成功 → 活动标签切到目标分类（结果可见）；失败（missing / invalid）toast 并保留旧顺序与旧分类
  async function onReorderDrop({ id, categoryId, toIndex, sourceCategoryId }) {
    const res = await guard(() => api.reorderApp({ id, categoryId, toIndex }));
    if (res.ok) {
      if (categoryId !== sourceCategoryId) state.activeCategoryId = categoryId; // 跨分类移动 → 活动标签切到目标分类
      applyMutation(res, null); // save_failed → warning 语义（3.1）：内存态生效 + toast「保存失败」
      return true;
    }
    toastForCode(res.code, 'app');
    return false;
  }

  // 分类拖动落位（F2.7 / 4.18）：categories 数组重排落库；
  // 失败（builtin / missing / invalid）保留旧顺序——4.11 固定文案表无 reorder 专属文案，不发明文案，仅 console 留痕
  async function onCategoryReorder({ id, toIndex }) {
    const res = await guard(() => api.reorderCategory({ id, toIndex }));
    if (!res.ok) {
      console.warn('速启：分类重排被拒绝', res.code);
      return false;
    }
    applyMutation(res, null); // save_failed → warning 语义（3.1）：内存态生效 + toast「保存失败」
    return true;
  }

  // ---------- 事件绑定 ----------

  function bindEvents() {
    addBtnEl.addEventListener('click', onAddClick);

    tabbarEl.addEventListener('click', (e) => {
      if (interactions.consumeClickSwallow()) return; // 拖动排序吞掉拖后那次标签点击（4.18，与条目点击同口径）
      if (categoryPanel.getCategoryEditing()) return; // 行内输入期间忽略标签操作
      const menuBtn = e.target.closest('.tab-menu-btn');
      if (menuBtn) {
        const tabEl = menuBtn.closest('.tab');
        const category = findCategory(tabEl.dataset.catId);
        if (category) categoryPanel.openCategoryMenu(tabEl, category);
        return;
      }
      if (e.target.closest('.tab-new')) {
        categoryPanel.startCategoryEdit({ mode: 'create' });
        return;
      }
      const tabEl = e.target.closest('.tab');
      if (tabEl) switchCategory(tabEl.dataset.catId);
    });

    // 标签右键 = 「⋯」按钮等效入口（默认分类同样开放；菜单项构成见 category-panel.openCategoryMenu）
    tabbarEl.addEventListener('contextmenu', (e) => {
      const tabEl = e.target.closest('.tab');
      if (!tabEl) return;
      e.preventDefault();
      const category = findCategory(tabEl.dataset.catId);
      if (category) categoryPanel.openCategoryMenu(tabEl, category);
    });

    // 标签栏溢出：滚轮映射为横向滚动
    tabbarEl.addEventListener('wheel', (e) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      tabbarEl.scrollLeft += e.deltaY;
    }, { passive: false });

    contentEl.addEventListener('click', (e) => {
      if (interactions.consumeClickSwallow()) return; // 拖动排序吞掉拖后那次点击（4.15）
      if (components.consumeItemClickSwallow()) return; // 行内确认被点掉的那次点击不触发条目动作
      components.closeMenu(); // 点中菜单锚点条目本身时也收起菜单
      const itemEl = e.target.closest('.item');
      if (!itemEl) return;
      const app = findApp(itemEl.dataset.appId);
      if (app) launchApp(app); // 单击启动：成功即收起、失败留驻
    });

    contentEl.addEventListener('contextmenu', (e) => {
      if (interactions.isReordering()) return; // 拖动态下不打开条目菜单（右键与拖动互斥，4.15）
      const itemEl = e.target.closest('.item');
      if (!itemEl) return;
      e.preventDefault();
      const app = findApp(itemEl.dataset.appId);
      if (app) itemActions.openItemMenu(itemEl, app);
    });

    // 拖拽：取第一个文件送校验；多文件仅提示一次
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault(); // 防拖拽触发页面导航
      if (components.isFormOpen()) return; // 浮层打开中忽略新的拖入
      const files = e.dataTransfer ? e.dataTransfer.files : null;
      if (!files || files.length === 0) return;
      if (files.length > 1) components.toast('本次仅添加 1 个');
      handleDroppedFile(files[0]);
    });

    // 4.5 例外④：面板根捕获组字事件（自面板内任意文本输入冒泡）→ 组字态通报（IPC #17）
    panelEl.addEventListener('compositionstart', () => api.setComposing(true));
    panelEl.addEventListener('compositionend', () => api.setComposing(false));

    // Esc 逐层：浮层 / 菜单 / 行内确认 → 分类行内输入 → 删除确认条 → 隐藏面板
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (components.dismissTop()) return;
      if (categoryPanel.getCategoryEditing()) categoryPanel.cancelCategoryEdit();
      else if (categoryPanel.getPendingDelete()) categoryPanel.cancelCategoryDeleteConfirm();
      else api.hidePanel();
    });
  }

  // ---------- 面板显示 / 初始化 ----------

  // 面板每次显示：重置临时 UI（浮层 / 菜单 / 行内确认 / 分类行内输入 / 删除确认条 / toast / 滚动位置）
  function onPanelShown() {
    components.closeAll();
    categoryPanel.resetCategoryUi();
    interactions.onPanelShown(); // 4.5「鼠标已进入」标记重置 + 计时清理
    contentEl.scrollTop = 0;
    renderAll();
    panelEl.classList.remove('is-showing'); // 重放显示动画（120ms）
    void panelEl.offsetWidth;
    panelEl.classList.add('is-showing');
  }

  async function init() {
    bindEvents();
    components.init({ panelEl, toastEl });
    // 分类管理编排（category-panel.js）：业务动作经回调交回（6.8 #7）
    categoryPanel.initCategoryManagement({
      renderTabs,
      renderContent,
      countApps: (categoryId) => appsOf(categoryId).length,
      createCategory: (name) => guard(() => api.createCategory(name)),
      renameCategory: (payload) => guard(() => api.renameCategory(payload)),
      deleteCategory: (id) => guard(() => api.deleteCategory(id)),
      applyCategoryCommit,
      onCategoryCommitFailed: (code) => toastForCode(code, 'category'),
    });
    // 条目右键菜单动作面（item-actions.js）：表单 / IPC 兜底 / 落库收口经回调交回（6.8 #8）
    itemActions.init({ openAppForm, guard, applyMutation });
    // 指针交互编排（interactions.js）：切换复用 switchCategory、隐藏走 api.hidePanel、
    // reorder 落库在 onReorderDrop / onCategoryReorder
    interactions.init({
      panelEl,
      tabbarEl,
      contentEl,
      getActiveCategoryId: () => state.activeCategoryId,
      countApps: (categoryId) => appsOf(categoryId).length, // 标签落点 toIndex 用（4.15）
      switchCategory,
      onHidePanel: () => api.hidePanel(),
      onReorder: onReorderDrop,
      onCategoryReorder, // 分类拖动落位（4.18）
    });
    api.onPanelShown(onPanelShown);
    try {
      const loaded = await api.loadState();
      if (loaded && Array.isArray(loaded.categories) && Array.isArray(loaded.apps)) state.data = loaded;
    } catch (err) {
      console.error('速启：状态加载失败', err);
    }
    // 顶栏图标（F7.3 / 4.17）：启动时取一次写入 src 并显示；取不到保持隐藏（不占位、不留破图）
    api.getAppIcon().then((res) => {
      const dataUrl = res && res.dataUrl ? res.dataUrl : null;
      if (!dataUrl) return;
      appIconEl.src = dataUrl;
      appIconEl.classList.add('visible');
    }).catch(() => {});
    renderAll();
  }

  init();
})();
