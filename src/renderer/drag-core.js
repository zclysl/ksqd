// 速启 · drag-core.js —— 条目拖动（4.15）与分类拖动（4.18）共用的指针拖动核心
// 职责：4px 阈值 / pointer capture / clone 影构造与随光标 / 落位矩形命中与左右半点判定 / 落位与取消归位动画。
// 边界：不持业务状态、不发 IPC、不读写「排序中」标记与抑制判定（那两处在 interactions.js 单点，4.18）。
// 加载形态：经典脚本（file:// 下 Chromium 以 CORS 拦截 ES 模块脚本）；经 window.SuqiDragCore 暴露。
(function (global) {
  'use strict';

  const THRESHOLD_PX = 4; // 十二节：4px 阈值区分单击 / 拖动
  const RETURN_MS = 120; // 十二节：落位 / 取消归位动画（沿显示动画节奏）
  const PLACEHOLDER_CLASS = 'is-dragging'; // 原位节点 = 半透明占位（十二节）
  const GHOST_CLASS = 'drag-ghost'; // clone 影（styles.css：fixed + pointer-events:none，不挡落点命中）

  // 起点记录：node = 被拖节点（.item / .tab），startX / startY = pointerdown 坐标
  function createSession({ node, pointerId, startX, startY }) {
    return {
      node,
      pointerId,
      startX,
      startY,
      next: node ? node.nextSibling : null, // 取消归位锚点（条目网格原位预览用）
      active: false,
      ghost: null,
      startRect: null,
      grabX: 0,
      grabY: 0,
    };
  }

  function exceedsThreshold(session, x, y) {
    return Math.hypot(x - session.startX, y - session.startY) > THRESHOLD_PX;
  }

  // 进入拖动态：原位节点半透明占位 + clone 影随光标 + pointer capture（面板外松手的事件送达，十三节实测点 10）
  function activate(session) {
    const rect = session.node.getBoundingClientRect();
    session.active = true;
    session.startRect = rect;
    session.grabX = session.startX - rect.left; // 抓取偏移：影跟手、起点不跳
    session.grabY = session.startY - rect.top;
    session.node.classList.add(PLACEHOLDER_CLASS);
    const ghost = session.node.cloneNode(true);
    ghost.classList.remove(PLACEHOLDER_CLASS); // 半透明占位只留原位节点；clone 影为实卡（十二节）
    ghost.classList.add(GHOST_CLASS);
    ghost.style.width = `${Math.round(rect.width)}px`;
    ghost.style.height = `${Math.round(rect.height)}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    session.ghost = ghost;
    try {
      session.node.setPointerCapture(session.pointerId);
    } catch {
      // 捕获不可用 → 由 interactions.js 的 window blur 监听兜底取消（语义不变）
    }
    return session;
  }

  function follow(session, x, y) {
    if (!session.ghost) return;
    session.ghost.style.left = `${x - session.grabX}px`;
    session.ghost.style.top = `${y - session.grabY}px`;
  }

  // 落位矩形命中 + 左右半点判定（4.18）：按传入顺序取首个包含指针的矩形；
  // 返回 { element, half: 'left' | 'right' } 或 null（空白处 / 面板外）。
  function hitRects(elements, x, y) {
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      return { element, half: x < rect.left + rect.width / 2 ? 'left' : 'right' };
    }
    return null;
  }

  // 落位 / 取消归位动画（十二节 120ms）：clone 影滑到 targetRect（缺省 = 拖动起点）后清理
  function settle(session, targetRect) {
    const ghost = session.ghost;
    if (!ghost) return;
    const target = targetRect || session.startRect || { left: 0, top: 0 };
    ghost.style.transition = `left ${RETURN_MS}ms ease-out, top ${RETURN_MS}ms ease-out, opacity ${RETURN_MS}ms ease-out`;
    ghost.style.left = `${target.left}px`;
    ghost.style.top = `${target.top}px`;
    ghost.style.opacity = '0';
    setTimeout(() => {
      ghost.remove();
      session.node.classList.remove(PLACEHOLDER_CLASS); // 成功路径该节点已被重渲染替换，此处为空操作
    }, RETURN_MS + 10);
  }

  global.SuqiDragCore = {
    createSession,
    exceedsThreshold,
    activate,
    follow,
    hitRects,
    settle,
  };
})(window);
