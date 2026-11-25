'use strict';
const MIN=60000;
const COST=0.0012;
const MIN_SAMPLES=20;

function buildSetup(bars,hit){
  const last=bars.at(-1);
  const recent=bars.slice(-15);
  const spans=recent.slice(1).map((b,i)=>Math.max(b.h-b.l,Math.abs(b.h-recent[i].c),Math.abs(b.l-recent[i].c)));
  const atr=spans.reduce((a,b)=>a+b,0)/spans.length;
  if(!last||!(atr>0))return null;
  const side=hit.direction==='up'?1:-1;
  const structural=hit.levels||[];
  const key=structural.length?(side===1?Math.max(...structural):Math.min(...structural)):(side===1?last.h:last.l);
  const invalid=structural.length?key-side*atr*0.35:(side===1?last.l:last.h);
  const prior=bars.slice(-32,-1);
  const levels=prior.slice(1,-1).filter((bar,i)=>side===1?
    bar.h>=prior[i].h&&bar.h>=prior[i+2].h:bar.l<=prior[i].l&&bar.l<=prior[i+2].l)
    .map(bar=>side===1?bar.h:bar.l).filter(level=>side*(level-key)>0);
  const obstacle=levels.length?(side===1?Math.min(...levels):Math.max(...levels)):null;
  return {key,invalid,atr,obstacle,side,structural:structural.length>0,lastClose:last.c};
}
function evaluateReview(m,scan,flow,now){
  if(!scan.matches.length)return null;
  const names=[...new Set(scan.matches.flatMap(h=>h.names))];
  const directions=new Set(scan.matches.map(h=>h.direction));
  const hits=scan.matches.map(h=>({period:h.period,direction:h.direction,names:h.names,
    setup:buildSetup(scan.bars[h.period],h)}));
  const result={distinct:names.length,duplicate:scan.matches.reduce((n,h)=>n+h.names.length,0)>names.length,hits,status:'waiting',reason:'等待确认'};
  if(directions.size!==1)return {...result,status:'conflict',reason:'15／30分钟方向冲突'};
  const lead=hits.find(h=>h.period===30)||hits[0];
  const setup=lead.setup;
  if(!setup)return result;
  const {key,invalid,side,atr,obstacle}=setup;
  const price=m.price;
  const live=price>0&&now-m.priceAt<=30000&&m.priceAt<=now+5000;
  const book=m.book;
  result.period=lead.period;
  result.distance=live?(price/key-1)*100:null;
  result.spread=book&&now-book.at<=75000?(book.ask-book.bid)/((book.ask+book.bid)/2)*100:null;
  result.rr=live&&obstacle&&side*(price-invalid)>0?
    (side*(obstacle-price)-price*COST)/(side*(price-invalid)):null;
  if(!live)return {...result,reason:'实时价格待核'};
  const stamp=scan.matches.map(h=>[h.period,h.closedAt,h.direction].join(':')).join('|');
  if(m.retest?.stamp!==stamp)m.retest={stamp,crossed:setup.structural,touchedAt:null,passedAt:null,lastAt:0};
  const sequence=m.retest;
  const delta=side*(price-key);
  const failed=side*(price-invalid)<=0;
  if(!sequence.failed&&failed)sequence.failed=true;
  if(!sequence.failed&&sequence.lastAt<m.priceAt){
    sequence.lastAt=m.priceAt;
    if(sequence.touchedAt!==null&&m.priceAt>sequence.touchedAt&&delta>=atr*0.15)sequence.passedAt=m.priceAt;
    if(sequence.crossed&&delta<=atr*0.12&&delta>=-atr*0.12)sequence.touchedAt??=m.priceAt;
    if(delta>=atr*0.15)sequence.crossed=true;
  }
  const current=m.bars15?.at(-1);
  const inactive=m.bars15?.filter(b=>b.closed).slice(-10)||[];
  const averageVolume=inactive.reduce((sum,b)=>sum+b.v,0)/inactive.length;
  const elapsed=now%900000;
  const enoughVolume=current?.t===now-elapsed&&!current.closed&&elapsed>=3*MIN&&averageVolume>0&&current.v>=averageVolume*(elapsed/900000)*0.7;
  if(flow&&!flow.partial&&enoughVolume&&side*(price-current.o)<atr*0.08&&
      (side===1?flow.buyPct:flow.sellPct)>=65)
    result.flowNote=side===1?'主动买入偏多，价格推进弱':'主动卖出偏多，价格推进弱';
  if(sequence.failed)return {...result,status:'invalid',reason:'已触及失效位'};
  if(delta>atr*0.5)return {...result,status:'extended',reason:'现价已走远'};
  if(sequence.passedAt===null||delta<0)return {...result,reason:sequence.crossed?'等待回踩／反抽后再确认':'等待越过确认价'};
  if(result.rr===null||result.rr<1.5)return {...result,reason:result.rr===null?'前方支撑／压力待核':'扣成本后前方空间偏小'};
  if(result.spread===null||result.spread>0.12)return {...result,reason:result.spread===null?'买卖价差待核':'买卖价差偏宽'};
  if(!enoughVolume)return {...result,reason:'当前成交量待核'};
  if(result.flowNote)return {...result,reason:result.flowNote};
  return {...result,status:'passed',reason:'通过位置与成交检查'};
}

function signedReturn(entry,exit,side,exchange){
  return side*(exchange==='coin'?1-entry/exit:exit/entry-1);
}

function horizons(record){return record.mode?.endsWith('20')?[20]:[15,30];}

function updateObservation(record,market,now){
  const at=market?.priceAt||0, price=market?.price;
  const fresh=at>record.lastAt&&at<=now+5000&&now-at<=30000&&price>0;
  if(fresh){
    const elapsed=at-record.start;
    const movement=signedReturn(record.entry,price,record.side,record.exchange);
    record.lastAt=at;
    if(elapsed<=5*MIN){
      record.adverse=Math.max(record.adverse,-movement);
      record.firstCount++;
      record.firstLast=elapsed;
    }
    if(record.adverse>=0.003&&elapsed<=15*MIN&&movement>=COST)record.recovered=true;
    for(const minutes of horizons(record)){
      if(!record.ends[minutes]&&elapsed>=minutes*MIN&&elapsed<=minutes*MIN+90000){
        record.ends[minutes]={at,price};
      }
    }
  }
  const end=horizons(record).at(-1);
  return now>=record.start+end*MIN+90000||!!record.ends[end];
}

function settle(record,events){
  for(const minutes of horizons(record)){
    const end=record.ends[minutes];
    if(!end){record.outcomes[minutes]=null;continue;}
    const funding=events.filter(e=>e.at>record.start&&e.at<=end.at)
      .reduce((total,e)=>total+e.rate,0);
    const net=signedReturn(record.entry,end.price,record.side,record.exchange)-COST-record.side*funding;
    record.outcomes[minutes]={net,win:net>0};
  }
  record.settled=true;
}

module.exports={buildSetup,horizons,evaluateReview,updateObservation,settle,MIN,COST,MIN_SAMPLES};
