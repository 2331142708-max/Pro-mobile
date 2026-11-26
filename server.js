'use strict';
/** Contract Lens Pro — public market data only. No API keys, orders, or account data. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {URL}=require('node:url');
const {evaluateReview,COST}=require('./review');
const {evaluateTwenty}=require('./twenty');
const {createPaperTrader}=require('./paper');
const {createReviewHistory}=require('./forward-review');
const {VERSION:RULE_VERSION,binanceBar,receiveBars,analyze,buySell,startPatternFeed}=require('./pattern-feed');
const {createPro2}=require('./pro2-engine');
const {createPro2Trades}=require('./pro2-trades');

const PORT=Number(process.env.PORT||3088);
const ENABLE_LEGACY=false; // Five-contract mode: no legacy scanning or paper polling.
const FIVE_SYMBOLS=Object.freeze(['BTCUSDT','BTCUSDC','ETHUSDT','ETHUSDC','ZECUSDT']);
const allowedSymbol=s=>FIVE_SYMBOLS.includes(s);
const BINANCE=(process.env.BINANCE_BASE||'https://fapi.binance.com').replace(/\/$/,'');
const OKX=(process.env.OKX_BASE||'https://www.okx.com').replace(/\/$/,'');
const BINANCE_WS='wss://fstream.binance.com/market/stream?streams=';
const OKX_WS=process.env.OKX_WS||'wss://ws.okx.com/ws/v5/public';
const volumePath=process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dataPath=volumePath||path.join(__dirname,'data');
const DB_FILE=path.join(dataPath,'signals-five.json');
const reviewHistory=createReviewHistory({file:path.join(dataPath,'review-signals-five.json'),binance:BINANCE,okx:OKX,json});
const trial=JSON.parse(process.env.CONTRACT_LENS_PAPER_TRIAL||'null');
const allMultiple=process.env.CONTRACT_LENS_PAPER_ALL_MULTIPLE==='1';
const reverse=process.env.CONTRACT_LENS_PAPER_REVERSE==='1';
const paper=createPaperTrader({file:path.join(dataPath,reverse?'paper-reverse-orders-five.json':'paper-orders-five.json'),binance:BINANCE,okx:OKX,json,
  funding:reviewHistory.funding,quality:reviewHistory.paperQuality,durable:!!volumePath,log,trial,allMultiple,
  stoppedAt:Number(process.env.CONTRACT_LENS_PAPER_STOPPED_AT)||0,reverse});
const MARKETS=new Map();
const pro2=createPro2({markets:MARKETS,json,binance:BINANCE,okx:OKX,log,stopped:()=>stop,dataDir:dataPath,allowedSymbols:FIVE_SYMBOLS});

/* Read-only BTCUSDT signal lab imported from the supplied component's source
 * commit. Inlined to comply with the existing deployment file allowlist. */
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
  const lossLimit=500;
  const netTotal=()=>round(codes.reduce((n,k)=>n+s.accounts[k].balance-config.capital,0));
  function enforceLossLimit(t){if(!s.lossStoppedAt&&netTotal()<=-lossLimit){s.lossStoppedAt=t;return true}return false}
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
  if(alive){let changed=false;for(const code of codes)for(const [sym,p] of Object.entries(s.accounts[code].positions)){finish(code,sym,p,now(),"restart");changed=true}if(enforceLossLimit(now()))changed=true;if(changed)persist()}
  function scan(symbol,view,t=now()){
    if(symbol!==config.symbol||s.lossStoppedAt)return false;
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
      if(raw>=config.tp-1e-8||raw<=-config.sl+1e-8){finish(code,symbol,p,at,raw>0?"tp":"sl",price,round(raw));changed=true;if(enforceLossLimit(t))break}
    }
    if(s.lossStoppedAt){for(const code of codes)for(const [sym,p] of Object.entries(s.accounts[code].positions)){finish(code,sym,p,t,"loss_limit");changed=true}}
    if(changed)persist();
  }
  function sweep(t=now()){
    if(!alive)return;let changed=false;
    for(const code of codes)for(const [sym,p] of Object.entries(s.accounts[code].positions))if(t-p.lastAt>config.maxGapMs){finish(code,sym,p,t,"gap");changed=true}
    if(changed)persist();
  }
  function snapshot(t=now()){
    return {version:"swing-signal-lab-btc-v1",symbol:config.symbol,config,startedAt:s.startedAt,serverAt:t,latestAt,enabled:alive,error:failure,lossGuard:{limit:lossLimit,net:netTotal(),stoppedAt:s.lossStoppedAt||null},
      accounts:codes.map(code=>{const a=s.accounts[code],count=a.wins+a.losses;return {code,label:labels[code],balance:a.balance,net:round(a.balance-config.capital),reserved:used(a),active:Object.keys(a.positions).length,wins:a.wins,losses:a.losses,invalid:a.invalid,skipped:a.skipped,observedNet:a.observedNet,maxDrawdown:a.maxDrawdown,winRate:count?round(a.wins/count*100):null,bySymbol:a.bySymbol}}),
      history:s.history.slice(0,100)};
  }
  return {scan,trade,sweep,snapshot,flush:persist};
}

function openSignalLab({file,log=()=>{}}){
 let initial=null,error='';
 try{if(fs.existsSync(file))initial=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){error='无法读取已有记录，已暂停：'+e.message;}
 const save=state=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,file)};
 try{return createLab({initial,save,error})}catch(e){log('SIGNAL_LAB '+e.message);return createLab({enabled:false,error:'已有记录不兼容，已暂停：'+e.message})}
}


// Forward-only, unleveraged event study. Descriptive rules are research
// assumptions, not validated entries. No orders, money, or account balance.

// Fixed-horizon forward observational audit. No forecasts, leverage,
// execution, position sizing or selection of an optimal trading horizon.
function createHorizonAudit({initial=null,save=()=>{},now=Date.now,enabled=true,error=''}={}){
  const labels={ssr:'原SSR',exhaustion:'动能衰竭',failed_break:'假突破回归',absorption:'主动成交吸收',ofi:'订单流失衡（近似）',vwap:'VWAP均值回归'};
  const codes=Object.keys(labels),minutes=[2,3,4,5],gap=6000,flat=.005;
  const empty=()=>({n:0,same:0,opposite:0,flat:0,interrupted:0,sum:0,adverse:0,held:0});
  const fresh=()=>({version:1,startedAt:now(),models:Object.fromEntries(codes.map(k=>[k,{pending:null,lastEvent:0,skipped:0,windows:Object.fromEntries(minutes.map(m=>[m,empty()]))}])),history:[]});
  const st=initial||fresh();
  if(st.version!==1||!Array.isArray(st.history)||codes.some(k=>!st.models?.[k]||minutes.some(m=>!Number.isFinite(st.models[k].windows?.[m]?.n))))throw Error('周期复核记录不兼容');
  let alive=enabled&&!error,failure=error,latestAt=0;
  function persist(){if(!alive)return;try{save(st)}catch(e){alive=false;failure='保存失败，复核暂停：'+String(e.message||e).slice(0,100)}}
  function record(k,m,p,reason,at,value=null){
    const w=st.models[k].windows[m],valid=reason==='complete'&&Number.isFinite(value);
    if(valid){
      w.n++;w.sum+=value;w.adverse+=p.adverse;
      if(value>flat)w.same++;else if(value< -flat)w.opposite++;else w.flat++;
      if(value>flat&&p.adverse<=flat)w.held++;
    }else w.interrupted++;
    st.history.unshift({code:k,minutes:m,category:p.direction===1?'回升':'回落',endedAt:at,reason,change:valid?value:null,adverse:valid?p.adverse:null});
    st.history=st.history.slice(0,300);
  }
  function invalidate(k,reason,t){
    const model=st.models[k],p=model.pending;if(!p)return false;
    for(const m of minutes)if(!p.done[m])record(k,m,p,reason,t);
    model.pending=null;return true;
  }
  if(alive){let dirty=false;for(const k of codes)if(invalidate(k,'restart',now()))dirty=true;if(dirty)persist()}
  function event(k,direction,sourceAt,t=now()){
    if(!alive||!codes.includes(k)||![1,-1].includes(direction)||!Number.isFinite(sourceAt)||sourceAt<=0||sourceAt>t+1000||t-sourceAt>gap)return false;
    const model=st.models[k];if(sourceAt<=model.lastEvent)return false;
    model.lastEvent=sourceAt;
    if(model.pending){model.skipped++;persist();return false}
    // No retrospective fill. Reference is a subsequent real public print.
    model.pending={direction,sourceAt,detectedAt:t,entryAt:null,reference:null,lastAt:null,adverse:0,done:{}};
    persist();return true;
  }
  function trade(symbol,price,at,t=now()){
    if(!alive||symbol!=='BTCUSDT'||!Number.isFinite(price)||price<=0||!Number.isFinite(at)||at<=0||at>t+1000||t-at>gap||at<latestAt)return;
    latestAt=at;let changed=false;
    for(const k of codes){
      const model=st.models[k],p=model.pending;if(!p)continue;
      if(p.entryAt===null){
        if(t-p.detectedAt>gap){changed=invalidate(k,'gap',t)||changed;continue}
        if(at<=p.sourceAt)continue;
        p.entryAt=at;p.reference=price;p.lastAt=at;changed=true;continue;
      }
      if(at<p.lastAt)continue;
      if(at-p.lastAt>gap){changed=invalidate(k,'gap',t)||changed;continue}
      p.lastAt=at;
      const value=p.direction*100*(price/p.reference-1);
      p.adverse=Math.max(p.adverse,-value,0);
      for(const m of minutes){
        if(p.done[m]||at<p.entryAt+m*60000)continue;
        record(k,m,p,'complete',at,value);p.done[m]=true;changed=true;
      }
      if(p.done[5])model.pending=null;
    }
    if(changed)persist();
  }
  function sweep(t=now()){
    if(!alive)return;let changed=false;
    for(const k of codes){const p=st.models[k].pending;if(p&&t-(p.lastAt??p.detectedAt)>gap)changed=invalidate(k,'gap',t)||changed}
    if(changed)persist();
  }
  function snapshot(t=now()){
    return {enabled:alive,error:failure,startedAt:st.startedAt,latestAt,serverAt:t,models:codes.map(code=>{const m=st.models[code];return {code,label:labels[code],skipped:m.skipped,pending:!!m.pending,windows:minutes.map(minute=>{const w=m.windows[minute];return {minute,n:w.n,same:w.same,opposite:w.opposite,flat:w.flat,interrupted:w.interrupted,mean:w.n?w.sum/w.n:null,meanAdverse:w.n?w.adverse/w.n:null,held:w.held}})}}),history:st.history.slice(0,24)};
  }
  return {event,trade,sweep,snapshot,flush:persist};
}
function openHorizonAudit(file){
  let initial=null,error='';
  try{if(fs.existsSync(file))initial=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){error='已有复核记录无法读取'}
  const save=state=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,file)};
  try{return createHorizonAudit({initial,save,error})}catch(e){return createHorizonAudit({enabled:false,error:'复核记录格式不兼容'})}
}

const horizonAudit=openHorizonAudit(path.join(dataPath,'btc-horizon-audit-v1.json'));
function createShortStudy({initial=null,save=()=>{},now=Date.now,enabled=true,error='',onEvent=()=>{}}={}){
  const definitions={
    exhaustion:{label:'动能衰竭反转',note:'比较连续价格变化、成交额和主动成交力量是否减弱'},
    failed_break:{label:'假突破回归',note:'观察前区间被突破后是否实际返回区间'},
    absorption:{label:'主动成交吸收',note:'观察主动成交偏向与实际价格位移是否背离；不推断隐藏挂单'},
    ofi:{label:'订单流失衡（快照近似）',note:'买一卖一价格与数量变化、主动成交和价格变化；不等同全量挂撤单事件'},
    vwap:{label:'VWAP均值回归',note:'真实成交额/成交数量计算滚动VWAP；按震荡或方向性样本分别统计'}
  };
  const codes=Object.keys(definitions),horizon=60000,maxGap=6000;
  const stats=()=>({samples:0,aligned:0,opposite:0,flat:0,invalid:0,sum:0,absolute:0,byRegime:{},byDirection:{}});
  const fresh=()=>({version:1,startedAt:now(),models:Object.fromEntries(codes.map(k=>[k,{stats:stats(),pending:null,lastEventAt:0}])),history:[]});
  const state=initial||fresh();
  if(state.version!==1||!Array.isArray(state.history)||codes.some(k=>!state.models?.[k]?.stats))throw Error('研究记录不兼容');
  let alive=enabled&&!error,failure=error,latestAt=0,bookAt=0,lastTrade=null,previousBook=null;
  const buckets=[],books=[],ready={};
  function persist(){if(!alive)return;try{save(state)}catch(e){alive=false;failure='保存失败，研究暂停：'+String(e.message||e).slice(0,100)}}
  function result(st,value){
    st.samples++;st.sum+=value;st.absolute+=Math.abs(value);
    if(value>.005)st.aligned++;else if(value<-.005)st.opposite++;else st.flat++;
  }
  function finalize(key,reason,at,price=null){
    const m=state.models[key],p=m.pending;if(!p)return;
    const value=reason==='complete'&&Number.isFinite(price)&&p.price>0?p.direction*100*(price/p.price-1):null;
    if(value===null)m.stats.invalid++;
    else{
      result(m.stats,value);
      const regime=m.stats.byRegime[p.regime]||(m.stats.byRegime[p.regime]=stats());result(regime,value);
      const direction=p.direction>0?'回升':'回落',part=m.stats.byDirection[direction]||(m.stats.byDirection[direction]=stats());result(part,value);
    }
    state.history.unshift({code:key,label:definitions[key].label,direction:p.direction>0?'回升':'回落',regime:p.regime,startAt:p.at,endAt:at,reference:p.price,endPrice:price,change:value,reason});
    state.history=state.history.slice(0,1000);m.pending=null;
  }
  if(alive){let changed=false;for(const key of codes)if(state.models[key].pending){finalize(key,'restart',now());changed=true}if(changed)persist()}
  function onTrade(symbol,price,at,side,notional,t=now()){
    if(!alive||symbol!=='BTCUSDT'||!Number.isFinite(price)||price<=0||!Number.isFinite(at)||t-at>maxGap||at>t+1000||!['buy','sell'].includes(side)||!Number.isFinite(notional)||notional<=0||at<latestAt)return;
    const gap=latestAt&&at-latestAt>maxGap;
    if(gap){buckets.length=0;for(const k of codes)ready[k]='成交断流，重新积累样本'}
    let changed=false;
    for(const k of codes){const p=state.models[k].pending;if(!p)continue;
      if(gap||at-p.lastAt>maxGap){finalize(k,'gap',t);changed=true}
      else if(at>=p.at+horizon){finalize(k,'complete',at,price);changed=true}
      else p.lastAt=at;
    }
    latestAt=at;lastTrade={price,at};const sec=Math.floor(at/1000)*1000;
    let b=buckets.at(-1);if(!b||b.t!==sec){b={t:sec,o:price,h:price,l:price,c:price,buy:0,sell:0,qty:0,notional:0};buckets.push(b)}
    b.h=Math.max(b.h,price);b.l=Math.min(b.l,price);b.c=price;b[side]+=notional;b.qty+=notional/price;b.notional+=notional;
    while(buckets.length&&buckets[0].t<sec-180000)buckets.shift();
    if(changed)persist();
  }
  // Observed top-of-book changes from successive public snapshots; changes
  // between snapshots are not observed and cancellation is not identifiable.
  function onBook(bid,bidQty,ask,askQty,at,t=now()){
    if(!alive||![bid,bidQty,ask,askQty,at].every(Number.isFinite)||!(bid>0&&ask>=bid&&bidQty>=0&&askQty>=0)||Math.abs(t-at)>15000||at<=bookAt)return;
    const b={bid,bidQty,ask,askQty,at},p=previousBook;
    if(p&&at-p.at<=12000){
      const imbalance=(bid>=p.bid?bidQty:0)-(bid<=p.bid?p.bidQty:0)-(ask<=p.ask?askQty:0)+(ask>=p.ask?p.askQty:0);
      const scale=bidQty+askQty+p.bidQty+p.askQty;
      if(scale>0)books.push({at,value:imbalance/scale});
    }else books.length=0;
    previousBook=b;bookAt=at;while(books.length&&books[0].at<at-60000)books.shift();
  }
  function window(a){if(!a.length)return null;const buy=a.reduce((n,b)=>n+b.buy,0),sell=a.reduce((n,b)=>n+b.sell,0),volume=buy+sell;return {o:a[0].o,c:a.at(-1).c,h:Math.max(...a.map(b=>b.h)),l:Math.min(...a.map(b=>b.l)),volume,flow:volume?(buy-sell)/volume:0,qty:a.reduce((n,b)=>n+b.qty,0),notional:a.reduce((n,b)=>n+b.notional,0),n:a.length}}
  const move=(a,b)=>100*(b/a-1);
  function scan(t=now()){
    if(!alive)return;
    let changed=false;
    for(const k of codes){const p=state.models[k].pending;if(p&&t-p.lastAt>maxGap){finalize(k,'gap',t);changed=true}}
    const end=buckets.at(-1)?.t;
    if(!lastTrade||t-latestAt>maxGap||!end||buckets[0].t>end-115000||buckets.some((b,i)=>i&&b.t-buckets[i-1].t>maxGap)){
      for(const k of codes)ready[k]='等待连续约2分钟真实成交';
      if(changed)persist();return;
    }
    // Use completed seconds only. Evaluate one event per model per
    // 60-second observation window; the reference is a later actual print.
    const closed=buckets.filter(b=>b.t<end),recent=window(closed.filter(b=>b.t>=end-15000)),
      prior=window(closed.filter(b=>b.t>=end-45000&&b.t<end-15000)),
      base=window(closed.filter(b=>b.t>=end-120000&&b.t<end-45000)),
      full=window(closed.filter(b=>b.t>=end-120000));
    if(!recent||!prior||!base||!full||recent.n<8||prior.n<16||base.n<40||!full.qty){
      for(const k of codes)ready[k]='有效成交样本不足';if(changed)persist();return;
    }
    const displacement=move(full.o,full.c),range=move(full.l,full.h),
      regime=range>0&&Math.abs(displacement)/range>=.65?'方向性':'震荡',
      d0=move(prior.o,prior.c),d1=move(recent.o,recent.c),
      candidates={exhaustion:0,failed_break:0,absorption:0,ofi:0,vwap:0};
    if(Math.abs(d0)>.025&&d0*d1<0&&recent.volume/15<prior.volume/30&&Math.abs(recent.flow)<Math.abs(prior.flow))candidates.exhaustion=-Math.sign(d0);
    if(prior.l<base.l&&recent.c>base.l&&recent.c<base.h)candidates.failed_break=1;
    else if(prior.h>base.h&&recent.c<base.h&&recent.c>base.l)candidates.failed_break=-1;
    if(Math.abs(recent.flow)>.35&&Math.abs(d1)<.015&&recent.volume/15>=prior.volume/30)candidates.absorption=-Math.sign(recent.flow);
    const goodBooks=books.filter(b=>b.at>=t-30000);
    if(goodBooks.length>=3&&t-bookAt<=10000){
      const flow=goodBooks.reduce((n,b)=>n+b.value,0)/goodBooks.length;
      if(Math.abs(flow)>.12&&flow*recent.flow>0&&flow*d1>0)candidates.ofi=Math.sign(flow);
      ready.ofi='真实买一卖一连续快照（近似OFI）';
    }else ready.ofi='等待连续盘口数量快照；不推断撤单';
    const vw=full.notional/full.qty,dev=move(vw,prior.c),closer=Math.abs(move(vw,recent.c))<Math.abs(dev);
    if(Math.abs(dev)>.025&&closer&&dev*d1<0)candidates.vwap=-Math.sign(dev);
    for(const k of codes){
      if(k!=='ofi')ready[k]='公开成交样本已就绪';
      const m=state.models[k],direction=candidates[k];
      // Count only a new occurrence, rather than resampling an unchanged condition.
      const prev=m.lastCondition||0;m.lastCondition=direction;
      if(!direction||direction===prev||m.pending||t-m.lastEventAt<horizon)continue;
      m.lastEventAt=t;
      m.pending={direction,regime,at:lastTrade.at,price:lastTrade.price,lastAt:lastTrade.at};
      onEvent(k,direction,lastTrade.at,t);changed=true;
    }
    if(changed)persist();
  }
  function summarize(st){
    return {samples:st.samples,aligned:st.aligned,opposite:st.opposite,flat:st.flat,invalid:st.invalid,mean:st.samples?st.sum/st.samples:null,alignment:st.samples?100*st.aligned/st.samples:null};
  }
  function snapshot(t=now()){
    return {enabled:alive,error:failure,startedAt:state.startedAt,latestAt,bookAt,serverAt:t,horizonSeconds:horizon/1000,
      models:codes.map(code=>{const m=state.models[code],st=m.stats;return {code,...definitions[code],status:ready[code]||'等待真实样本',...summarize(st),active:!!m.pending,
        byRegime:Object.fromEntries(Object.entries(st.byRegime).map(([k,v])=>[k,summarize(v)])),byDirection:Object.fromEntries(Object.entries(st.byDirection).map(([k,v])=>[k,summarize(v)]))}}),history:state.history.slice(0,100)};
  }
  return {onTrade,onBook,scan,snapshot,flush:persist};
}
function openShortStudy(file){
  let initial=null,error='';
  try{if(fs.existsSync(file))initial=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){error='已有研究记录读取失败'}
  const save=state=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,file)};
  try{return createShortStudy({initial,save,error,onEvent:(k,d,at,t)=>horizonAudit.event(k,d,at,t)})}catch(e){return createShortStudy({enabled:false,error:'已有研究记录格式不兼容'})}
}

const shortStudy=openShortStudy(path.join(dataPath,'btc-short-observation-v1.json'));
const signalLab=openSignalLab({file:path.join(dataPath,'swing-signal-lab-btc-v1.json'),log});
const pro2Trades=createPro2Trades({markets:MARKETS,log,stopped:()=>stop,onTrade:(symbol,price,at,side,amount)=>{if(symbol==='BTCUSDT'){signalLab.trade(symbol,price,at);shortStudy.onTrade(symbol,price,at,side,amount);horizonAudit.trade(symbol,price,at)}}});

// Retain observed SSR events, not future trade signals. The 60-second window
// measures the outcome, rather than extending validity of the original rule.
function createSwingFollow({initial=null,save=()=>{},now=Date.now,symbols=[],enabled=true,error='',onEvent=()=>{}}={}){
  const duration=60000,gap=6000;
  const fresh=()=>({version:1,startedAt:now(),items:{}});
  const state=initial||fresh();
  if(state.version!==1||!state.items||typeof state.items!=='object')throw Error('观察记录格式不兼容');
  let alive=enabled&&!error,failure=error;
  const pending=new Map();
  function slot(symbol){return state.items[symbol]||(state.items[symbol]={active:null,history:[],seenAt:0,stats:{completed:0,interrupted:0,aligned:0,opposite:0,flat:0,kept:0,conditionLost:0,totalConfirmMs:0,totalConditionMs:0}})}
  function persist(){if(!alive)return;try{save(state)}catch(e){alive=false;failure='观察记录保存失败：'+String(e.message||e).slice(0,100)}}
  function finish(v,reason,t,price=null){
    const p=v.active;if(!p)return;
    const valid=reason==='complete'&&Number.isFinite(price)&&price>0;
    const change=valid?100*(price/p.reference-1):null;
    const signed=change===null?null:p.direction*change;
    const elapsed=Math.max(0,Math.min(duration,(p.lastAt||p.confirmedAt)-p.confirmedAt));
    const kept=valid&&!p.lostAt;
    const conditionMs=Math.max(0,Math.min(duration,(p.lostAt||p.lastAt||p.confirmedAt)-p.confirmedAt));
    const record={...p,endedAt:t,reason,change,signed,elapsedMs:elapsed,conditionMs,kept};
    v.history.unshift(record);v.history=v.history.slice(0,100);v.active=null;
    const st=v.stats;
    if(valid){
      st.completed++;st.totalConfirmMs+=Math.max(0,p.confirmedAt-p.firstAt);st.totalConditionMs+=conditionMs;
      if(kept)st.kept++;else st.conditionLost++;
      if(signed>.005)st.aligned++;else if(signed<-.005)st.opposite++;else st.flat++;
    }else st.interrupted++;
  }
  if(alive){
    let changed=false;
    for(const symbol of symbols){const v=state.items[symbol];if(v?.active){finish(v,'restart',now());changed=true}}
    if(changed)persist();
  }
  function observe(symbol,view,t=now()){
    if(!alive||!symbols.includes(symbol))return;
    const v=slot(symbol),p=v.active;
    const at=view?.latestAt,price=view?.price;
    const good=!!view?.ready&&Number.isFinite(at)&&at>0&&at<=t+1000&&t-at<=gap&&Number.isFinite(price)&&price>0;
    const phase=view?.phase,code=phase?.code||'';
    const observed=good&&/^(up|down)_(early|elapsed)$/.test(code)&&Number.isFinite(phase.turnAt)&&phase.turnAt<=at;
    const direction=observed?(code.startsWith('up')?1:-1):0;
    if(p){
      if(!good){
        pending.delete(symbol);
        // A transient missing view is not a fabricated reversal. Only an
        // actual sample gap invalidates the whole outcome.
        if(t-p.lastAt>gap){finish(v,'gap',t);persist()}
        return;
      }
      if(at<=p.lastAt)return;
      if(at-p.lastAt>gap){finish(v,'gap',t);pending.delete(symbol);persist();return}
      p.lastAt=at;p.lastPrice=price;
      // Original classification may expire naturally. Track that loss of
      // condition separately from the actually measured price outcome.
      if(!p.lostAt&&(!observed||direction!==p.direction||phase.turnAt!==p.turnAt)){
        p.lostAt=at;p.lossReason=observed&&direction!==p.direction?'原分类发生反向变化':'原分类条件不再满足';persist();
      }
      if(at>=p.confirmedAt+duration){finish(v,'complete',at,price);persist()}
      return;
    }
    if(!observed){pending.delete(symbol);return}
    if(phase.turnAt<=v.seenAt){pending.delete(symbol);return}
    const c=pending.get(symbol);
    // Two distinct public samples for stable display; not a new strategy.
    if(!c||c.turnAt!==phase.turnAt||c.direction!==direction||at-c.lastAt>3000){
      pending.set(symbol,{turnAt:phase.turnAt,direction,firstAt:at,lastAt:at});return;
    }
    if(at<=c.lastAt)return;
    if(at-c.firstAt<1000)return;
    v.seenAt=phase.turnAt;
    v.active={direction,turnAt:phase.turnAt,firstAt:c.firstAt,confirmedAt:at,reference:price,lastPrice:price,lastAt:at,lostAt:null,lossReason:null};
    pending.delete(symbol);persist();onEvent(symbol,direction,at,t);
  }
  function snapshot(symbol,t=now()){
    if(!symbols.includes(symbol))return null;
    const v=state.items[symbol],p=v?.active,c=pending.get(symbol);
    const st=v?.stats||{completed:0,interrupted:0,aligned:0,opposite:0,flat:0,kept:0,conditionLost:0,totalConfirmMs:0,totalConditionMs:0};
    const valid=alive&&p&&t-p.lastAt<=gap&&p.lastAt<=t+1000;
    const history=v?.history||[];
    return {enabled:alive,error:failure,stage:!alive?'paused':p?(valid?(p.lostAt?'lost':'observing'):'gap'):c&&t-c.lastAt<=gap?'checking':history.length?'reviewed':'waiting',durationSeconds:60,
      active:p?{...p,elapsedSeconds:Math.max(0,Math.min(60,Math.floor((p.lastAt-p.confirmedAt)/1000)))}:null,
      last:history[0]||null,history:history.slice(0,10),stats:{...st,meanConfirmMs:st.completed?st.totalConfirmMs/st.completed:null,meanConditionMs:st.completed?st.totalConditionMs/st.completed:null}};
  }
  return {observe,snapshot,flush:persist};
}
function openSwingFollow(file,symbols){
  let initial=null,error='';
  try{if(fs.existsSync(file))initial=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){error='已有观察记录无法读取'}
  const save=state=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,file)};
  try{return createSwingFollow({initial,save,symbols,error,onEvent:(symbol,d,at,t)=>{if(symbol==='BTCUSDT')horizonAudit.event('ssr',d,at,t)}})}catch(e){return createSwingFollow({symbols,enabled:false,error:'已有观察记录格式不兼容'})}
}

const swingFollow=openSwingFollow(path.join(dataPath,'ssr-follow-v1.json'),FIVE_SYMBOLS);
let signalLabTimer=null;
function scanSignalLab(){
  if(stop)return;
  try{const now=Date.now();signalLab.sweep(now);horizonAudit.sweep(now);shortStudy.scan(now);for(const symbol of FIVE_SYMBOLS){if(!MARKETS.has(symbol))continue;const view=pro2Trades.getSwing(symbol);swingFollow.observe(symbol,view,now);if(symbol==='BTCUSDT')signalLab.scan(symbol,view,now)}}
  catch(e){log('SIGNAL_LAB_SCAN '+String(e.message||e).slice(0,120))}
}

let stopPatternFeed;
const state={startedAt:Date.now(),binance:{connected:false,rest:false,ws:false,at:0,error:''},
  okx:{connected:false,rest:false,ws:false,at:0,error:''},historyDone:0,historyTotal:0,
  historyErrors:0,marketSetAt:0,baseCount:0,addedCount:0,lastAnalysis:0,alerts:[],
  okxSymbols:new Map(),okxSubs:new Set(),deep:[],updatedAt:0,wsB:null,wsO:null,errors:[]};
let stop=false,initStarted=false,binanceTimer=null,okxTimer=null,saveTimer=null;
function log(msg){console.log(`[${new Date().toISOString()}] ${msg}`)}
function errorStatus(exchange,e){const message=String(e?.message||e).slice(0,200);
  state[exchange].error=message;state[exchange].connected=false;
  log(`${exchange}: ${message}`);}
function safeNumber(x,or=0){let n=Number(x);return Number.isFinite(n)?n:or}
async function json(url, timeout=9500){
  const controller=new AbortController();const t=setTimeout(()=>controller.abort(),timeout);
  try{
    const r=await fetch(url,{signal:controller.signal,headers:{'Accept':'application/json','User-Agent':'ContractLensPro/1.0'}});
    if(!r.ok)throw new Error(`HTTP ${r.status} ${new URL(url).host}`);
    const data=await r.json();
    if(data?.code && data.code!=='0')throw new Error(`${data.code} ${data.msg||'API error'}`);
    return data;
  }finally{clearTimeout(t)}
}
function newMarket(symbol,price,volume){return {symbol,price,priceAt:Date.now(),quoteVolume24h:volume,
  change24h:0,candles:[],klineAt:0,depth:null,depthSeries:[],oi:null,okx:null,
  okxTrade:{window:[],buy:0,sell:0,at:0},okxDepth:null,view:null};}
function loadSignals(){try{const raw=JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
  if(Array.isArray(raw))state.alerts=raw.filter(s=>s?.ruleVersion===RULE_VERSION&&allowedSymbol(s.symbol)&&Number.isFinite(s.createdAt)).slice(-3000);
 }catch{state.alerts=[]}}
loadSignals();
function persistSignals(){
  try{fs.mkdirSync(path.dirname(DB_FILE),{recursive:true});
    const tmp=DB_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state.alerts.slice(-3000),null,2));
    fs.renameSync(tmp,DB_FILE);
  }catch(e){log(`保存信号失败: ${e.message}`)}
}

async function initBinance(){
 if(initStarted)return;initStarted=true;
 try{
  const [info,tickers]=await Promise.all([
   json(BINANCE+'/fapi/v1/exchangeInfo',18000),
   Promise.allSettled(FIVE_SYMBOLS.map(symbol=>json(BINANCE+'/fapi/v1/ticker/24hr?symbol='+symbol,12000))).then(rows=>rows.filter(x=>x.status==='fulfilled').map(x=>x.value))
  ]);
  const by=new Map((Array.isArray(tickers)?tickers:[]).map(x=>[x.symbol,x]));
  for(const x of info.symbols||[]){
   if(!allowedSymbol(x.symbol)||x.status!=='TRADING'||!x.contractType||x.contractType==='NONE')continue;
   const t=by.get(x.symbol)||{},px=safeNumber(t.lastPrice),key=x.symbol;
   let m=MARKETS.get(key);
   if(!m){m=newMarket(key,px,safeNumber(t.quoteVolume));MARKETS.set(key,m)}
   m.exchange='binance';m.displaySymbol=key;m.apiSymbol=key;
   m.exchangeLabel='币安U本位';m.quoteAsset=x.quoteAsset||'USDT';m.contractType=x.contractType;
   const lot=x.filters?.find(f=>f.filterType==='MARKET_LOT_SIZE'&&+f.stepSize>0)||
     x.filters?.find(f=>f.filterType==='LOT_SIZE');
   m.paperProduct=x.quoteAsset==='USDT'&&x.marginAsset==='USDT'&&+lot?.stepSize>0?
      {unit:1,step:+lot.stepSize,minQty:+lot.minQty||+lot.stepSize}:null;
   if(px>0&&safeNumber(t.closeTime)>0){m.price=px;m.priceAt=safeNumber(t.closeTime)}else{m.price=0;m.priceAt=0}
   m.quoteVolume24h=safeNumber(t.quoteVolume);m.change24h=safeNumber(t.priceChangePercent);
  }
  state.baseCount=[...MARKETS.values()].filter(x=>x.exchange==='binance').length;
  state.marketSetAt=Date.now();state.historyTotal=MARKETS.size;
  state.binance.rest=true;state.binance.connected=true;state.binance.at=Date.now();state.binance.error='';
  log('PRO_V3_BINANCE_U '+state.baseCount);
  connectBinanceWS();void refreshBinanceBooks();
 }catch(e){errorStatus('binance',e);initStarted=false;if(!stop)setTimeout(initBinance,20000).unref()}
}
function connectBinanceWS(){
  if(stop||!MARKETS.size)return;
  try{
    const streams=[...MARKETS.values()].map(m=>m.apiSymbol.toLowerCase()+'@miniTicker');
    const ws=new WebSocket(BINANCE_WS+streams.join('/'));state.wsB=ws;
    ws.addEventListener('open',()=>{
      state.binance.ws=true;state.binance.connected=true;state.binance.error='';state.binance.at=Date.now();
      log('币安五合约实时报价WebSocket已连接');
      const streams=ENABLE_LEGACY?[...MARKETS.values()].filter(m=>m.exchange==='binance').map(m=>m.apiSymbol.toLowerCase()+'@kline_15m'):[];
      let idx=0;
      const subscribe=()=>{
        if(ws.readyState!==WebSocket.OPEN)return;
        if(idx>=streams.length)return;
        const items=streams.slice(idx,idx+45);idx+=45;
        ws.send(JSON.stringify({method:'SUBSCRIBE',params:items,id:idx}));
        setTimeout(subscribe,500).unref();
      };subscribe();
    });
    ws.addEventListener('message',event=>{
      try{
        const packet=JSON.parse(String(event.data));
        const d=packet.data??packet;
        if(Array.isArray(d)||d?.e==='24hrMiniTicker'){
          for(const t of Array.isArray(d)?d:[d]){
            const m=MARKETS.get(t.s);if(!m)continue;
            const p=safeNumber(t.c),q=safeNumber(t.q);
            const tAt=safeNumber(t.E);
            if(!tAt||Math.abs(Date.now()-tAt)>60000)continue;
          if(p>0&&tAt>=m.priceAt){m.price=p;m.priceAt=tAt}
            if(q>0)m.quoteVolume24h=q;
            if(Number.isFinite(+t.o)&&p>0)m.change24h=(p/(+t.o)-1)*100;
          }
        }else if(d.e==='kline'&&d.k){
          const m=MARKETS.get(d.s);if(!m)return;
          const k=binanceBar(d.k);
          if(d.k.i!=='15m')return;
          receiveBars(m,[k],true);
          const at=safeNumber(d.E,Date.now());
          if(k.c>0 && at>=m.priceAt){m.price=k.c;m.priceAt=at;}
          m.klineAt=Date.now();
        }
        state.binance.at=Date.now();
      }catch(e){log(`币安WS解码失败: ${e.message}`)}
    });
    ws.addEventListener('error',()=>{state.binance.error='实时行情连接错误'});
    ws.addEventListener('close',()=>{
      if(state.wsB!==ws)return;
      state.binance.ws=false;state.binance.connected=false;
      state.binance.error='WS断开，等待重连';
      if(!stop)setTimeout(connectBinanceWS,6000).unref();
    });
  }catch(e){errorStatus('binance',e);setTimeout(connectBinanceWS,7000).unref()}
}
function updateBook(m,bid,ask,at){
  if(+bid>0&&+ask>=+bid&&at>=(m.book?.at||0))m.book={bid:+bid,ask:+ask,at};
}
let booksPending=false;
async function refreshBinanceBooks(){
  if(booksPending||stop)return;
  booksPending=true;
  try{
    await Promise.allSettled([...MARKETS.values()].map(async m=>{
      const row=await json(BINANCE+'/fapi/v1/ticker/bookTicker?symbol='+encodeURIComponent(m.apiSymbol),10000);
      const at=safeNumber(row.time);
      if(row.symbol===m.symbol&&at&&Math.abs(Date.now()-at)<30000)updateBook(m,row.bidPrice,row.askPrice,at);
    }));
  }finally{booksPending=false;}
}
function selectCandidate(m,scan,twenty,now){
  if(!twenty?.reviewed||m.review?.status!=='passed')return null;
  const signals=scan.matches;
  if(signals.some(hit=>hit.direction!==twenty.direction)||
     new Set(signals.flatMap(hit=>hit.names)).size<2)return null;
  const book=m.book;
  if(!book||!(book.bid>0&&book.ask>=book.bid)||!(book.at>=now-30000&&book.at<=now+5000))return null;
  const side=twenty.direction==='up'?1:-1;
  const entry=side===1?book.ask:book.bid;
  const spread=book.ask-book.bid;
  const distance=side*(entry-twenty.key);
  const risk=side*(entry-twenty.invalid);
  const room=side*(twenty.obstacle-entry)-entry*COST-spread;
  if(!(distance>=0&&distance<=twenty.atr*.5&&risk>0&&room/risk>=1.5&&spread/entry<=.0012))return null;
  return {ratio:room/risk,spreadPct:100*spread/entry};
}
function activity(m,now){
  const bars=m.bars5||[];
  const bar=bars.at(-1);
  const step=300000;
  if(!bar||now-bar.t>=2*step+5000)return null;
  const end=bar.t+step;
  if(end>now)return null;
  if(m.activityCache?.end===end)return m.activityCache;
  const recent=bars.slice(-21);
  if(recent.length<21||recent.some((b,i)=>i&&b.t!==recent[i-1].t+step))return null;
  const base=recent.slice(0,-1);
  const median=values=>{
    values.sort((a,b)=>a-b);
    return (values[9]+values[10])/2;
  };
  const range=b=>(b.h-b.l)/b.o;
  const volBase=median(base.map(b=>b.v));
  const rangeBase=median(base.map(range));
  const rel=(value,baseline)=>baseline>0?Math.min(4,value/baseline):value>0?4:0;
  const score=.65*rel(bar.v,volBase)+.35*rel(range(bar),rangeBase);
  const quiet=range(bar)<=.001&&bar.v<=volBase*.6;
  const level=quiet||score<.4?'极低':score<.75?'低':score<1.4?'中':score<2.2?'高':'极高';
  return m.activityCache={end,level};
}
function publishedView(m, now) {
  const scan=analyze(m,now);
  const matches=scan.matches;
  const twenty=matches.some(h=>h.period===15)?evaluateTwenty(m,scan,now):null;
  const up=matches.some(hit=>hit.direction==='up'), down=matches.some(hit=>hit.direction==='down');
  return {
    symbol:m.symbol,displaySymbol:m.displaySymbol,exchange:m.exchange,exchangeLabel:m.exchangeLabel,
    quoteAsset:m.quoteAsset,contractType:m.contractType,price:m.price,priceAt:m.priceAt,change24h:m.change24h,
    quoteVolume24h:m.quoteVolume24h,historyReady:scan.ready.length>0,
    activity:activity(m,now),readyPeriods:scan.ready,matches,flow:buySell(m,now),
    twenty,selected:selectCandidate(m,scan,twenty,now),
    review:matches.length&&m.review?{status:now-m.priceAt>30000?'waiting':m.review.status,
      reason:now-m.priceAt>30000?'实时价格待核':m.review.reason,distinct:m.review.distinct,duplicate:m.review.duplicate}:null,
    stale:!m.priceAt||now-m.priceAt>60000,
    direction:up&&down?'mixed':up?'up':down?'down':'neutral',
    phase:matches.length?'形态已命中':scan.ready.length?'未命中':'等待已收盘K线'
  };
}
function runAnalysis(){
  const now=Date.now();
  let changed=false;
  for(const m of MARKETS.values()){
    const scan=analyze(m,now);
    m.review=evaluateReview(m,scan,buySell(m,now),now);
    reviewHistory.add(m,scan,m.review,now);
    m.needFive=scan.matches.find(h=>h.period===15)?.closedAt||0;
    m.paperDecision=evaluateTwenty(m,scan,now);
    m.paperTrialHits=scan.matches;
    m.paperNames=m.paperDecision?.reviewed?
      [...new Set(scan.matches.filter(hit=>hit.direction===m.paperDecision.direction).flatMap(hit=>hit.names))]:[];
    reviewHistory.addTwenty(m,scan,m.paperDecision,now);
    for(const hit of scan.matches){
      const key=[hit.period,hit.direction].join(':');
      m.patternSeen??=new Map();
      if((m.patternSeen.get(key)||0)>=hit.closedAt)continue;
      m.patternSeen.set(key,hit.closedAt);
      state.alerts.push({...hit,symbol:m.symbol,displaySymbol:m.displaySymbol,exchangeLabel:m.exchangeLabel,
        ruleVersion:RULE_VERSION,createdAt:now,result:null});
      changed=true;
    }
  }
  if(state.alerts.length>3000)state.alerts=state.alerts.slice(-3000);
  for(const s of state.alerts){
    if(s.result!==null||now<s.closedAt+s.period*60000)continue;
    const market=MARKETS.get(s.symbol);
    const next=market&&analyze(market,now).bars[s.period].find(k=>k.t===s.closedAt);
    if(next){
      const change=(next.c-s.close)/s.close*100;
      s.result={change,aligned:s.direction==='up'?change>0:change<0};
      changed=true;
    }
  }
  if(changed){clearTimeout(saveTimer);saveTimer=setTimeout(persistSignals,1800);}
  reviewHistory.advance(MARKETS,now);
  paper.advance(MARKETS,now);
  state.lastAnalysis=now;
}
function currentSnapshot(){
  const now=Date.now(), all=[...MARKETS.values()].map(m=>publishedView(m,now));
  const venues={binance:0,coin:0,okxSwaps:0,okxFutures:0};
  for(const row of all){
    const key=row.exchange==='okx'?(row.contractType==='SWAP'?'okxSwaps':'okxFutures'):row.exchange;
    venues[key]++;
  }
  const loaded=all.filter(row=>MARKETS.get(row.symbol).bars15?.length>=10).length;
  return {serverTime:now,ruleVersion:RULE_VERSION, sources:{binance:state.binance,okx:state.okx},
    counts:{eligible:all.length,venues,loaded,ready:all.filter(v=>v.historyReady).length,
      up:all.filter(v=>v.matches.some(h=>h.direction==='up')).length,
      down:all.filter(v=>v.matches.some(h=>h.direction==='down')).length},
    symbols:all,alerts:state.alerts.slice(-70).reverse(),lastAnalysis:state.lastAnalysis,
    reviewStats:reviewHistory.groups(),comparison20:reviewHistory.comparison20(),
    stats:[15,30].map(period=>{
      const records=state.alerts.filter(s=>s.period===period);
      const checked=records.filter(s=>s.result);
      return {period,samples:checked.length,pending:records.length-checked.length,
        aligned:checked.filter(s=>s.result.aligned).length};
    })};
}
function marketDetail(symbol){
  const m=MARKETS.get(symbol);
  if(!m)return null;
  const now=Date.now(),scan=analyze(m,now);
  return {...publishedView(m,now),review:evaluateReview(m,scan,buySell(m,now),now),success:reviewHistory.contract(m.symbol),charts:{5:(m.bars5||[]).slice(-32),15:scan.bars[15].slice(-80),30:scan.bars[30].slice(-80)}};
}
const PUBLIC=path.join(__dirname,'public');
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
function reply(res,status,body,contentType='application/json; charset=utf-8'){
  res.writeHead(status,{'Content-Type':contentType,'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));
}


// Invite-only account registration. Credentials stay in server-local data.
const crypto=require('node:crypto');
const ACCESS_FILE=path.join(dataPath,'.pro-access-code');
const ACCOUNTS=path.join(dataPath,'accounts-v1');
const SESSION_TTL=12*60*60*1000;
const sessions=new Map();
const USER_RE=/^[a-z0-9_]{3,24}$/;
let failures=[],pendingLogins=0;
const digest=v=>crypto.createHash('sha256').update(v).digest();
function readAccessCode(){
  try{const v=fs.readFileSync(ACCESS_FILE,'utf8').trim();return v.length>=8&&Buffer.byteLength(v)<=128?v:null}catch{return null}
}
function readAccount(name){
  if(!USER_RE.test(name))return null;
  try{const v=JSON.parse(fs.readFileSync(path.join(ACCOUNTS,name+'.json'),'utf8'));return v.username===name&&typeof v.nickname==='string'&&/^[a-f0-9]{32}$/.test(v.salt)&&/^[a-f0-9]{64}$/.test(v.hash)?v:null}
  catch(e){if(e.code==='ENOENT')return null;throw e}
}

// Owner privilege is restricted to the account already present before the
// confirmed enrollment cutoff. A future registration cannot obtain this role.
const OWNER_ACCOUNT_DIGEST='3f7a55cf514d56f94a9ae453e6ecaa2f03606b7eb1117935dfc2005b42397fb1';
const OWNER_ENROLLED_BEFORE=Date.parse('2026-11-26T04:40:00+08:00');
function isOwnerAccount(account){
  return !!(account&&typeof account.username==='string'&&USER_RE.test(account.username)&&
    digest(account.username).toString('hex')===OWNER_ACCOUNT_DIGEST&&
    Number.isSafeInteger(account.createdAt)&&account.createdAt>0&&account.createdAt<OWNER_ENROLLED_BEFORE);
}
function isAdmin(user){
  if(!user||typeof user.username!=='string'||digest(user.username).toString('hex')!==OWNER_ACCOUNT_DIGEST)return false;
  try{return isOwnerAccount(readAccount(user.username))}catch{return false}
}
function remainingRestriction(account,now=Date.now()){
  return Number.isSafeInteger(account?.blockedUntil)&&account.blockedUntil>now?Math.ceil((account.blockedUntil-now)/1000):0;
}

function passwordHash(password,salt){
  return new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(salt,'hex'),32,{N:16384,r:8,p:1,maxmem:64*1024*1024},(e,key)=>e?reject(e):resolve(key)));
}
function saveAccount(v){
  fs.mkdirSync(ACCOUNTS,{recursive:true,mode:0o700});
  if(fs.readdirSync(ACCOUNTS).filter(n=>/^[a-z0-9_]{3,24}\.json$/.test(n)).length>=200)throw Error('注册人数已达上限');
  const temp=path.join(ACCOUNTS,'.new-'+crypto.randomBytes(16).toString('hex'));
  try{fs.writeFileSync(temp,JSON.stringify(v),{mode:0o600,flag:'wx'});fs.linkSync(temp,path.join(ACCOUNTS,v.username+'.json'))}
  finally{try{fs.unlinkSync(temp)}catch{}}
}
function rememberedAccount(req){
  return /(?:^|;\s*)pro_remember_user=([a-z0-9_]{3,24})(?:;|$)/.exec(req.headers.cookie||'')?.[1]||'';
}
function loginPage(res,message='',status=200,register=false,remembered=''){
  const saved=USER_RE.test(remembered)?remembered:'';
  const remember=register?'':'<label class="remember"><input type="checkbox" name="remember" value="1" '+(saved?'checked':'')+'>记住账号密码（保持登录7天）</label><p class="remember-note">密码由浏览器密码管理器保存，仅在自己的设备上勾选。</p>';
  const fields=register?'<label for="nickname">昵称</label><input id="nickname" name="nickname" required maxlength="24" autocomplete="nickname" placeholder="分享圈显示的名字">':'';
  const invite=register?'<label for="invite">注册邀请码</label><input id="invite" name="invite" type="password" required maxlength="128" autocomplete="off" placeholder="原网站登录码">':'';
  const confirm=register?'<label for="confirm">确认密码</label><input id="confirm" name="confirm" type="password" required minlength="10" maxlength="128" autocomplete="new-password">':'';
  const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合约实时数据Pro v9代 '+(register?'注册':'登录')+'</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#ededed;color:#171717;font:16px system-ui,sans-serif;padding:20px}main{width:100%;max-width:390px;background:white;padding:28px;border-radius:12px}h1{font-size:26px;margin:0 0 7px}p{font-size:13px;color:#666;line-height:1.6}label{display:block;font-size:14px;font-weight:600;margin:16px 0 7px}input,button{width:100%;min-height:46px;font:inherit;border-radius:6px;padding:10px}input{border:1px solid #ddd;background:#fafafa}button{background:#07a85b;color:white;border:0;margin-top:20px;font-weight:700}a{color:#087a42}.msg{color:#aa3030}.warn{color:#8a5c17}.remember{display:flex;align-items:center;gap:8px;font-weight:500;margin:16px 0 4px;color:#333}.remember input{width:18px;height:18px;min-height:0;margin:0;padding:0;accent-color:#07a85b}.remember-note{font-size:11px;margin:4px 0;color:#777}</style></head><body><main><h1>合约实时数据Pro v9代 · '+(register?'注册':'登录')+'</h1><p>南柯一梦制作 · 私人观察台</p><form method="post" action="'+(register?'/register':'/login')+'"><label for="username">账号</label><input id="username" name="username" required minlength="3" maxlength="24" autocomplete="username" value="'+(register?'':saved)+'" autocapitalize="none" spellcheck="false" placeholder="3–24位字母、数字或下划线">'+fields+'<label for="password">密码</label><input id="password" name="password" type="password" required maxlength="128" '+(register?'minlength="10" autocomplete="new-password" placeholder="至少10位，不要使用其他账号的密码"':'autocomplete="current-password"')+'>'+confirm+invite+remember+'<button type="submit">'+(register?'注册并登录':'登录')+'</button></form><p class="msg" role="status">'+message+'</p><p>'+(register?'已有账号？ <a href="/login">返回登录</a>':'没有账号？ <a href="/register">立即注册</a>')+'</p><p class="warn">如浏览器显示连接不安全，密码及内容可能被网络窃听。请使用本站专属密码，不要上传敏感信息。</p></main></body></html>';
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
  res.end(html);
}
function cookieOptions(req){
  const secure=req.socket.encrypted||req.headers['x-forwarded-proto']==='https';
  return '; Path=/; HttpOnly; SameSite=Strict'+(secure?'; Secure':'');
}
function sessionToken(req){return /(?:^|;\s*)pro_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1]}
function currentUser(req){
  const token=sessionToken(req),session=token&&sessions.get(token);
  if(!session||session.until<=Date.now()||!session.user||session.quickLocked)return null;
  return session.user;
}
function startSession(req,res,user,remember=false){
  if(sessions.size>=256)sessions.delete(sessions.keys().next().value);
  const token=sessionToken(req);if(token)sessions.delete(token);
  const t=crypto.randomBytes(32).toString('hex');
  const seconds=remember?7*86400:SESSION_TTL/1000;
  sessions.set(t,{until:Date.now()+seconds*1000,user:{username:user.username,nickname:user.nickname}});
  const cookies=['pro_session='+t+cookieOptions(req)+'; Max-Age='+seconds,'pro_remember_user='+(remember?user.username:'')+cookieOptions(req)+'; Max-Age='+(remember?30*86400:0)];
  res.writeHead(303,{'Location':'/','Cache-Control':'no-store','Set-Cookie':cookies});res.end();
}

function quickPinHash(token,pin){return crypto.createHmac('sha256',token).update('pro-quick-pin:'+pin).digest('hex')}
function quickPinMatches(token,pin,hash){
  return /^[0-9]{1,8}$/.test(pin)&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)&&crypto.timingSafeEqual(Buffer.from(quickPinHash(token,pin),'hex'),Buffer.from(hash,'hex'));
}
function quickPage(req,res,session,message='',status=200){
  if(!session.quickCsrf)session.quickCsrf=crypto.randomBytes(24).toString('hex');
  const field='<input type="hidden" name="csrf" value="'+session.quickCsrf+'">';
  const form=(op,body)=>'<form method="post" action="/device-lock">'+field+'<input type="hidden" name="op" value="'+op+'">'+body+'</form>';
  const pinInput='<label for="quickPin">数字快捷码</label><input id="quickPin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{1,8}" maxlength="8" minlength="1" required autocomplete="off">';
  const configured=!!session.quickHash;
  const main=session.quickLocked?form('unlock',pinInput+'<button>解锁</button>')+'<p>输入错误三次将结束本次登录。</p>':
    (configured?form('lock','<button>立即锁定本设备</button>')+form('remove','<button class="secondary">关闭快捷解锁</button>'):'')+
    form('setup','<label for="fullPassword">当前完整登录密码</label><input id="fullPassword" name="password" type="password" maxlength="128" required autocomplete="current-password">'+pinInput+'<p>可设置1至8位数字。设置后立即锁定，原登录密码不变。</p><button>'+ (configured?'重新设置并锁定':'设置并锁定')+'</button>');
  const back=session.quickLocked?'<a href="/login">使用完整密码重新登录</a>':'<a href="/">返回网站</a>';
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
  res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理员快捷解锁</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#ededed;display:grid;place-items:center;font:16px system-ui,sans-serif;color:#171717;padding:20px}main{width:100%;max-width:390px;background:#fff;border-radius:12px;padding:24px}h1{font-size:23px;margin:0 0 12px}p{color:#666;font-size:13px;line-height:1.6}label{display:block;font-weight:600;margin:12px 0 6px}input,button{font:inherit;width:100%;min-height:44px;border-radius:6px;padding:10px}input{border:1px solid #ddd}button{border:0;background:#168568;color:#fff;margin:12px 0 4px;font-weight:600}.secondary{background:#e9eeec;color:#333}.msg{color:#b52f3d}a{color:#2563b8;font-size:14px}</style></head><body><main><h1>管理员 · '+(session.quickLocked?'快捷解锁':'快捷解锁设置')+'</h1><p>仅当前已验证的登录会话有效；退出登录、会话过期或服务重启后仍需完整密码。</p><p class="msg" role="status">'+message+'</p>'+main+'<p>'+back+'</p><p>短数字码仅用于临时锁定，不替代账号密码。请勿在不可信设备或不安全网络上使用。</p></main></body></html>');
}
function quickDeviceRoute(req,res,url,token,session){
  if(!session||session.until<=Date.now()||!isAdmin(session.user)){reply(res,403,{error:'仅已验证的管理员会话可使用'});return}
  if(req.method==='GET'){quickPage(req,res,session);return}
  if(req.method!=='POST'||req.headers['sec-fetch-site']==='cross-site'||!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||'')){reply(res,403,{error:'无效操作'});req.resume();return}
  if(session.quickBusy){reply(res,429,{error:'操作处理中'});req.resume();return}
  session.quickBusy=true;
  let chunks=[],size=0,done=false;
  const release=()=>{session.quickBusy=false};
  const abort=()=>{if(!done){done=true;release()}};
  req.setTimeout(10000,()=>{abort();req.destroy()});req.on('aborted',abort);req.on('error',abort);req.on('close',abort);
  req.on('data',b=>{if(done)return;size+=b.length;if(size>4096){abort();req.destroy();return}chunks.push(b)});
  req.on('end',async()=>{
    if(done)return;done=true;
    const live=()=>sessions.get(token)===session&&session.until>Date.now()&&isAdmin(session.user);
    const redirect=loc=>{res.writeHead(303,{'Location':loc,'Cache-Control':'no-store'});res.end()};
    const fail=msg=>quickPage(req,res,session,msg,400);
    const revoke=()=>{sessions.delete(token);res.writeHead(303,{'Location':'/login','Cache-Control':'no-store','Set-Cookie':'pro_session='+cookieOptions(req)+'; Max-Age=0'});res.end()};
    const miss=msg=>{session.quickFailures=(session.quickFailures||0)+1;if(session.quickFailures>=3)revoke();else fail(msg+'，剩余 '+(3-session.quickFailures)+' 次。')};
    try{
      if(!live()){revoke();return}
      const p=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),op=p.get('op'),pin=p.get('pin')||'';
      if(!session.quickCsrf||p.get('csrf')!==session.quickCsrf){reply(res,403,{error:'无效请求'});return}
      if(session.quickLocked){
        if(op!=='unlock'){fail('请先解锁');return}
        if(!quickPinMatches(token,pin,session.quickHash)){miss('快捷码错误');return}
        session.quickLocked=false;session.quickFailures=0;session.quickCsrf=crypto.randomBytes(24).toString('hex');redirect('/');return;
      }
      if(op==='lock'){
        if(!session.quickHash){fail('请先设置快捷码');return}
        session.quickLocked=true;session.quickFailures=0;session.quickCsrf=crypto.randomBytes(24).toString('hex');redirect('/device-lock');return;
      }
      if(op==='remove'){delete session.quickHash;session.quickFailures=0;session.quickCsrf=crypto.randomBytes(24).toString('hex');redirect('/device-lock');return}
      if(op!=='setup'||!/^[0-9]{1,8}$/.test(pin)){fail('快捷码须为1至8位数字');return}
      const password=p.get('password')||'';
      if(!password||Buffer.byteLength(password)>128){miss('完整密码错误');return}
      const account=readAccount(session.user.username),candidate=await passwordHash(password,account.salt);
      if(!live()||readAccount(session.user.username)?.hash!==account.hash){revoke();return}
      if(!crypto.timingSafeEqual(candidate,Buffer.from(account.hash,'hex'))){miss('完整密码错误');return}
      session.quickHash=quickPinHash(token,pin);session.quickFailures=0;session.quickLocked=true;session.quickCsrf=crypto.randomBytes(24).toString('hex');redirect('/device-lock');
    }catch{if(!res.headersSent)reply(res,500,{error:'快捷解锁操作失败，请重新登录'})}
    finally{release()}
  });
}

function accessGate(req,res,url){
  const now=Date.now();for(const [t,s] of sessions)if(s.until<=now)sessions.delete(t);
  const token=sessionToken(req),user=currentUser(req),quickSession=token&&sessions.get(token);
  if(url.pathname==='/device-lock'){quickDeviceRoute(req,res,url,token,quickSession);return false}
  if(req.method==='GET'&&url.pathname==='/api/pro2/health'&&!user){reply(res,200,{ok:true});return false}
  if(req.method==='POST'&&url.pathname==='/logout'){
    if(req.headers['sec-fetch-site']==='cross-site'){reply(res,403,{error:'无效请求'});return false}
    if(token)sessions.delete(token);
    res.writeHead(303,{'Location':'/','Cache-Control':'no-store','Set-Cookie':'pro_session='+cookieOptions(req)+'; Max-Age=0'});res.end();return false;
  }
  const register=url.pathname==='/register';
  if(req.method==='POST'&&(register||url.pathname==='/login')){
    if(req.headers['sec-fetch-site']==='cross-site'){reply(res,403,{error:'无效请求'});req.resume();return false}
    failures=failures.filter(t=>t>now-5*60*1000);
    if(failures.length>=24||pendingLogins>=3){loginPage(res,'请求次数过多，请稍后再试。',429,register);req.resume();return false}
    if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||'')){loginPage(res,'请求格式错误。',400,register);req.resume();return false}
    pendingLogins++;
    let chunks=[],size=0,ended=false,released=false;
    const release=()=>{if(!released){released=true;pendingLogins--}};
    const abort=()=>{if(!ended){ended=true;release()}};
    req.setTimeout(10000,()=>{abort();req.destroy()});req.on('aborted',abort);req.on('error',abort);req.on('close',abort);
    req.on('data',chunk=>{if(ended)return;size+=chunk.length;if(size>4096){abort();req.destroy();return}chunks.push(chunk)});
    req.on('end',async()=>{
      if(ended)return;ended=true;
      const reject=(msg,status=400)=>{failures.push(Date.now());if(!res.destroyed)loginPage(res,msg,status,register)};
      try{
        const p=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const name=(p.get('username')||'').trim().toLowerCase(),password=p.get('password')||'';
        if(!USER_RE.test(name)||!password||Buffer.byteLength(password)>128){reject('账号或密码格式不正确。');return}
        let account;
        if(register){
          const nickname=(p.get('nickname')||'').trim(),invite=readAccessCode();
          if(!invite||!crypto.timingSafeEqual(digest(invite),digest(p.get('invite')||''))){reject('注册邀请码不正确。',403);return}
          if(!nickname||nickname.length>24||/[\x00-\x1f\x7f]/.test(nickname)||password.length<10||password!==p.get('confirm')){reject('请填写有效昵称，密码至少10位且两次一致。');return}
          if(readAccount(name)){reject('账号已存在，请换一个。',409);return}
          const salt=crypto.randomBytes(16).toString('hex'),hash=(await passwordHash(password,salt)).toString('hex');
          if(res.destroyed)return;
          account={username:name,nickname,salt,hash,createdAt:Date.now()};
          try{saveAccount(account)}catch(e){if(e.code==='EEXIST'){reject('账号已存在，请换一个。',409);return}throw e}
        }else{
          account=readAccount(name);
          const candidate=await passwordHash(password,account?.salt||'00000000000000000000000000000000');
          if(!account||!crypto.timingSafeEqual(candidate,Buffer.from(account.hash,'hex'))){reject('账号或密码错误。',401);return}
        }
        const latest=readAccount(name);
        if(!latest||latest.hash!==account.hash){reject('账号状态已改变，请重新登录。',409);return}
        const wait=remainingRestriction(latest);
        if(wait){if(!res.destroyed)loginPage(res,'账号暂时限制登录，请在 '+wait+' 秒后重试。',423,false);return}
        if(!res.destroyed)startSession(req,res,latest,!register&&p.get('remember')==='1');
      }catch(e){log('ACCOUNT_ERROR '+String(e.code||'internal'));if(!res.destroyed)loginPage(res,'账号操作失败，请稍后重试。',500,register)}
      finally{release()}
    });return false;
  }
  if(req.method==='GET'&&(url.pathname==='/register'||url.pathname==='/login')){
    loginPage(res,'',200,register,rememberedAccount(req));return false;
  }
  if(quickSession?.quickLocked){
    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html')){quickPage(req,res,quickSession);return false}
    reply(res,423,{error:'设备已锁定，请重新打开网站解锁'});return false;
  }
  if(user)return true;
  if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html')){loginPage(res,'',200,false,rememberedAccount(req));return false}
  reply(res,401,{error:'请先登录'});return false;
}

const SHARE_DIR=path.join(dataPath,'share-circle-v1');
const SHARE_ID=/^[0-9]{13}-[a-f0-9]{24}$/;
const SHARE_MAX=450*1024, SHARE_BODY=6*1024*1024;
let sharePending=0;
function shareIds(){
  fs.mkdirSync(SHARE_DIR,{recursive:true,mode:0o700});
  return fs.readdirSync(SHARE_DIR,{withFileTypes:true}).filter(e=>e.isDirectory()&&SHARE_ID.test(e.name)).map(e=>e.name).sort().reverse();
}
function shareMeta(id,user){
  const m=JSON.parse(fs.readFileSync(path.join(SHARE_DIR,id,'meta.json'),'utf8'));
  const author=m.owner?readAccount(m.owner):null;
  return {id,createdAt:m.createdAt,text:m.text,author:author?.nickname||m.nickname||'历史动态',avatar:author?.avatar?accountPublic(author).avatar:null,authorAccount:author?.username||null,canDelete:!!(isAdmin(user)||(m.owner&&user&&m.owner===user.username)),images:Array.from({length:m.count},(_,i)=>'/api/share/image/'+id+'/'+i)};
}
function shareImage(v){
  if(typeof v!=='string'||v.length>Math.ceil(SHARE_MAX/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(v))throw Error('图片格式或大小不符合要求');
  const b=Buffer.from(v,'base64');
  if(b.length<4||b.length>SHARE_MAX||b.toString('base64')!==v||b[0]!==255||b[1]!==216||b[2]!==255||b[b.length-2]!==255||b[b.length-1]!==217)throw Error('仅支持JPEG图片');
  return b;
}
function shareCreate(p,user){
  if(!p||typeof p.text!=='string'||p.text.length>2000||!Array.isArray(p.images)||p.images.length>9)throw Error('文字最多2000字，图片最多9张');
  const text=p.text.trim(),images=p.images.map(shareImage);
  if(!text&&!images.length)throw Error('请输入文字或添加图片');
  if(shareIds().length>=200)throw Error('已达200条上限，请删除旧记录');
  const createdAt=Date.now(),id=String(createdAt)+'-'+crypto.randomBytes(12).toString('hex');
  const temp=fs.mkdtempSync(path.join(SHARE_DIR,'.pending-'));
  try{
    for(let i=0;i<images.length;i++)fs.writeFileSync(path.join(temp,i+'.jpg'),images[i],{mode:0o600,flag:'wx'});
    fs.writeFileSync(path.join(temp,'meta.json'),JSON.stringify({createdAt,text,count:images.length,owner:user.username,nickname:user.nickname}),{mode:0o600,flag:'wx'});
    fs.renameSync(temp,path.join(SHARE_DIR,id));
  }catch(e){try{fs.rmSync(temp,{recursive:true,force:true})}catch{}throw e;}
  return shareMeta(id,user);
}
function shareRoute(req,res,url){
  const p=url.pathname,user=currentUser(req);
  if(!p.startsWith('/api/share/'))return false;
  const fail=(status,error)=>reply(res,status,{error});
  try{
    if(req.method==='GET'&&p==='/api/share/posts'){
      const before=url.searchParams.get('before');
      if(before&&!SHARE_ID.test(before)){fail(400,'无效分页');return true;}
      const ids=shareIds().filter(id=>!before||id<before),batch=ids.slice(0,15);
      reply(res,200,{posts:batch.map(id=>shareMeta(id,user)),next:ids.length>15?batch.at(-1):null});return true;
    }
    const im=/^\/api\/share\/image\/([0-9]{13}-[a-f0-9]{24})\/([0-8])$/.exec(p);
    if(req.method==='GET'&&im){
      try{reply(res,200,fs.readFileSync(path.join(SHARE_DIR,im[1],im[2]+'.jpg')),'image/jpeg')}catch{fail(404,'图片不存在')}
      return true;
    }
    if(req.method!=='POST'&&req.method!=='DELETE'){fail(405,'不支持的操作');return true;}
    if(req.headers['x-pro-share']!=='1'){fail(403,'无效操作');req.resume();return true;}
    const del=/^\/api\/share\/posts\/([0-9]{13}-[a-f0-9]{24})$/.exec(p);
    if(req.method==='DELETE'&&del){
      const dir=path.join(SHARE_DIR,del[1]);
      if(!fs.existsSync(dir)){fail(404,'记录不存在');return true;}
      const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8'));
      if(!user||(meta.owner!==user.username&&!isAdmin(user))){fail(403,'只能删除自己发表的动态');return true;}
      fs.rmSync(dir,{recursive:true,force:false});
      if(meta.owner!==user.username)log('ADMIN_MODERATION '+JSON.stringify({action:'delete_post',actor:user.username,target:meta.owner||null,post:del[1],at:Date.now()}));
      reply(res,200,{ok:true});return true;
    }
    if(req.method!=='POST'||p!=='/api/share/posts'){fail(404,'接口不存在');return true;}
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){fail(415,'仅支持JSON');req.resume();return true;}
    if(Number(req.headers['content-length'])>SHARE_BODY){fail(413,'图片总大小超过限制');req.resume();return true;}
    if(sharePending>=2){fail(429,'正在处理其他发表，请稍后再试');req.resume();return true;}
    sharePending++;
    let parts=[],size=0,finished=false;
    const finish=()=>{if(finished)return false;finished=true;sharePending--;return true;};
    req.setTimeout(30000,()=>{finish();req.destroy()});
    req.on('aborted',finish);req.on('error',finish);req.on('close',finish);
    req.on('data',chunk=>{if(finished)return;size+=chunk.length;if(size>SHARE_BODY){finish();parts=[];fail(413,'图片总大小超过限制');req.resume();return;}parts.push(chunk)});
    req.on('end',()=>{
      if(!finish())return;
      const author=currentUser(req);
      if(!author){fail(401,'登录已过期，请重新登录');return;}
      let payload;try{payload=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{fail(400,'无效内容');return;}
      try{reply(res,201,{post:shareCreate(payload,author)})}catch(e){if(e.code){log('SHARE_WRITE_ERROR '+String(e.code));fail(500,'保存失败，请检查服务器存储')}else fail(400,String(e.message).slice(0,120))}
    });
    return true;
  }catch(e){log('SHARE_ERROR '+String(e.code||'internal'));fail(500,'分享圈读取或操作失败');return true;}
}


// Profile settings are authenticated and stored atomically beside the account.
function accountPublic(account){
  return {username:account.username,nickname:account.nickname,avatar:account.avatar?'/api/account/avatar/'+account.username+'?v='+Number(account.avatarAt||0):null};
}
function replaceAccount(account){
  const temp=path.join(ACCOUNTS,'.edit-'+crypto.randomBytes(16).toString('hex'));
  try{fs.writeFileSync(temp,JSON.stringify(account),{mode:0o600,flag:'wx'});fs.renameSync(temp,path.join(ACCOUNTS,account.username+'.json'))}
  finally{try{fs.unlinkSync(temp)}catch{}}
}
let profilePending=0,profileFailures=new Map();
function accountRoute(req,res,url){
  const p=url.pathname;
  if(!p.startsWith('/api/account/'))return false;
  const user=currentUser(req),fail=(status,error)=>reply(res,status,{error});
  if(!user){fail(401,'请先登录');return true}
  try{
    const account=readAccount(user.username);
    if(!account){fail(401,'账号不存在');return true}
    if(req.method==='GET'&&p==='/api/account/me'){reply(res,200,{...accountPublic(account),admin:isOwnerAccount(account)});return true}
    const match=/^\/api\/account\/avatar\/([a-z0-9_]{3,24})$/.exec(p);
    if(req.method==='GET'&&match){
      const other=match[1]===user.username?account:readAccount(match[1]);
      if(!other?.avatar){fail(404,'尚未设置头像');return true}
      reply(res,200,Buffer.from(other.avatar,'base64'),'image/jpeg');return true;
    }
    if(req.method!=='POST'||!['/api/account/profile','/api/account/password'].includes(p)){fail(404,'接口不存在');return true}
    if(req.headers['x-pro-account']!=='1'||req.headers['sec-fetch-site']==='cross-site'){fail(403,'无效操作');req.resume();return true}
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){fail(415,'仅支持JSON');req.resume();return true}
    const limit=p.endsWith('/password')?4096:650*1024;
    if(Number(req.headers['content-length'])>limit){fail(413,'内容超过限制');req.resume();return true}
    if(profilePending>=3){fail(429,'请求过多，请稍后重试');req.resume();return true}
    profilePending++;
    let chunks=[],size=0,done=false,released=false;
    const release=()=>{if(!released){released=true;profilePending--}};
    const abort=()=>{if(!done){done=true;release()}};
    req.setTimeout(15000,()=>{abort();req.destroy()});req.on('aborted',abort);req.on('error',abort);req.on('close',abort);
    req.on('data',b=>{if(done)return;size+=b.length;if(size>limit){abort();chunks=[];fail(413,'内容超过限制');req.resume();return}chunks.push(b)});
    req.on('end',async()=>{
      if(done)return;done=true;
      try{
        if(currentUser(req)?.username!==user.username){fail(401,'登录已过期');return}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail(400,'无效内容');return}
        if(!body||typeof body!=='object'||Array.isArray(body)){fail(400,'无效内容');return}
        const fresh=readAccount(user.username);
        if(!fresh){fail(401,'账号不存在');return}
        if(p.endsWith('/profile')){
          const nickname=typeof body.nickname==='string'?body.nickname.trim():'';
          if(!nickname||nickname.length>24||/[\x00-\x1f\x7f]/.test(nickname)){fail(400,'昵称需为1–24个有效字符');return}
          if(Object.hasOwn(body,'avatar')){
            if(body.avatar===null){delete fresh.avatar;delete fresh.avatarAt}
            else{try{shareImage(body.avatar)}catch(e){fail(400,e.message);return}fresh.avatar=body.avatar;fresh.avatarAt=Date.now()}
          }
          fresh.nickname=nickname;replaceAccount(fresh);
          for(const sess of sessions.values())if(sess.user?.username===fresh.username)sess.user.nickname=nickname;
          reply(res,200,accountPublic(fresh));return;
        }
        const {oldPassword,newPassword,confirm}=body;
        if(typeof oldPassword!=='string'||typeof newPassword!=='string'||Buffer.byteLength(oldPassword)>128||Buffer.byteLength(newPassword)>128||newPassword.length<10||newPassword!==confirm||oldPassword===newPassword){fail(400,'新密码至少10位，两次输入一致，且不同于旧密码');return}
        const now=Date.now(),attempts=(profileFailures.get(user.username)||[]).filter(t=>t>now-5*60*1000);
        if(attempts.length>=5){fail(429,'旧密码尝试过多，五分钟后再试');return}
        attempts.push(now);profileFailures.set(user.username,attempts);
        const candidate=await passwordHash(oldPassword,fresh.salt);
        if(!crypto.timingSafeEqual(candidate,Buffer.from(fresh.hash,'hex'))){fail(403,'旧密码错误');return}
        const salt=crypto.randomBytes(16).toString('hex'),hash=(await passwordHash(newPassword,salt)).toString('hex');
        const latest=readAccount(user.username);
        if(!latest||latest.hash!==fresh.hash||currentUser(req)?.username!==user.username){fail(409,'账号状态已改变，请重新登录');return}
        latest.salt=salt;latest.hash=hash;replaceAccount(latest);
        profileFailures.delete(user.username);
        for(const [token,sess] of sessions)if(sess.user?.username===user.username)sessions.delete(token);
        reply(res,200,{ok:true,relogin:true});
      }catch(e){log('PROFILE_ERROR '+String(e.code||'internal'));if(!res.destroyed)fail(500,'账号设置保存失败')}
      finally{release()}
    });return true;
  }catch(e){log('PROFILE_ERROR '+String(e.code||'internal'));fail(500,'账号设置读取失败');return true}
}


// Private friend requests and direct messages. All operations require a session.
const CHAT_DIR=path.join(dataPath,'private-chat-v1');
const CHAT_PAIR=/^[a-z0-9_]{3,24}\.[a-z0-9_]{3,24}\.json$/;
const CHAT_LIMIT=500;
let chatPending=0;
function chatFile(a,b){return path.join(CHAT_DIR,[a,b].sort().join('.')+'.json')}
function chatGet(a,b){
  if(!USER_RE.test(a)||!USER_RE.test(b)||a===b)return null;
  try{return JSON.parse(fs.readFileSync(chatFile(a,b),'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}
}
function chatSave(v){
  fs.mkdirSync(CHAT_DIR,{recursive:true,mode:0o700});
  const tmp=path.join(CHAT_DIR,'.tmp-'+crypto.randomBytes(12).toString('hex'));
  try{fs.writeFileSync(tmp,JSON.stringify(v),{flag:'wx',mode:0o600});fs.renameSync(tmp,chatFile(...v.users))}
  finally{try{fs.unlinkSync(tmp)}catch{}}
}
function chatFiles(){
  try{return fs.readdirSync(CHAT_DIR).filter(n=>CHAT_PAIR.test(n))}catch(e){if(e.code==='ENOENT')return [];throw e}
}
function chatOwnFiles(name,files=chatFiles()){
  return files.filter(n=>{const a=n.split('.');return a[0]===name||a[1]===name});
}

const PRESENCE_FILE=path.join(dataPath,'chat-last-active-v1.json');
const presenceLast=new Map();
let presenceLoaded=false,presenceDirty=false,presenceSavedAt=0;
const PRESENCE_ONLINE_MS=20000;
function loadPresence(){
  if(presenceLoaded)return;presenceLoaded=true;
  try{
    const value=JSON.parse(fs.readFileSync(PRESENCE_FILE,'utf8'));
    for(const [name,at] of Object.entries(value))if(USER_RE.test(name)&&Number.isSafeInteger(at)&&at>0&&at<=Date.now()+1000)presenceLast.set(name,at);
  }catch(e){if(e.code!=='ENOENT')log('PRESENCE_READ '+String(e.code||'invalid'))}
}
function savePresence(force=false){
  if(!presenceDirty||(!force&&Date.now()-presenceSavedAt<30000))return;
  try{
    fs.mkdirSync(dataPath,{recursive:true,mode:0o700});
    const tmp=PRESENCE_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(Object.fromEntries(presenceLast)),{mode:0o600});fs.renameSync(tmp,PRESENCE_FILE);
    presenceSavedAt=Date.now();presenceDirty=false;
  }catch(e){log('PRESENCE_SAVE '+String(e.code||'internal'))}
}
function touchPresence(req,now=Date.now()){
  const session=sessions.get(sessionToken(req));
  if(!session?.user||session.until<=now)return;
  loadPresence();session.activeAt=now;
  presenceLast.set(session.user.username,now);presenceDirty=true;savePresence();
}
function chatPresence(name,now=Date.now()){
  loadPresence();
  let online=false;
  for(const session of sessions.values())if(session.user?.username===name&&session.until>now&&Number.isFinite(session.activeAt)&&now-session.activeAt<=PRESENCE_ONLINE_MS&&session.activeAt<=now+1000){online=true;break}
  const at=presenceLast.get(name)||null;
  return {online,lastActiveAt:at,ageMs:at===null?null:Math.max(0,now-at)};
}
function chatPeer(account,accepted){
  const p=accountPublic(account);
  return accepted?{...p,presence:chatPresence(account.username)}:p;
}

function chatList(name){
  const result=[];
  for(const file of chatOwnFiles(name)){
    const [a,b]=file.split('.'),peer=a===name?b:a,v=chatGet(name,peer),acc=readAccount(peer);
    if(!v||!acc||!v.users.includes(name))continue;
    const last=v.messages.at(-1),read=v.read[name]||0;
    result.push({peer:chatPeer(acc,v.state==='accepted'),adminAddedBy:v.adminAddedBy||null,state:v.state,incoming:v.state==='pending'&&v.requester!==name,last:last?{text:last.text,at:last.at,from:last.from}:null,unread:v.state==='accepted'?v.messages.filter(m=>m.from!==name&&m.id>read).length:0,lastIncoming:v.state==='accepted'?(v.messages.filter(m=>m.from!==name).at(-1)?.id||0):0,updatedAt:v.updatedAt});
  }
  result.sort((a,b)=>Number(b.incoming)-Number(a.incoming)||b.updatedAt-a.updatedAt);
  return {items:result,unread:result.reduce((n,v)=>n+v.unread+(v.incoming?1:0),0)};
}
function chatOperation(name,p,body){
  const err=(status,message)=>({status,data:{error:message}});
  const ok=data=>({status:200,data});
  const peer=body?.peer;
  if(typeof peer!=='string'||!USER_RE.test(peer)||peer===name)return err(400,'请输入其他用户的正确账号');
  const account=readAccount(peer);
  if(!account)return err(404,'未找到该账号');
  let v=chatGet(name,peer);
  if(p==='request'){
    const admin=isAdmin({username:name});
    if(v){
      if(v.state==='pending'&&admin){
        v.state='accepted';v.adminAddedBy=name;v.updatedAt=Date.now();chatSave(v);
        log('ADMIN_FRIEND_ADD '+JSON.stringify({actor:name,target:peer,at:v.updatedAt}));
        return ok({ok:true,state:'accepted'});
      }
      return err(409,v.state==='accepted'?'已经是好友':'好友申请已存在');
    }
    const files=chatFiles();
    if(files.length>=500||chatOwnFiles(name,files).length>=40||chatOwnFiles(peer,files).length>=40)return err(409,'好友或申请数量已达上限');
    v={users:[name,peer].sort(),state:admin?'accepted':'pending',requester:name,updatedAt:Date.now(),messages:[],read:{[name]:0,[peer]:0}};
    if(admin)v.adminAddedBy=name;
    chatSave(v);
    if(admin)log('ADMIN_FRIEND_ADD '+JSON.stringify({actor:name,target:peer,at:v.updatedAt}));
    return ok({ok:true,state:v.state});
  }
  if(!v||!v.users.includes(name)||!v.users.includes(peer))return err(403,'请先添加好友');
  if(p==='accept'||p==='reject'){
    if(v.state!=='pending'||v.requester!==peer)return err(403,'只能处理收到的好友申请');
    if(p==='reject'){fs.unlinkSync(chatFile(name,peer));return ok({ok:true})}
    v.state='accepted';v.updatedAt=Date.now();chatSave(v);return ok({ok:true});
  }
  if(v.state!=='accepted')return err(403,'好友申请尚未通过');
  if(p==='send'){
    const text=typeof body.text==='string'?body.text.trim():'';
    if(!text||text.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))return err(400,'消息须为1–1000字');
    if(v.messages.length>=CHAT_LIMIT)return err(409,'此会话已达500条保存上限');
    const clientId=body.clientId;
    if(typeof clientId!=='string'||!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId))return err(400,'无效消息标识');
    const previous=v.messages.find(m=>m.from===name&&m.clientId===clientId);
    if(previous)return ok({message:previous});
    const m={id:(v.messages.at(-1)?.id||0)+1,from:name,text,at:Date.now(),clientId};
    v.messages.push(m);v.updatedAt=m.at;chatSave(v);return ok({message:m});
  }
  if(p==='read'){
    const upTo=body.upTo;
    if(!Number.isSafeInteger(upTo)||upTo<1)return err(400,'无效已读标记');
    const last=v.messages.filter(m=>m.from===peer&&m.id<=upTo).at(-1);
    if(last&&last.id>(v.read[name]||0)){v.read[name]=last.id;chatSave(v)}
    return ok({ok:true});
  }
  return err(404,'接口不存在');
}
function chatRoute(req,res,url){
  const prefix='/api/chat/';
  if(!url.pathname.startsWith(prefix))return false;
  const user=currentUser(req),p=url.pathname.slice(prefix.length),fail=(status,error)=>reply(res,status,{error});
  if(!user){fail(401,'请先登录');return true}
  try{
    if(req.method==='GET'&&p==='list'){if(req.headers['x-pro-presence']==='1'&&req.headers['sec-fetch-site']!=='cross-site')touchPresence(req);reply(res,200,chatList(user.username));return true}
    if(req.method==='GET'&&p==='messages'){
      const peer=url.searchParams.get('peer')||'',v=chatGet(user.username,peer);
      if(!v||v.state!=='accepted'||!v.users.includes(user.username)){fail(403,'只能查看自己的好友会话');return true}
      const acc=readAccount(peer);if(!acc){fail(404,'账号不存在');return true}
      const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):Infinity;
      if(before!==Infinity&&(!Number.isSafeInteger(before)||before<1)){fail(400,'分页无效');return true}
      const all=v.messages.filter(m=>m.id<before),messages=all.slice(-80).map(m=>({id:m.id,from:m.from,text:m.text,at:m.at}));
      reply(res,200,{me:user.username,peer:chatPeer(acc,true),messages,peerRead:v.read[peer]||0,myRead:v.read[user.username]||0,hasOlder:all.length>80});return true;
    }
    if(req.method!=='POST'||!['request','accept','reject','send','read'].includes(p)){fail(404,'接口不存在');return true}
    if(req.headers['x-pro-chat']!=='1'||req.headers['sec-fetch-site']==='cross-site'){fail(403,'无效请求');req.resume();return true}
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){fail(415,'仅支持JSON');req.resume();return true}
    if(Number(req.headers['content-length'])>8192){fail(413,'请求过大');req.resume();return true}
    if(chatPending>=8){fail(429,'请求过多，请稍后重试');req.resume();return true}
    chatPending++;let parts=[],size=0,done=false;
    const finish=()=>{if(done)return false;done=true;chatPending--;return true};
    req.setTimeout(10000,()=>{finish();req.destroy()});req.on('aborted',finish);req.on('error',finish);req.on('close',finish);
    req.on('data',b=>{if(done)return;size+=b.length;if(size>8192){finish();parts=[];fail(413,'请求过大');req.resume();return}parts.push(b)});
    req.on('end',()=>{
      if(!finish())return;
      try{
        if(currentUser(req)?.username!==user.username){fail(401,'登录已过期');return}
        let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{fail(400,'无效请求');return}
        const result=chatOperation(user.username,p,body);reply(res,result.status,result.data);
      }catch(e){log('CHAT_WRITE_ERROR '+String(e.code||'internal'));fail(500,'消息操作失败，请稍后重试')}
    });return true;
  }catch(e){log('CHAT_READ_ERROR '+String(e.code||'internal'));fail(500,'聊天读取失败');return true}
}


let moderationPending=0;
function moderateAccount(actor,target,minutes){
  const fail=(status,error)=>({status,data:{error}});
  if(!isAdmin(actor))return fail(403,'需要管理员权限');
  if(typeof target!=='string'||!USER_RE.test(target)||target===actor.username)return fail(400,'请选择其他账号');
  if(!Number.isInteger(minutes)||minutes<0||minutes>5)return fail(400,'限制时间仅允许0至5分钟');
  const account=readAccount(target);
  if(!account)return fail(404,'账号不存在');
  if(isOwnerAccount(account))return fail(403,'不能限制管理员');
  const now=Date.now();
  // Do not accidentally shorten an existing restriction when only kicking.
  const until=Math.max(Number.isSafeInteger(account.blockedUntil)?account.blockedUntil:0,minutes?now+minutes*60000:0);
  if(until>now){account.blockedUntil=until;replaceAccount(account)}
  let revoked=0;
  for(const [token,sess] of sessions)if(sess.user?.username===target){sessions.delete(token);revoked++}
  log('ADMIN_MODERATION '+JSON.stringify({actor:actor.username,action:minutes?'kick_and_restrict':'kick',target,minutes,revoked,blockedUntil:until>now?until:0,at:now}));
  return {status:200,data:{ok:true,revoked,blockedUntil:until>now?until:0}};
}
function moderationRoute(req,res,url){
  if(!url.pathname.startsWith('/api/moderation/'))return false;
  const user=currentUser(req),fail=(status,error)=>reply(res,status,{error});
  if(!isAdmin(user)){fail(403,'需要管理员权限');req.resume();return true}
  if(req.method!=='POST'||url.pathname!=='/api/moderation/kick'){fail(404,'接口不存在');req.resume();return true}
  if(req.headers['x-pro-admin']!=='1'||req.headers['sec-fetch-site']==='cross-site'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){fail(403,'无效操作');req.resume();return true}
  if(Number(req.headers['content-length'])>1024||moderationPending>=2){fail(429,'请求过多或过大');req.resume();return true}
  moderationPending++;
  let chunks=[],size=0,done=false;
  const finish=()=>{if(done)return false;done=true;moderationPending--;return true};
  req.setTimeout(10000,()=>{finish();req.destroy()});req.on('aborted',finish);req.on('error',finish);req.on('close',finish);
  req.on('data',b=>{if(done)return;size+=b.length;if(size>1024){finish();chunks=[];fail(413,'请求过大');req.resume();return}chunks.push(b)});
  req.on('end',()=>{
    if(!finish())return;
    try{
      const actor=currentUser(req);
      if(actor?.username!==user.username||!isAdmin(actor)){fail(403,'管理员会话已失效');return}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail(400,'无效内容');return}
      const r=moderateAccount(actor,body?.target,body?.minutes);reply(res,r.status,r.data);
    }catch(e){log('MODERATION_ERROR '+String(e.code||'internal'));fail(500,'管理员操作失败')}
  });return true;
}


// Clearly labeled virtual practice ledger. No payment, withdrawal, exchange
// credentials, real orders, leverage, or monetary entitlement.
const SIM_DIR=path.join(dataPath,'practice-points-v1');
const SIM_AMOUNTS=[100,500,1000,5000];
const SIM_CAP=100000;
let simPending=0;
function simFile(name){if(!USER_RE.test(name))throw Error('Invalid account');return path.join(SIM_DIR,name+'.json')}
function simGet(name){
  try{return JSON.parse(fs.readFileSync(simFile(name),'utf8'))}
  catch(e){if(e.code==='ENOENT')return {balance:0,positions:{},requests:[],trades:[]};throw e}
}
function simSave(name,v){
  fs.mkdirSync(SIM_DIR,{recursive:true,mode:0o700});
  const tmp=path.join(SIM_DIR,'.tmp-'+crypto.randomBytes(12).toString('hex'));
  try{fs.writeFileSync(tmp,JSON.stringify(v),{flag:'wx',mode:0o600});fs.renameSync(tmp,simFile(name))}
  finally{try{fs.unlinkSync(tmp)}catch{}}
}
function simQuote(symbol,now=Date.now()){
  const m=MARKETS.get(symbol);
  if(!allowedSymbol(symbol)||!m)return null;
  const price=Number(m.price),at=Number(m.priceAt);
  return {symbol,price:Number.isFinite(price)&&price>0?price:null,at:Number.isFinite(at)?at:0,
    fresh:Number.isFinite(price)&&price>0&&Number.isFinite(at)&&at>0&&Math.abs(now-at)<45000,
    change:Number.isFinite(m.change24h)?m.change24h:null,
    book:m.book&&Number.isFinite(m.book.at)&&Math.abs(now-m.book.at)<30000&&m.book.bid>0&&m.book.ask>=m.book.bid?{bid:m.book.bid,ask:m.book.ask,at:m.book.at}:null};
}
function simRequests(){
  let files=[];try{files=fs.readdirSync(SIM_DIR)}catch(e){if(e.code!=='ENOENT')throw e}
  const out=[];
  for(const file of files){
    if(!/^[a-z0-9_]{3,24}\.json$/.test(file))continue;
    const name=file.slice(0,-5),v=simGet(name);
    for(const r of v.requests)if(r.status==='pending')out.push({...r,username:name});
  }
  return out.sort((a,b)=>a.at-b.at);
}
function simView(name){
  const v=simGet(name),quotes=FIVE_SYMBOLS.map(symbol=>simQuote(symbol)||{symbol,price:null,at:0,fresh:false,change:null});
  return {unit:'虚拟练习点',balance:v.balance,positions:v.positions,requests:v.requests.slice(-50).reverse(),trades:v.trades.slice(-50).reverse(),quotes,serverTime:Date.now()};
}
function simOperation(user,op,body){
  const fail=(status,error)=>({status,data:{error}}),ok=data=>({status:200,data});
  if(!body||typeof body!=='object'||Array.isArray(body))return fail(400,'无效请求');
  const name=user.username;
  if(op==='review'){
    if(!isAdmin(user))return fail(403,'需要管理员权限');
    const target=body.username,id=body.id;
    if(typeof target!=='string'||!USER_RE.test(target)||typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id)||!['approve','reject'].includes(body.decision))return fail(400,'无效审核操作');
    if(!readAccount(target))return fail(404,'账号不存在');
    const v=simGet(target),r=v.requests.find(x=>x.id===id);
    if(!r)return fail(404,'申请不存在');
    if(r.status!=='pending')return fail(409,'申请已处理，请刷新');
    if(body.decision==='approve'&&v.balance+r.amount>SIM_CAP)return fail(409,'虚拟余额将超过上限，请拒绝或稍后审核');
    if(body.decision==='approve')v.balance+=r.amount;
    r.status=body.decision==='approve'?'approved':'rejected';r.reviewedAt=Date.now();r.reviewer=name;
    simSave(target,v);log('PRACTICE_REVIEW '+JSON.stringify({actor:name,target,id,decision:body.decision,amount:r.amount,at:r.reviewedAt}));
    return ok({ok:true});
  }
  const v=simGet(name);
  if(op==='request'){
    if(!SIM_AMOUNTS.includes(body.amount))return fail(400,'请选择预设虚拟额度');
    if(v.requests.some(r=>r.status==='pending'))return fail(409,'已有待审核申请');
    if(v.requests.length>=200)return fail(409,'申请记录已达上限');
    if(v.balance+body.amount>SIM_CAP)return fail(409,'虚拟余额将超过上限');
    const r={id:crypto.randomBytes(12).toString('hex'),amount:body.amount,status:'pending',at:Date.now()};
    v.requests.push(r);simSave(name,v);return ok({request:r});
  }
  if(op!=='practice')return fail(404,'接口不存在');
  const {symbol,side,clientId}=body;
  if(typeof clientId!=='string'||!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId))return fail(400,'无效练习标识');
  const previous=v.trades.find(x=>x.clientId===clientId);
  if(previous)return ok({trade:previous});
  if(v.trades.length>=500)return fail(409,'练习记录已达500条上限');
  if(!allowedSymbol(symbol)||!['buy','sell'].includes(side))return fail(400,'无效合约或操作');
  const quote=simQuote(symbol);if(!quote?.fresh)return fail(409,'报价过期，暂停模拟操作');
  const price=quote.price,old=v.positions[symbol]||{qty:0,cost:0};
  let amount,qty;
  if(side==='buy'){
    amount=body.amount;
    if(!Number.isInteger(amount)||amount<1||amount>1000||amount>v.balance)return fail(400,'请输入1–1000练习点，且不得超过余额');
    qty=amount/price;
    v.balance-=amount;v.positions[symbol]={qty:old.qty+qty,cost:old.cost+amount};
  }else{
    if(!(old.qty>0))return fail(400,'没有该合约的模拟持有记录');
    qty=old.qty;amount=Math.floor(qty*price*100)/100;
    if(!Number.isFinite(amount)||amount<0||v.balance+amount>SIM_CAP)return fail(409,'模拟结算超过余额上限');
    v.balance=Math.round((v.balance+amount)*100)/100;delete v.positions[symbol];
  }
  const trade={id:crypto.randomBytes(12).toString('hex'),clientId,symbol,side,price,qty,amount,at:Date.now(),quoteAt:quote.at};
  v.trades.push(trade);simSave(name,v);return ok({trade});
}

const SIM_PERIODS=['line','1s','1m','3m','5m','15m','30m','1h','2h'];
const simDataCache=new Map();
let simDataActive=0;
async function simCached(key,ttl,loader){
  const now=Date.now();let item=simDataCache.get(key);
  if(item?.pending)return item.pending;
  if(item&&now-item.at<ttl)return item.value;
  if(simDataActive>=5)throw Error('行情请求繁忙');
  item={at:now,value:null,pending:null};simDataCache.set(key,item);simDataActive++;
  item.pending=(async()=>{try{item.value=await loader();return item.value}finally{item.at=Date.now();item.pending=null;simDataActive--}})();
  return item.pending;
}
function simBar(r){
  const [t,o,h,l,c,v]=r.map(Number);
  return [t,o,h,l,c,v].every(Number.isFinite)&&t>0&&o>0&&l>0&&h>=Math.max(o,c,l)&&l<=Math.min(o,c)&&v>=0?{t,o,h,l,c,v}:null;
}
function simSecondBars(trades){
  if(!Array.isArray(trades))return [];
  const map=new Map();
  for(const a of [...trades].sort((x,y)=>Number(x.T)-Number(y.T)||Number(x.a)-Number(y.a))){
    const p=Number(a.p),q=Number(a.q),t=Math.floor(Number(a.T)/1000)*1000;
    if(!Number.isFinite(t)||t<=0||!(p>0)||!Number.isFinite(p)||!(q>=0)||!Number.isFinite(q))continue;
    const b=map.get(t);
    if(b){b.h=Math.max(b.h,p);b.l=Math.min(b.l,p);b.c=p;b.v+=q}
    else map.set(t,{t,o:p,h:p,l:p,c:p,v:q});
  }
  return [...map.values()].slice(-150);
}
async function simChartData(symbol,interval){
  return simCached('chart:'+symbol+':'+interval,interval==='1s'?5000:15000,async()=>{
    const query='symbol='+encodeURIComponent(symbol);
    if(interval==='1s'){
      const raw=await json(BINANCE+'/fapi/v1/aggTrades?'+query+'&limit=1000',8000);
      return {symbol,interval,rows:simSecondBars(raw),source:'近期公开聚合成交按秒归并；无成交秒留空，覆盖长度随成交频率变化。'};
    }
    const p=interval==='line'?'1m':interval;
    const raw=await json(BINANCE+'/fapi/v1/klines?'+query+'&interval='+p+'&limit=150',8000);
    if(!Array.isArray(raw))throw Error('无有效K线');
    return {symbol,interval,rows:raw.map(simBar).filter(Boolean),source:interval==='line'?'1分钟公开K线收盘价连线（末根可能未收盘）':'交易所公开K线，末根可能尚未收盘'};
  });
}
async function simPublicInfo(symbol){
  return simCached('info:'+symbol,10000,async()=>{
    const q='symbol='+encodeURIComponent(symbol);
    const [fund,depth]=await Promise.allSettled([json(BINANCE+'/fapi/v1/premiumIndex?'+q,7000),json(BINANCE+'/fapi/v1/depth?'+q+'&limit=5',7000)]);
    const f=fund.status==='fulfilled'?fund.value:null,d=depth.status==='fulfilled'?depth.value:null;
    const levels=a=>Array.isArray(a)?a.slice(0,5).map(r=>({price:Number(r[0]),qty:Number(r[1])})).filter(r=>Number.isFinite(r.price)&&Number.isFinite(r.qty)&&r.price>0&&r.qty>=0):[];
    const rate=Number(f?.lastFundingRate),next=Number(f?.nextFundingTime),fundAt=Number(f?.time),mark=Number(f?.markPrice),at=Number(d?.T||d?.E);
    return {symbol,funding:f&&Number.isFinite(rate)&&Number.isFinite(next)&&next>0&&Number.isFinite(fundAt)&&fundAt>0?{rate,next,at:fundAt,mark:Number.isFinite(mark)&&mark>0?mark:null}:null,
      depth:d&&Number.isFinite(at)&&at>0?{asks:levels(d.asks),bids:levels(d.bids),at}:null};
  });
}

const PRACTICE_PAUSED=true;
function simRoute(req,res,url){
  if(!url.pathname.startsWith('/api/practice/'))return false;
  if(PRACTICE_PAUSED){req.resume();reply(res,503,{error:'暂停服务，请返回其他界面',paused:true});return true}
  const user=currentUser(req),p=url.pathname.slice('/api/practice/'.length),fail=(status,error)=>reply(res,status,{error});
  if(!user){fail(401,'请先登录');return true}
  try{
    if(req.method==='GET'&&p==='state'){reply(res,200,simView(user.username));return true}
    if(req.method==='GET'&&(p==='chart'||p==='public-info')){
      const symbol=url.searchParams.get('symbol')||'',interval=url.searchParams.get('interval')||'2h';
      if(!allowedSymbol(symbol)||!SIM_PERIODS.includes(interval)){fail(400,'无效合约或周期');return true}
      const task=p==='chart'?simChartData(symbol,interval):simPublicInfo(symbol);
      task.then(value=>{if(!res.destroyed)reply(res,value?200:503,value||{error:'公开行情暂不可用'})}).catch(()=>{if(!res.destroyed)fail(503,'公开行情暂不可用')});
      return true;
    }
    if(req.method==='GET'&&p==='review'){
      if(!isAdmin(user)){fail(403,'需要管理员权限');return true}
      reply(res,200,{pending:simRequests()});return true;
    }
    if(req.method!=='POST'||!['request','review','practice'].includes(p)){fail(404,'接口不存在');return true}
    if(req.headers['x-pro-practice']!=='1'||req.headers['sec-fetch-site']==='cross-site'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){fail(403,'无效请求');req.resume();return true}
    if(Number(req.headers['content-length'])>4096||simPending>=6){fail(429,'请求过多或过大');req.resume();return true}
    simPending++;let chunks=[],size=0,done=false;
    const finish=()=>{if(done)return false;done=true;simPending--;return true};
    req.setTimeout(10000,()=>{finish();req.destroy()});req.on('aborted',finish);req.on('error',finish);req.on('close',finish);
    req.on('data',b=>{if(done)return;size+=b.length;if(size>4096){finish();chunks=[];fail(413,'请求过大');req.resume();return}chunks.push(b)});
    req.on('end',()=>{
      if(!finish())return;
      try{
        const actor=currentUser(req);if(actor?.username!==user.username){fail(401,'登录已过期');return}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail(400,'无效内容');return}
        const r=simOperation(actor,p,body);reply(res,r.status,r.data);
      }catch(e){log('PRACTICE_ERROR '+String(e.code||'internal'));fail(500,'模拟记录保存失败')}
    });return true;
  }catch(e){log('PRACTICE_ERROR '+String(e.code||'internal'));fail(500,'模拟数据读取失败');return true}
}


function publicQuoteView(symbol,market,trade,now=Date.now()){
  const valid=(p,at)=>Number.isFinite(p)&&p>0&&Number.isFinite(at)&&at>0&&at<=now+1000;
  const tape=trade&&valid(trade.price,trade.at)?{price:trade.price,at:trade.at,receivedAt:trade.receivedAt,source:'aggTrade'}:null;
  const ticker=valid(market?.price,market?.priceAt)?{price:market.price,at:market.priceAt,source:'ticker'}:null;
  // Prefer the real trade time. A ticker event timestamp does not prove a new trade.
  // If tape is stale, fall back to the separate ticker quote with its own label.
  const q=tape&&now-tape.at<=2500?tape:ticker&&now-ticker.at<=2500?ticker:(tape&&(!ticker||tape.at>=ticker.at)?tape:ticker);
  const age=q?Math.max(0,now-q.at):null;
  return {symbol,price:q?.price??null,at:q?.at??null,source:q?.source??null,ageMs:age,fresh:age!==null&&age<=2500,serverTime:now};
}


const classicFlowCache=new Map();
let classicPulseCache=null;
function classicLiveView(symbol,now=Date.now()){
  const market=MARKETS.get(symbol);
  if(!market||!allowedSymbol(symbol))return null;
  let cached=classicFlowCache.get(symbol);
  if(!cached||now-cached.at>=750){
    cached={at:now,micro:pro2Trades.getMicro(symbol),largeTrades:pro2Trades.getStats(symbol)};
    classicFlowCache.set(symbol,cached);
  }
  if(!classicPulseCache||now-classicPulseCache.at>=2000){
    classicPulseCache={at:now,value:pro2Trades.getMarketPulse()};
  }
  return {symbol,serverTime:now,quote:publicQuoteView(symbol,market,pro2Trades.getLatestPrint(symbol),now),
    micro:cached.micro,largeTrades:cached.largeTrades,flowAt:cached.at,marketPulse:classicPulseCache.value};
}


let shortBookBusy=false,shortBookTimer=null;
async function sampleStudyBook(){
  if(stop||shortBookBusy||!MARKETS.has('BTCUSDT'))return;
  shortBookBusy=true;
  try{
    const row=await json(BINANCE+'/fapi/v1/ticker/bookTicker?symbol=BTCUSDT',5000);
    if(row.symbol==='BTCUSDT')shortStudy.onBook(Number(row.bidPrice),Number(row.bidQty),Number(row.askPrice),Number(row.askQty),Number(row.time));
  }catch{}finally{shortBookBusy=false}
}


function swingStudySummary(symbol,study,now=Date.now()){
  if(symbol!=='BTCUSDT')return {supported:false,reason:'新增五类模型目前仅有 BTCUSDT 独立研究数据，不混用其他合约样本'};
  const d=study.snapshot(now);
  const fresh=d.enabled&&Number.isFinite(d.latestAt)&&d.latestAt>0&&now-d.latestAt<=6000&&d.latestAt<=now+1000;
  const bookFresh=Number.isFinite(d.bookAt)&&d.bookAt>0&&now-d.bookAt<=10000&&d.bookAt<=now+1000;
  return {supported:true,enabled:d.enabled,fresh,latestAt:d.latestAt||null,bookFresh,bookAt:d.bookAt||null,horizonSeconds:d.horizonSeconds,serverAt:now,
    models:d.models.map(m=>{
      const last=d.history.find(x=>x.code===m.code&&x.reason==='complete');
      return {code:m.code,label:m.label,note:m.note,status:!d.enabled?'研究已暂停':!fresh?'等待新鲜公开成交':m.code==='ofi'&&!bookFresh?'等待有效盘口快照':m.status,
        samples:m.samples,aligned:m.aligned,opposite:m.opposite,flat:m.flat,invalid:m.invalid,mean:m.mean,alignment:m.alignment,lastCompletedAt:last?.endAt||null,lastCompleted:last&&Number.isFinite(last.change)?{direction:last.direction,change:last.change,endAt:last.endAt}:null,
        byRegime:m.code==='vwap'?m.byRegime:undefined};
    })};
}

const server=http.createServer((req,res)=>{
  let url;try{url=new URL(req.url,'http://localhost')}catch{return reply(res,400,{error:'无效请求'})}
  if(!accessGate(req,res,url))return;
  if(shareRoute(req,res,url))return;
  if(accountRoute(req,res,url))return;
  if(chatRoute(req,res,url))return;
  if(moderationRoute(req,res,url))return;
  if(simRoute(req,res,url))return;
  if(req.method!=='GET')return reply(res,405,{error:'只允许GET；无交易/下单API'});
  if(url.pathname==='/api/ui-error'){log('PRO_FRONTEND_ERROR '+(url.searchParams.get('message')||'unknown').slice(0,200));return reply(res,200,{ok:true})}
  if(url.pathname==='/api/pro2/signal-lab')return reply(res,200,{...signalLab.snapshot(),shortStudy:shortStudy.snapshot()});
  if(url.pathname==='/api/pro2/snapshot')return reply(res,200,pro2.snapshot(pro2Trades));
  if(url.pathname==='/api/pro2/flow-health')return reply(res,200,pro2Trades.health());
  if(url.pathname==='/api/pro2/detail'){
    const symbol=(url.searchParams.get('symbol')||'').toUpperCase();
    // Public, read-only detail requests activate a bounded temporary trade stream.
    pro2Trades.watch(symbol);
    const value=pro2.detail(symbol,pro2Trades);return reply(res,value?200:404,value||{error:'合约不可用'});
  }
  if(url.pathname==='/api/pro2/classic-live'){
    const symbol=(url.searchParams.get('symbol')||'').toUpperCase();
    const value=classicLiveView(symbol);
    return reply(res,value?200:404,value||{error:'合约不可用'});
  }
  if(url.pathname==='/api/pro2/quote'){
    const symbol=(url.searchParams.get('symbol')||'').toUpperCase(),m=MARKETS.get(symbol);
    if(!allowedSymbol(symbol)||!m)return reply(res,404,{error:'合约不可用'});
    return reply(res,200,publicQuoteView(symbol,m,pro2Trades.getLatestPrint(symbol)));
  }
  if(url.pathname==='/api/pro2/swing'){
    const symbol=(url.searchParams.get('symbol')||'').toUpperCase();
    const m=MARKETS.get(symbol);if(!m)return reply(res,404,{error:'合约不可用'});
    if(!pro2Trades.watch(symbol))return reply(res,200,{version:'ssr-research-v1',symbol,ready:false,reason:'该合约暂无支持的公开主动成交流',periods:[]});
    return reply(res,200,{...pro2Trades.getSwing(symbol),symbol,exchangeLabel:m.exchangeLabel,shortStudy:swingStudySummary(symbol,shortStudy),follow:swingFollow.snapshot(symbol),horizonAudit:symbol==='BTCUSDT'?horizonAudit.snapshot():null,closedLab:symbol==='BTCUSDT'?(()=>{const d=signalLab.snapshot();return {enabled:d.enabled,lossGuard:d.lossGuard,history:d.history.filter(x=>['tp','sl'].includes(x.reason)&&Number.isFinite(x.entry)&&Number.isFinite(x.exit)).slice(0,10).map(x=>({label:x.label,entry:x.entry,exit:x.exit,exitAt:x.exitAt,reason:x.reason,pnl:x.pnl,observedPnl:x.observedPnl}))}})():null});
  }
  if(url.pathname==='/api/pro2/health')return reply(res,200,pro2.state());
  if(url.pathname==='/api/paper')return reply(res,200,paper.snapshot(Date.now()));
  if(url.pathname==='/api/snapshot')return reply(res,200,currentSnapshot());
  if(url.pathname==='/api/detail'){
    const symbol=(url.searchParams.get('symbol')||'').toUpperCase();
    const value=marketDetail(symbol);return reply(res,value?200:404,value||{error:'币种不可用'});
  }
  if(url.pathname==='/api/health')return reply(res,200,{status:state.binance.ws?'online':'waiting',ruleVersion:RULE_VERSION,
    binance:state.binance,okx:state.okx,markets:MARKETS.size,historyDone:[...MARKETS.values()].filter(m=>m.bars15?.length>=10).length});
  const clean=url.pathname==='/'?'/index.html':url.pathname;
  let filepath; try { const decoded=decodeURIComponent(clean); if(decoded.includes(String.fromCharCode(0))) return reply(res,400,{error:'Bad Request'}); filepath=path.resolve(PUBLIC,'.'+decoded); } catch { return reply(res,400,{error:'Bad Request'}); }
  if(!filepath.startsWith(PUBLIC+path.sep))return reply(res,403,{error:'禁止访问'});
  fs.readFile(filepath,(e,data)=>{
    if(e)return reply(res,404,{error:'Not Found'});
    if(filepath===path.join(PUBLIC,'index.html')){
      const user=currentUser(req);if(!user)return loginPage(res);
      return reply(res,200,data.toString('utf8').replace('data-pro-account=""','data-pro-account="'+user.username+'"').replace('data-pro-admin="0"','data-pro-admin="'+(isAdmin(user)?'1':'0')+'"').replace('<form class="me-logout"',isAdmin(user)?'<div style="padding:12px 16px;background:white;border-top:1px solid #eee"><a href="/device-lock" style="display:block;color:#168568;font-weight:600;text-decoration:none">管理员快捷解锁设置 / 锁定设备 ›</a></div><form class="me-logout"':'<form class="me-logout"'),MIME['.html']);
    }
    reply(res,200,data,MIME[path.extname(filepath)]||'application/octet-stream');
  });
});
server.listen(PORT,'127.0.0.1',()=>{
  pro2.start();pro2Trades.start();signalLab.flush();shortStudy.flush();swingFollow.flush();horizonAudit.flush();shortBookTimer=setInterval(sampleStudyBook,5000);shortBookTimer.unref?.();signalLabTimer=setInterval(scanSignalLab,1000);signalLabTimer.unref?.();
  log(`合约实时数据Pro v9代 本地运行: http://localhost:${PORT}`);
  if(ENABLE_LEGACY)stopPatternFeed=startPatternFeed({markets:MARKETS,json,binance:BINANCE,okx:OKX,
    okxWs:OKX_WS,stopped:()=>stop,log});
  initBinance(); // No OKX or COIN-M directory, sockets or polling.
  if(ENABLE_LEGACY)setInterval(runAnalysis,3000);
  setInterval(refreshBinanceBooks,20000).unref();
  void refreshBinanceBooks();

});
function shutdown(){stop=true;clearInterval(binanceTimer);clearInterval(okxTimer);
  clearTimeout(saveTimer);persistSignals();reviewHistory.save();paper.save();
  clearInterval(signalLabTimer);clearInterval(shortBookTimer);savePresence(true);shortStudy.flush();signalLab.flush();swingFollow.flush();horizonAudit.flush();stopPatternFeed?.();pro2.stop();pro2Trades.stop();
  state.wsB?.close();
  server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);


// Feed watchdog and public REST recovery.
let proQuotesBusy=false,proKlinesBusy=false,proLogAt=0;
async function recoverQuotes(){
  if(stop||proQuotesBusy||MARKETS.size===0)return;
  proQuotesBusy=true;
  try{
    const data=(await Promise.allSettled([...MARKETS.keys()].map(symbol=>json(BINANCE+'/fapi/v1/ticker/24hr?symbol='+encodeURIComponent(symbol),12000)))).filter(x=>x.status==='fulfilled').map(x=>x.value);
    if(!data.length)throw Error('No selected ticker response');
    const now=Date.now();let n=0;
    if(!Array.isArray(data))throw Error('Invalid ticker list');
    for(const t of data){
      const m=MARKETS.get(t.symbol);if(!m)continue;
      const timestamp=safeNumber(t.closeTime,0),price=safeNumber(t.lastPrice,0);
      // A valid and recent exchange event time is required; no manufactured freshness.
      if(!timestamp||Math.abs(now-timestamp)>45000||price<=0||timestamp<=(m.priceAt||0))continue;
      m.price=price;m.priceAt=timestamp;
      const q=safeNumber(t.quoteVolume);
      if(q>0)m.quoteVolume24h=q;
      const change=safeNumber(t.priceChangePercent,NaN);
      if(Number.isFinite(change))m.change24h=change;
      n++;
    }
    state.binance.rest=true;
    if(!state.binance.ws)state.binance.error='WebSocket暂停，公开REST报价补充中';
    if(now-proLogAt>60000){proLogAt=now;log('PRO_QUOTES_RECOVERY '+JSON.stringify({updated:n,ws:state.binance.ws,wsAge:now-state.binance.at}))}
  }catch(e){if(Date.now()-proLogAt>60000){proLogAt=Date.now();log('PRO_QUOTES_RECOVERY_ERROR '+String(e.message||e))}}
  finally{proQuotesBusy=false}
}
const proWatch=setInterval(()=>{
  if(stop||!state.wsB||state.wsB.readyState!==WebSocket.OPEN)return;
  const now=Date.now(),age=now-state.binance.at;
  if(age>26000){
    log('PRO_WS_STALL_RECONNECT '+age);
    state.binance.ws=false;state.binance.error='实时行情停止更新，自动重连';
    try{state.wsB.close(4000,'stalled feed')}catch(e){}
  }
},12000);
proWatch.unref();
const proQuotes=setInterval(()=>{void recoverQuotes()},10000);proQuotes.unref();
/* 2小时版不再启动分钟K线自动恢复。 */
setTimeout(()=>{void recoverQuotes()},4500).unref();


