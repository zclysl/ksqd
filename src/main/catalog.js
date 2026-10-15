// 速启 · 分类与条目纯逻辑（设计档 4.6 / 4.7 / 4.10）
// 纯 Node 模块：不依赖 Electron、不触磁盘 —— 可脱离 Electron 直接 node --test。

import path from 'node:path';
import { randomUUID } from 'node:crypto';

// .lnk 判定复用图标容错链同一纯逻辑（4.16「同源口径」）；经本模块再导出，launcher / main 侧从本模块取判定
// （icons.js 沿既有 icon-fallback 导入组不变）
export { isShortcutPath } from './icon-fallback.js';

/** 「未分类」固定 id（恒首位、不可删、可改名；4.10 / F2.4） */
export const UNCATEGORIZED_ID = 'uncategorized';
/** 初始名 / 名称回退值（改名后各处按存储名显示） */
export const UNCATEGORIZED_NAME = '未分类';

/** 仅支持 .exe / .lnk（F3.1） */
export const SUPPORTED_EXTENSIONS = ['.exe', '.lnk'];

/** 判重键：规范化路径（path.resolve）+ 小写化（4.7 统一校验 / F3.6） */
export function pathKey(filePath) {
  return path.resolve(String(filePath)).toLowerCase();
}

/** 扩展名是否受支持（大小写不敏感） */
export function isSupportedFile(filePath) {
  return SUPPORTED_EXTENSIONS.includes(path.extname(String(filePath)).toLowerCase());
}

/** 默认名称 = 文件名去扩展名（F3.2） */
export function defaultNameOf(filePath) {
  const base = path.basename(String(filePath));
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** 名称归一化：非字符串 → 空串；trim（4.10 名称 trim 后为空即拒绝） */
export function normalizeName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

export function findCategoryById(state, id) {
  return state.categories.find((category) => category.id === id) || null;
}

export function findAppById(state, id) {
  return state.apps.find((app) => app.id === id) || null;
}

export function findAppByPath(state, filePath) {
  const key = pathKey(filePath);
  return state.apps.find((app) => pathKey(app.path) === key) || null;
}

/** 新建分类（F2.3）：trim 后空 → empty；数组末尾追加；id 唯一 */
export function createCategory(state, name) {
  const clean = normalizeName(name);
  if (!clean) return { ok: false, code: 'empty' };
  const category = { id: `c-${randomUUID()}`, name: clean, builtin: false };
  return { ok: true, state: { ...state, categories: [...state.categories, category] } };
}

/** 重命名分类（F2.3 / F2.4）：默认分类同样可改名（仅改 name——id / builtin / 恒首位不变）；空名 → empty */
export function renameCategory(state, id, name) {
  const category = findCategoryById(state, id);
  if (!category) return { ok: false, code: 'missing' };
  const clean = normalizeName(name);
  if (!clean) return { ok: false, code: 'empty' };
  const categories = state.categories.map((item) => (item.id === id ? { ...item, name: clean } : item));
  return { ok: true, state: { ...state, categories } };
}

/** 删除分类（F2.3 / F2.5）：未分类拒绝；其下条目迁入未分类并计数 moved */
export function deleteCategory(state, id) {
  if (id === UNCATEGORIZED_ID) return { ok: false, code: 'builtin' };
  const category = findCategoryById(state, id);
  if (!category) return { ok: false, code: 'missing' };
  if (category.builtin) return { ok: false, code: 'builtin' };
  const categories = state.categories.filter((item) => item.id !== id);
  let moved = 0;
  const apps = state.apps.map((app) => {
    if (app.categoryId !== id) return app;
    moved += 1;
    return { ...app, categoryId: UNCATEGORIZED_ID };
  });
  return { ok: true, state: { ...state, categories, apps }, moved };
}

/** 新增条目（F3.1 / F3.2）：判重（F3.6）；名称空拒绝；分类缺省或不存在 → 未分类（4.10 归一化规则）；
 *  realPath（F3.9 / 4.16）：非空字符串 → resolve 后登记；否则 null（其余契约与返回形态不变） */
export function createApp(state, payload) {
  const filePath = typeof payload?.path === 'string' ? payload.path.trim() : '';
  if (!filePath) return { ok: false, code: 'missing' };
  const clean = normalizeName(payload?.name);
  if (!clean) return { ok: false, code: 'empty' };
  if (findAppByPath(state, filePath)) return { ok: false, code: 'duplicate' };
  const categoryId = findCategoryById(state, payload?.categoryId) ? payload.categoryId : UNCATEGORIZED_ID;
  const realPath = typeof payload?.realPath === 'string' && payload.realPath.trim()
    ? path.resolve(payload.realPath.trim())
    : null;
  const app = {
    id: `a-${randomUUID()}`,
    name: clean,
    path: path.resolve(filePath),
    realPath,
    categoryId,
    addedAt: new Date().toISOString(),
  };
  return { ok: true, state: { ...state, apps: [...state.apps, app] } };
}

/** 编辑条目（F3.4）：改名 / 换分类；目标分类不存在 → 拒绝（第八节用例 8） */
export function updateApp(state, payload) {
  const app = findAppById(state, payload?.id);
  if (!app) return { ok: false, code: 'missing' };
  const clean = normalizeName(payload?.name);
  if (!clean) return { ok: false, code: 'empty' };
  if (!findCategoryById(state, payload?.categoryId)) return { ok: false, code: 'missing' };
  const apps = state.apps.map((item) => (
    item.id === app.id ? { ...item, name: clean, categoryId: payload.categoryId } : item
  ));
  return { ok: true, state: { ...state, apps } };
}

/** 删除条目（F3.5）：仅移除记录；id 不存在按幂等成功（3.1 #6 契约无失败分支） */
export function deleteApp(state, id) {
  if (!findAppById(state, id)) return { ok: true, state };
  return { ok: true, state: { ...state, apps: state.apps.filter((item) => item.id !== id) } };
}

/**
 * 重排条目（F3.8 / 4.15）：toIndex = 落位后条目在目标分类内的序位（最终下标，0 起）；
 * categoryId = 目标分类（可异于条目当前分类）——同分类重排 / 跨分类移动共用（决策 #36）。
 * 值域（落位序位上限 = 落位后该分类条目数 - 1）：同分类 0..该分类当前条目数-1（含被拖条目）；
 * 跨分类 0..目标分类当前条目数（不含被拖条目，送该值 = 追加末尾）。
 * id / 目标分类不存在 → missing；toIndex 非整数或超值域 → invalid；均不改状态。
 * 幂等：同分类且目标序位 = 现位 → ok、状态不变；其余条目相对顺序不变（目标分类外不受扰动）。
 * （4.15 编码语义以 v1.3 归档单测 + 父侧 2026-10-13 裁定为准：落位序位编码。）
 */
export function reorderApp(state, payload) {
  const app = findAppById(state, payload?.id);
  if (!app) return { ok: false, code: 'missing' };
  const category = findCategoryById(state, payload?.categoryId);
  if (!category) return { ok: false, code: 'missing' };
  const toIndex = payload?.toIndex;
  const rest = state.apps.filter((item) => item.id !== app.id);
  const targetOthers = rest.filter((item) => item.categoryId === category.id);
  // 落位序位上限 = 落位后该分类条目数 - 1（同分类 / 跨类同式：其余条目数即落位后条目数 - 1）
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex > targetOthers.length) {
    return { ok: false, code: 'invalid' };
  }
  const sameCategory = category.id === app.categoryId;
  // 幂等（8.3 用例 2）：目标序位 = 现位 → ok、状态不变
  if (sameCategory) {
    const inCategory = state.apps.filter((item) => item.categoryId === app.categoryId);
    if (inCategory.indexOf(app) === toIndex) return { ok: true, state };
  }
  // 锚位：toIndex = 0 → 插到目标分类首条目之前；否则 → 第 toIndex-1 条目之后（其后即目标分类第 toIndex 位）；
  // 目标分类无其余条目（空分类落点）→ 追加到全局末尾
  const anchor = toIndex === 0 ? targetOthers[0] : targetOthers[toIndex - 1];
  const insertAt = toIndex === 0 ? rest.indexOf(anchor) : rest.indexOf(anchor) + 1;
  const apps = [...rest];
  apps.splice(insertAt < 0 ? rest.length : insertAt, 0, sameCategory ? app : { ...app, categoryId: category.id });
  return { ok: true, state: { ...state, apps } };
}
