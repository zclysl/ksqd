// 速启 · interactions.js —— 面板指针交互编排（F2.6 悬停切标签 / F1.6 鼠标离开延迟隐藏 / F3.8 拖动排序与跨分类移动）
// 职责：三机制的计时、抑制标记与拖动预览；业务动作（切换 / 隐藏 / 重排落库）经回调交回 renderer。
// 抑制判定读 window.SuqiComponents 的统一打开态（4.5 抑制②「按 components.js 打开态统一判定」）。
// 加载形态：经典脚本（file:// 下 Chromium 以 CORS 拦截 ES 模块脚本）。
(function (global) {
  'use strict';

  const components = window.SuqiComponents;

  const HOVER_SWITCH_MS = 200; // 4.6 悬停切换迟滞（快速扫过多个标签不切换）
  const LEAVE_HIDE_MS = 300; // 4.5 鼠标离开延迟隐藏（移回取消）
  const DRAG_THRESHOLD_PX = 4; // 4.15 阈值区分单击 / 拖动（十二节）
  const FALSE_LEAVE_INSET_PX = 4; // 4.5 假移出复核内缩（严格内部 = 假移出；与 pointerOutside 原矩形容差不同，不合并）
  const RETURN_MS = 120; // 十二节 落位 / 取消归位动画（沿显示动画节奏）

  let opts = null; // { panelEl, tabbarEl, contentEl, getActiveCategoryId, countApps, switchCategory, onHidePanel, onReorder }
  let hideTimer = null;
  let hoverTimer = null;
  let hoverTab = null;

  // ---------- 抑制标记（4.5 四项 / 4.6 枚举读取）----------
  let entered = false; // 「鼠标已进入」标记（4.5 进入标记；panel:shown 重置）
  let reordering = false; // 「排序中」标记（4.15；供 F1.6 抑制③ 与 F2.6 抑制读取）
  let dropping = false; // 「拖入中」标记（外部拖入；4.6 待实测点 12 回退形态）
  let picking = false; // 「＋」pickApp 在途（4.5 抑制④ 原生文件对话框）
  let pointer = null; // 最后指针位置（client 坐标；抑制解除收尾判定「指针在面板外」）
  let pointerFresh = true; // 指针坐标是否可信（文件对话框期间无事件 → 冻结）
  let releasePending = false; // 抑制解除时坐标冻结 → 首个指针事件到达后补判（4.5 收尾）
  let clickSwallow = false; // 拖动态吞掉随后那次条目点击（4.15）
  let drag = null;

  // ---------- 抑制判定 ----------

  // 鼠标离开路径的抑制（4.5 抑制四项，不扩不缩）：① 唤出后鼠标从未进入；② 浮层或面板内菜单打开中（含行内确认）；
  // ③ 条目拖动排序中；④ 原生文件对话框打开中。
  function leaveSuppressed() {
    if (!entered) return true; // ①
    const t = components.getTransientState();
    return t.form || t.menu || t.confirm || reordering || picking; // ② / ③ / ④
  }

  // 悬停切换路径的抑制（4.6）：拖动排序中 / 分类行内输入中 / 浮层或行内确认打开中 / 外部拖入中；
  // 面板内菜单不抑制——到点先收菜单再切换（4.6 触发语义）。
  function hoverSuppressed() {
    const t = components.getTransientState();
    return reordering || dropping || Boolean(components.getCategoryEditing()) || t.form || t.confirm;
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

  // ---------- 拖动排序（F3.8 / 4.15，pointer 事件自绘）----------

  function beginDrag(e) {
    const d = drag;
    const item = d.item;
    const rect = item.getBoundingClientRect();
    d.active = true;
    d.startRect = rect;
    d.grabX = d.startX - rect.left;
    d.grabY = d.startY - rect.top;
    item.classList.add('is-dragging'); // 原位节点 = 半透明占位（十二节）
    const ghost = item.cloneNode(true);
    ghost.classList.remove('is-dragging'); // 半透明占位只留原位节点；clone 影为实卡（十二节）
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${Math.round(rect.width)}px`;
    ghost.style.height = `${Math.round(rect.height)}px`;
    ghost.style.left = `${e.clientX - d.grabX}px`;
    ghost.style.top = `${e.clientY - d.grabY}px`;
    document.body.appendChild(ghost);
    d.ghost = ghost;
    reordering = true; // 「排序中」标记（4.15）
    opts.panelEl.classList.add('is-reordering'); // 光标 grabbing（十二节）
    try {
      item.setPointerCapture(d.pointerId); // 面板外松手的事件送达（十三节实测点 10）
    } catch (err) {
      // 捕获不可用 → 窗口 blur 兜底取消（语义不变）
    }
  }

  // 占位随光标落点在网格内滑动预览插入位置（4.15）；网格外不动占位
  function previewDrop(x, y) {
    const grid = opts.contentEl.querySelector('.grid');
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const items = [...grid.querySelectorAll('.item')].filter((el) => el !== drag.item);
    let index = 0;
    for (const el of items) {
      const r = el.getBoundingClientRect();
      const inRow = y >= r.top && y < r.bottom;
      const before = inRow ? x >= r.left + r.width / 2 : r.top + r.height / 2 < y;
      if (!before) break;
      index += 1;
    }
    const ref = items[index] || null;
    if (drag.item.parentNode === grid && drag.item.nextSibling === ref) return; // 位置不变
    grid.insertBefore(drag.item, ref);
  }

  // 取消 / 失败：占位移回原位（顺序不变；无 IPC 的取消路径不经重渲染）
  function restorePreview(d) {
    const grid = opts.contentEl.querySelector('.grid');
    if (!grid) return;
    if (d.next && d.next.parentNode === grid) grid.insertBefore(d.item, d.next);
    else grid.appendChild(d.item);
  }

  // 落位 / 取消归位动画（十二节 120ms）：clone 影回到槽位后清理
  function settleGhost(d, target) {
    const ghost = d.ghost;
    if (!ghost) return;
    ghost.style.transition = `left ${RETURN_MS}ms ease-out, top ${RETURN_MS}ms ease-out, opacity ${RETURN_MS}ms ease-out`;
    ghost.style.left = `${target.left}px`;
    ghost.style.top = `${target.top}px`;
    ghost.style.opacity = '0';
    setTimeout(() => {
      ghost.remove();
      d.item.classList.remove('is-dragging'); // 成功路径该节点已被重渲染替换，此处为空操作
    }, RETURN_MS + 10);
  }

  // 拖动结束复位（含取消）：「排序中」标记复位 + 抑制解除收尾（4.15）
  function endReordering() {
    reordering = false;
    opts.panelEl.classList.remove('is-reordering');
    onSuppressionReleased();
  }

  function onPointerUp(e) {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    drag = null;
    if (!d.active) return; // 未超阈值松手 = 普通单击（启动路径不变）
    e.preventDefault();
    clickSwallow = true; // 拖动态吞 click（4.15）
    const payload = dropPayload(d, e); // 三级落点判定（4.15）；null = 取消
    const finalRect = d.item.getBoundingClientRect(); // 占位最终槽位（落位动画目标）
    endReordering();
    if (!payload) {
      // 落点无效（顶栏 / 标签栏空白 / 「＋」区 / 空态占位 / 面板外松手）→ 取消：顺序与分类均不变、无 IPC
      restorePreview(d);
      settleGhost(d, d.startRect);
      return;
    }
    // 有效落点 → 重排 / 跨分类移动落库（动作经回调交回 renderer）；失败（missing / invalid）保留旧顺序与旧分类
    Promise.resolve(opts.onReorder(payload)).then((applied) => {
      if (!applied) restorePreview(d);
      settleGhost(d, applied ? finalRect : d.startRect);
    }).catch(() => {
      restorePreview(d);
      settleGhost(d, d.startRect);
    });
  }

  // 三级落点判定（4.15，自上而下）：① 分类标签矩形 → 移入该分类；② 内容区网格 → 同分类重排；
  // ③ 其余（顶栏 / 标签栏空白 / 「＋」区 / 空态占位 / 面板外）→ 取消（null）。
  // 只读标签矩形与 data-cat-id、不调 switchCategory —— 拖动中经过标签栏不切标签（4.15）。
  function dropPayload(d, e) {
    const sourceCategoryId = d.sourceCategoryId ?? opts.getActiveCategoryId(); // 等价来源兜底（4.15）
    for (const tab of opts.tabbarEl.querySelectorAll('.tab')) { // ① 标签矩形命中（横向滚动下仍是视口坐标）
      const r = tab.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
      if (!tab.dataset.catId) break; // 无分类锚点的标签（防御）→ 按无效落点取消
      const categoryId = tab.dataset.catId;
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
      toIndex: [...grid.querySelectorAll('.item')].indexOf(d.item), // 占位最终序位（4.15）
      sourceCategoryId,
    };
  }

  function cancelDrag() {
    const d = drag;
    drag = null;
    if (!d || !d.active) return;
    clickSwallow = true;
    restorePreview(d);
    settleGhost(d, d.startRect);
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

    // 拖动排序（F3.8）：pointerdown 记起点，移动超阈值进拖动态
    contentEl.addEventListener('pointerdown', (e) => {
      clickSwallow = false; // 每次按下重新起算（拖动取消路径不再吞后续单击）
      if (e.button !== 0 || drag) return;
      const item = e.target.closest('.item');
      if (!item) return;
      drag = {
        item,
        id: item.dataset.appId,
        sourceCategoryId: item.closest('[data-cat-id]')?.dataset.catId ?? null, // 来源分类（4.15：落点分类 = 来源分类 → 同分类重排语义）
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        next: item.nextSibling, // 取消归位锚点
        active: false,
      };
      pointer = { x: e.clientX, y: e.clientY };
    });
    document.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= DRAG_THRESHOLD_PX) return;
        beginDrag(e);
      }
      drag.ghost.style.left = `${e.clientX - drag.grabX}px`;
      drag.ghost.style.top = `${e.clientY - drag.grabY}px`;
      previewDrop(e.clientX, e.clientY);
    });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('blur', cancelDrag); // 拖动中窗口 blur → 取消（防御）

    // 最后指针位置（抑制解除收尾判定「指针在面板外」）；坐标冻结解除后补判收尾；
    // 首个鼠标事件亦是「拖入中」标记的兜底复位（见上）
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

  // 拖动态吞 click 的消费口（renderer 条目点击前置问）
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
