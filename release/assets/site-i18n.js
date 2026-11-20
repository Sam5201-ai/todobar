/* ============================================================
   Tacco 下载站 · 运行时多语言
   ------------------------------------------------------------
   字典：assets/i18n/common.js + assets/i18n/<page>.js
        （往 window.SITE_I18N_DICT 上按语言合并词条）
   用法：
   - 静态节点：data-i18n（textContent）/ data-i18n-html（innerHTML）
     / data-i18n-placeholder / data-i18n-title / data-i18n-aria-label / data-i18n-alt
   - JS 内取词：window.SiteI18n.t('index.dl.win.label', { ver: '0.4.82' })
   - 语言记忆：localStorage('site-lang')；首访按 navigator.languages 判定
   - 语言切换后会调用 window.__siteRepaint()（index.html 用来重绘下载区动态文案）
   注意：静态 HTML 保持中文原文（SEO 真源），爬虫看到中文，浏览器端运行时切换。
   ============================================================ */
(function () {
  'use strict';

  var LOCALES = [
    { code: 'zh-CN', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' }
  ];
  var LANG_KEY = 'site-lang';
  var dict = window.SITE_I18N_DICT = window.SITE_I18N_DICT || {};
  var current = detect();

  /* ---------- 语言判定 ----------
     两轮扫描：第一轮只认 zh/ja/ko（不管在列表第几位，中文用户浏览器常见 en 排第一）；
     第二轮才认 en；都没命中兜底 en。 */
  function detect() {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved && dict[saved]) return saved;
    } catch (e) { /* 隐私模式等场景忽略 */ }
    var langs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || navigator.userLanguage || 'en'];
    var kind = { zhHant: null, zh: null, ja: null, ko: null, en: null };
    for (var i = 0; i < langs.length; i++) {
      var l = String(langs[i] || '').toLowerCase().replace('_', '-');
      if (!l) continue;
      if (!kind.zhHant && (l === 'zh-hant' || l.indexOf('zh-hant') === 0 ||
          l.indexOf('zh-tw') === 0 || l.indexOf('zh-hk') === 0 || l.indexOf('zh-mo') === 0)) kind.zhHant = 'zh-TW';
      else if (!kind.zh && l.indexOf('zh') === 0) kind.zh = 'zh-CN';
      else if (!kind.ja && l.indexOf('ja') === 0) kind.ja = 'ja';
      else if (!kind.ko && l.indexOf('ko') === 0) kind.ko = 'ko';
      else if (!kind.en && l.indexOf('en') === 0) kind.en = 'en';
    }
    return kind.zhHant || kind.zh || kind.ja || kind.ko || kind.en || 'en';
  }

  /* ---------- 取词 + {name} 插值 ---------- */
  function t(key, params) {
    var s = (dict[current] || {})[key];
    if (s == null) s = (dict['zh-CN'] || {})[key];
    if (s == null) return key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        return params[name] != null ? String(params[name]) : m;
      });
    }
    return s;
  }

  /* ---------- 应用到 DOM ---------- */
  function applyPack(pack) {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = pack[el.getAttribute('data-i18n')];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var v = pack[el.getAttribute('data-i18n-html')];
      if (v != null) el.innerHTML = v;
    });
    var attrMap = {
      'data-i18n-placeholder': 'placeholder',
      'data-i18n-title': 'title',
      'data-i18n-aria-label': 'aria-label',
      'data-i18n-alt': 'alt'
    };
    Object.keys(attrMap).forEach(function (a) {
      document.querySelectorAll('[' + a + ']').forEach(function (el) {
        var v = pack[el.getAttribute(a)];
        if (v != null) el.setAttribute(attrMap[a], v);
      });
    });
  }

  function apply() {
    applyPack(dict['zh-CN'] || {}); /* 先补齐缺失词条（防漏），再覆盖当前语言 */
    applyPack(dict[current] || {});
    document.documentElement.setAttribute('lang', current);
    updateSwitcherLabel();
  }

  /* ---------- 语言切换器 ---------- */
  var btnEl = null, menuEl = null, boxEl = null;

  function nameOf(code) {
    for (var i = 0; i < LOCALES.length; i++) if (LOCALES[i].code === code) return LOCALES[i].name;
    return code;
  }

  function buildSwitcher() {
    if (document.getElementById('siteLangSwitch')) return;
    var host = document.querySelector('.nav-right') || document.querySelector('.topbar .wrap');
    if (!host) return;

    boxEl = document.createElement('div');
    boxEl.className = 'lang-switch';
    boxEl.id = 'siteLangSwitch';

    btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.className = 'lang-btn';
    btnEl.setAttribute('aria-haspopup', 'listbox');
    btnEl.setAttribute('aria-label', t('common.lang.aria'));
    btnEl.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/></svg>' +
      '<span class="lang-cur">' + nameOf(current) + '</span>' +
      '<svg class="lang-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

    menuEl = document.createElement('div');
    menuEl.className = 'lang-menu';
    menuEl.setAttribute('role', 'listbox');
    LOCALES.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.dataset.code = l.code;
      b.textContent = l.name;
      b.addEventListener('click', function () {
        setLang(l.code);
        close();
      });
      menuEl.appendChild(b);
    });

    boxEl.appendChild(btnEl);
    boxEl.appendChild(menuEl);

    btnEl.addEventListener('click', function (e) {
      e.stopPropagation();
      boxEl.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (boxEl && !boxEl.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    /* index.html 顶栏：插在最前（深色按钮前）；子站 topbar：插在「免费下载」按钮前 */
    var anchor = host.querySelector('.tcta') || host.querySelector('.theme-btn');
    if (anchor && anchor.parentNode === host) host.insertBefore(boxEl, anchor);
    else host.appendChild(boxEl);

    refreshActive();
    updateSwitcherLabel();
  }

  function refreshActive() {
    if (!menuEl) return;
    menuEl.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.code === current);
    });
  }

  function updateSwitcherLabel() {
    if (!btnEl) return;
    btnEl.setAttribute('aria-label', t('common.lang.aria'));
    var cur = btnEl.querySelector('.lang-cur');
    if (cur) cur.textContent = nameOf(current);
  }

  function close() { if (boxEl) boxEl.classList.remove('open'); }

  /* ---------- 切换语言 ---------- */
  function setLang(code) {
    if (!dict[code] || code === current) { refreshActive(); return; }
    current = code;
    try { localStorage.setItem(LANG_KEY, code); } catch (e) { /* 忽略 */ }
    apply();
    refreshActive();
    /* 通知页面重绘 JS 动态文案（index.html 下载区） */
    if (typeof window.__siteRepaint === 'function') window.__siteRepaint();
  }

  /* ---------- 样式（自注入，两套页面模板都能用） ---------- */
  function injectStyle() {
    var css = [
      '.lang-switch{position:relative;flex-shrink:0}',
      '.lang-btn{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 11px;border-radius:11px;',
        'border:1px solid var(--border,rgba(15,23,42,.12));background:transparent;color:var(--muted,#5b6b83);',
        'font-size:13px;font-weight:600;cursor:pointer;transition:background .2s;font-family:inherit;line-height:1}',
      '.lang-btn:hover{background:rgba(148,163,184,.15);color:var(--text,var(--muted,#5b6b83))}',
      '.lang-cur{max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lang-chev{opacity:.6}',
      '.lang-menu{position:absolute;top:calc(100% + 8px);right:0;min-width:148px;display:none;z-index:300;',
        'background:var(--card,#fff);border:1px solid var(--border,rgba(15,23,42,.12));border-radius:12px;',
        'box-shadow:0 14px 34px -10px rgba(15,23,42,.28);padding:6px}',
      '.lang-switch.open .lang-menu{display:block}',
      '.lang-menu button{display:flex;align-items:center;width:100%;border:0;background:transparent;cursor:pointer;',
        'padding:8px 12px;border-radius:8px;font-size:13.5px;color:var(--text,#0f172a);text-align:left;font-family:inherit}',
      '.lang-menu button:hover{background:rgba(148,163,184,.14)}',
      '.lang-menu button.active{color:var(--primary,#1d7ef0);font-weight:700;background:rgba(29,126,240,.08)}',
      '@media (max-width:860px){.lang-cur{max-width:64px}}'
    ].join('');
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------- 启动 ---------- */
  function init() {
    injectStyle();
    apply();
    buildSwitcher();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ---------- 对外 API ---------- */
  window.SiteI18n = {
    t: t,
    apply: apply,
    setLang: setLang,
    getLang: function () { return current; },
    locales: LOCALES
  };
})();
