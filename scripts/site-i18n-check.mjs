/* ============================================================
   下载站多语言一致性校验
   用法：node scripts/site-i18n-check.mjs
   检查：
   1. 字典文件（common + 5 个页面）可解析，且 5 语 key 集合完全一致
   2. HTML 里 data-i18n* 引用的每个 key 在 5 语中都有值
   3. 页面可见中文文本（body 内）是否都被 data-i18n* 覆盖（启发式，输出告警）
   4. 字典里从未被引用的 key（告警）
   ============================================================ */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);
const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
const PAGES = ['index', 'features', 'faq', 'compare', 'changelog'];
const DICT_FILES = ['common', ...PAGES];

/* JS 会在运行时被动态引用的 key（index.html 下载区由 SiteI18n.t() 取词，不写 data-i18n）
   注意：必须匹配 SiteI18n.t( 完整前缀，否则 getContext('2d') 之类会被误报成 key '2d' */
const JS_USED_KEY_RE = /SiteI18n\.t\(\s*['"]([\w.\-]+)['"]/g;
/* 已知由 JS 动态重绘、无需 data-i18n 标注的元素 id */
const DYNAMIC_IDS = ['osBadge', 'mainDownloadText', 'heroMeta', 'installVer', 'installDownloadText', 'installSteps', 'installNote'];
/* 允许保持中文、不参与翻译的区域 */
const SKIP_IDS = ['fYear'];

/* 运行时 site-i18n.js 内部引用、不出现在页面里的 key */
const RUNTIME_KEYS = ['common.lang.aria'];
/* 通过三元表达式引用、引用正则捕获不到的 key（index.html paintBadge） */
const TERNARY_KEYS = ['index.badge.win', 'index.badge.both'];

let errors = 0, warnings = 0;
const err = (m) => { console.error('✗ ' + m); errors++; };
const warn = (m) => { console.warn('⚠ ' + m); warnings++; };

/* ---------- 1. 加载字典 ---------- */
const stubWindow = {};
for (const name of DICT_FILES) {
  const f = rel(`release/assets/i18n/${name}.js`);
  if (!existsSync(f)) { err(`缺少字典文件 release/assets/i18n/${name}.js`); continue; }
  try {
    new Function('window', readFileSync(f, 'utf8'))(stubWindow);
  } catch (e) {
    err(`字典文件解析失败 ${name}.js: ${e.message}`);
  }
}
const dict = stubWindow.SITE_I18N_DICT || {};
const merged = {};
for (const locale of LOCALES) merged[locale] = dict[locale] || {};

const zhKeys = Object.keys(merged['zh-CN']).sort();
for (const locale of LOCALES.slice(1)) {
  const keys = Object.keys(merged[locale]).sort();
  const missing = zhKeys.filter((k) => !(k in merged[locale]));
  const extra = keys.filter((k) => !(k in merged['zh-CN']));
  missing.forEach((k) => err(`[${locale}] 缺少词条: ${k}`));
  extra.forEach((k) => err(`[${locale}] 多出词条: ${k}`));
}
for (const locale of LOCALES) {
  for (const [k, v] of Object.entries(merged[locale])) {
    if (typeof v !== 'string' || !v.trim()) err(`[${locale}] 词条为空: ${k}`);
  }
}
console.log(`字典：${zhKeys.length} 个 key × ${LOCALES.length} 语`);

/* ---------- 2/3. 扫描 HTML ---------- */
const ATTR_RE = /\bdata-i18n(?:-html|-placeholder|-title|-aria-label|-alt)?="([^"]+)"/g;
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

function referencedKeys(html) {
  const set = new Set();
  for (const m of html.matchAll(ATTR_RE)) set.add(m[1]);
  for (const m of html.matchAll(JS_USED_KEY_RE)) set.add(m[1]);
  return set;
}

/* 启发式覆盖检查：剔除 script/style/head，按标签栈找未被 data-i18n 覆盖的中文文本 */
function uncoveredReader(html, page) {
  let body = html;
  const bodyM = body.match(/<body[\s\S]*<\/body>/i);
  if (bodyM) body = bodyM[0];
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const issues = [];
  const stack = [];
  const tokenRe = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(body)) !== null) {
    if (m[1] !== undefined) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] || '';
      const closing = m[0].startsWith('</');
      const selfClosed = /\/\s*$/.test(attrs);
      if (!closing) {
        if (!VOID.has(tag) && !selfClosed) stack.push({ tag, attrs });
        if (tag === 'svg' || tag === 'kbd') { /* svg/kbd 内文本视为符号，跳过其内容 */ }
      } else {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === tag) { stack.length = i; break; }
        }
      }
    } else if (m[3] !== undefined) {
      const text = m[3];
      if (!/[\u4e00-\u9fff]/.test(text)) continue;
      const covered = stack.some((n) => /\bdata-i18n/i.test(n.attrs));
      const inSkipped = stack.some((n) => SKIP_IDS.includes(n.attrs.match(/id="([^"]+)"/)?.[1] || ''));
      if (covered || inSkipped) continue;
      const owner = [...stack].reverse().find((n) => /id="([^"]+)"/.test(n.attrs));
      const ownerId = owner ? owner.attrs.match(/id="([^"]+)"/)[1] : '';
      if (ownerId && DYNAMIC_IDS.includes(ownerId)) continue;
      issues.push({ text: text.trim().slice(0, 60), id: ownerId, page });
    }
  }
  return issues;
}

const referenced = new Map();
for (const page of PAGES) {
  const f = rel(`release/${page}.html`);
  if (!existsSync(f)) { err(`缺少页面 release/${page}.html`); continue; }
  const html = readFileSync(f, 'utf8');
  const keys = referencedKeys(html);
  referenced.set(page, keys);
  for (const k of keys) {
    for (const locale of LOCALES) {
      if (!(k in merged[locale])) err(`${page}.html 引用的 key 在 [${locale}] 缺失: ${k}`);
    }
  }
  for (const issue of uncoveredReader(html, page)) {
    warn(`${page}.html 未标注翻译的中文文本${issue.id ? `（#${issue.id} 内）` : ''}: "${issue.text}"`);
  }
}

/* ---------- 4. 未引用词条 ---------- */
const allRef = new Set();
for (const s of referenced.values()) for (const k of s) allRef.add(k);
for (const k of zhKeys) {
  if (!allRef.has(k) && !RUNTIME_KEYS.includes(k) && !TERNARY_KEYS.includes(k)) {
    warn(`字典词条未被任何页面引用: ${k}`);
  }
}

console.log('');
if (errors) { console.log(`校验失败：${errors} 个错误，${warnings} 个告警`); process.exit(1); }
console.log(`校验通过：${warnings} 个告警（告警需人工确认，不阻断）`);
