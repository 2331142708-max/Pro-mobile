'use strict';
// Separate, verified 1-hour signal pipeline. The legacy 15/30-minute models are NOT used here.
const {matchPatterns}=require('./patterns');
const fs=require('node:fs');
const path=require('node:path');
const STEP=60*60*1000;
const VERSION='pro-mobile-1h-real-candles-v1';
const HISTORY=64;
const MAX_ALERTS=600;
function normBinance(b,now){
  if(!Array.isArray(b))return null;
  const t=+b[0],o=+b[1],h=+b[2],l=+b[3],c=+b[4],v=+b[5];
  if(!Number.isFinite(t)||t%STEP!==0||![o,h,l,c,v].every(Number.isFinite)||o<=0||c<=0||v<0||h<Math.max(o,c)||l>Math.min(o,c)||+b[6]>now-5000)return null;
  return {t,o,h,l,c,v,closed:true};
}
function normOkx(b,now){
  if(!Array.isArray(b)||String(b[8])!=='1')return null;
  const t=+b[0],o=+b[1],h=+b[2],l=+b[3],c=+b[4],v=+b[5];
  if(!Number.isFinite(t)||t%STEP!==0||t+STEP>now-5000||![o,h,l,c,v].every(Number.isFinite)||o<=0||c<=0||v<0||h<Math.max(o,c)||l>Math.min(o,c))return null;
  return {t,o,h,l,c,v,closed:true};
}
function contiguousTail(bars){
  if(!bars.length)return [];
  let i=bars.length-1;
  while(i>0&&bars[i].t-bars[i-1].t===STEP)i--;
  return bars.slice(i);
}
function analyzeBars(rows,now){
  const expected=Math.floor((now-5000)/STEP)*STEP-STEP;
  const last=rows.at(-1);
  const contiguous=contiguousTail(rows);
  if(!last||last.t!==expected||contiguous.length<20){
    return {ready:false,reason:!last?'尚未加载真实1小时K线':last.t!==expected?'等待最新1小时K线收盘数据':'连续历史K线不足20根',matches:[],bars:contiguous};
  }
  const levels={};
  const found=matchPatterns(contiguous,levels);
  const matches=[];
  for(const direction of ['up','down']){
    if(found[direction]?.length)matches.push({period:60,direction,names:found[direction],levels:Object.values(levels[direction]||{}),closedAt:last.t+STEP,close:last.c});
  }
  const p=contiguous.slice(-21,-1),volBase=p.reduce((sum,b)=>sum+b.v,0)/p.length;
  const volumeRatio=volBase>0?last.v/volBase:null;
  const absRanges=p.map(b=>b.h-b.l);
  const atr=absRanges.reduce((sum,x)=>sum+x,0)/absRanges.length;
  const prev=contiguous.slice(-21,-1);
  const high=Math.max(...prev.map(b=>b.h)),low=Math.min(...prev.map(b=>b.l));
  return {ready:true,reason:'已收盘1小时K线',matches,bars:contiguous,volumeRatio,atr,rangeHigh:high,rangeLow:low,closedAt:last.t+STEP};
}
function createPro2({markets,json,binance,okx,log,stopped,dataDir,allowedSymbols=null}){
  const file=path.join(dataDir,'pro2-alerts-1h.json');
  const source=file;
  let alerts=[];
  try{const found=JSON.parse(fs.readFileSync(source,'utf8'));if(Array.isArray(found))alerts=found.filter(x=>x&&x.version===VERSION).slice(-MAX_ALERTS)}catch{}
  let timer=null,checking=false,sequence=0,lastFetch=0,failCount=0,lastError='';
  const pending=new Set();
  let saveTimer;
  function persist(){try{fs.mkdirSync(dataDir,{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(alerts));fs.renameSync(temp,file)}catch(e){log('PRO2 保存预警失败 '+e.message)}}
  function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(persist,1500);saveTimer.unref?.()}
  function update(m,raw,now){
    const parsed=raw.map(x=>m.exchange==='okx'?normOkx(x,now):normBinance(x,now)).filter(Boolean);
    const rows=[...new Map(parsed.map(b=>[b.t,b])).values()].sort((a,b)=>a.t-b.t).slice(-HISTORY);
    const computed=analyzeBars(rows,now);
    m.pro2={...computed,seenAt:now,lastAttempt:now,rows,error:null};
    if(computed.ready){
      for(const hit of computed.matches){
        const key=m.symbol+':'+hit.direction+':'+hit.closedAt;
        if(alerts.some(a=>a.key===key))continue;
        alerts.push({key,version:VERSION,symbol:m.symbol,displaySymbol:m.displaySymbol,exchangeLabel:m.exchangeLabel,
          direction:hit.direction,names:hit.names,closedAt:hit.closedAt,observedAt:now,close:hit.close,
          volumeRatio:computed.volumeRatio,result:null});
        if(alerts.length>MAX_ALERTS)alerts=alerts.slice(-MAX_ALERTS);
        scheduleSave();
      }
      // Evaluate only using a later, fully closed one-hour candle; never a live quote.
      let changed=false;
      for(const a of alerts){
        if(a.symbol!==m.symbol||a.result!==null)continue;
        const next=rows.find(b=>b.t===a.closedAt);
        if(!next)continue;
        const change=(next.c-a.close)/a.close*100;
        a.result={change,aligned:a.direction==='up'?change>0:change<0,checkedAt:next.t+STEP};changed=true;
      }
      if(changed)scheduleSave();
    }
  }
  async function refresh(m){
    const now=Date.now();pending.add(m.symbol);m.pro2Attempt=now;
    const symbol=encodeURIComponent(m.apiSymbol);
    const url=m.exchange==='okx' ? okx+'/api/v5/market/candles?instId='+symbol+'&bar=1H&limit=70'
      : (m.exchange==='coin'?'https://dapi.binance.com/dapi/v1/klines':binance+'/fapi/v1/klines')+'?symbol='+symbol+'&interval=1h&limit=70';
    try{
      const result=await json(url,14000),raw=m.exchange==='okx'?result.data:result;
      if(!Array.isArray(raw)||!raw.length)throw new Error('交易所未返回1小时K线');
      update(m,raw,Date.now());failCount=0;
    }catch(e){
      failCount++;lastError=String(e.message||e).slice(0,120);
      m.pro2={...(m.pro2||{}),ready:false,reason:'1小时行情暂不可用',matches:[],error:lastError,lastAttempt:now};
      if(failCount%50===1)log('PRO2 K线请求失败 '+m.symbol+' '+lastError);
    }finally{pending.delete(m.symbol)}
  }
  function choose(now){
    const all=[...markets.values()];
    if(!all.length)return null;
    const candidates=[];
    for(const m of all){
      if(!m.apiSymbol||pending.has(m.symbol)||now-(m.pro2Attempt||0)<50000)continue;
      const latestExpected=Math.floor((now-5000)/STEP)*STEP-STEP;
      const complete=m.pro2?.ready&&m.pro2?.rows?.at(-1)?.t===latestExpected;
      if(complete)continue;
      // Avoid repeatedly requesting a listed-but-unavailable contract.
      if(m.pro2?.error&&now-m.pro2Attempt<3*60*1000)continue;
      candidates.push(m);
    }
    if(!candidates.length)return null;
    // Start with the highest-liquidity contracts; then round-robin remaining ones.
    if(sequence<80)candidates.sort((a,b)=>b.quoteVolume24h-a.quoteVolume24h);
    else candidates.sort((a,b)=>(a.pro2Attempt||0)-(b.pro2Attempt||0)||b.quoteVolume24h-a.quoteVolume24h);
    sequence++;
    return candidates[0];
  }
  function tick(){
    const now=Date.now();
    if(stopped()||pending.size>=2||now-lastFetch<350)return;
    const m=choose(now);
    if(!m)return;
    lastFetch=now;void refresh(m);
  }
  function view(m,now,trades){
    const p=m.pro2||{};
    const ready=!!p.ready&&p.rows?.at(-1)?.t===Math.floor((now-5000)/STEP)*STEP-STEP;
    const matches=ready?p.matches||[]:[];
    const up=matches.some(x=>x.direction==='up'),down=matches.some(x=>x.direction==='down');
    const direction=up&&down?'mixed':up?'up':down?'down':'neutral';
    const priceRecent=m.priceAt&&Math.abs(now-m.priceAt)<60000;
    const book=m.book;
    const bookRecent=book&&Math.abs(now-book.at)<30000&&book.bid>0&&book.ask>=book.bid;
    const spreadPct=bookRecent?100*(book.ask-book.bid)/((book.ask+book.bid)/2):null;
    const distinct=[...new Set(matches.flatMap(x=>x.names))];
    const multi=ready&&distinct.length>=2&&! (up&&down);
    const volRatio=p.volumeRatio;
    const close=p.rows?.at(-1)?.c;
    const extended=ready&&p.atr>0&&m.price>0&&Math.abs(m.price-close)>p.atr*1.2;
    const selected=!!(multi&&priceRecent&&bookRecent&&spreadPct<=0.12&&volRatio>=1.05&&!extended);
    return {symbol:m.symbol,displaySymbol:m.displaySymbol,exchange:m.exchange,exchangeLabel:m.exchangeLabel,
      quoteAsset:m.quoteAsset,contractType:m.contractType,price:m.price,priceAt:m.priceAt,change24h:m.change24h,
      quoteVolume24h:m.quoteVolume24h,ready,reason:ready?p.reason:p.reason||'等待加载真实1小时K线',
      closedAt:ready?p.closedAt:null,volumeRatio:ready?volRatio:null,spreadPct,selected,multi,matches,
      direction,stale:!priceRecent,trade:trades?.getStats(m.symbol)||null,error:p.error||null};
  }
  function snapshot(trades){
    const now=Date.now(),all=[...markets.values()].map(m=>view(m,now,trades));
    const ready=all.filter(m=>m.ready).length;
    const evaluated=alerts.filter(x=>x.result);
    return {version:VERSION,serverTime:now,intervalMinutes:60,source:'交易所已收盘1小时K线',
      counts:{eligible:all.length,ready,loaded:all.filter(m=>m.ready||markets.get(m.symbol).pro2?.rows?.length).length,
        up:all.filter(m=>m.matches.some(h=>h.direction==='up')).length,
        down:all.filter(m=>m.matches.some(h=>h.direction==='down')).length,
        multiple:all.filter(m=>m.multi).length,selected:all.filter(m=>m.selected).length},
      symbols:all,marketPulse:trades?.getMarketPulse?.()||{ready:false,reason:'实时成交监测未就绪'},alerts:alerts.slice(-50).reverse(),
      verification:{samples:evaluated.length,aligned:evaluated.filter(x=>x.result.aligned).length,
        pending:alerts.length-evaluated.length,description:'下一根已收盘1小时K线与形态方向一致的记录比例；不等于真实交易胜率'},
      scanner:{pending:pending.size,lastError}};
  }
  function detail(symbol,trades){
    const m=markets.get(symbol);if(!m)return null;
    return {...view(m,Date.now(),trades),charts:{60:(m.pro2?.rows||[]).slice(-64)},rangeHigh:m.pro2?.rangeHigh,
      rangeLow:m.pro2?.rangeLow,atr:m.pro2?.atr,largeTrades:trades?.getStats(symbol)||null,
      micro:trades?.getMicro?.(symbol)||{covered:false,reason:'短时成交数据不可用'}};
  }
  return {start(){if(!timer){timer=setInterval(tick,300);timer.unref();}},stop(){clearInterval(timer);clearTimeout(saveTimer);persist()},snapshot,detail,
    state(){return {version:VERSION,pending:pending.size,errors:failCount,lastError}},_test:{update}};
}
module.exports={STEP,VERSION,normBinance,normOkx,analyzeBars,createPro2};
