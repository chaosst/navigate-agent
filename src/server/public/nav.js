/* ── 一级导航条折叠菜单的增强脚本（8 个 H5 页面共用这一份）───────────────────
 *
 * 刻意是「渐进增强」：不导出任何全局，页面脚本一行都不依赖它。
 * 它挂了 / 被拦了，菜单依然能点开（<details> 原生行为），只是少两个补丁：
 *   ① 点空白处 / 按 Esc 收起已展开的菜单
 *   ② 非管理员隐藏 data-admin-only 的入口（guest 点进去必然 403，不留死链）
 *
 * token 取法与各页脚本一致：URL 上的 ?token= 先落到 sessionStorage 再读，
 * 否则从 TUI 复制出来的链接会在这一步丢掉身份。
 */
(function () {
  "use strict";

  // ① 点空白处 / Esc 收起。
  // 注意时序：点击 <summary> 时，原生 toggle 是这次 click 的默认动作，发生在事件
  // 派发「之后」—— 所以这里读到的 d.open 还是旧值，跳过含本次点击的那个菜单即可，
  // 不要去手动 toggle，否则会和原生行为对冲（一次点击变两次翻转）。
  function closeAll(except) {
    document.querySelectorAll("details.nav-menu[open]").forEach(function (d) {
      if (d !== except) d.open = false;
    });
  }
  document.addEventListener("click", function (e) {
    var t = e.target;
    var inside = t && t.closest ? t.closest("details.nav-menu") : null;
    closeAll(inside);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAll(null);
  });

  // ② 仅管理员可见的入口
  try {
    var urlToken = new URLSearchParams(location.search).get("token");
    if (urlToken) sessionStorage.setItem("navigate_token", urlToken);
  } catch (e) { /* 隐私模式下 sessionStorage 可能抛错 —— 不该拖垮导航 */ }

  var token = null;
  try { token = sessionStorage.getItem("navigate_token"); } catch (e) { /* 同上 */ }

  var items = document.querySelectorAll("[data-admin-only]");
  if (!items.length || !token) return; // 无 token 时交给 requirePage 的 302 兜底

  fetch("/api/me?token=" + encodeURIComponent(token))
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me.isAdmin) items.forEach(function (el) { el.remove(); });
    })
    .catch(function () { /* 网络异常保留入口，服务端 403 兜底 */ });
})();
