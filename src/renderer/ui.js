// 速启 · ui.js —— 无状态 DOM 构建层
// 职责：输入数据、输出 DOM 节点（分类标签栏 / 图标项 / 菜单 / 确认条 / 添加编辑浮层 / 空态占位）。
// 边界：不持状态、不发 IPC、不做定位计算（定位在 renderer）。
// 加载形态：file:// 下 Chromium 以 CORS 拦截 ES 模块脚本（Electron loadFile 走同一加载器），
// 故以经典脚本加载、经 window.SuqiUI 暴露构建函数，不产生全局业务状态。
(function (global) {
  'use strict';

  // ---------- 基础 ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, action) {
    const node = el('button', className, text);
    node.type = 'button';
    if (action) node.dataset.action = action;
    return node;
  }

  // 「删除 / 取消」按钮组（条目行内确认与分类确认条共用）
  function confirmActions() {
    const wrap = el('div', 'confirm-actions');
    wrap.append(
      button('btn btn-primary', '删除', 'confirm'),
      button('btn btn-ghost', '取消', 'cancel'),
    );
    return wrap;
  }

  // ---------- 分类标签栏 ----------

  function buildTab(category, activeId) {
    const tab = el('div', 'tab');
    tab.dataset.catId = category.id;
    if (category.id === activeId) tab.classList.add('active');
    const name = el('span', 'tab-name', category.name);
    name.title = category.name;
    tab.appendChild(name);
    tab.appendChild(button('tab-menu-btn', '⋯')); // hover 显示（默认分类同样提供；菜单仅「重命名…」）
    return tab;
  }

  function buildTabInput(value) {
    const input = el('input', 'tab-input');
    input.type = 'text';
    input.value = value;
    return input;
  }

  function buildNewTab() {
    const node = button('tab-new', '＋'); // 仅符号（F2.3 / AC-28）：文字「新建分类」退到悬停 title
    node.title = '新建分类';
    return node;
  }

  // categories 顺序 = 展示顺序；editing: {mode:'create'} | {mode:'rename', id} | null
  function buildTabBar(categories, activeId, editing) {
    const frag = document.createDocumentFragment();
    for (const category of categories) {
      if (editing && editing.mode === 'rename' && editing.id === category.id) {
        frag.appendChild(buildTabInput(category.name)); // 标签原位行内输入
      } else {
        frag.appendChild(buildTab(category, activeId));
      }
    }
    if (editing && editing.mode === 'create') {
      frag.appendChild(buildTabInput('')); // 新建分类：原位替代「＋ 新建分类」
    } else {
      frag.appendChild(buildNewTab());
    }
    return frag;
  }

  // ---------- 图标网格与空态 ----------

  function firstChar(name) {
    return Array.from(String(name || '').trim())[0] || '?';
  }

  function buildIcon(app, dataUrl) {
    const box = el('div', 'item-icon');
    if (dataUrl) {
      const img = el('img');
      img.src = dataUrl;
      img.alt = '';
      img.draggable = false;
      box.appendChild(img);
    } else {
      box.appendChild(el('div', 'icon-fallback', firstChar(app.name))); // 首字符圆角块占位
    }
    return box;
  }

  // iconFor(app) -> dataUrl | null（由 renderer 提供，含会话内缓存）
  function buildGrid(apps, iconFor) {
    const grid = el('div', 'grid');
    for (const app of apps) {
      const item = el('div', 'item');
      item.dataset.appId = app.id;
      item.appendChild(buildIcon(app, iconFor(app)));
      const name = el('div', 'item-name', app.name);
      name.title = app.name;
      item.appendChild(name);
      grid.appendChild(item);
    }
    return grid;
  }

  // 图标异步到达后的原位替换（仍是节点构建，故留在本层）
  function setItemIcon(itemEl, dataUrl) {
    if (!itemEl || !dataUrl) return;
    const box = itemEl.querySelector('.item-icon');
    if (!box) return;
    const img = el('img');
    img.src = dataUrl;
    img.alt = '';
    img.draggable = false;
    box.replaceChildren(img);
  }

  function buildEmptyCategory() {
    return el('div', 'empty-category', '拖入软件到此分类');
  }

  function buildEmptyGuide() {
    const wrap = el('div', 'empty-guide');
    wrap.append(
      el('div', 'empty-guide-main', '点击「+」添加软件'),
      el('div', 'empty-guide-sub', '或将 .exe / .lnk 拖入窗口'),
    );
    return wrap;
  }

  // ---------- 菜单与确认 ----------

  // items: [{label, action}]
  function buildMenu(items) {
    const menu = el('div', 'menu');
    for (const item of items) menu.appendChild(button('menu-item', item.label, item.action));
    return menu;
  }

  function buildConfirmPop(text) {
    const pop = el('div', 'menu menu-confirm');
    pop.appendChild(el('div', 'menu-confirm-text', text));
    pop.appendChild(confirmActions());
    return pop;
  }

  function buildConfirmBar(text) {
    const bar = el('div', 'confirm-bar');
    bar.appendChild(el('div', 'confirm-bar-text', text));
    bar.appendChild(confirmActions());
    return bar;
  }

  // ---------- 添加 / 编辑浮层 ----------

  function buildFormRow(labelText, control) {
    const row = el('div', 'form-row');
    row.appendChild(el('div', 'form-label', labelText));
    row.appendChild(control);
    return row;
  }

  // opts: {mode:'add'|'edit', name, path, categoryId, categories}
  function buildAppForm(opts) {
    const overlay = el('div', 'overlay');
    const card = el('div', 'form-card');
    card.appendChild(el('div', 'form-title', opts.mode === 'edit' ? '编辑软件' : '添加软件'));

    const nameInput = el('input', 'form-input');
    nameInput.type = 'text';
    nameInput.value = opts.name;
    card.appendChild(buildFormRow('名称', nameInput));

    const select = el('select', 'form-select');
    for (const category of opts.categories) {
      const option = el('option', null, category.name);
      option.value = category.id;
      if (category.id === opts.categoryId) option.selected = true;
      select.appendChild(option);
    }
    card.appendChild(buildFormRow('分类', select));

    const pathEl = el('div', 'form-path', opts.path); // 只读行
    pathEl.title = opts.path;
    card.appendChild(buildFormRow('路径', pathEl));

    overlay.appendChild(card);
    return overlay;
  }

  global.SuqiUI = {
    buildTabBar,
    buildGrid,
    setItemIcon,
    buildEmptyCategory,
    buildEmptyGuide,
    buildMenu,
    buildConfirmPop,
    buildConfirmBar,
    buildAppForm,
  };
})(window);
