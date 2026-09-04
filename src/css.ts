// The stylesheet. Paper, ink, one red. Tokens and materials are in docs/BRAND.md; every color here
// is one of its hex values. Fonts are self-hosted latin subsets in public/fonts (OFL).

export const CSS = `
@font-face{font-family:Literata;font-style:normal;font-weight:400 700;font-display:swap;src:url(/fonts/literata-normal-400-700.woff2) format("woff2")}
@font-face{font-family:Literata;font-style:italic;font-weight:400 700;font-display:swap;src:url(/fonts/literata-italic-400-700.woff2) format("woff2")}
@font-face{font-family:"Courier Prime";font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/courier-prime-normal-400.woff2) format("woff2")}
@font-face{font-family:"Courier Prime";font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/courier-prime-normal-700.woff2) format("woff2")}
@font-face{font-family:"Courier Prime";font-style:italic;font-weight:400;font-display:swap;src:url(/fonts/courier-prime-italic-400.woff2) format("woff2")}
:root{color-scheme:light;--paper:#e8dcc7;--paper-deep:#dfd2bf;--fog:#c7bcac;--fog-deep:#ab9d90;--ink:#282620;--ink-soft:#464133;--bark:#5e5846;--seal:#ab462f;--seal-deep:#963d29;--text:Literata,Georgia,"Times New Roman",serif;--mono:"Courier Prime","Courier New",Courier,monospace}
*{box-sizing:border-box}
html{background:var(--paper);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
body{margin:0 auto;max-width:58rem;padding:0 1.25rem 2.5rem;font:17px/1.55 var(--text);color:var(--ink);text-wrap:pretty}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--fog-deep);text-underline-offset:.18em;text-decoration-thickness:1px}
@media(hover:hover){a:hover{text-decoration-color:var(--ink)}}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.skip{position:absolute;left:-999px;top:0;padding:.5rem 1rem;background:var(--ink);color:var(--paper);font:15px var(--mono)}
.skip:focus{left:1rem;top:1rem;z-index:1}
header{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;align-items:baseline;padding:1.1rem 0 .7rem;border-bottom:1px solid var(--fog)}
.wm{display:inline-flex;align-items:center;gap:.55rem;font:600 1.15rem/1 var(--text);text-decoration:none}
.wm svg{width:22px;height:22px;flex:none}
header nav{display:flex;flex-wrap:wrap;gap:.25rem 1.1rem;margin-left:auto;font:15px/1.4 var(--mono)}
header nav a{text-decoration:none;padding:.6rem 0}
@media(hover:hover){header nav a:hover{text-decoration:underline}}
main{position:relative;margin:1.25rem 0;padding:2rem 1.75rem 2.25rem}
.tk{position:absolute;width:14px;height:14px;border:0 solid var(--ink)}
.tk.a{top:0;left:0;border-width:1px 0 0 1px}.tk.b{top:0;right:0;border-width:1px 1px 0 0}.tk.c{bottom:0;left:0;border-width:0 0 1px 1px}.tk.d{bottom:0;right:0;border-width:0 1px 1px 0}
.head{margin:0 0 1.6rem}
.ns{font:14px/1.4 var(--mono);color:var(--ink-soft);margin:0 0 .2rem}
.head h1{font:600 1.85rem/1.15 var(--text);margin:0;overflow-wrap:anywhere}
.head h1 .sub{font-weight:400;font-size:1.1rem;color:var(--ink-soft)}
.under{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:0 1.5rem;margin-top:.35rem}
.facts{font:13px/1.7 var(--mono);color:var(--bark);margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.facts a{color:inherit}
.acts{display:flex;flex-wrap:wrap;gap:0 1.1rem;margin:0;padding:0;list-style:none;font:14px/1.6 var(--mono)}
.acts a{display:inline-block;padding:.5rem 0;color:var(--ink-soft);text-decoration:none}
@media(hover:hover){.acts a:hover{color:var(--ink);text-decoration:underline}}
h1{font:600 1.45rem/1.25 var(--text);margin:0 0 .6rem;text-wrap:balance}
h2{font:600 1.1rem/1.3 var(--text);margin:2.25rem 0 .75rem;text-wrap:balance}
article{max-width:42rem;overflow-wrap:anywhere}
article :is(p,ul,ol,blockquote){margin:0 0 1rem}
article h1,article h2,article h3{margin-top:1.4rem}
.well,article pre{background:var(--paper-deep);padding:.85rem 1rem;border-radius:2px;overflow-x:auto}
code,pre,kbd{font:15px/1.5 var(--mono)}
.mono{font:15px/1.6 var(--mono)}
figure{margin:0 0 1.25rem}
.hero img{display:block;width:100%;height:auto}
.spot{display:block;width:min(24rem,100%);height:auto;margin:0 auto .75rem}
.tag{font:600 1.6rem/1.25 var(--text);margin:.25rem 0 .5rem;text-wrap:balance}
.lede{max-width:42rem;margin:0 0 1rem}
.agent{max-width:42rem;margin:0 0 1.5rem}
.agent p{margin:0 0 .5rem}
.agent code{overflow-wrap:anywhere;background:var(--paper-deep);padding:.15rem .4rem;border-radius:2px}
.h2row{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1rem;margin:2.25rem 0 .75rem}
.h2row h2{margin:0}
button.copy{min-height:40px;padding:0 .9rem;font-size:14px;font-weight:400;margin:0}
ol.path .line{display:block}
ol.path{list-style:none;margin:0;padding:0 0 0 1.75rem;position:relative}
ol.path::before{content:"";position:absolute;left:.5rem;top:1rem;bottom:1rem;border-left:1px dashed var(--bark)}
ol.path li{position:relative;padding:.5rem 0;overflow-wrap:anywhere}
ol.path .where{margin-right:.6rem}
ol.path .note{color:var(--ink-soft)}
ol.path li .facts{display:block;margin-top:.05rem}
ol.path li.day{padding:1.1rem 0 .2rem;font:13px/1.4 var(--mono);color:var(--bark)}
ol.path li.day::before{display:none}
ol.path li:first-child.day{padding-top:.2rem}
ol.path.rows li{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:.1rem 1rem}ol.path.rows .body{flex:1 1 16rem;min-width:0}ol.path.rows li .facts{display:inline;margin:0}
ol.path li::before{content:"";position:absolute;left:-1.5rem;top:1rem;width:11px;height:11px;border:1.5px solid var(--ink);background:var(--paper)}
ol.path.live li:first-child::before{background:var(--seal);border-color:var(--seal)}
ol.path li.redacted::before{background:var(--bark);border-color:var(--bark)}
ol.path li.redacted .body{text-decoration:line-through;color:var(--ink-soft)}
.mono,code,pre{font-variant-numeric:tabular-nums}
ol.path .body :is(p,ul,ol){margin:0;display:inline}
dl.fm{display:grid;grid-template-columns:max-content 1fr;gap:.15rem 1rem;font:15px/1.6 var(--mono);margin:0 0 1.25rem}
dl.fm dt{color:var(--ink-soft)}dl.fm dd{margin:0;overflow-wrap:anywhere}
form{max-width:42rem;margin:0 0 1.5rem}
label{display:block;font:15px/1.6 var(--mono);color:var(--ink-soft);margin:0 0 .9rem}
textarea,input{display:block;width:100%;margin:.3rem 0 0;padding:.55rem .7rem;font:16px/1.5 var(--mono);color:var(--ink);background:var(--paper-deep);border:1px solid var(--fog);border-radius:2px}
textarea{min-height:16rem;resize:vertical}
textarea:focus-visible,input:focus-visible{outline-offset:0;border-color:var(--ink)}
::placeholder{color:var(--bark);opacity:1}
button,input[type=submit]{width:auto;display:inline-block;font:700 16px/1 var(--mono);min-height:44px;padding:0 1.2rem;margin:.25rem .5rem 0 0;border:1.5px solid var(--ink);border-radius:2px;background:transparent;color:var(--ink);cursor:pointer}
button.seal{background:var(--seal);border-color:var(--seal);color:var(--paper)}
@media(hover:hover){button.seal:hover{background:var(--seal-deep);border-color:var(--seal-deep)}button:not(.seal):hover,input[type=submit]:hover{background:var(--paper-deep)}}
button:active,input[type=submit]:active{transform:scale(.96)}
.receipt{position:relative;max-width:42rem;margin:0 0 1rem}
.receipt pre{margin:0;padding:1rem 5.5rem 1rem 1rem;white-space:pre-wrap;overflow-wrap:anywhere}
.receipt .stamp{position:absolute;right:.9rem;top:-.7rem;width:66px;height:66px;transform:rotate(-8deg)}
.manual{white-space:pre;font:14px/1.55 var(--mono);margin:0}
.empty{text-align:center;max-width:34rem;margin:1rem auto}
.empty .mono{overflow-wrap:anywhere}
footer{border-top:1px solid var(--fog);padding:1rem 0 0;font:14px/1.6 var(--mono);color:var(--ink-soft);display:flex;flex-wrap:wrap;gap:.25rem 1.25rem}
p.notice{font:14px/1.6 var(--mono);color:var(--ink-soft);margin:0 0 1rem}
.more{font:15px/1.6 var(--mono);margin:1rem 0 0}
@media(max-width:40rem){body{padding:0 .9rem 2rem}main{padding:1.4rem 1rem 1.5rem}.head h1{font-size:1.5rem}}
@media(prefers-reduced-motion:reduce){button:active,input[type=submit]:active{transform:none}}
`.trim();
