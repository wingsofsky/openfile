/**
 * 注入进报告 srcdoc 的链接接管脚本（纯字符串、零依赖）。
 *
 * ⚠️ CSP hash 契约：srcdoc 文档会继承 app 壳的 CSP（tauri.conf.json
 * security.csp，script-src 无 unsafe-inline），本脚本靠壳 CSP 里的
 * 'sha256-…' 通行证才能在打包后的 WKWebView 里执行。**改动本字符串的
 * 任何一个字节，必须同步更新 tauri.conf.json 的 hash**——
 * htmlview.test.ts 的契约测试会在两者失配时变红。
 */
export const LINK_TAP_JS = `(function(){
document.addEventListener("click",function(e){
  var t=e.target; if(!t||!t.closest) return;
  var a=t.closest("a[href]"); if(!a) return;
  var raw=a.getAttribute("href")||""; if(!raw) return;
  if(raw.charAt(0)==="#"){
    e.preventDefault();
    var id=raw.slice(1); try{id=decodeURIComponent(id);}catch(_){/* 原样 */}
    var el=document.getElementById(id);
    if(!el){var byName=document.getElementsByName(id); el=byName&&byName[0];}
    if(el&&el.scrollIntoView) el.scrollIntoView();
    return;
  }
  e.preventDefault();
  if(window.parent) window.parent.postMessage({__openfile_link:raw},"*");
},true);
})();`;
