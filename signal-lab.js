'use strict';
const fs=require('node:fs');
const path=require('node:path');
function createLab({initial=null,save=()=>{},now=Date.now,enabled=true,error=""}={}){
  const config=Object.freeze({symbol:"BTCUSDT",capital:1000,margin:100,leverage:100,tp:13,sl:17,fee:0,maxGapMs:6000});
  const labels={up_early:"回升起步",up_elapsed:"回升已发生",down_early:"回落起步",down_elapsed:"回落已发生"};
  const codes=Object.keys(labels);
  const fresh=()=>({version:1,startedAt:now(),accounts:Object.fromEntries(codes.map(code=>[code,{balance:1000,wins:0,losses:0,invalid:0,skipped:0,observedNet:0,peak:1000,maxDrawdown:0,bySymbol:{},positions:{},lastTurn:{}}])),history:[]});
  const s=initial||fresh();
  if(s.version!==1||!s.accounts||!Array.isArray(s.history)||codes.some(k=>!s.accounts[k]||!Number.isFinite(s.accounts[k].balance)||!s.accounts[k].positions||!s.accounts[k].lastTurn||!s.accounts[k].bySymbol))throw Error("模拟记录格式不兼容");
  let failure=error,alive=enabled&&!error,latestAt=0;
  const round=x=>Math.round(x*10000)/10000;
  const used=a=>Object.values(a.positions).reduce((n,p)=>n+p.margin,0);
  function persist(){if(!alive)return;try{save(s)}catch(e){failure="保存失败，已暂停模拟："+String(e.message||e).slice(0,120);alive=false}}
  function stat(a,symbol){return a.bySymbol[symbol]||(a.bySymbol[symbol]={wins:0,losses:0,invalid:0,skipped:0,net:0,observedNet:0})}
  function finish(code,symbol,p,at,reason,price=null,observed=null){
    const a=s.accounts[code],b=stat(a,symbol);
    const pnl=reason==="tp"?config.tp:reason==="sl"?-config.sl:0;
    delete a.positions[symbol];
    if(reason==="tp"){a.wins++;b.wins++}
    else if(reason==="sl"){a.losses++;b.losses++}
    else {a.invalid++;b.invalid++}
    a.balance=round(a.balance+pnl);b.net=round(b.net+pnl);
    if(observed!==null){a.observedNet=round(a.observedNet+observed);b.observedNet=round(b.observedNet+observed)}
    a.peak=Math.max(a.peak,a.balance);a.maxDrawdown=Math.max(a.maxDrawdown,round(a.peak-a.balance));
    s.history.unshift({code,label:labels[code],symbol,turnAt:p.turnAt,detectedAt:p.detectedAt,entryAt:p.entryAt??null,entry:p.entry??null,exitAt:at,exit:price,reason,pnl:reason==="tp"||reason==="sl"?pnl:null,observedPnl:observed});
    if(s.history.length>2000)s.history.length=2000;
  }
  // A restart cannot recreate the unseen path. Never count an interrupted position as a winner.
  if(alive){let changed=false;for(const code of codes)for(const [sym,p] of Object.entries(s.accounts[code].positions)){finish(code,sym,p,now(),"restart");changed=true}if(changed)persist()}
  function scan(symbol,view,t=now()){
    if(symbol!==config.symbol)return false;
    if(!alive||!view?.ready||!Number.isFinite(view.latestAt)||t-view.latestAt>config.maxGapMs||view.latestAt>t+1000)return false;
    const code=view.phase?.code,turn=view.phase?.turnAt;
    if(!codes.includes(code)||!Number.isFinite(turn)||turn>view.latestAt||view.latestAt-turn>60000)return false;
    const a=s.accounts[code];
    if((a.lastTurn[symbol]??-Infinity)>=turn)return false;
    a.lastTurn[symbol]=turn;
    if(a.positions[symbol]||a.balance-used(a)<config.margin){a.skipped++;stat(a,symbol).skipped++;persist();return false}
    // Reserve virtual margin and wait for the next fresh public trade, not a retrospectively selected price.
    a.positions[symbol]={symbol,code,turnAt:turn,detectedAt:t,afterAt:view.latestAt,margin:config.margin,entry:null,lastAt:t};
    persist();return true;
  }
  function trade(symbol,price,at,t=now()){
    if(symbol!==config.symbol)return;
    if(!alive||!Number.isFinite(price)||price<=0||!Number.isFinite(at)||t-at>config.maxGapMs||at>t+1000)return;
    latestAt=Math.max(latestAt,at);let changed=false;
    for(const code of codes){
      const p=s.accounts[code].positions[symbol];if(!p)continue;
      if(p.entry===null){
        if(t-p.detectedAt>config.maxGapMs){finish(code,symbol,p,t,"gap");changed=true;continue}
        if(at<p.afterAt||at<p.detectedAt-1000)continue;
        p.entry=price;p.entryAt=at;p.lastAt=at;changed=true;continue;
      }
      if(at<p.lastAt)continue;
      if(at-p.lastAt>config.maxGapMs){finish(code,symbol,p,t,"gap");changed=true;continue}
      p.lastAt=at;
      const raw=(code.startsWith("up")?1:-1)*(price/p.entry-1)*p.margin*config.leverage;
      if(raw>=config.tp-1e-8||raw<=-config.sl+1e-8){finish(code,symbol,p,at,raw>0?"tp":"sl",price,round(raw));changed=true}
    }
    if(changed)persist();
  }
  function sweep(t=now()){
    if(!alive)return;let changed=false;
    for(const code of codes)for(const [sym,p] of Object.entries(s.accounts[code].positions))if(t-p.lastAt>config.maxGapMs){finish(code,sym,p,t,"gap");changed=true}
    if(changed)persist();
  }
  function snapshot(t=now()){
    return {version:"swing-signal-lab-btc-v1",symbol:config.symbol,config,startedAt:s.startedAt,serverAt:t,latestAt,enabled:alive,error:failure,
      accounts:codes.map(code=>{const a=s.accounts[code],count=a.wins+a.losses;return {code,label:labels[code],balance:a.balance,net:round(a.balance-config.capital),reserved:used(a),active:Object.keys(a.positions).length,wins:a.wins,losses:a.losses,invalid:a.invalid,skipped:a.skipped,observedNet:a.observedNet,maxDrawdown:a.maxDrawdown,winRate:count?round(a.wins/count*100):null,bySymbol:a.bySymbol}}),
      history:s.history.slice(0,100)};
  }
  return {scan,trade,sweep,snapshot,flush:persist};
}
const PAGE="<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>实时模拟 BTCUSDT · Pro v9</title><style>\n*{box-sizing:border-box}body{margin:0;background:#f6f8fc;color:#192331;font:15px system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:18px}a{color:#235dc6}h1{font-size:24px;margin:14px 0 6px}p{color:#596575;line-height:1.6}#cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{padding:16px;border:1px solid #e0e6ee;border-radius:14px;background:white}.card h2{font-size:16px;margin:0 0 10px}.big{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}.muted{font-size:12px;color:#667282;line-height:1.7}.row{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid #edf0f4}.table{overflow:auto;background:white;border:1px solid #e0e6ee;border-radius:12px}table{border-collapse:collapse;width:100%;white-space:nowrap;font-size:12px}th,td{padding:10px;border-bottom:1px solid #e9edf3;text-align:left}.good{color:#16834d}.bad{color:#c43333}#status{color:#516072}\n</style></head><body><main><a href=\"/\">← 返回行情首页</a><h1>实时模拟 · BTCUSDT</h1><p>仅测试币安 BTCUSDT 永续 · 独立虚拟研究账本 · 不连接账户、不提供下单、充值或提现。只统计原有四种波段阶段出现后，公开成交路径触及假设盈亏阈值的结果。</p><div class=\"card\"><strong>每类初始 1,000 U · 单样本 100 U · 假设 100× · +13 / −17 U · 手续费 0</strong><p class=\"muted\">理论余额以固定阈值结算；另列首次观察到穿越阈值的价格对应盈亏。不是实际可成交收益，不含真实滑点、点差、资金费率及强平规则。断流或重启时样本作废，不计胜负；余额不足100 U时不再接受新样本。保本胜率约56.67%（理想固定盈亏，不计无效样本）。</p><div id=\"status\">等待接口…</div></div><h2>四类独立账户</h2><div id=\"cards\"></div><h2>最近完成的研究样本</h2><p class=\"muted\">历史仅显示最近100条，账户累计统计保留。未完成样本不计胜率。</p><div class=\"table\"><table><thead><tr><th>时间</th><th>阶段</th><th>合约</th><th>结果</th><th>理论盈亏 U</th><th>观测穿越盈亏 U</th></tr></thead><tbody id=\"rows\"></tbody></table></div></main><script>\nconst $=x=>document.getElementById(x),money=x=>Number(x).toFixed(2),signed=x=>x==null?\"—\":(x>0?\"+\":\"\")+money(x);\nfunction el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}\nfunction line(p,k,v){const r=el(\"div\",undefined,\"row\");r.append(el(\"span\",k),el(\"b\",v));p.append(r)}\nlet busy=false;async function refresh(){if(busy)return;busy=true;try{const res=await fetch(\"/api/pro2/signal-lab\",{cache:\"no-store\"});if(!res.ok)throw Error(\"HTTP \"+res.status);const d=await res.json();$(\"status\").textContent=!d.enabled?(\"已暂停：\"+(d.error||\"未启用\")):d.latestAt&&d.serverAt-d.latestAt<=6000?\"正在采集公开成交 · \"+new Date(d.latestAt).toLocaleTimeString():\"等待新鲜公开成交 · 无有效价格时不产生样本\";const cards=d.accounts.map(a=>{const c=el(\"section\",undefined,\"card\");c.append(el(\"h2\",a.label),el(\"div\",money(a.balance)+\" U\",\"big\"),el(\"p\",\"理论累计盈亏 \"+signed(a.net)+\" U\",a.net>=0?\"good\":\"bad\"));line(c,\"止盈 / 止损\",a.wins+\" / \"+a.losses);line(c,\"已完成样本\",a.wins+a.losses);line(c,\"理论胜率\",a.winRate==null?\"样本不足\":a.winRate.toFixed(2)+\"%\");line(c,\"进行中 / 占用虚拟保证金\",a.active+\" / \"+money(a.reserved)+\" U\");line(c,\"中断作废 / 跳过\",a.invalid+\" / \"+a.skipped);line(c,\"最大已结算回撤\",money(a.maxDrawdown)+\" U\");line(c,\"穿越价格累计盈亏\",signed(a.observedNet)+\" U\");for(const [sym,b] of Object.entries(a.bySymbol))line(c,sym,b.wins+\"胜 \"+b.losses+\"负 · \"+signed(b.net)+\" U\");return c});$(\"cards\").replaceChildren(...cards);const names={tp:\"触及止盈\",sl:\"触及止损\",gap:\"断流作废\",restart:\"重启作废\"};$(\"rows\").replaceChildren(...d.history.map(h=>{const tr=el(\"tr\");for(const x of [new Date(h.exitAt).toLocaleString(),h.label,h.symbol,names[h.reason]||h.reason,signed(h.pnl),signed(h.observedPnl)])tr.append(el(\"td\",x));return tr}));}catch(e){$(\"status\").textContent=\"接口暂不可用；未确认实时状态。\"}finally{busy=false}}\nrefresh();setInterval(refresh,2000);</script></body></html>";
function openSignalLab({file,log=()=>{}}){
 let initial=null,error='';
 try{if(fs.existsSync(file))initial=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){error='无法读取已有记录，已暂停：'+e.message;}
 const save=state=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,file)};
 try{return createLab({initial,save,error})}catch(e){log('SIGNAL_LAB '+e.message);return createLab({enabled:false,error:'已有记录不兼容，已暂停：'+e.message})}
}
module.exports={openSignalLab,createLab,PAGE};
