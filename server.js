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
const pro2Trades=createPro2Trades({markets:MARKETS,log,stopped:()=>stop});
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

// The public Pro Mobile application is read-only; no user login or trading endpoints.

const server=http.createServer((req,res)=>{
  if(req.method!=='GET')return reply(res,405,{error:'只允许GET；无交易/下单API'});
  let url;try{url=new URL(req.url,'http://localhost')}catch{return reply(res,400,{error:'无效请求'})}
  if(url.pathname==='/api/ui-error'){log('PRO_FRONTEND_ERROR '+(url.searchParams.get('message')||'unknown').slice(0,200));return reply(res,200,{ok:true})}
  if(url.pathname==='/api/pro2/snapshot')return reply(res,200,pro2.snapshot(pro2Trades));
  if(url.pathname==='/api/pro2/flow-health')return reply(res,200,pro2Trades.health());
  if(url.pathname==='/api/pro2/detail'){
    const symbol=(url.searchParams.get('symbol')||'').toUpperCase();
    // Public, read-only detail requests activate a bounded temporary trade stream.
    pro2Trades.watch(symbol);
    const value=pro2.detail(symbol,pro2Trades);return reply(res,value?200:404,value||{error:'合约不可用'});
  }
  if(url.pathname==='/api/pro2/swing'){
    const symbol=(url.searchParams.get('symbol')||'').toUpperCase();
    const m=MARKETS.get(symbol);if(!m)return reply(res,404,{error:'合约不可用'});
    if(!pro2Trades.watch(symbol))return reply(res,200,{version:'ssr-research-v1',symbol,ready:false,reason:'该合约暂无支持的公开主动成交流',periods:[]});
    return reply(res,200,{...pro2Trades.getSwing(symbol),symbol,exchangeLabel:m.exchangeLabel});
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
    reply(res,200,data,MIME[path.extname(filepath)]||'application/octet-stream');
  });
});
server.listen(PORT,'127.0.0.1',()=>{
  pro2.start();pro2Trades.start();
  log(`Contract Lens Pro 本地运行: http://localhost:${PORT}`);
  if(ENABLE_LEGACY)stopPatternFeed=startPatternFeed({markets:MARKETS,json,binance:BINANCE,okx:OKX,
    okxWs:OKX_WS,stopped:()=>stop,log});
  initBinance(); // No OKX or COIN-M directory, sockets or polling.
  if(ENABLE_LEGACY)setInterval(runAnalysis,3000);
  setInterval(refreshBinanceBooks,20000).unref();
  void refreshBinanceBooks();

});
function shutdown(){stop=true;clearInterval(binanceTimer);clearInterval(okxTimer);
  clearTimeout(saveTimer);persistSignals();reviewHistory.save();paper.save();
  stopPatternFeed?.();pro2.stop();pro2Trades.stop();
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


