// 速启 · 数据持久化（设计档 4.10）
// 纯 Node 模块（不引用 Electron）：以「基础目录」为入参，数据文件 = <基础目录>/data.json。
// main 侧注入 app.getPath('userData')；单元测试注入 fs.mkdtemp 临时目录（不触碰真实 %APPDATA%\速启）。

import fs from 'node:fs';
import path from 'node:path';

import { UNCATEGORIZED_ID, UNCATEGORIZED_NAME } from './catalog.js';
import { DEFAULT_ACCELERATOR, normalizeAccelerator } from './accelerator.js';

/** 当前数据版本（4.10） */
export const DATA_VERSION = 1;

/** 默认结构：仅「未分类」+ 空条目 + settings.autoLaunch 默认 true（F2.4 / F6.2）+ settings.hotkey 默认 Alt+Space（F1.5 / 4.14） */
export function createDefaultState() {
  return {
    version: DATA_VERSION,
    categories: [{ id: UNCATEGORIZED_ID, name: UNCATEGORIZED_NAME, builtin: true }],
    apps: [],
    settings: { autoLaunch: true, hotkey: DEFAULT_ACCELERATOR },
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 归一化（4.10）：缺失字段补默认；「未分类」恒在首位（名称取存储值——缺失 / trim 后为空 → 初始名）；条目指向不存在分类 → 落「未分类」 */
export function normalizeState(raw) {
  const state = createDefaultState();
  if (!isRecord(raw)) return state;

  const knownIds = new Set([UNCATEGORIZED_ID]);
  const categories = [];
  let defaultName = ''; // 「未分类」的存储名（trim 后；缺失 / 空白 → 初始名）
  if (Array.isArray(raw.categories)) {
    for (const item of raw.categories) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (id === UNCATEGORIZED_ID) {
        if (name && !defaultName) defaultName = name; // 改名重启保持（4.10）
        continue;
      }
      if (!id || !name || knownIds.has(id)) continue;
      knownIds.add(id);
      categories.push({ id, name, builtin: false });
    }
  }
  state.categories = [
    { id: UNCATEGORIZED_ID, name: defaultName || UNCATEGORIZED_NAME, builtin: true }, // 恒首位 / builtin 不变
    ...categories,
  ];

  const apps = [];
  if (Array.isArray(raw.apps)) {
    for (const item of raw.apps) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const filePath = typeof item.path === 'string' ? item.path.trim() : '';
      if (!id || !name || !filePath) continue;
      const categoryId = typeof item.categoryId === 'string' && knownIds.has(item.categoryId)
        ? item.categoryId
        : UNCATEGORIZED_ID;
      const addedAt = typeof item.addedAt === 'string' && item.addedAt ? item.addedAt : new Date().toISOString();
      // realPath（v1.4 / F3.9）：缺失 / 非字符串 / trim 后为空 → null；非空取 trim 后值（不 resolve，保持原样写回）
      const realPath = typeof item.realPath === 'string' && item.realPath.trim() ? item.realPath.trim() : null;
      apps.push({ id, name, path: filePath, categoryId, addedAt, realPath });
    }
  }
  state.apps = apps;

  const settings = isRecord(raw.settings) ? raw.settings : {};
  state.settings = {
    autoLaunch: typeof settings.autoLaunch === 'boolean' ? settings.autoLaunch : true,
    // 4.10 载入归一化：缺失 / 空白 / 不含修饰键 / 键名不可识别 → 默认；合法值归一化后保留（判定复用 accelerator.js）
    hotkey: normalizeAccelerator(settings.hotkey) || DEFAULT_ACCELERATOR,
  };

  return state;
}

/** 写回白名单字段（4.10）：只落结构内字段，不带任何野生字段 */
function serialize(state) {
  const payload = {
    version: DATA_VERSION,
    categories: state.categories.map((category) => ({
      id: category.id,
      name: category.name,
      builtin: category.builtin === true,
    })),
    apps: state.apps.map((app) => ({
      id: app.id,
      name: app.name,
      path: app.path,
      categoryId: app.categoryId,
      addedAt: app.addedAt,
      realPath: typeof app.realPath === 'string' ? app.realPath : null, // 白名单写回含 realPath（4.10）
    })),
    settings: {
      autoLaunch: state.settings.autoLaunch === true,
      hotkey: normalizeAccelerator(state.settings.hotkey) || DEFAULT_ACCELERATOR, // 白名单写回含 hotkey（4.10）
    },
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 建库（4.10 注入接缝）：baseDir = 数据基础目录（main 注入 userData 路径 / 单测注入临时目录）。
 * load() 载入（缺文件→默认结构落盘；损坏→data.corrupt-* 备份；版本过高→data.backup-* 备份；归一化）。
 * save(next) 更新内存态并原子落盘（写 data.json.tmp → renameSync）；失败抛出，由调用方保留内存态。
 */
export function createStore(baseDir) {
  const filePath = path.join(baseDir, 'data.json');
  let state = null;

  function persist(next) {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, serialize(next), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  function archive(name) {
    try {
      fs.renameSync(filePath, path.join(baseDir, name));
    } catch (err) {
      console.warn('[速启] 数据备份失败：', err);
    }
  }

  function load() {
    fs.mkdirSync(baseDir, { recursive: true });

    let text = null;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      state = createDefaultState();
      if (err?.code === 'ENOENT') {
        // 缺文件 → 立即写默认结构（首次运行即满足 AC-9）
        try {
          persist(state);
        } catch (writeErr) {
          console.warn('[速启] 默认数据落盘失败：', writeErr);
        }
      } else {
        // 其他读取失败：只降级内存态、不落盘，避免覆盖可能完好的数据（4.10「不覆盖可疑数据」取向）
        console.warn('[速启] 数据文件读取失败，按默认结构降级运行（不落盘）：', err);
      }
      return state;
    }

    let raw = null;
    let parseError = null;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      parseError = err;
    }

    if (parseError || !isRecord(raw)) {
      if (parseError) console.warn('[速启] 数据文件损坏（JSON 解析失败），已备份：', parseError.message);
      archive(`data.corrupt-${timestampSuffix()}.json`);
      raw = null;
    } else if (Number.isFinite(raw.version) && raw.version > DATA_VERSION) {
      console.warn(`[速启] 数据版本（${raw.version}）高于当前支持（${DATA_VERSION}），已备份，不覆盖可疑数据`);
      archive(`data.backup-${timestampSuffix()}.json`);
      raw = null;
    }

    state = raw === null ? createDefaultState() : normalizeState(raw);
    if (raw === null) {
      try {
        persist(state);
      } catch (writeErr) {
        console.warn('[速启] 默认数据落盘失败：', writeErr);
      }
    }
    return state;
  }

  function save(next) {
    if (next) state = next;
    persist(state);
    return state;
  }

  return {
    filePath,
    get state() {
      return state;
    },
    load,
    save,
  };
}
