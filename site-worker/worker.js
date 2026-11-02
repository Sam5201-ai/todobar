/**
 * Todobar 下载页子域名代理 Worker
 * 作用:让 https://todobar.tuanzhang.site 直接打开 Todobar 下载落地页
 *      (实际内容由 https://todobar-app.app.workbuddy.host 提供)
 *
 * 部署方法(和 todobar-sync 相同流程):
 * 1. Cloudflare 控制台 → Workers 和 Pages → 创建 → 创建 Worker
 *    名字填 todobar-site(可自定),点"部署"
 * 2. 点"编辑代码",全选删除后粘贴本文件全部内容,再点"部署"
 * 3. 该 Worker → 设置 → 域和路由 → 添加自定义域 → 填 todobar.tuanzhang.site
 * 4. 等待证书生效(几十秒),浏览器打开 https://todobar.tuanzhang.site 即可
 *
 * 想换别的子域名(如 download.tuanzhang.site),
 * 只需在第 3 步填对应域名即可,代码不用改。
 */

const UPSTREAM = 'https://todobar-app.app.workbuddy.host';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = UPSTREAM + url.pathname + url.search;

    // 静态资源请求直接转发
    const resp = await fetch(target, { redirect: 'follow' });

    const headers = new Headers(resp.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(resp.body, { status: resp.status, headers });
  },
};
