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
  const records=new Map(), observer=createObserver({markets}),lastSeen=new Map(),leases=new Map();
  const errors={binance:'',okx:''}, reconnects={binance:0,okx:0};
  const connections={binanceBase:null,okxBase:null,binanceWatch:null,okxWatch:null};
  let timer=null;
  const limit={binance:18,okx:10},activeWatchLimit=5;
  function eligible(m){return !!(m&&m.apiSymbol&&((m.exchange==='binance'&&/(?:USDT|USDC)$/.test(m.apiSymbol))||(m.exchange==='okx'&&m.contractType==='SWAP'&&m.apiSymbol.endsWith('-USDT-SWAP')&&m.tradeUnitBase>0)))}
  function top(exchange){return [...markets.values()].filter(m=>eligible(m)&&m.exchange===exchange)
    .sort((a,b)=>safe(b.quoteVolume24h)-safe(a.quoteVolume24h)).slice(0,limit[exchange]);}
  function selectedForWatch(exchange){
    const time=Date.now();for(const [sym,at] of leases){if(time-at>WATCH_TTL)leases.delete(sym)}
    const base=new Set((connections[exchange+'Base']?.selected||top(exchange)).map(m=>m.symbol));
    return [...leases].sort((a,b)=>b[1]-a[1]).map(([sym])=>markets.get(sym))
      .filter(m=>eligible(m)&&m.exchange===exchange&&!base.has(m.symbol))
      .slice(0,activeWatchLimit);
  }
  function connected(ctx){return !!(ctx?.ws&&ctx.ws.readyState===1&&!ctx.closed)}
  function active(symbol){return Object.values(connections).find(c=>connected(c)&&c.symbols.has(symbol))||null}
  function observe(symbol,side,amount,at,price){
    if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(price)||price<=0||!Number.isFinite(at)||Math.abs(Date.now()-at)>90_000)return false;
    if(side!=='buy'&&side!=='sell')return false;
    const now=Date.now();lastSeen.set(symbol,now);
    observer.record(symbol,side,amount,price,at);
    try{onTrade(symbol,price,at)}catch(e){log('SIGNAL_LAB_TRADE '+String(e.message||e).slice(0,120))}
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
  function open(exchange,kind,selected){
    const slot=exchange+(kind==='Base'?'Base':'Watch');
    if(!selected.length||stopped())return;
    const by=new Map(selected.map(m=>[m.apiSymbol,m]));
    const base=exchange==='binance'?BINANCE_MARKET_WS+selected.map(m=>m.apiSymbol.toLowerCase()+'@aggTrade').join('/') : OKX_PUBLIC_WS;
    let ws;
    try{ws=new WebSocket(base)}catch(err){errors[exchange]=String(err.message||err);reconnects[exchange]=Date.now()+10000;log(`PRO5_${exchange}_OPEN_FAIL ${errors[exchange]}`);return}
    const ctx={slot,exchange,kind,ws,selected,symbols:new Set(selected.map(m=>m.symbol)),startedAt:Date.now(),openedAt:0,lastPacketAt:0,lastTradeAt:0,received:0,discarded:0,confirmed:new Set(),closed:false,reason:'连接中'};
    connections[slot]=ctx;
    log(`PRO5_${exchange.toUpperCase()}_${kind.toUpperCase()}_CONNECT symbols=${selected.length}`);
    ws.addEventListener('open',()=>{
      ctx.openedAt=Date.now();ctx.reason='等待真实成交';errors[exchange]='';
      if(exchange==='okx'){
        ws.send(JSON.stringify({op:'subscribe',args:selected.map(m=>({channel:'trades',instId:m.apiSymbol}))}));
        ctx.heartbeat=setInterval(()=>{if(connected(ctx))try{ws.send('ping')}catch{}},20000);ctx.heartbeat.unref?.();
      }
    });
    ws.addEventListener('message',event=>{
      ctx.lastPacketAt=Date.now();
      try{
        const raw=typeof event.data==='string'?event.data:String(event.data);
        if(raw==='pong'||raw==='ping')return;
        const msg=JSON.parse(raw);
        if(exchange==='binance'){
          if(msg.error||msg.code){errors[exchange]=String(msg.msg||msg.error||'订阅返回错误').slice(0,160);log(`PRO5_BINANCE_MESSAGE_ERROR ${errors[exchange]}`);return}
          const t=msg.data||msg;
          if(t?.e!=='aggTrade')return;
          const m=by.get(t.s);if(!m){ctx.discarded++;return}
          const at=+t.T,amount=(+t.p)*(+t.q);
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
      if(connections[slot]===ctx){connections[slot]=null;reconnects[exchange]=Date.now()+10000}
      if(!ctx.closed)log(`PRO5_${exchange}_CLOSE code=${e?.code||'?'} received=${ctx.received}`);
      ctx.closed=true;
      for(const m of selected){if(!active(m.symbol))observer.reset(m.symbol)}
    });
  }
  function watch(symbol){
    const m=markets.get(symbol);
    if(!eligible(m))return false;
    leases.delete(symbol);leases.set(symbol,Date.now());
    // Do not disrupt the stable top-liquidity subscription for a detail request.
    syncWatch(m.exchange);return true;
  }
  function syncWatch(exchange){
    const slot=exchange+'Watch';const target=selectedForWatch(exchange);
    const prev=connections[slot];
    if(prev&&target.map(m=>m.symbol).join(',')===prev.selected.map(m=>m.symbol).join(',')&&(connected(prev)||prev.ws?.readyState===0))return;
    if(prev)close(prev,'更新当前查看合约');
    connections[slot]=null;
    if(target.length)open(exchange,'Watch',target);
  }
  function tick(){
    if(stopped())return;
    const time=Date.now();
    for(const ex of ['binance','okx']){
      const key=ex+'Base',ctx=connections[key];
      if(ctx&&connected(ctx)){
        // BTC/ETH should deliver quickly; an open but silent obsolete route is not healthy.
        if(ctx.openedAt&&ctx.received===0&&time-ctx.openedAt>35000){errors[ex]='已连接但35秒内未收到真实成交：检查数据流路由/网络';log(`PRO5_${ex}_SILENT_OPEN ${ctx.received}`);close(ctx,'连接后无成交');connections[key]=null;reconnects[ex]=time+10000;}
        else if(ctx.lastTradeAt&&time-ctx.lastTradeAt>90000){errors[ex]='成交流已超过90秒未更新';close(ctx,'成交停止更新');connections[key]=null;reconnects[ex]=time+10000}
      }else if(ctx&&ctx.openedAt===0&&time-ctx.startedAt>20000){close(ctx,'连接超时');connections[key]=null;reconnects[ex]=time+10000}
      if(!connections[key]&&time>=reconnects[ex]){const base=top(ex);if(base.length)open(ex,'Base',base)}
      const watchCtx=connections[ex+'Watch'];
      if(watchCtx&&connected(watchCtx)&&watchCtx.lastTradeAt&&time-watchCtx.lastTradeAt>120000){close(watchCtx,'动态监测连接停止更新');connections[ex+'Watch']=null}
      const expected=selectedForWatch(ex).map(m=>m.symbol).join(',');
      if((!watchCtx||(!connected(watchCtx)&&watchCtx.ws?.readyState!==0)||expected!==watchCtx.selected.map(m=>m.symbol).join(','))){
        if(watchCtx)close(watchCtx,'动态监测名单更新');connections[ex+'Watch']=null;
        if(expected&&time>=reconnects[ex])syncWatch(ex);
      }
    }
  }
  function status(symbol){
    const ctx=active(symbol),last=lastSeen.get(symbol)||0,age=Date.now()-last;
    if(!ctx)return {connected:false,received:false,ready:false,reason:'合约成交流未连接'};
    if(!last||last<ctx.openedAt||!ctx.confirmed.has(symbol)||ctx.received===0)return {connected:true,received:false,ready:false,reason:'WebSocket已连接，等待首笔真实成交',openedAt:ctx.openedAt};
    if(age>45000)return {connected:true,received:true,ready:false,reason:'成交数据已延迟，暂不展示实时买卖占比',latestAt:last,ageMs:age};
    return {connected:true,received:true,ready:true,latestAt:last,ageMs:age,openedAt:ctx.openedAt};
  }
  function getMicro(symbol){const s=status(symbol);if(!s.connected)return {covered:false,ready:false,reason:s.reason};if(!s.ready)return {covered:true,ready:false,reason:s.reason,latestAt:s.latestAt||null};return observer.stats(symbol,true)}
  function getStats(symbol){const s=status(symbol),start=floorHour(Date.now()),v=records.get(symbol);if(!s.ready)return {covered:false,ready:false,threshold:MILLION,reason:s.reason};return {covered:true,ready:true,threshold:MILLION,windowStart:start,partial:true,buy:v?.start===start?v.buy:0,sell:v?.start===start?v.sell:0,buyCount:v?.start===start?v.buyCount:0,sellCount:v?.start===start?v.sellCount:0,latestAt:v?.start===start?v.latestAt:null,firstObservedAt:s.openedAt,label:'100万计价币种单位门槛的交易所聚合成交，不等于大户账户或全部真实交易',quoteAsset:markets.get(symbol)?.quoteAsset||'USDT'};}
  function getSwing(symbol){const s=status(symbol);return s.ready?observer.swing(symbol):{version:'ssr-research-v1',ready:false,reason:s.reason,periods:[]};}
  function getMarketPulse(){return observer.marketPulse(symbol=>status(symbol).ready)}
  function health(){
    const out={version:'routed-aggtrade-v5',serverTime:Date.now(),errors:{...errors},sources:{},tracked:0,active:0,receiving:0};
    for(const [key,c] of Object.entries(connections))out.sources[key]=c?{connected:connected(c),monitored:c.selected.length,openedAt:c.openedAt,received:c.received,lastPacketAt:c.lastPacketAt,lastTradeAt:c.lastTradeAt,discarded:c.discarded,reason:c.reason}:{connected:false,monitored:0};
    const symbols=new Set(Object.values(connections).flatMap(c=>c?.selected.map(m=>m.symbol)||[]));out.tracked=symbols.size;
    for(const sym of symbols){const s=status(sym);if(s.connected)out.active++;if(s.ready)out.receiving++}
    return out;
  }
  return {start(){if(timer)return;tick();timer=setInterval(tick,5000);timer.unref?.()},stop(){if(timer)clearInterval(timer);timer=null;for(const key of Object.keys(connections)){close(connections[key],'停止');connections[key]=null;}},watch,getStats,getMicro,getSwing,getMarketPulse,health,_test:{observe,tick,status,connections}};
}
module.exports={createPro2Trades};
