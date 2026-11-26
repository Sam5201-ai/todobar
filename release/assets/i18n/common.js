/* ============================================================
   Tacco 下载站 · 公共词条（顶栏导航 / CTA / 页脚 / 语言切换器）
   5 个公开页面共用。zh-CN 为真源，与应用内译法保持一致。
   ============================================================ */
(function () {
  var D = window.SITE_I18N_DICT = window.SITE_I18N_DICT || {};
  D['zh-CN'] = D['zh-CN'] || {}; D['zh-TW'] = D['zh-TW'] || {}; D.en = D.en || {}; D.ja = D.ja || {}; D.ko = D.ko || {};

  Object.assign(D['zh-CN'], {
    'common.nav.home': '首页',
    'common.nav.features': '功能',
    'common.nav.compare': '对比',
    'common.nav.faq': '常见问题',
    'common.nav.changelog': '更新日志',
    'common.nav.terms': '服务条款',
    'common.nav.privacy': '隐私协议',
    'common.tcta': '免费下载',
    'common.lang.aria': '切换语言'
  });

  Object.assign(D['zh-TW'], {
    'common.nav.home': '首頁',
    'common.nav.features': '功能',
    'common.nav.compare': '對比',
    'common.nav.faq': '常見問題',
    'common.nav.changelog': '更新日誌',
    'common.nav.terms': '服務條款',
    'common.nav.privacy': '隱私權政策',
    'common.tcta': '免費下載',
    'common.lang.aria': '切換語言'
  });

  Object.assign(D.en, {
    'common.nav.home': 'Home',
    'common.nav.features': 'Features',
    'common.nav.compare': 'Compare',
    'common.nav.faq': 'FAQ',
    'common.nav.changelog': 'Changelog',
    'common.nav.terms': 'Terms',
    'common.nav.privacy': 'Privacy',
    'common.tcta': 'Free Download',
    'common.lang.aria': 'Switch language'
  });

  Object.assign(D.ja, {
    'common.nav.home': 'ホーム',
    'common.nav.features': '機能',
    'common.nav.compare': '比較',
    'common.nav.faq': 'よくある質問',
    'common.nav.changelog': '更新履歴',
    'common.nav.terms': '利用規約',
    'common.nav.privacy': 'プライバシー',
    'common.tcta': '無料ダウンロード',
    'common.lang.aria': '言語を切り替える'
  });

  Object.assign(D.ko, {
    'common.nav.home': '홈',
    'common.nav.features': '기능',
    'common.nav.compare': '비교',
    'common.nav.faq': '자주 묻는 질문',
    'common.nav.changelog': '업데이트 로그',
    'common.nav.terms': '서비스 약관',
    'common.nav.privacy': '개인정보 처리방침',
    'common.tcta': '무료 다운로드',
    'common.lang.aria': '언어 변경'
  });
})();
