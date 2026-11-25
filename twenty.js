'use strict';

const {buildSetup,COST}=require('./review');
const FIVE=300000;
const QUARTER=900000;

function evaluateTwenty(m,scan,now){
  const signals=scan.matches.filter(h=>h.period===15);
  if(!signals.length)return null;
  const result={status:'waiting',reason:'等5分钟收盘确认',fiveConfirmed:false,reviewed:false};
  if(signals.length!==1)return {...result,status:'conflict',reason:'15分钟形态方向冲突'};
  const signal=signals[0], setup=buildSetup(scan.bars[15],signal);
  if(!setup)return result;
  const {key,invalid,atr,obstacle,side}=setup;
  const fresh=m.price>0&&now-m.priceAt<=30000&&m.priceAt<=now+5000;
  const delta=price=>side*(price-key);
  const crossed=price=>delta(price)>=atr*0.08;
  const expected=Math.floor((now-3000)/FIVE)*FIVE-FIVE;
  const rows=(m.bars5||[]).filter(b=>b.closed&&b.t>=signal.closedAt&&b.t<=expected);
  const validSequence=rows.length&&rows.at(-1).t===expected&&rows.every((bar,i)=>bar.t===signal.closedAt+i*FIVE);
  const detail={...result,direction:signal.direction,closedAt:signal.closedAt,key,invalid,obstacle,atr};
  if(!fresh)return {...detail,reason:'实时价格待核'};
  if(now>=signal.closedAt+QUARTER || m.priceAt<signal.closedAt)return {...detail,reason:'等待新收盘信号'};
  if(side*(m.price-invalid)<=0)return {...detail,status:'invalid',reason:'已触及15分钟失效位'};
  if(!validSequence)return {...detail,reason:'等待第一根或补齐5分钟收盘K线'};
  let broke=setup.structural&&crossed(setup.lastClose);
  let confirmedAt=null;
  for(const bar of rows){
    const extreme=side===1?bar.l:bar.h;
    if(side*(extreme-invalid)<=0)return {...detail,status:'invalid',reason:'5分钟K线触及失效位'};
    const held=delta(extreme)>=-atr*0.15;
    if(broke&&held&&delta(extreme)<=atr*0.20&&crossed(bar.c)&&side*(bar.c-bar.o)>0)confirmedAt=bar.t+FIVE;
    if(crossed(bar.c))broke=true;
  }
  if(!confirmedAt)return {...detail,reason:broke?'等5分钟回踩／反抽收盘确认':'等5分钟收盘越过确认价'};
  if(m.priceAt<confirmedAt)return {...detail,reason:'等待确认后的新报价'};
  if(delta(m.price)<0)return {...detail,reason:'现价退回确认价另一侧'};
  if(delta(m.price)>atr*0.5)return {...detail,status:'extended',reason:'现价已走远，跳过本次追价'};
  if(!obstacle)return {...detail,reason:'下一道压力／支撑待核'};
  const rewardRisk=(side*(obstacle-m.price)-m.price*COST)/(side*(m.price-invalid));
  if(rewardRisk<1.5)return {...detail,reason:'扣成本后前方空间偏小'};
  const ready={...detail,confirmedAt,fiveConfirmed:true};
  const opposite30=scan.matches.some(h=>h.period===30&&h.direction!==signal.direction);
  if(opposite30)return {...ready,status:'conflict',reason:'已确认5分钟位置，30分钟明确反向'};
  if(!scan.ready.includes(30))return {...ready,reason:'已确认5分钟位置，30分钟收盘数据待核'};
  return {...ready,status:'confirmed',reviewed:true,reason:'20分钟方案已确认'};
}

module.exports={evaluateTwenty,FIVE};
