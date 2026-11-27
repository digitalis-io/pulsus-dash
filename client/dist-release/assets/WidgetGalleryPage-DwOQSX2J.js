const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/BoardPage-DwSGyJl1.js","assets/index-CFN7xQEI.js","assets/jsx-runtime-B4UN2VIk.js","assets/clsx-BZbxhBNB.js","assets/useLoadMoreSentinel-DkzBdnQv.js","assets/variableRefs-BJf1lxiA.js","assets/useTimeContext-CgUaMEz9.js","assets/hooks-B0qIYnkQ.js","assets/lib-BDFOREvo.js","assets/t-b1KZZgSW.js","assets/layout-UTbssZ--.js","assets/Button-BA3x1uvX.js","assets/cx-CykQDk87.js","assets/Button-cOnU7ERx.css","assets/index-DMhCC03R.css","assets/fieldMessages-9hxyxGj7.js","assets/SegmentedControl-B1rw7Fbq.js","assets/SegmentedControl-qnMK70n2.css","assets/useFormValidation-CMWSHr3d.js","assets/TextField-_iazg-I0.js","assets/ListBox-i1_rIvl1.js","assets/QueryFallback-CAcrgXG-.js","assets/esm-xX_fNqDQ.js","assets/esm-CO7ytI6g.css","assets/ContextSummary-Ro7jjhmU.js","assets/ContextSummary-DVQdpLc7.css","assets/QueryFallback-B3nuiZwy.css","assets/EmptyState-R_NulmuO.js","assets/EmptyState-fNAMlRVm.css","assets/TextField-DEnTNS2e.js","assets/TextField-BZfgn1x_.css","assets/Checkbox-Bc0miXQ6.js","assets/Checkbox-twcgDY1x.css","assets/ShareLinkControls-BXKqwAqg.js","assets/ShareLinkControls-Cusk0SgT.css","assets/useLogqlModules-BQh-ZXkv.js","assets/LogStream-BIxVtayr.js","assets/LogStream-CdbXmjKz.css","assets/querySize-3FX8oBx7.js","assets/MetricPicker-dBVeNoqC.js","assets/promMetadata-Dxk96ulU.js","assets/BoardPage-CrOIwRV5.css"])))=>i.map(i=>d[i]);
import{n as e,s as t,t as n}from"./jsx-runtime-B4UN2VIk.js";import{c as r}from"./hooks-B0qIYnkQ.js";import{t as i}from"./t-b1KZZgSW.js";import{t as a}from"./cx-CykQDk87.js";import{I as o,x as s}from"./index-CFN7xQEI.js";var c=t(e(),1),l={page:`_page_1aj30_2`,intro:`_intro_1aj30_9`,panels:`_panels_1aj30_14`,panel:`_panel_1aj30_14`,title:`_title_1aj30_29`,body:`_body_1aj30_36`,editor:`_editor_1aj30_43`},u=[`widget-text`,`widget-text-removals`];function d(e){return u.includes(e??``)?e:`widget-text`}var f=new Map([[`env`,`prod`]]),p=`# Checkout runbook ($env)

Use this page when the **checkout** service pages on-call. Start with the board, then the logs.

## First five minutes

1. Open [Service overview](/t/demo/board/b-1) and check the request rate and the error ratio.
2. Compare with the same window yesterday; a deploy shows as a step, not a slope.
3. If the error ratio is above *2 %*, page the payments team.

## Useful queries

- Rate: \`sum by (job) (rate(http_requests_total[5m]))\`
- Errors: \`sum(rate(http_requests_total{code=~"5.."}[5m]))\`
- Latency: \`histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))\`
- Saturation: \`max by (instance) (process_open_fds / process_max_fds)\`

> The p95 is the number the customers feel. A healthy p95 with a bad p99 means a slow
> dependency for a few requests, not an overloaded service.

## Mitigations

- Roll back the last deploy from the release tool.
- Shed the recommendations call: it is optional on the checkout path.
- Scale the API tier by two replicas; the database is rarely the limit.
- Turn off the promotions banner, which calls the pricing service on every page.

\`\`\`promql
sum by (instance) (rate(process_cpu_seconds_total{job="checkout"}[5m]))
\`\`\`

## After the incident

1. Confirm the error ratio has been below *0.5 %* for thirty minutes before you stand down.
2. Note the start, the detection, the mitigation and the end times in the incident record.
3. Link the deploy, the config change or the dependency that caused it, with the evidence.
4. Open follow-up issues for every alert that fired late, fired twice or did not fire at all.

## Known noisy signals

- The **cart-sync** job retries for five minutes after a cache flush; its errors are expected.
- Latency doubles during the nightly report export between 02:00 and 02:20 UTC.
- A single pod restart shows as a short gap in the rate panel, not as an outage.

---

Mail the [payments on-call](mailto:payments-oncall@example.test) before escalating an outage, and
read the [escalation policy](/t/demo/boards) for who to call. Write up every page within two days.
`,m=`sum by (job) (
  rate(http_requests_total{env="prod"}[5m])
)
/ ignoring (code) group_left
sum by (job) (rate(http_requests_total[5m]))`,h=[`# Release notes`,``,`<div class="banner">Maintenance tonight</div>`,``,`Deploys are <b>frozen</b> until Friday.`,``,`<iframe src="/status/embed"></iframe>`,``,`Open the [console](javascript:alert(1)) for details.`,``,`![Status](/api/status/badge.png)`,``,`Owner: $missing`,``,`${`> `.repeat(31)}Deeply quoted note.`,``].join(`
`),g=(e,t,n)=>({id:e,title:t,grid:{x:0,y:0,w:6,h:8},vis:{kind:`text`,options:n}});function _(e){return e===`widget-text-removals`?[g(`text-removals`,`Release notes`,{mode:`markdown`,content:h})]:[g(`text-runbook`,`Checkout runbook`,{mode:`markdown`,content:p}),g(`text-code`,`Error ratio query`,{mode:`code`,language:`promql`,content:m}),g(`text-empty`,`Notes`,{mode:`markdown`,content:``})]}var v=n();function y({m:e,panel:t}){let n=(0,c.useId)();return(0,v.jsxs)(`section`,{className:a(l.panel),"aria-labelledby":n,"data-gallery-id":t.id,children:[(0,v.jsx)(`h2`,{id:n,className:a(l.title),children:t.title}),(0,v.jsx)(`div`,{className:a(l.body),children:(0,v.jsx)(e.WidgetBody,{panel:t,headingId:n,editing:!1})})]})}function b({m:e,initial:t}){let[n,r]=(0,c.useState)(t),i=e.WIDGETS.defs.find(e=>e.kind===n.vis.kind)?.Editor;return i===void 0?null:(0,v.jsx)(`div`,{className:a(l.editor),"data-gallery-id":n.id,children:(0,v.jsx)(i,{panel:n,title:n.title,pointer:`/panels/0`,fields:[],readOnly:!1,original:t.vis,onVis:e=>{r(t=>({...t,vis:e}))}})})}var x=(0,c.lazy)(async()=>{let e=await o(()=>import(`./BoardPage-DwSGyJl1.js`).then(e=>e.t),__vite__mapDeps([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41]));function t({page:t}){let n=(0,c.useContext)(e.BoardRunContext),r=_(t);return(0,v.jsx)(e.BoardRunContext.Provider,{value:{...n,vars:f},children:(0,v.jsx)(`div`,{"data-widget-gallery":t,children:t===`widget-text-removals`?r.map(t=>(0,v.jsx)(b,{m:e,initial:t},t.id)):(0,v.jsx)(`div`,{className:a(l.panels),children:r.map(t=>(0,v.jsx)(y,{m:e,panel:t},t.id))})})})}return{default:t}});function S(){s(i(`widgetGallery.title`));let e=d(new URLSearchParams(r().search).get(`page`));return(0,v.jsxs)(`div`,{className:a(l.page),children:[(0,v.jsx)(`p`,{className:a(l.intro),children:i(`widgetGallery.intro`)}),(0,v.jsx)(c.Suspense,{fallback:(0,v.jsx)(`p`,{"aria-busy":`true`,children:i(`panel.loading`)}),children:(0,v.jsx)(x,{page:e})})]})}export{S as WidgetGalleryPage};