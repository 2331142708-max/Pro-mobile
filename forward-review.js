'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {MIN,MIN_SAMPLES,horizons,updateObservation,settle}=require('./review');

function createReviewHistory({file,binance,okx,json}){
  let history={version:1,records:[],stats:{},groups:{},seen:{}};
  try{
    const stored=JSON.parse(fs.readFileSync(file,'utf8'));
    if(stored.version===history.version)history=stored;
  }catch{}
  let pending=false,dirty=false,lastSave=0;

  function save(){
    if(!dirty)return;
    try{
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file+'.tmp',JSON.stringify(history));
      fs.renameSync(file+'.tmp',file);
      dirty=false;lastSave=Date.now();
    }catch(e){console.warn('保存合约复核统计失败',e.message);}
  }
  function seenKey(symbol,direction,mode){return [symbol,direction,mode].join('|');}
  function seed(m,direction,closedAt,mode,group){
    const key=seenKey(m.symbol,direction,mode);
    if((history.seen[key]||0)>=closedAt)return;
    history.seen[key]=closedAt;
    if(mode==='confirm20'||mode==='filtered20')(history.approved20??={})[key+'|'+closedAt]=true;
    const at=m.priceAt;
    history.records.push({symbol:m.symbol,apiSymbol:m.apiSymbol,closedAt,direction,
      perpetual:['PERPETUAL','SWAP'].includes(m.contractType),
      exchange:m.exchange,side:direction==='up'?1:-1,mode,group,start:at,entry:m.price,
      lastAt:at,firstCount:0,firstLast:0,adverse:0,recovered:false,ends:{},outcomes:{}});
    dirty=true;
  }
  function addTwenty(m,scan,decision,now){
    const signals=scan.matches.filter(h=>h.period===15);
    if(signals.length!==1||!(m.price>0)||m.priceAt>now+5000||now-m.priceAt>30000)return;
    const {closedAt,direction}=signals[0];
    if(m.priceAt<closedAt||now>=closedAt+15*MIN)return;
    seed(m,direction,closedAt,'base20','base20');
    if(decision?.fiveConfirmed)seed(m,direction,closedAt,'confirm20','confirm20');
    if(decision?.reviewed)seed(m,direction,closedAt,'filtered20','filtered20');
  }
  function add(m,scan,review,now){
    const at=m.priceAt;
    if(!m.price||at>now+5000||now-at>30000)return;
    const sides=new Set(scan.matches.map(h=>h.direction));
    for(const direction of sides){
      const hits=scan.matches.filter(h=>h.direction===direction);
      const closedAt=Math.max(...hits.map(h=>h.closedAt));
      if(at<closedAt)continue;
      const group=sides.size>1?'conflict':new Set(hits.flatMap(h=>h.names)).size>=2?'multiple':'single';
      const modes=review?.status==='passed'?['raw','reviewed']:['raw'];
      for(const mode of modes)seed(m,direction,closedAt,mode,group);
    }
  }
  function tally(total,record){
    for(const minutes of horizons(record)){
      const outcome=record.outcomes[minutes];
      if(!outcome)continue;
      const item=total[minutes]??={samples:0,wins:0,sum:0};
      item.samples++;item.wins+=Number(outcome.win);item.sum+=outcome.net;
    }
    if(record.firstCount>=5&&record.firstLast>=4*MIN+30000){
      total.paths=(total.paths||0)+1;
      total.adverse=(total.adverse||0)+record.adverse;
      if(record.ends[15]&&record.adverse>=0.003&&!record.recovered)total.unrecovered=(total.unrecovered||0)+1;
    }
    if(record.fundingUnknown)total.fundingUnknown=(total.fundingUnknown||0)+1;
  }
  function publish(record){
    if(['raw','base20'].includes(record.mode))tally(history.stats[record.symbol]??={},record);
    if(record.mode==='filtered20'&&record.outcomes[20]){
      const key=seenKey(record.symbol,record.direction,record.mode);
      tally((history.confirmed??={})[key]??={},record);
    }
    if(record.mode==='base20'&&record.outcomes[20]){
      for(const mode of ['confirm20','filtered20']){
        const group=history.groups[mode]??={};
        group.baseline=(group.baseline||0)+1;
        const comparisonKey=seenKey(record.symbol,record.direction,mode)+'|'+record.closedAt;
        if(!history.approved20?.[comparisonKey]){
          group.missed=(group.missed||0)+1;
          if(record.outcomes[20].win)group.missedWins=(group.missedWins||0)+1;
          if(record.firstCount>=5&&record.firstLast>=4*MIN+30000&&record.adverse>=.003&&!record.recovered)
            group.missedAdverse=(group.missedAdverse||0)+1;
        }
        if(history.approved20)delete history.approved20[comparisonKey];
      }
    }
    const group=record.mode==='raw'?record.group:record.mode;
    if(record.mode==='base20'&&!record.outcomes[20]&&history.approved20){
      for(const mode of ['confirm20','filtered20'])delete history.approved20[seenKey(record.symbol,record.direction,mode)+'|'+record.closedAt];
    }
    tally(history.groups[group]??={},record);
    history.records=history.records.filter(r=>r!==record);
    dirty=true;
  }
  async function funding(record){
    const ends=Object.values(record.ends);
    if(!record.perpetual||!ends.length)return [];
    const end=Math.max(...ends.map(v=>v.at));
    const symbol=encodeURIComponent(record.apiSymbol);
    const coin=record.exchange==='coin';
    const isOkx=record.exchange==='okx';
    const url=isOkx
      ? okx+'/api/v5/public/funding-rate-history?instId='+symbol+'&limit=20'
      : (coin?'https://dapi.binance.com/dapi/v1':binance+'/fapi/v1')+'/fundingRate?symbol='+symbol+
        '&startTime='+(record.start+1)+'&endTime='+end+'&limit=100';
    const raw=await json(url,10000);
    const rows=isOkx?raw?.data:raw;
    if(!Array.isArray(rows)||isOkx&&rows.length===0)throw Error('资金费历史无有效响应');
    return rows.filter(row=>+row.fundingTime>record.start&&+row.fundingTime<=end).map(row=>{
      const value=isOkx?row.realizedRate:row.fundingRate;
      if(value===null||value===''||!Number.isFinite(+value))throw Error('结算费率待核');
      return {at:+row.fundingTime,rate:+value,mark:+row.markPrice||null};
    });
  }
  function advance(markets,now){
    for(const record of history.records){
      if(!record.done&&updateObservation(record,markets.get(record.symbol),now)){
        record.done=now;dirty=true;
      }
    }
    const due=history.records.filter(r=>r.done&&now-r.done>60000&&(!r.retryAt||now>=r.retryAt)).slice(0,5);
    if(!pending&&due.length){
      pending=true;
      void (async()=>{
        for(const record of due){
          try{settle(record,await funding(record));publish(record);}
          catch{
            record.attempts=(record.attempts||0)+1;
            if(record.attempts>=3){record.fundingUnknown=true;publish(record);}
            else record.retryAt=Date.now()+60000;
            dirty=true;
          }
          await new Promise(resolve=>setTimeout(resolve,500));
        }
      })().finally(()=>{pending=false});
    }
    if(dirty&&now-lastSave>=15000)save();
  }
  function view(t={},periods=[15,30]){
    return {windows:periods.map(period=>{
      const {samples=0,wins=0,sum=0}=t[period]||{};
      return {period,samples,wins,rate:samples>=MIN_SAMPLES?100*wins/samples:null,net:samples?100*sum/samples:null};
    }), paths:t.paths||0,adverse:t.paths?100*t.adverse/t.paths:null,
    unrecovered:t.unrecovered||0,fundingUnknown:t.fundingUnknown||0};
  }
  return {add,addTwenty,advance,save,funding,
    paperQuality:(symbol,direction)=>{
      const row=history.confirmed?.[seenKey(symbol,direction,'filtered20')]?.[20];
      return row?{samples:row.samples,wins:row.wins,net:100*row.sum/row.samples}:null;
    },contract:symbol=>view(history.stats[symbol],[15,20,30]),
    comparison20:()=>Object.fromEntries(['base20','confirm20','filtered20'].map(key=>{
      const g=history.groups[key]||{};
      return [key,{...view(g,[20]),baseline:g.baseline||0,missed:g.missed||0,missedWins:g.missedWins||0,missedAdverse:g.missedAdverse||0}];
    })),
    groups:()=>Object.fromEntries(['single','multiple','conflict','reviewed'].map(group=>[group,view(history.groups[group])]))};
}
module.exports={createReviewHistory};
