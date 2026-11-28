'use strict';
// Evidence-limited short-horizon tape monitor; not a forecast or an account identity feed.
const {swingView}=require('./swing-research');
const SECOND=1000, MINUTE=60000, WINDOW=31*MINUTE, LARGE=100000;
const pct=(a,b)=>a+b>0?100*a/(a+b):null;
const round=(n,d=2)=>Number.isFinite(n)?+n.toFixed(d):null;
function createObserver({markets,now=Date.now}){
  const histories=new Map();
  const checkRecords=new Map();
  function record(symbol,side,usd,price,at){
    if(side!=='buy'&&side!=='sell'||!Number.isFinite(usd)||usd<=0||!Number.isFinite(price)||price<=0||!Number.isFinite(at)||Math.abs(at-now())>90000)return;
    let h=histories.get(symbol);
    if(!h){h={startedAt:at,latestAt:at,buckets:[]};histories.set(symbol,h)}
    if(at<h.latestAt-2000)return; // ignore late/out-of-order data instead of backdating live results
    h.latestAt=Math.max(h.latestAt,at);
    const sec=Math.floor(at/SECOND)*SECOND;
    let b=h.buckets.at(-1);
    if(b&&sec<b.t)return;
    if(!b||b.t!==sec){b={t:sec,buy:0,sell:0,buyCount:0,sellCount:0,largeBuy:0,largeSell:0,largeBuyCount:0,largeSellCount:0,open:price,close:price};h.buckets.push(b)}
    b[side]+=usd;b[side+'Count']++;
    if(usd>=LARGE){b[side==='buy'?'largeBuy':'largeSell']+=usd;b[side==='buy'?'largeBuyCount':'largeSellCount']++}
    b.close=price;
    if(h.buckets.length>2100||h.buckets[0].t<at-WINDOW){while(h.buckets.length&&h.buckets[0].t<at-WINDOW)h.buckets.shift()}
    // Forward-only 30m observations from short-horizon order-flow pressure; no backfilled outcomes.
    const records=checkRecords.get(symbol)||[];
    for(const r of records){
      if(r.outcome!==null||at<r.at+30*MINUTE)continue;
      if(at-r.at>31*MINUTE){r.outcome='missed';continue}
      r.change=round(100*(price/r.price-1),3);
      r.outcome=r.direction==='up'?r.change>0:r.change<0;
      r.checkedAt=at;
    }
    const slot=Math.floor(at/(10*MINUTE));
    if(h.lastCheckedSlot!==slot&&at-h.startedAt>=5*MINUTE){
      h.lastCheckedSlot=slot;
      const sample=stats(symbol,true);
      if(sample.short?.confirmed){records.push({at,direction:sample.short.direction,price,outcome:null,change:null,checkedAt:null});}
    }
    if(records.length>30)records.splice(0,records.length-30);
    checkRecords.set(symbol,records);
  }
  function summary(h,from,to){
    const out={buy:0,sell:0,buyCount:0,sellCount:0,largeBuy:0,largeSell:0,largeBuyCount:0,largeSellCount:0};
    for(let i=h.buckets.length-1;i>=0;i--){const b=h.buckets[i];if(b.t<from)break;if(b.t>=to)continue;
      for(const k of Object.keys(out))out[k]+=b[k]||0;
    }
    out.buyPct=round(pct(out.buy,out.sell),1);out.sellPct=out.buyPct===null?null:round(100-out.buyPct,1);
    return out;
  }
  function change(h,seconds,time){
    if(time-h.latestAt>45000)return null;
    const target=time-seconds*SECOND;
    let candidate=null;
    for(let i=h.buckets.length-1;i>=0;i--){const b=h.buckets[i];
      if(b.t>target)continue;
      candidate=b;break;
    }
    if(!candidate||target-candidate.t>30000||!(candidate.close>0))return null;
    const last=h.buckets.at(-1);
    return round((last.close/candidate.close-1)*100,3);
  }
  function stats(symbol,connected=true){
    const h=histories.get(symbol),time=now();
    if(!connected)return {covered:false,reason:'监测连接中断，暂不发布短时数据'};
    if(!h)return {covered:true,ready:false,reason:'已订阅成交，但尚未收到有效数据'};
    const fresh=time-h.latestAt<=45000;
    if(!fresh)return {covered:true,ready:false,reason:'公开成交流已延迟，暂停短时判断',latestAt:h.latestAt,startedAt:h.startedAt};
    const w30=summary(h,time-30000,time+1000),w5=summary(h,time-5*MINUTE,time+1000);
    const wPrev5=summary(h,time-10*MINUTE,time-5*MINUTE);
    const w30m=summary(h,time-30*MINUTE,time+1000);
    const age=time-h.startedAt;
    const fresh30=age>=30000&&w30.buyPct!==null;
    const enough5=age>=5*MINUTE&&w5.buyPct!==null;
    const enough10=age>=10*MINUTE&&wPrev5.buyPct!==null;
    const v5=w5.buy+w5.sell,vPrev=wPrev5.buy+wPrev5.sell;
    const activityRatio=enough10&&vPrev>0?round(v5/vPrev,2):null;
    const activity=activityRatio===null?'样本不足':activityRatio<.45?'极低':activityRatio<.8?'低':activityRatio<1.3?'中':activityRatio<2?'高':'极高';
    const move1=change(h,60,time),move5=change(h,300,time),move10=change(h,600,time);
    const positive=!!(fresh30&&enough5&&move1!==null&&w30.buyPct>=65&&w5.buyPct>=58&&move1>=.07);
    const negative=!!(fresh30&&enough5&&move1!==null&&w30.buyPct<=35&&w5.buyPct<=42&&move1<=-.07);
    const score=fresh30&&enough5&&move1!==null?Math.max(0,Math.min(100,Math.round(
       50+(w30.buyPct-50)*.5+(w5.buyPct-50)*.3+Math.max(-10,Math.min(10,move1*20))))) :null;
    const minuteBars=new Map();
    for(const b of h.buckets){if(b.t<time-30*MINUTE)continue;
      const key=Math.floor(b.t/MINUTE)*MINUTE;
      const v=minuteBars.get(key)||{t:key,buy:0,sell:0,buyCount:0,sellCount:0};
      v.buy+=b.largeBuy;v.sell+=b.largeSell;v.buyCount+=b.largeBuyCount;v.sellCount+=b.largeSellCount;
      minuteBars.set(key,v);
    }
    const records=checkRecords.get(symbol)||[],evaluated=records.filter(r=>typeof r.outcome==='boolean');
    const forwardChecks={total:evaluated.length,aligned:evaluated.filter(r=>r.outcome).length,
      pending:records.filter(r=>r.outcome===null).length,missed:records.filter(r=>r.outcome==='missed').length,
      last:evaluated.at(-1)||null};
    return {covered:true,ready:true,startedAt:h.startedAt,latestAt:h.latestAt,ageMs:age,
      last30:fresh30?w30:null,sample30:w30,sample30Partial:!fresh30,last5m:enough5?w5:null,large30m:{...w30m,partial:age<30*MINUTE},
      activity,activityRatio,change1m:move1,change5m:move5,change10m:move10,
      largeMinuteSeries:[...minuteBars.values()].sort((a,b)=>a.t-b.t),forwardChecks,
      short:{direction:positive?'up':negative?'down':'neutral',score,confirmed:positive||negative,
        explanation:!fresh30?'监测不足30秒':!enough5?'正在积累5分钟主动成交':move1===null?'价格变化数据不足':positive?'短时主动买入与价格同向':negative?'短时主动卖出与价格同向':'多项条件未同向确认'},
      evidence:'公开聚合成交，非真实身份；覆盖的只是本服务器监测时段，不是全市场全量'};
  }
  function marketPulse(connected){
    const time=now(),items=[];
    for(const [symbol,h] of histories){if(!connected(symbol))continue;
      const s=stats(symbol,true);if(!s.ready||s.change10m===null||!s.last5m)continue;
      items.push({symbol,change:s.change10m,buy:s.last5m.buy,sell:s.last5m.sell});
    }
    if(items.length<5)return {ready:false,monitored:items.length,reason:'当前有足够连续10分钟样本的合约少于5只'};
    const up=items.filter(x=>x.change>.03).length,down=items.filter(x=>x.change<-.03).length;
    const buy=items.reduce((s,x)=>s+x.buy,0),sell=items.reduce((s,x)=>s+x.sell,0);
    const buyPct=pct(buy,sell),breadth=100*up/items.length;
    const longScore=Math.round(Math.min(100,Math.max(0,50+(buyPct-50)*.45+(breadth-50)*.35)));
    const market=longScore>=57?'观察到偏多压力':longScore<=43?'观察到偏空压力':'多空分歧';
    const btc=items.find(x=>x.symbol==='BTCUSDT'),eth=items.find(x=>x.symbol==='ETHUSDT');
    return {ready:true,monitored:items.length,up,down,neutral:items.length-up-down,
      buyPct:round(buyPct,1),sellPct:round(100-buyPct,1),longScore,shortScore:100-longScore,
      sentiment:market,btc10m:btc?.change??null,eth10m:eth?.change??null,updatedAt:time,
      note:'仅覆盖已订阅且持续有行情的合约；规则强度不是涨跌概率'};
  }
  function historicalWindow(symbol,end){
    const h=histories.get(symbol),start=end-300000;
    if(!h||h.startedAt>start||h.latestAt<end||end>now()-300000)return null;
    const rows=h.buckets.filter(b=>b.t>=start&&b.t<end);
    if(rows.length<30||rows[0].t-start>30000||end-rows.at(-1).t>30000||rows.some((b,i)=>i&&b.t-rows[i-1].t>30000))return null;
    const v=summary(h,start,end);return {...v,first:rows[0].open,last:rows.at(-1).close,end};
  }
  function reset(symbol){histories.delete(symbol);checkRecords.delete(symbol)}
  return {record,reset,stats,marketPulse,historicalWindow,swing:symbol=>swingView(histories.get(symbol),now()),_test:{summary,change,histories}};
}
module.exports={createObserver};
