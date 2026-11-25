'use strict';
const fs=require('node:fs');
const path=require('node:path');

const MIN=60000;
const INITIAL_CAPITAL=10000;
const ADDED_CAPITAL=30000;
const CONFIG={capital:INITIAL_CAPITAL+ADDED_CAPITAL,margin:1000,leverage:15,holdMin:20,maxPositions:40,
  fee:0.0005,slippage:0.0001,maintenance:0.01,minSamples:20,minRate:55};

function walk(levels,side,{cash,quantity,step,minQty}){
  const slip=1+side*CONFIG.slippage;
  let qty=0,value=0;
  for(const [price,available] of levels){
    const adjusted=price*slip;
    const take=Math.min(available,cash==null?(quantity-qty):(cash-value)/adjusted);
    if(take<=0)break;
    qty+=take;
    value+=take*adjusted;
    if(cash==null ? qty>=quantity-1e-10 : value>=cash-1e-6)break;
  }
  if(cash!=null){
    if(value<cash-1e-5)return null;
    const executable=Math.floor(qty/step+1e-9)*step;
    return executable>0&&executable>=minQty?walk(levels,side,{quantity:executable}):null;
  }
  return qty>0&&qty>=quantity-1e-9?{qty,value,price:value/qty}:null;
}
function confidence(wins,samples){
  const p=wins/samples,z=1.96;
  return (p+z*z/(2*samples)-z*Math.sqrt((p*(1-p)+z*z/(4*samples))/samples))/(1+z*z/samples);
}

function createPaperTrader({file,binance,okx,json,funding,quality,durable,log,fetchDepth,trial,allMultiple=false,stoppedAt=0,reverse=false}){
  const config=reverse?{...CONFIG,capital:30000,maxPositions:30}:CONFIG;
  let state={version:1,startedAt:Date.now(),balance:reverse?config.capital:INITIAL_CAPITAL,open:[],closed:[],claimed:{},
    total:{count:0,wins:0,net:0,paths:0,adverse:0,fastAdverse:0,invalid:0,marginExit:0}};
  let loadError=null;
  try{
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(saved.version!==1)throw Error('账本版本不匹配');
    state=saved;
  }catch(e){if(e.code!=='ENOENT'){loadError='模拟账本读取失败，等待修复';log('PAPER_LOAD_ERROR '+e.message);}}
  let dirty=false,busy=false,lastSave=0,lastRun=0;
  if(!reverse&&!loadError&&!state.capitalTopUp){
    state.balance+=ADDED_CAPITAL;
    state.capitalTopUp=ADDED_CAPITAL;
    dirty=true;
    save();
  }
  let funnel={confirmed:0,multiple:0,qualified:0,depthUnfilled:0};
  const retryAt=new Map();
  const trialRetryAt=new Map();
  let multipleRows=[];
  const bookWait=new Map();
  const monitorAttemptAt=new Map();
  function collectMultiple(markets,now){
    const positions=new Set(state.open.map(p=>p.symbol));
    const limit=state.open.length>=config.maxPositions||available()<CONFIG.margin;
    const rows=[];
    for(const m of markets.values()){
      const hits=m.paperTrialHits||[];
      const names=hits.flatMap(h=>h.names);
      if(names.length<2)continue;
      const direction=hits[0].direction;
      const conflict=hits.some(h=>h.direction!==direction);
      const closedAt=Math.max(...hits.map(h=>h.closedAt));
      let status='ready';
      if(conflict)status='conflict';
      else if(positions.has(m.symbol))status='open';
      else if((state.claimed[m.symbol]||0)>=closedAt)status='done';
      else if(!m.paperProduct)status='unsupported';
      else if(limit)status='capacity';
      else if((trialRetryAt.get(m.symbol)||0)>now)status=bookWait.get(m.symbol)||'book';
      rows.push({m,hits,names,direction,closedAt,status});
    }
    return rows.sort((a,b)=>b.m.quoteVolume24h-a.m.quoteVolume24h||a.m.symbol.localeCompare(b.m.symbol));
  }
  function trialRows(markets,now){
    if(!trial||now<trial.from||now>=trial.until)return [];
    const round=state.trial?.id===trial.id?state.trial:null;
    if(round&&(now>=round.first+90000||round.assets.length>=CONFIG.maxPositions))return [];
    const rows=[];
    for(const m of markets.values()){
      const hits=m.paperTrialHits;
      if(!m.paperProduct||!hits?.length||m.review?.status==='invalid'||m.paperDecision?.status==='invalid'||
        !m.priceAt||now-m.priceAt>30000||(trialRetryAt.get(m.symbol)||0)>now||state.open.some(p=>p.symbol===m.symbol))continue;
      const direction=hits[0].direction;
      if(hits.some(h=>h.direction!==direction))continue;
      const names=[...new Set(hits.flatMap(h=>h.names))];
      if(names.length<2)continue;
      const asset=m.baseAsset|| (m.exchange==='okx'?m.apiSymbol.split('-')[0]:m.apiSymbol.replace(/USDT(?:_.*)?$/,''));
      if(round?.assets.includes(asset))continue;
      const sample=quality(m.symbol,direction);
      const score=sample?.samples>0?confidence(sample.wins,sample.samples):0;
      rows.push({m,asset,direction,names,hits,sample,score});
    }
    return rows.sort((a,b)=>b.score-a.score||b.names.length-a.names.length||b.m.quoteVolume24h-a.m.quoteVolume24h||
      a.m.symbol.localeCompare(b.m.symbol));
  }
  function save(){
    if(!dirty||loadError)return;
    try{
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file+'.tmp',JSON.stringify(state));
      fs.renameSync(file+'.tmp',file);
      dirty=false;lastSave=Date.now();
    }catch(e){log('PAPER_SAVE_ERROR '+e.message);}
  }
  function available(){return state.balance-state.open.length*CONFIG.margin;}
  function candidateRows(markets,now){
    const rows=[];
    funnel={confirmed:0,multiple:0,qualified:0,depthUnfilled:funnel.depthUnfilled};
    for(const m of markets.values()){
      const d=m.paperDecision;
      if(!m.paperProduct||!d?.reviewed)continue;
      funnel.confirmed++;
      if(m.paperNames.length<2)continue;
      funnel.multiple++;
      const sample=quality(m.symbol,d.direction);
      if(!sample||sample.samples<CONFIG.minSamples||sample.wins*100/sample.samples<CONFIG.minRate||sample.net<=0)continue;
      funnel.qualified++;
      if((state.claimed[m.symbol]||0)>=d.closedAt||state.open.some(p=>p.symbol===m.symbol)||(retryAt.get(m.symbol)||0)>now)continue;
      rows.push({m,d,sample,score:confidence(sample.wins,sample.samples)});
    }
    return rows.sort((a,b)=>b.score-a.score||b.sample.net-a.sample.net||a.m.symbol.localeCompare(b.m.symbol));
  }
  async function orderBook(m){
    if(fetchDepth)return fetchDepth(m);
    const symbol=encodeURIComponent(m.apiSymbol),isOkx=m.exchange==='okx';
    const levels=allMultiple?100:20;
    const raw=await json(isOkx?okx+'/api/v5/market/books?instId='+symbol+'&sz='+levels:
      binance+'/fapi/v1/depth?symbol='+symbol+'&limit='+levels,5000);
    const value=isOkx?raw?.data?.[0]:raw;
    if(!value)return null;
    const at=+(isOkx?value.ts:value.T??value.E);
    const now=Date.now();
    if(!(at>0)||at>now+5000||now-at>12000)return null;
    const normalize=side=>Array.isArray(side)?side.map(row=>[+row[0],+row[1]*m.paperProduct.unit])
      .filter(([p,q])=>p>0&&q>0&&Number.isFinite(p)&&Number.isFinite(q)):[];
    const bids=normalize(value.bids).sort((a,b)=>b[0]-a[0]);
    const asks=normalize(value.asks).sort((a,b)=>a[0]-b[0]);
    return bids.length&&asks.length&&bids[0][0]<=asks[0][0]?{at,bids,asks}:null;
  }
  async function enter({m,d,sample},started){
    retryAt.set(m.symbol,started+15000);
    const book=await orderBook(m);
    const current=m.paperDecision;
    if(!book||!current?.reviewed||current.closedAt!==d.closedAt||current.direction!==d.direction||
      m.paperNames.length<2||book.at<d.confirmedAt||book.at>=d.closedAt+15*MIN||book.at<started-1000)return;
    const side=d.direction==='up'?1:-1;
    const {step,minQty}=m.paperProduct;
    const fill=walk(side===1?book.asks:book.bids,side,
      {cash:CONFIG.margin*CONFIG.leverage,step,minQty});
    if(!fill||!walk(side===1?book.bids:book.asks,-side,{quantity:fill.qty})){
      funnel.depthUnfilled++;return;
    }
    const entryDistance=side*(fill.price-current.key);
    const risk=side*(fill.price-current.invalid);
    const advantage=side*(current.obstacle-fill.price)-fill.price*(CONFIG.fee+CONFIG.slippage)*2;
    if(entryDistance<0||entryDistance>current.atr*.5||risk<=0||advantage/risk<1.5)return;
    if(available()<CONFIG.margin||state.open.length>=CONFIG.maxPositions)return;
    state.claimed[m.symbol]=d.closedAt;
    state.open.push({id:m.symbol+'-'+d.closedAt,symbol:m.symbol,displaySymbol:m.displaySymbol,exchange:m.exchange,
      exchangeLabel:m.exchangeLabel,apiSymbol:m.apiSymbol,perpetual:['PERPETUAL','SWAP'].includes(m.contractType),
      side,names:[...m.paperNames],sample,start:book.at,entry:fill.price,qty:fill.qty,
      notional:fill.value,invalid:d.invalid,lastAt:book.at,mae:0,firstMinuteMae:0,firstMinuteSamples:0,firstMae:0,firstSamples:0,firstLast:0});
    dirty=true;save();
  }
  async function enterTrial({m,asset,direction,names,hits,sample,closedAt},started){
    trialRetryAt.set(m.symbol,started+15000);
    let book;
    try{book=await orderBook(m);}catch(e){bookWait.set(m.symbol,'book');throw e;}
    if(!book||book.at<started-1000||m.paperTrialHits!==hits||!allMultiple&&book.at>=trial.until){
      bookWait.set(m.symbol,'book');return;
    }
    const signalSide=direction==='up'?1:-1;
    const side=reverse?-signalSide:signalSide;
    const {step,minQty}=m.paperProduct;
    const fill=walk(side===1?book.asks:book.bids,side,{cash:CONFIG.margin*CONFIG.leverage,step,minQty});
    if(!fill||!walk(side===1?book.bids:book.asks,-side,{quantity:fill.qty})){
      bookWait.set(m.symbol,'depth');return;
    }
    if(available()<CONFIG.margin||state.open.length>=config.maxPositions)return;
    if(allMultiple)state.claimed[m.symbol]=closedAt;
    else{
      const round=state.trial?.id===trial.id?state.trial:{id:trial.id,first:book.at,assets:[]};
      if(round.assets.includes(asset)||book.at>=round.first+90000)return;
      round.assets.push(asset);state.trial=round;
    }
    bookWait.delete(m.symbol);
    state.open.push({id:allMultiple?(reverse?'reverse-':'multiple-')+m.symbol+'-'+closedAt:trial.id+'-'+m.symbol,
      symbol:m.symbol,displaySymbol:m.displaySymbol,exchange:m.exchange,
      exchangeLabel:m.exchangeLabel,apiSymbol:m.apiSymbol,perpetual:['PERPETUAL','SWAP'].includes(m.contractType),
      side,names,sample:sample??null,start:book.at,entry:fill.price,qty:fill.qty,notional:fill.value,
      ...(allMultiple?{allMultiple:true,signalClosedAt:closedAt,signalDirection:direction}:{trialId:trial.id}),
      lastAt:book.at,mae:0,firstMinuteMae:0,firstMinuteSamples:0,firstMae:0,firstSamples:0,firstLast:0});
    dirty=true;save();
  }
  async function monitor(m,p){
    const book=await orderBook(m);
    if(!book||book.at<=p.lastAt)return;
    const fill=walk(p.side===1?book.bids:book.asks,-p.side,{quantity:p.qty});
    if(!fill)return;
    const elapsed=book.at-p.start;
    const move=p.side*(fill.price/p.entry-1);
    const gross=move*p.notional;
    const tradingFees=(p.notional+fill.value)*CONFIG.fee;
    p.lastAt=book.at;p.mark=fill.price;p.floating=gross-tradingFees;
    p.mae=Math.max(p.mae,-move);
    if(elapsed<=MIN){p.firstMinuteMae=Math.max(p.firstMinuteMae||0,-move);p.firstMinuteSamples=(p.firstMinuteSamples||0)+1;}
    if(elapsed<=5*MIN){p.firstMae=Math.max(p.firstMae,-move);p.firstSamples++;p.firstLast=elapsed;}
    dirty=true;
    const depleted=CONFIG.margin+gross-tradingFees<=fill.value*CONFIG.maintenance;
    const invalid=!p.trialId&&!p.allMultiple&&p.side*(fill.price-p.invalid)<=0;
    const stopped=stoppedAt>0&&book.at>=stoppedAt;
    if(stopped||depleted||invalid||elapsed>=CONFIG.holdMin*MIN){
      const manual=stopped&&stoppedAt<p.start+CONFIG.holdMin*MIN;
      p.exit={at:book.at,price:fill.price,gross,tradingFees,
        reason:manual?'停止模拟平仓':depleted?'模拟保证金风险退出':invalid&&elapsed<CONFIG.holdMin*MIN?'触及失效位':'持有到期'};
      save();
    }
  }
  async function close(p,now){
    if(p.perpetual&&(now-p.exit.at<60000||now<(p.fundingRetryAt||0)))return;
    let events;
    try{
      events=await funding({...p,ends:{20:p.exit}});
    }catch(e){
      p.fundingRetryAt=now+120000;
      p.fundingPending=true;dirty=true;
      log('PAPER_FUNDING_PENDING '+p.symbol+' '+e.message);
      return;
    }
    const fundingCost=p.side*p.qty*events.reduce((sum,e)=>sum+e.rate*(e.mark||p.entry),0);
    const net=Math.max(-CONFIG.margin,p.exit.gross-p.exit.tradingFees-fundingCost);
    const trade={...p,net,fundingCost,marginReturn:100*net/CONFIG.margin,fundingPending:false};
    state.balance+=net;state.open=state.open.filter(x=>x!==p);
    state.closed.unshift(trade);state.closed=state.closed.slice(0,250);
    const t=state.total;t.count++;t.wins+=Number(net>0);t.net+=net;
    if(p.firstSamples>=5&&(p.firstLast>=270000||p.exit.at-p.start<5*MIN)){
      t.paths++;t.adverse+=p.firstMae;t.fastAdverse+=Number(p.firstMae>=.003);
    }
    t.invalid+=Number(p.exit.reason==='触及失效位');t.marginExit+=Number(p.exit.reason==='模拟保证金风险退出');
    dirty=true;save();
  }
  function advance(markets,now){
    if(busy||loadError)return;
    busy=true;lastRun=now;
    void (async()=>{
      const open=state.open.filter(p=>!p.exit&&markets.get(p.symbol)?.paperProduct);
      // Rotate order-book requests across positions so a large batch stays within the public API budget.
      const monitored=allMultiple?open.sort((a,b)=>(monitorAttemptAt.get(a.symbol)||0)-
        (monitorAttemptAt.get(b.symbol)||0)).slice(0,8):open;
      await Promise.allSettled(monitored.map(p=>{
        monitorAttemptAt.set(p.symbol,now);
        return monitor(markets.get(p.symbol),p);
      }));
      const ended=state.open.filter(p=>p.exit&&(!p.perpetual||now-p.exit.at>=60000)&&now>=(p.fundingRetryAt||0));
      await Promise.allSettled(ended.slice(0,stoppedAt?4:1).map(p=>close(p,now)));
      if(stoppedAt)return;
      if(allMultiple){
        const rows=collectMultiple(markets,now);
        const first=rows.find(row=>row.status==='ready');
        if(first){
          try{await enterTrial(first,now);}catch(e){log('PAPER_MULTIPLE_BOOK_WAIT '+first.m.symbol+' '+e.message);}
        }
        multipleRows=collectMultiple(markets,now).map(({m,direction,names,status})=>(
          {symbol:m.symbol,displaySymbol:m.displaySymbol,exchangeLabel:m.exchangeLabel,direction,names,status}
        ));
        return;
      }
      const candidates=candidateRows(markets,now);
      if(state.open.length<CONFIG.maxPositions&&available()>=CONFIG.margin){
        const trialCandidate=trialRows(markets,now)[0];
        if(trialCandidate){
          try{await enterTrial(trialCandidate,now);}catch(e){log('PAPER_TRIAL_BOOK_WAIT '+trialCandidate.m.symbol+' '+e.message);}
          return;
        }
        const first=candidates[0];
        if(first){
          try{await enter(first,now);}catch(e){log('PAPER_BOOK_WAIT '+first.m.symbol+' '+e.message);}
        }
      }
    })().catch(e=>log('PAPER_ERROR '+e.message)).finally(()=>{
      busy=false;
      if(dirty&&Date.now()-lastSave>10000)save();
    });
  }
  function snapshot(now){
    const stats={...state.total};
    const notes=[];
    if(stats.count<20)notes.push('已结算样本不足20笔，继续收集数据再调整筛选门槛。');
    if(stats.count&&stats.net<0)notes.push('累计净收益为负，优先比较成交点差和入场位置对结果的影响。');
    if(stats.paths&&stats.fastAdverse/stats.paths>=.3)notes.push('至少三成可观测样本前5分钟逆向≥0.3%，优先复查5分钟确认后的入场价。');
    if(stats.invalid||stats.marginExit)notes.push('已出现提前退出，检查失效价距离和杠杆下的亏损幅度。');
    const trialStatus=trial?{...trial,entered:state.trial?.id===trial.id?state.trial.assets.length:0,
      entryUntil:state.trial?.id===trial.id?Math.min(trial.until,state.trial.first+90000):trial.until}:null;
    return {config,reverse,startedAt:state.startedAt,lastRun,loadError,durable,trial:trialStatus,
      capitalTopUp:state.capitalTopUp||0,stoppedAt,
      multiple:allMultiple?multipleRows:null,balance:state.balance,available:available(),
      locked:state.open.length*CONFIG.margin,open:state.open.map(p=>({...p,delayed:!p.exit&&now>p.start+CONFIG.holdMin*MIN})),
      closed:stoppedAt?state.closed:state.closed.slice(0,80),stats,funnel,notes};
  }
  return {advance,snapshot,save};
}
module.exports={createPaperTrader,walk,confidence,CONFIG};
