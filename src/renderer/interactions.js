// 速启 · interactions.js —— 面板指针交互编排（F2.6 悬停切标签 / F1.6 鼠标离开延迟隐藏 /
// F3.8 条目拖动排序与跨分类移动 / F2.7 分类拖动排序）
// 职责：三机制的计时、抑制标记与拖动编排；业务动作（切换 / 隐藏 / 重排落库）经回调交回 renderer。
// 拖动核心（4px 阈值 / pointer capture / clone 影构造与随光标 / 落位矩形命中 / 归位动画）在 drag-core.js，
// 4.15 与 4.18 共用同一实现（6.8 #12）；「排序中」标记与两条抑制判定仍留本文件单点。
// 抑制判定读 window.SuqiComponents 的统一打开态（4.5 抑制②「按 components.js 打开态统一判定」）
// 与 window.SuqiCategoryPanel 的分类行内输入态。
// 加载形态：经典脚本（file:// 下 Chromium 以 CORS 拦截 ES 模块脚本）。
(function (global) {
  'use strict';

  const components = window.SuqiComponents;
  const categoryPanel = window.SuqiCategoryPanel;
  const core = window.SuqiDragCore;

  const HOVER_SWITCH_MS = 200; // 4.6 悬停切换迟滞（快速扫过多个标签不切换）
  const LEAVE_HIDE_MS = 300; // 4.5 鼠标离开延迟隐藏（移回取消）
  const FALSE_LEAVE_INSET_PX = 4; // 4.5 假移出复核内缩（严格内部 = 假移出；与 pointerOutside 原矩形容差不同，不合并）
  const UNCATEGORIZED_ID = 'uncategorized'; // 「未分类」固定 id（4.10：恒首位、不可拖，4.18）

  let opts = null; // { panelEl, tabbarEl, contentEl, getActiveCategoryId, countApps,
  //   switchCategory, onHidePanel, onReorder, onCategoryReorder }
  let hideTimer = null;
  let hoverTimer = null;
  let hoverTab = null;

  // ---------- 抑制标记（4.5 四项 / 4.6 枚举读取）----------
  let entered = false; // 「鼠标已进入」标记（4.5 进入标记；panel:shown 重置）
  let reordering = false; // 「排序中」标记（4.15 条目 / 4.18 分类共用；供 F1.6 抑制③ 与 F2.6 抑制读取）
  let dropping = false; // 「拖入中」标记（外部拖入；4.6 待实测点 12 回退形态）
  let picking = false; // 「＋」pickApp 在途（4.5 抑制④ 原生文件对话框）
  let pointer = null; // 最后指针位置（client 坐标；抑制解除收尾判定「指针在面板外」）
  let pointerFresh = true; // 指针坐标是否可信（文件对话框期间无事件 → 冻结）
  let releasePending = false; // 抑制解除时坐标冻结 → 首个指针事件到达后补判（4.5 收尾）
  let clickSwallow = false; // 拖动态吞掉随后那次点击（4.15 / 4.18）
  let drag = null; // 当前拖动记录（同一次 pointerdown 只建一个：条目 / 分类二选一，4.18）

  // ---------- 抑制判定 ----------

  // 鼠标离开路径的抑制（4.5 抑制四项，不扩不缩）：① 唤出后鼠标从未进入；② 浮层或面板内菜单打开中（含行内确认）；
  // ③ 拖动排序中（条目 4.15 / 分类 4.18）；④ 原生文件对话框打开中。
  function leaveSuppressed() {
    if (!entered) return true; // ①
    const t = components.getTransientState();
    return t.form || t.menu || t.confirm || reordering || picking; // ② / ③ / ④
  }

  // 悬停切换路径的抑制（4.6）：拖动排序中 / 分类行内输入中 / 浮层或行内确认打开中 / 外部拖入中；
  // 面板内菜单不抑制——到点先收菜单再切换（4.6 触发语义）。
  function hoverSuppressed() {
    const t = components.getTransientState();
    return reordering || dropping || Boolean(categoryPanel.getCategoryEditing()) || t.form || t.confirm;
  }

  function pointerOutside() {
    if (!pointer) return true;
    const r = opts.panelEl.getBoundingClientRect();
    return pointer.x < r.left || pointer.x > r.right || pointer.y < r.top || pointer.y > r.bottom;
  }

  // 假移出复核（4.5，v1.3.1）：mouseleave 事件坐标深在面板卡内（getBoundingClientRect 内缩 4px 严格内部）
  // = 覆盖窗（IME 候选窗等）抢占命中测试造成的假移出 → 不起计；卡外或贴边 = 真移出。
  function isFalseLeave(x, y) {
    const r = opts.panelEl.getBoundingClientRect();
    return x > r.left + FALSE_LEAVE_INSET_PX && x < r.right - FALSE_LEAVE_INSET_PX
      && y > r.top + FALSE_LEAVE_INSET_PX && y < r.bottom - FALSE_LEAVE_INSET_PX;
  }

  // 抑制解除收尾（4.5）：任一抑制结束（拖动结束含取消 / 原生文件对话框关闭 / 浮层与行内确认关闭）
  // 且指针已在面板外 → 补起 300ms 隐藏计时（到点隐藏、延迟内移回取消）；不依赖补发 mouseleave。
  function onSuppressionReleased() {
    if (!entered || !pointerOutside()) return;
    if (leaveSuppressed()) return;
    startHideTimer();
  }

  // ---------- 鼠标离开延迟隐藏（F1.6 / 4.5）----------

  function startHideTimer() {
    clearHideTimer();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (leaveSuppressed()) return; // 抑制期到点不隐藏；抑制解除时由收尾补起
      opts.onHidePanel(); // 到点隐藏（api.hidePanel）
    }, LEAVE_HIDE_MS);
  }

  function clearHideTimer() {
    if (!hideTimer) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  // ---------- 悬停切换标签（F2.6 / 4.6）----------

  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hoverTab = null;
  }

  function onTabHover(tab) {
    if (tab === hoverTab) return;
    clearHoverTimer();
    const catId = tab.dataset.catId;
    // 抑制中不落 hoverTab：抑制解除后同一标签的后续 mouseover 重新起计（不吞掉本次悬停意图）
    if (!catId || catId === opts.getActiveCategoryId() || hoverSuppressed()) return;
    hoverTab = tab;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      hoverTab = null;
      if (hoverSuppressed()) return; // 到点仍处抑制 → 不切换
      if (catId === opts.getActiveCategoryId()) return;
      components.closeMenu(); // 到点先收面板内菜单（点外收起语义）再切换
      opts.switchCategory(catId); // 复用点击路径同一函数
    }, HOVER_SWITCH_MS);
  }

  // ---------- 拖动排序（F3.8 / 4.15 条目、F2.7 / 4.18 分类；pointer 事件自绘）----------

  // 进入拖动态：核心建影 + 置「排序中」标记（两处拖动共用同一个 reordering，4.18）
  function beginDrag(d) {
    core.activate(d.session);
    reordering = true; // 「排序中」标记（4.15 / 4.18）：F1.6 抑制③ 与 F2.6 抑制读它
    opts.panelEl.classList.add('is-reordering'); // 光标 grabbing（十二节）
  }

  // 占位随光标落点在网格内滑动预览插入位置（4.15）；网格外不动占位
  function previewDrop(d, x, y) {
    const item = d.session.node;
    const grid = opts.contentEl.querySelector('.grid');
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const items = [...grid.querySelectorAll('.item')].filter((el) => el !== item);
    let index = 0;
    for (const el of items) {
      const r = el.getBoundingClientRect();
      const inRow = y >= r.top && y < r.bottom;
      const before = inRow ? x >= r.left + r.width / 2 : r.top + r.height / 2 < y;
      if (!before) break;
      index += 1;
    }
    const ref = items[index] || null;
    if (item.parentNode === grid && item.nextSibling === ref) return; // 位置不变
    grid.insertBefore(item, ref);
  }

  // 取消 / 失败：占位移回原位（顺序不变；无 IPC 的取消路径不经重渲染）
  function restorePreview(d) {
    if (d.kind !== 'item') return; // 分类拖动无原位预览（落位在松手时按左右半判定，4.18）
    const grid = opts.contentEl.querySelector('.grid');
    if (!grid) return;
    const item = d.session.node;
    if (d.session.next && d.session.next.parentNode === grid) grid.insertBefore(item, d.session.next);
    else grid.appendChild(item);
  }

  // 拖动结束复位（含取消）：「排序中」标记复位 + 抑制解除收尾（4.15 / 4.18）
  function endReordering() {
    reordering = false;
    opts.panelEl.classList.remove('is-reordering');
    onSuppressionReleased();
  }

  function onPointerUp(e) {
    const d = drag;
    if (!d || e.pointerId !== d.session.pointerId) return;
    drag = null;
    if (!d.session.active) return; // 未超阈值松手 = 普通单击（启动 / 切标签 / 开菜单不变）
    e.preventDefault();
    clickSwallow = true; // 拖动态吞 click（4.15 / 4.18）
    const payload = d.kind === 'category' ? categoryDropPayload(d, e) : dropPayload(d, e); // null = 取消
    const finalRect = d.session.node.getBoundingClientRect(); // 占位最终槽位（落位动画目标）
    endReordering();
    if (!payload) {
      // 落点无效（顶栏 / 标签栏空白 / 「＋」区 / 空态占位 / 面板外松手）→ 取消：顺序与分类均不变、无 IPC
      restorePreview(d);
      core.settle(d.session, d.session.startRect);
      return;
    }
    // 有效落点 → 重排 / 跨分类移动落库（动作经回调交回 renderer）；失败（missing / invalid）保留旧顺序与旧分类
    const apply = d.kind === 'category' ? opts.onCategoryReorder : opts.onReorder;
    Promise.resolve(apply(payload)).then((applied) => {
      if (!applied) restorePreview(d);
      core.settle(d.session, applied ? finalRect : d.session.startRect);
    }).catch(() => {
      restorePreview(d);
      core.settle(d.session, d.session.startRect);
    });
  }

  // 条目三级落点判定（4.15，自上而下）：① 分类标签矩形 → 移入该分类；② 内容区网格 → 同分类重排；
  // ③ 其余（顶栏 / 标签栏空白 / 「＋」区 / 空态占位 / 面板外）→ 取消（null）。
  // 只读标签矩形与 data-cat-id、不调 switchCategory —— 拖动中经过标签栏不切标签（4.15）。
  function dropPayload(d, e) {
    const sourceCategoryId = d.sourceCategoryId ?? opts.getActiveCategoryId(); // 等价来源兜底（4.15）
    const hit = core.hitRects(opts.tabbarEl.querySelectorAll('.tab'), e.clientX, e.clientY); // ① 标签矩形命中
    if (hit) {
      const categoryId = hit.element.dataset.catId;
      if (!categoryId) return null; // 无分类锚点的标签（防御）→ 按无效落点取消
      const count = opts.countApps(categoryId);
      // 落位序位送值（父侧裁定）：自己所在分类 → 条目数-1（落末尾）；他类 → 该分类当前条目数（追加末尾，空分类即 0）
      return { id: d.id, categoryId, toIndex: categoryId === sourceCategoryId ? count - 1 : count, sourceCategoryId };
    }
    const grid = opts.contentEl.querySelector('.grid'); // ② 网格内 → 同分类重排
    const rect = grid ? grid.getBoundingClientRect() : null;
    const inside = Boolean(rect) && e.clientX >= rect.left && e.clientX <= rect.right
      && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) return null; // ③
    return {
      id: d.id,
      categoryId: opts.getActiveCategoryId(),
      toIndex: [...grid.querySelectorAll('.item')].indexOf(d.session.node), // 占位最终序位（4.15）
      sourceCategoryId,
    };
  }

  // 分类落位（4.18）：目标标签矩形 → 左右半决定前插 / 后插；自身 / 空白处 / 「＋」/ 面板外 → 取消（null，无 IPC）。
  // 下标换算（j = 被拖标签现下标、i = 目标标签下标）：目标在 rest 中的下标 = i - (j < i ? 1 : 0)；
  // 落左半 → 送该值、落右半 → 送该值 + 1；目标为「未分类」→ 恒送 1（恒首位、不得后移，十节 #73）。
  function categoryDropPayload(d, e) {
    const tabs = [...opts.tabbarEl.querySelectorAll('.tab')];
    const hit = core.hitRects(tabs, e.clientX, e.clientY);
    if (!hit) return null;
    const target = hit.element;
    const targetId = target.dataset.catId;
    if (!targetId) return null;
    if (target === d.session.node) return null; // 落点是被拖标签自身 → 无操作
    if (targetId === UNCATEGORIZED_ID) return { id: d.id, toIndex: 1 };
    const j = tabs.indexOf(d.session.node);
    const i = tabs.indexOf(target);
    const restIndex = i - (j < i ? 1 : 0);
    return { id: d.id, toIndex: hit.half === 'left' ? restIndex : restIndex + 1 };
  }

  function cancelDrag() {
    const d = drag;
    drag = null;
    if (!d || !d.session.active) return;
    clickSwallow = true;
    restorePreview(d);
    core.settle(d.session, d.session.startRect);
    endReordering();
  }

  // ---------- 初始化与事件绑定 ----------

  function init(options) {
    opts = options;
    const { panelEl, tabbarEl, contentEl } = opts;

    // 鼠标离开 / 进入（F1.6）：mouseleave 起计、mouseenter 或面板内 mousemove 取消并置「鼠标已进入」
    panelEl.addEventListener('mouseenter', () => {
      entered = true;
      clearHideTimer();
    });
    panelEl.addEventListener('mouseleave', (e) => {
      if (isFalseLeave(e.clientX, e.clientY)) return; // 假移出复核（4.5）：覆盖窗抢占命中测试 → 不起计
      if (leaveSuppressed()) return; // ①②③④ 任一成立 → 不启动计时
      startHideTimer();
    });
    panelEl.addEventListener('mousemove', () => {
      entered = true; // 双挂点兜底（十三节实测点 11）
      clearHideTimer(); // 移回取消
    }, { passive: true });

    // 悬停切标签（F2.6）：标签栏委托（标签随重渲染重建，委托免重复挂接）
    tabbarEl.addEventListener('mouseover', (e) => {
      const tab = e.target.closest('.tab');
      if (tab) onTabHover(tab);
    });
    tabbarEl.addEventListener('mouseout', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab || tab !== hoverTab) return;
      if (e.relatedTarget && tab.contains(e.relatedTarget)) return; // 标签内移动不取消
      clearHoverTimer(); // 离开标签取消；移到另一标签重新起计
    });

    // 条目拖动排序（F3.8 / 4.15）：pointerdown 记起点，移动超阈值进拖动态
    contentEl.addEventListener('pointerdown', (e) => {
      clickSwallow = false; // 每次按下重新起算（拖动取消路径不再吞后续单击）
      if (e.button !== 0 || drag) return;
      const item = e.target.closest('.item');
      if (!item) return;
      drag = {
        kind: 'item',
        session: core.createSession({ node: item, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY }),
        id: item.dataset.appId,
        sourceCategoryId: item.closest('[data-cat-id]')?.dataset.catId ?? null, // 来源分类（4.15：落点分类 = 来源分类 → 同分类重排语义）
      };
      pointer = { x: e.clientX, y: e.clientY };
    });

    // 分类拖动排序（F2.7 / 4.18）：tabbarEl 上 pointerdown 记起点——排除「⋯」菜单按钮与「未分类」（不可拖）；
    // 分类行内输入期间忽略标签操作（4.6 既有规则）。
    tabbarEl.addEventListener('pointerdown', (e) => {
      clickSwallow = false;
      if (e.button !== 0 || drag) return;
      if (categoryPanel.getCategoryEditing()) return;
      if (e.target.closest('.tab-menu-btn')) return;
      const tab = e.target.closest('.tab');
      if (!tab || !tab.dataset.catId) return;
      if (tab.dataset.catId === UNCATEGORIZED_ID) return; // 「未分类」拖不动（F2.4 恒首位；无 clone 影）
      drag = {
        kind: 'category',
        session: core.createSession({ node: tab, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY }),
        id: tab.dataset.catId,
      };
      pointer = { x: e.clientX, y: e.clientY };
    });

    document.addEventListener('pointermove', (e) => {
      const d = drag;
      if (!d || e.pointerId !== d.session.pointerId) return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!d.session.active) {
        if (!core.exceedsThreshold(d.session, e.clientX, e.clientY)) return;
        beginDrag(d);
      }
      core.follow(d.session, e.clientX, e.clientY);
      if (d.kind === 'item') previewDrop(d, e.clientX, e.clientY);
    });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('blur', cancelDrag); // 拖动中窗口 blur → 取消（防御，4.15 / 4.18）

    // 最后指针位置（抑制解除收尾判定「指针在面板外」）；坐标冻结解除后补判收尾；
    // 首个鼠标事件亦是「拖入中」标记的兜底复位（见下）
    document.addEventListener('mousemove', (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      pointerFresh = true;
      dropping = false;
      if (releasePending) {
        releasePending = false;
        onSuppressionReleased();
      }
    }, { passive: true });

    // 外部 .exe / .lnk 拖入的「拖入中」标记（4.6；待实测点 12 回退形态：dragover 置位、drop / dragend 复位）。
    // 外部拖入的 dragend 只送达拖出方、drop 仅在落进本窗时送达 → 补两处复位闭合「拖入中断后标记残留」：
    // 首个 mousemove（HTML5 拖放期间不产生鼠标事件，出现鼠标事件即拖放已结束）与 panel:shown 清理。
    document.addEventListener('dragover', () => { dropping = true; }, { passive: true });
    document.addEventListener('drop', () => { dropping = false; });
    document.addEventListener('dragend', () => { dropping = false; });

    // 浮层 / 菜单 / 行内确认关闭 = 抑制解除事件 → 收尾（4.5）
    components.onTransientClosed(onSuppressionReleased);
  }

  // 面板每次显示（panel:shown）：「鼠标已进入」标记重置 + 计时清理
  function onPanelShown() {
    entered = false;
    dropping = false;
    clearHideTimer();
    clearHoverTimer();
    cancelDrag();
    clickSwallow = false;
    releasePending = false;
    pointerFresh = true;
  }

  // 4.5 抑制④：「＋」pickApp 在途（renderer 在文件对话框前后置位 / 复位）。
  // 对话框期间页面收不到指针事件（坐标冻结）→ 关闭时若坐标不可信，收尾判定推迟到首个指针事件补判。
  function setPicking(active) {
    if (active) {
      picking = true;
      pointerFresh = false;
      return;
    }
    picking = false;
    if (pointerFresh) onSuppressionReleased(); // 对话框关闭 → 抑制解除收尾（4.5）
    else releasePending = true;
  }

  // 拖动态吞 click 的消费口（renderer 条目点击 / 标签点击前置问，4.15 / 4.18）
  function consumeClickSwallow() {
    const swallow = clickSwallow;
    clickSwallow = false;
    return swallow;
  }

  function isReordering() {
    return reordering;
  }

  global.SuqiInteractions = {
    init,
    onPanelShown,
    setPicking,
    consumeClickSwallow,
    isReordering,
  };
})(window);
