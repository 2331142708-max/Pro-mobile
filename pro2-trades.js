'use strict';
// Public exchange prints, not personal account flows or a prediction of the next candle.
// Binance USD-M aggTrade moved to the /market websocket route in 2026.
const {createObserver}=require('./pro2-observer');
const MILLION=1_000_000, HOUR=3_600_000, WATCH_TTL=15*60_000;
const BINANCE_MARKET_WS=process.env.PRO2_BINANCE_TRADES_WS||'wss://fstream.binance.com/market/stream?streams=';
const OKX_PUBLIC_WS=process.env.PRO2_OKX_TRADES_WS||'wss://ws.okx.com/ws/v5/public';
const floorHour=t=>Math.floor(t/HOUR)*HOUR;
const safe=(v,n=0)=>Number.isFinite(+v)?+v:n;
function createPro2Trades({markets,log=()=>{},stopped=()=>false,onTrade=()=>{}}){
  const records=new Map(), observer=createObserver({markets}),lastSeen=new Map(),leases=new Map(),latestPrint=new Map();
  const errors={binance:'',okx:'',coin:''}, reconnects={binance:0,okx:0,coin:0};
  const connections={binanceBase:null,okxBase:null,binanceWatch:null,okxWatch:null,coinBase:null,coinWatch:null};
  let timer=null,pulseCache=null;
  const coreSymbols=new Set(['BTCUSDT','BTCUSDC','ETHUSDT','ETHUSDC','ZECUSDT']);
  const shardSize=40,shardRetry=new Map(),owners=new Map(),lastAggId=new Map();
  const limit={binance:5,okx:10,coin:0},activeWatchLimit=5;
  function eligible(m){return !!(m&&m.apiSymbol&&((m.exchange==='binance')||(m.exchange==='coin'&&m.contractSize>0)||(m.exchange==='okx'&&m.contractType==='SWAP'&&m.apiSymbol.endsWith('-USDT-SWAP')&&m.tradeUnitBase>0)))}
  function top(exchange){return [...markets.values()].filter(m=>eligible(m)&&m.exchange===exchange)
    .sort((a,b)=>Number(['BTCUSDT','BTCUSDC','ETHUSDT','ETHUSDC','ZECUSDT'].includes(b.symbol))-Number(['BTCUSDT','BTCUSDC','ETHUSDT','ETHUSDC','ZECUSDT'].includes(a.symbol))||safe(b.quoteVolume24h)-safe(a.quoteVolume24h)).slice(0,limit[exchange]);}
  function selectedForWatch(exchange){
    const time=Date.now();for(const [sym,at] of leases){if(time-at>WATCH_TTL)leases.delete(sym)}
    const base=new Set((connections[exchange+'Base']?.selected||top(exchange)).map(m=>m.symbol));
    return [...leases].sort((a,b)=>b[1]-a[1]).map(([sym])=>markets.get(sym))
      .filter(m=>eligible(m)&&m.exchange===exchange&&!base.has(m.symbol))
      .slice(0,activeWatchLimit);
  }
  function connected(ctx){return !!(ctx?.ws&&ctx.ws.readyState===1&&!ctx.closed)}
  function active(symbol){const c=owners.get(symbol);return connected(c)?c:null}
  function observe(symbol,side,amount,at,price){
    if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(price)||price<=0||!Number.isFinite(at)||Math.abs(Date.now()-at)>90_000)return false;
    if(side!=='buy'&&side!=='sell')return false;
    const now=Date.now();lastSeen.set(symbol,now);
    const previous=latestPrint.get(symbol);
    if(!previous||at>=previous.at)latestPrint.set(symbol,{price,at,receivedAt:now});
    observer.record(symbol,side,amount,price,at);
    if(!previous||at>=previous.at)try{onTrade(symbol,price,at,side,amount)}catch(e){log('SIGNAL_LAB_TRADE '+String(e.message||e).slice(0,120))}
    if(amount>=MILLION){
      const start=floorHour(at),old=records.get(symbol);
      const v=old?.start===start?old:{start,firstObservedAt:at,buy:0,sell:0,buyCount:0,sellCount:0};
      v[side]+=amount;v[side+'Count']++;v.latestAt=at;records.set(symbol,v);
    }
    return true;
  }
  function close(ctx,why='refresh'){
    if(!ctx||ctx.closed)return;
    ctx.closed=true;ctx.reason=why;
    if(ctx.heartbeat)clearInterval(ctx.heartbeat);
    try{ctx.ws.close()}catch{}
  }
  function open(exchange,kind,selected,slot=exchange+(kind==='Base'?'Base':'Watch')){
    if(!selected.length||stopped())return;
    const by=new Map(selected.map(m=>[m.apiSymbol,m]));
    const base=exchange==='binance'?BINANCE_MARKET_WS+selected.map(m=>m.apiSymbol.toLowerCase()+'@aggTrade').join('/') : exchange==='coin'?'wss://dstream.binance.com/stream?streams='+selected.map(m=>m.apiSymbol.toLowerCase()+'@aggTrade').join('/'):OKX_PUBLIC_WS;
    let ws;
    try{ws=new WebSocket(base)}catch(err){errors[exchange]=String(err.message||err);reconnects[exchange]=Date.now()+10000;log(`PRO5_${exchange}_OPEN_FAIL ${errors[exchange]}`);return}
    const ctx={slot,exchange,kind,ws,selected,symbols:new Set(selected.map(m=>m.symbol)),startedAt:Date.now(),openedAt:0,lastPacketAt:0,lastTradeAt:0,received:0,discarded:0,confirmed:new Set(),closed:false,reason:'连接中'};
    connections[slot]=ctx;
    for(const m of selected)owners.set(m.symbol,ctx);
    log(`PRO5_${exchange.toUpperCase()}_${kind.toUpperCase()}_CONNECT symbols=${selected.length}`);
    ws.addEventListener('open',()=>{
      ctx.openedAt=Date.now();ctx.reason='等待真实成交';errors[exchange]='';
      if(exchange==='okx'){
        ws.send(JSON.stringify({op:'subscribe',args:selected.map(m=>({channel:'trades',instId:m.apiSymbol}))}));
        ctx.heartbeat=setInterval(()=>{if(connected(ctx))try{ws.send('ping')}catch{}},20000);ctx.heartbeat.unref?.();
      }
    });
    ws.addEventListener('message',event=>{
      if(ctx.closed||connections[slot]!==ctx)return;
      ctx.lastPacketAt=Date.now();
      try{
        const raw=typeof event.data==='string'?event.data:String(event.data);
        if(raw==='pong'||raw==='ping')return;
        const msg=JSON.parse(raw);
        if(exchange==='binance'||exchange==='coin'){
          if(msg.error||msg.code){errors[exchange]=String(msg.msg||msg.error||'订阅返回错误').slice(0,160);log(`PRO5_BINANCE_MESSAGE_ERROR ${errors[exchange]}`);return}
          const t=msg.data||msg;
          if(t?.e!=='aggTrade')return;
          const m=by.get(t.s);if(!m){ctx.discarded++;return}
          const at=+t.T,amount=exchange==='coin'?(+t.q)*m.contractSize:(+t.p)*(+t.q);
          const id=Number(t.a),prevId=lastAggId.get(m.symbol);
          if(Number.isSafeInteger(id)&&prevId!=null&&id<=prevId)return;
          if(Number.isSafeInteger(id))lastAggId.set(m.symbol,id);
          if(observe(m.symbol,t.m?'sell':'buy',amount,at,+t.p)){ctx.received++;ctx.lastTradeAt=Date.now();ctx.confirmed.add(m.symbol)}else ctx.discarded++;
        }else{
          if(msg.event==='error'){errors[exchange]=String(msg.msg||'订阅失败').slice(0,160);log(`PRO5_OKX_SUB_ERROR ${errors[exchange]}`);return}
          if(msg.event==='subscribe'){ctx.confirmed.add(by.get(msg.arg?.instId)?.symbol);return}
          const m=by.get(msg.arg?.instId);if(!m||!Array.isArray(msg.data))return;
          for(const t of msg.data){
            const amount=(+t.sz)*m.tradeUnitBase*(+t.px);
            if(observe(m.symbol,t.side,amount,+t.ts,+t.px)){ctx.received++;ctx.lastTradeAt=Date.now();ctx.confirmed.add(m.symbol)}else ctx.discarded++;
          }
        }
      }catch(e){ctx.discarded++;if(ctx.discarded<=3)log(`PRO5_${exchange}_PARSE_ERROR ${String(e.message||e).slice(0,120)}`)}
    });
    ws.addEventListener('error',e=>{
      if(ctx.closed)return;
      errors[exchange]=String(e?.message||'WebSocket连接异常').slice(0,160);
      ctx.reason='WebSocket连接异常';
      log(`PRO5_${exchange}_WS_ERROR ${errors[exchange]}`);
      try{ws.close()}catch{}
    });
    ws.addEventListener('close',e=>{
      if(ctx.heartbeat)clearInterval(ctx.heartbeat);
      if(connections[slot]===ctx){connections[slot]=null;shardRetry.set(slot,Date.now()+10000);}
      if(!ctx.closed)log(`PRO5_${exchange}_CLOSE code=${e?.code||'?'} received=${ctx.received}`);
      ctx.closed=true;
      for(const m of selected){if(owners.get(m.symbol)===ctx){owners.delete(m.symbol);observer.reset(m.symbol);lastSeen.delete(m.symbol);latestPrint.delete(m.symbol);records.delete(m.symbol);}}
    });
  }
  function watch(symbol){return eligible(markets.get(symbol))}
  function desiredShards(){
    const result=new Map();
    const bin=[...markets.values()].filter(m=>eligible(m)&&m.exchange==='binance');
    const core=bin.filter(m=>coreSymbols.has(m.symbol)).sort((a,b)=>a.symbol.localeCompare(b.symbol));
    if(core.length)result.set('binanceBase',{exchange:'binance',selected:core});
    for(const ex of ['binance','coin','okx']){
      const list=[...markets.values()].filter(m=>eligible(m)&&m.exchange===ex&&!(ex==='binance'&&coreSymbols.has(m.symbol))).sort((a,b)=>a.symbol.localeCompare(b.symbol));
      for(let i=0;i<list.length;i+=shardSize)result.set(ex+'Shard'+Math.floor(i/shardSize),{exchange:ex,selected:list.slice(i,i+shardSize)});
    }
    return result;
  }
  function retire(slot,ctx,reason){
    if(!ctx)return;
    close(ctx,reason);
    if(connections[slot]===ctx)delete connections[slot];
    for(const m of ctx.selected)if(owners.get(m.symbol)===ctx){
      owners.delete(m.symbol);observer.reset(m.symbol);lastSeen.delete(m.symbol);latestPrint.delete(m.symbol);records.delete(m.symbol);
    }
  }
  function tick(){
    if(stopped())return;
    const time=Date.now(),wanted=desiredShards();
    // Remove outdated shards before opening replacements so a symbol is never double counted.
    for(const [slot,ctx] of Object.entries(connections)){
      if(!ctx){delete connections[slot];continue}
      const target=wanted.get(slot);
      if(!target||target.selected.map(m=>m.symbol).join('|')!==ctx.selected.map(m=>m.symbol).join('|')){
        retire(slot,ctx,'合约目录更新');continue;
      }
      if(ctx.closed||(!connected(ctx)&&time-ctx.startedAt>20000)||(connected(ctx)&&time-(ctx.lastTradeAt||ctx.openedAt)>90000)){
        retire(slot,ctx,'成交流超时');shardRetry.set(slot,time+10000);
      }
    }
    // Stagger connection establishment and reconnects; do not create hundreds at once.
    let opened=0;
    for(const [slot,target] of wanted){
      if(connections[slot]||time<(shardRetry.get(slot)||0))continue;
      open(target.exchange,'Shard',target.selected,slot);shardRetry.set(slot,time+10000);
      if(++opened>=2)break;
    }
    for(const key of lastAggId.keys())if(!markets.has(key))lastAggId.delete(key);
  }
  function status(symbol){
    const ctx=active(symbol),last=lastSeen.get(symbol)||0,age=Date.now()-last;
    if(!ctx)return {connected:false,received:false,ready:false,reason:'合约成交流未连接'};
    if(!last||last<ctx.openedAt||!ctx.confirmed.has(symbol)||ctx.received===0)return {connected:true,received:false,ready:false,reason:'WebSocket已连接，等待首笔真实成交',openedAt:ctx.openedAt};
    if(age>45000)return {connected:true,received:true,ready:false,reason:'成交数据已延迟，暂不展示实时买卖占比',latestAt:last,ageMs:age};
    return {connected:true,received:true,ready:true,latestAt:last,ageMs:age,openedAt:ctx.openedAt};
  }
  function getMicro(symbol){const s=status(symbol);if(!s.connected)return {covered:false,ready:false,reason:s.reason};if(!s.ready)return {covered:true,ready:false,reason:s.reason,latestAt:s.latestAt||null};return observer.stats(symbol,true)}
  function getStats(symbol){const s=status(symbol),start=floorHour(Date.now()),v=records.get(symbol);if(!s.ready)return {covered:s.connected,ready:false,threshold:MILLION,reason:s.reason};return {covered:true,ready:true,threshold:MILLION,windowStart:start,partial:true,buy:v?.start===start?v.buy:0,sell:v?.start===start?v.sell:0,buyCount:v?.start===start?v.buyCount:0,sellCount:v?.start===start?v.sellCount:0,latestAt:v?.start===start?v.latestAt:null,firstObservedAt:s.openedAt,label:'100万计价币种单位门槛的交易所聚合成交，不等于大户账户或全部真实交易',quoteAsset:markets.get(symbol)?.quoteAsset||'USDT'};}
  function getLatestPrint(symbol){return latestPrint.get(symbol)||null;}
  function getSwing(symbol){const s=status(symbol);return s.ready?observer.swing(symbol):{version:'ssr-research-v1',ready:false,reason:s.reason,periods:[]};}
  function getMarketPulse(){const now=Date.now();if(!pulseCache||now-pulseCache.at>=5000)pulseCache={at:now,value:observer.marketPulse(symbol=>status(symbol).ready)};return pulseCache.value}
  function health(){
    const out={version:'all-market-aggtrade-v6',serverTime:Date.now(),errors:{...errors},sources:{},tracked:0,active:0,receiving:0};
    for(const [key,c] of Object.entries(connections))out.sources[key]=c?{connected:connected(c),monitored:c.selected.length,openedAt:c.openedAt,received:c.received,lastPacketAt:c.lastPacketAt,lastTradeAt:c.lastTradeAt,discarded:c.discarded,reason:c.reason}:{connected:false,monitored:0};
    const symbols=new Set(Object.values(connections).flatMap(c=>c?.selected.map(m=>m.symbol)||[]));out.tracked=symbols.size;
    for(const sym of symbols){const s=status(sym);if(s.connected)out.active++;if(s.ready)out.receiving++}
    return out;
  }
  return {start(){if(timer)return;tick();timer=setInterval(tick,5000);timer.unref?.()},stop(){if(timer)clearInterval(timer);timer=null;for(const key of Object.keys(connections)){close(connections[key],'停止');connections[key]=null;}},watch,getStats,getMicro,getSwing,getLatestPrint,getMarketPulse,health,_test:{observe,tick,status,connections,desiredShards}};
}
module.exports={createPro2Trades};
