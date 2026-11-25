'use strict';

const {FIVE}=require('./twenty');
const {matchPatterns}=require('./patterns');
const QUARTER=900000;
const HISTORY=120;
const VERSION='patterns-15m-30m-v1';

function binanceBar(row) {
  return Array.isArray(row)
    ? {t:+row[0],o:+row[1],h:+row[2],l:+row[3],c:+row[4],v:+row[5],buy:+row[9],closed:+row[6]<Date.now()}
    : {t:+row.t,o:+row.o,h:+row.h,l:+row.l,c:+row.c,v:+row.v,buy:+row.V,closed:row.x===true};
}
function okxBar(row) {
  return {t:+row[0],o:+row[1],h:+row[2],l:+row[3],c:+row[4],v:+row[5],buy:null,closed:row[8]==='1'||row[8]===1};
}
function valid(b) {
  return Number.isFinite(b.t)&&b.t%QUARTER===0&&[b.o,b.h,b.l,b.c].every(x=>Number.isFinite(x)&&x>0)&&
    b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&Number.isFinite(b.v)&&b.v>=0;
}
function receiveBars(m,bars,fromSocket=false) {
  if(fromSocket&&bars.length===1){
    const b=bars[0], rows=m.bars15??=[];
    if(!valid(b))return;
    const tail=rows.at(-1);
    if(!tail||b.t>=tail.t){
      if(tail?.t===b.t){
        if(tail.closed)return;
        rows[rows.length-1]=b;
      }else{
        rows.push(b);
        if(rows.length>HISTORY)rows.shift();
      }
      if(b.closed)m.patternCache=null;
      return;
    }
  }
  const by=new Map((m.bars15||[]).map(b=>[b.t,b]));
  for(const b of bars){
    if(!valid(b))continue;
    const old=by.get(b.t);
    if(old?.closed || (old && !fromSocket && !b.closed && old.v>=b.v))continue;
    by.set(b.t,b);
  }
  m.bars15=[...by.values()].sort((a,b)=>a.t-b.t).slice(-HISTORY);
  m.patternCache=null;
}
function frameBars(rows,period,now) {
  const closed=rows.filter(b=>b.closed&&b.t+QUARTER<=now);
  if(period===15)return closed;
  const out=[];
  for(let i=1;i<closed.length;i++){
    const a=closed[i-1],b=closed[i];
    if(a.t%(2*QUARTER)===0&&b.t===a.t+QUARTER){
      out.push({t:a.t,o:a.o,h:Math.max(a.h,b.h),l:Math.min(a.l,b.l),c:b.c,v:a.v+b.v,closed:true});
    }
  }
  return out;
}
function analyze(m,now) {
  const tick=Math.floor((now-3000)/QUARTER);
  if(m.patternCache?.tick===tick)return m.patternCache;
  const bars={}, matches=[], ready=[];
  for(const period of [15,30]){
    const step=period*60000, rows=frameBars(m.bars15||[],period,now);
    const expected=Math.floor((now-3000)/step)*step-step;
    const latest=rows.at(-1);
    let i=rows.length-1;
    while(i>0&&rows[i].t-rows[i-1].t===step)i--;
    const contiguous=rows.slice(i);
    bars[period]=contiguous;
    if(latest?.t!==expected||contiguous.length<10)continue;
    ready.push(period);
    const levels={};
    const hits=matchPatterns(contiguous,levels);
    for(const direction of ['up','down']){
      if(hits[direction].length)matches.push({period,direction,names:hits[direction],levels:Object.values(levels[direction]||{}),closedAt:latest.t+step,close:latest.c});
    }
  }
  return m.patternCache={tick,bars,matches,ready};
}
function buySell(m,now) {
  const t=Math.floor(now/QUARTER)*QUARTER;
  const b=m.bars15?.at(-1);
  const trade=m.aggressor;
  const total=m.exchange==='okx'?(trade?.t===t&&trade.socket.readyState===1?trade.buy+trade.sell:0):b?.t===t&&!b.closed?b.v:0;
  const buy=m.exchange==='okx'?trade?.buy:b?.buy;
  if(!(total>0)||!(buy>=0)||buy>total)return null;
  const buyPct=Math.round(buy/total*1000)/10;
  return {buyPct,sellPct:(1000-Math.round(buyPct*10))/10,partial:m.exchange==='okx'&&trade.since>t+3000,
    window:'当前15分钟'};
}
function startPatternFeed({markets,json,binance,okx,okxWs,stopped,log}) {
  const pending=new Set(), last={binance:0,coin:0,okx:0}, sockets=[];
  let index=0, preferFive=false;
  function refresh(m,period) {
    if(pending.has(m.symbol)||stopped())return;
    const now=Date.now();
    if(now-last[m.exchange]<130)return;
    last[m.exchange]=now;
    pending.add(m.symbol);
    if(period===5)m.fiveAttempt=now;else m.patternAttempt=now;
    const symbol=encodeURIComponent(m.apiSymbol);
    const count=period===5?32:m.bars15?.length>=100?12:HISTORY;
    const url=m.exchange==='okx'
      ? okx+'/api/v5/market/candles?instId='+symbol+'&bar='+period+'m&limit='+count
      : (m.exchange==='coin'?'https://dapi.binance.com/dapi/v1/klines':binance+'/fapi/v1/klines')+
        '?symbol='+symbol+'&interval='+period+'m&limit='+count;
    void json(url,12000).then(result=>{
      const data=m.exchange==='okx'?result.data:result;
      if(!Array.isArray(data)||!data.length)throw Error('K线数据为空');
      const rows=data.map(m.exchange==='okx'?okxBar:binanceBar);
      if(period===5){
        m.bars5=rows.filter(b=>b.closed&&b.t%FIVE===0&&[b.o,b.h,b.l,b.c].every(x=>Number.isFinite(x)&&x>0)&&
          b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&Number.isFinite(b.v)&&b.v>=0)
          .sort((a,b)=>a.t-b.t);
      }else{
        receiveBars(m,rows);
        m.patternError='';m.patternFetched=true;
      }
    }).catch(err=>{m.patternError=String(err.message||err)}).finally(()=>pending.delete(m.symbol));
  }
  function connectOkx(group,channel){
    if(stopped())return;
    const isTrade=channel==='trades';
    const url=isTrade?okxWs:okxWs.replace(/\/public(?:\?.*)?$/,'/business');
    const by=new Map(group.map(m=>[m.apiSymbol,m]));
    let socket;
    try{socket=new WebSocket(url)}catch(e){log(String(e));setTimeout(()=>connectOkx(group,channel),7000).unref();return;}
    const entry={socket,group,channel};
    sockets.push(entry);
    let heartbeat,opened=0;
    socket.addEventListener('open',()=>{
      opened=Date.now();
      const args=group.map(m=>({channel,instId:m.apiSymbol}));
      socket.send(JSON.stringify({op:'subscribe',args}));
      heartbeat=setInterval(()=>{if(socket.readyState===1)socket.send('ping')},18000);
      heartbeat.unref();
    });
    socket.addEventListener('message',event=>{
      try{
        if(event.data==='pong')return;
        const payload=JSON.parse(String(event.data));
        if(payload.event==='error'){log('OKX '+channel+' '+payload.code+' '+payload.msg);return;}
        const m=by.get(payload.arg?.instId);
        if(!m||!Array.isArray(payload.data))return;
        if(!isTrade){receiveBars(m,payload.data.map(okxBar),true);return;}
        const now=Date.now(),t=Math.floor(now/QUARTER)*QUARTER;
        if(!m.aggressor||m.aggressor.t!==t||m.aggressor.socket!==socket){
          m.aggressor={t,buy:0,sell:0,since:opened,socket};
        }
        for(const trade of payload.data){
          const amount=+trade.sz;
          if(+trade.ts>=t&&+trade.ts<=now+5000&&amount>0&&(trade.side==='buy'||trade.side==='sell')){
            m.aggressor[trade.side]+=amount;
          }
        }
      }catch(e){log('OKX '+channel+' '+e.message);}
    });
    socket.addEventListener('close',()=>{
      clearInterval(heartbeat);
      const i=sockets.indexOf(entry);if(i>=0)sockets.splice(i,1);
      if(!stopped())setTimeout(()=>connectOkx(group,channel),7000).unref();
    });
  }
  const subscribed=new Set();
  const timer=setInterval(()=>{
    const now=Date.now(),all=[...markets.values()];
    if(!all.length)return;
    // Round-robin keeps later directory entries eligible when individual instruments fail.
    for(const exchange of ['binance','coin','okx']){
      if(now-last[exchange]<130)continue;
      function candidate(period){
        const step=period===5?FIVE:QUARTER;
        const expected=Math.floor((now-5000)/step)*step-step;
        for(let i=0;i<all.length;i++){
          const m=all[(index+i)%all.length];
          if(m.exchange!==exchange||pending.has(m.symbol))continue;
          if(period===5){
            if(now-(m.fiveAttempt||0)>=30000&&
                (m.bars5?.at(-1)?.t??-1)<expected)return m;
          }else if(now-(m.patternAttempt||0)>=45000&&
              (!m.patternFetched||(m.bars15?.findLast(b=>b.closed)?.t??-1)<expected)){
            return m;
          }
        }
      }
      const first=preferFive?5:15, second=preferFive?15:5;
      const m=candidate(first);
      if(m)refresh(m,first);
      else{
        const backup=candidate(second);
        if(backup)refresh(backup,second);
      }
    }
    preferFive=!preferFive;
    index=(index+11)%all.length;
    const newOkx=all.filter(m=>m.exchange==='okx'&&!subscribed.has(m.symbol));
    for(let i=0;i<newOkx.length;i+=100){
      const group=newOkx.slice(i,i+100);
      for(const m of group)subscribed.add(m.symbol);
      connectOkx(group,'candle15m');connectOkx(group,'trades');
    }
  },145);
  timer.unref();
  return ()=>{clearInterval(timer);for(const {socket} of sockets)socket.close();};
}

module.exports={QUARTER,VERSION,binanceBar,okxBar,receiveBars,frameBars,analyze,buySell,startPatternFeed};
