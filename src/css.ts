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
.head h1{font:600 1.85rem/1.15 var(--text);margin:0;overflow-wrap:break-word}
.head h1 .nsl{font-weight:400;color:var(--ink-soft);text-decoration:none}
@media(hover:hover){.head h1 a.nsl:hover{text-decoration:underline;text-decoration-color:var(--fog-deep)}}
.head h1 .sep{font-weight:400;color:var(--fog-deep);margin:0 .28em}
.head h1 .sub{font-weight:400;font-size:1.1rem;color:var(--ink-soft)}
.under{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:.25rem 1.5rem;margin-top:.4rem}
.facts{font:13px/1.7 var(--mono);color:var(--bark);margin:0;font-variant-numeric:tabular-nums;overflow-wrap:break-word}
.facts a{color:inherit}
.acts{display:flex;flex-wrap:wrap;gap:0 1.1rem;margin:0;padding:0;list-style:none;font:14px/1.6 var(--mono)}
.acts a{display:inline-block;padding:.5rem 0;color:var(--ink-soft);text-decoration:none}
@media(hover:hover){.acts a:hover{color:var(--ink);text-decoration:underline}}
h1{font:600 1.45rem/1.25 var(--text);margin:0 0 .6rem;text-wrap:balance}
h2{font:600 1.1rem/1.3 var(--text);margin:2.25rem 0 .75rem;text-wrap:balance;scroll-margin-top:1rem}
article{max-width:42rem;overflow-wrap:break-word;overflow-x:auto}
article code{white-space:nowrap}
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
.prompt{max-width:42rem;display:flex;align-items:flex-start;gap:.4rem;padding:.6rem .4rem .6rem .9rem}
.prompt code{flex:1;min-width:0;font:15px/1.55 var(--mono);overflow-wrap:break-word;padding:.35rem 0}
.seg{display:inline-flex;border:1px solid var(--bark);border-radius:2px;overflow:hidden;font:14px/1 var(--mono)}
.seg a{padding:.6rem .8rem;color:var(--ink-soft);text-decoration:none}
.seg a.on{background:var(--ink);color:var(--paper)}
@media(hover:hover){.seg a:not(.on):hover{background:var(--paper-deep);color:var(--ink)}}
.raw{font:14px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:break-word;margin:0}
.raw.cols{white-space:pre;overflow-x:auto;font-size:13px}
.raw b{font-weight:700}
.raw .ph{color:var(--bark);font-style:italic}
.man{font:14px/1.6 var(--mono);max-width:52rem;overflow-wrap:break-word}
.man p{margin:0 0 .6rem}
.man h3{font:600 15px/1.4 var(--text);margin:1.25rem 0 .4rem}
.man ul{margin:0 0 .6rem;padding-left:1.2rem}
.man .g{display:grid;grid-template-columns:7.5rem minmax(0,1fr);column-gap:1rem;padding:.25rem 0}
.man .verb{font-weight:700;color:var(--ink)}
.man .sig{overflow-wrap:break-word}
.man .m{color:var(--bark)}
.man .ex{grid-column:2;color:var(--ink-soft)}
.man .ph{color:var(--bark);font-style:italic}
.h1row{display:flex;align-items:center;justify-content:space-between;gap:1rem}
button.icon{width:40px;height:40px;min-height:0;padding:0;margin:0;border:0;border-radius:2px;background:transparent;color:var(--ink-soft);display:inline-grid;place-items:center;flex:none}
@media(hover:hover){button.icon:hover{color:var(--ink);background:var(--paper-deep)}.well button.icon:hover{background:var(--paper)}}
ol.path{list-style:none;margin:0;padding:0 0 0 1.75rem}
ol.path li{position:relative;display:grid;grid-template-columns:6.4rem minmax(0,1fr) auto;column-gap:.75rem;align-items:baseline;padding:.4rem 0}
ol.path .n{position:absolute;left:calc(.5px - 1.75rem);top:calc(.4rem + 6px);width:11px;height:11px;border:1.5px solid var(--ink);background:var(--paper)}
ol.path li::before,ol.path li::after{content:"";position:absolute;left:calc(7px - 1.75rem);border-left:1px dashed var(--bark)}
ol.path li::before{top:0;height:calc(.4rem + 6px)}
ol.path li::after{top:calc(.4rem + 20px);bottom:0}
ol.path li:first-child::before,ol.path li:last-child::after{display:none}
ol.path li.now .n{background:var(--seal);border-color:var(--seal)}
ol.path li.redacted .n{background:var(--bark);border-color:var(--bark)}
ol.path li.redacted .what{text-decoration:line-through;color:var(--ink-soft)}
.t{font:14px/1.6 var(--mono);color:var(--bark);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.what{min-width:0;overflow-wrap:break-word}
.note{color:var(--ink-soft);margin-left:.5rem}
ol.path .facts{grid-column:3;text-align:right;white-space:nowrap}
ol.path.rows li{grid-template-columns:minmax(0,1fr) auto}
ol.path.rows .facts{grid-column:2}
ol.path .body :is(p,ul,ol){margin:0;display:inline}
dl.fm{display:grid;grid-template-columns:max-content 1fr;gap:.15rem 1rem;font:15px/1.6 var(--mono);margin:0 0 1.25rem}
dl.fm dt{color:var(--ink-soft)}dl.fm dd{margin:0;overflow-wrap:break-word}
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
.receipt pre{margin:0;padding:1rem 5.5rem 1rem 1rem;white-space:pre-wrap;overflow-wrap:break-word}
.receipt .stamp{position:absolute;right:.9rem;top:-.7rem;width:66px;height:66px;transform:rotate(-8deg)}
.empty{text-align:center;max-width:34rem;margin:1rem auto}
.empty .mono{overflow-wrap:break-word}
footer{border-top:1px solid var(--fog);padding:1rem 0 0;font:14px/1.6 var(--mono);color:var(--ink-soft);display:flex;flex-wrap:wrap;gap:.25rem 1.25rem}
p.notice{font:14px/1.6 var(--mono);color:var(--ink-soft);margin:0 0 1rem}
.more{font:15px/1.6 var(--mono);margin:1rem 0 0}
@media(max-width:40rem){body{padding:0 .9rem 2rem}main{padding:1.4rem 1rem 1.5rem}.head h1{font-size:1.5rem}.wm{order:-2}.seg{order:-1;margin-left:auto}header nav{margin-left:0}ol.path li{grid-template-columns:5.9rem minmax(0,1fr)}.t{font-size:13px}ol.path .facts{grid-column:2;text-align:left;white-space:normal}ol.path.rows li{grid-template-columns:1fr}ol.path.rows .facts{grid-column:1}.man .g{grid-template-columns:minmax(0,1fr)}.man .ex{grid-column:1}}
@media(prefers-reduced-motion:reduce){button:active,input[type=submit]:active{transform:none}}
`.trim();
