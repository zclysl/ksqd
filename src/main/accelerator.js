// 速启 · 唤起快捷键组合纯逻辑（设计档 4.14 / 4.10 / 决策 #26）
// 纯 Node 模块：不依赖 Electron —— 合法性判定与归一化可脱离 Electron 直接 node --test。
// 规则（4.14）：须含 Ctrl / Alt / Shift / Win（→ Super）之一；键位 ∈ 白名单；
// 归一化 = 修饰键序 Ctrl+Alt+Shift+Super、字母大写。

/** 默认组合（4.14 / F1.5） */
export const DEFAULT_ACCELERATOR = 'Alt+Space';

/** 修饰键别名 → 规范名（Win → Electron Super，4.14） */
const MODIFIER_ALIASES = new Map([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['win', 'Super'],
  ['super', 'Super'],
]);

/** 归一化修饰键顺序（4.14：Ctrl+Alt+Shift+Super） */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];

/** 具名键白名单（4.14；别名覆盖 e.key 形态 ArrowUp / Return） */
const NAMED_KEYS = new Map([
  ['space', 'Space'], ['tab', 'Tab'], ['enter', 'Enter'], ['return', 'Enter'],
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['arrowup', 'Up'], ['arrowdown', 'Down'], ['arrowleft', 'Left'], ['arrowright', 'Right'],
  ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'],
  ['insert', 'Insert'], ['delete', 'Delete'],
]);

/** 常用标点白名单（4.14：可打印 ASCII 标点） */
const PUNCTUATION = new Set([
  '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  ':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~',
]);

/** 键名归一化：字母大写 / 数字原样 / F1–F24 / 具名键规范名 / 标点原样；不可识别 → null */
function normalizeKeyName(token) {
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (fn) return `F${fn[1]}`;
  const named = NAMED_KEYS.get(token.toLowerCase());
  if (named) return named;
  if (PUNCTUATION.has(token)) return token;
  return null;
}

/**
 * 组合归一化（4.14）：修饰键序 Ctrl+Alt+Shift+Super、字母大写；
 * 不可识别 / 不含修饰键 / 键名不在白名单 → null（调用方按默认值或拒绝处理）。
 */
export function normalizeAccelerator(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('+');
  // 末两段皆空 → 末位键为字面 '+'（如 Ctrl++），合并还原
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    parts.pop();
    parts[parts.length - 1] = '+';
  }
  const modifiers = new Set();
  let key = null;
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i].trim();
    if (!token) return null;
    if (i < parts.length - 1) {
      const modifier = MODIFIER_ALIASES.get(token.toLowerCase());
      if (!modifier) return null; // 非修饰键出现在键位前 / 未知修饰键
      modifiers.add(modifier);
    } else {
      key = normalizeKeyName(token);
      if (!key) return null;
    }
  }
  if (modifiers.size === 0) return null; // 4.14：须含 Ctrl / Alt / Shift / Win 之一
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

/** 组合是否合法（判定复用归一化：能归一化出结果即合法） */
export function isValidAccelerator(raw) {
  return normalizeAccelerator(raw) !== null;
}
