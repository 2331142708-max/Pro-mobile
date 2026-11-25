'use strict';
// Read-only realized swing statistics from the existing public trade stream.
const HORIZONS=[1,3,5], MAX_GAP=6000;
const round=x=>Number.isFinite(x)?+x.toFixed(4):null;
const pct=(a,b)=>a>0?round(100*(b/a-1)):null;
// Classify already observed local turns only. Thresholds are uncalibrated research defaults.
function observedPhase(h){
 const end=h.buckets.at(-1)?.t;
 const neutral=(reason,code='neutral')=>({code,reason});
 const a=h.buckets.filter(b=>b.t>=end-90000);
 if(a.length<75||end-a[0].t<85000||a.some((b,i)=>!Number.isFinite(b.close)||b.close<=0||(i&&b.t-a[i-1].t>3000)))return neutral('等待约90秒连续有效采样','waiting');
 const moves=a.slice(1).map((b,i)=>Math.abs(Math.log(b.close/a[i].close))*100).sort((x,y)=>x-y);
 const threshold=Math.max(.025,6*moves[Math.floor(moves.length*.75)]);
 const last=a.at(-1);const recent=a.filter(b=>b.t>=end-5000);
 const candidates=[];
 for(const sign of [1,-1]){
   const zone=a.filter(b=>b.t>=end-60000);
   const pivot=zone.reduce((best,b)=>sign*(b.close-best.close)<=0?b:best);
   const age=(end-pivot.t)/1000;
   if(age<6||age>55)continue;
   const before=a.filter(b=>b.t>=pivot.t-30000&&b.t<=pivot.t-15000);
   if(before.length<10)continue;
   const beforeMean=before.reduce((sum,b)=>sum+b.close,0)/before.length;
   const prior=sign*100*(beforeMean-pivot.close)/pivot.close;
   const move=sign*100*(last.close-pivot.close)/pivot.close;
   const held=recent.length>=4&&recent.every(b=>sign*100*(b.close-pivot.close)/pivot.close>=threshold*.65);
   if(prior<threshold||move<threshold||!held)continue;
   candidates.push({code:sign===1?(age<=20?'up_early':'up_elapsed'):(age<=20?'down_early':'down_elapsed'),turnAt:pivot.t,ageSeconds:age,change:round(sign*move),threshold:round(threshold),reason:'已观察到局部转折后的持续价格变化，非未来预测'});
 }
 if(candidates.length!==1)return neutral(candidates.length?'双向波动，阶段不明确':'尚未观察到满足条件的局部转折');
 return candidates[0];
}
// Independent descriptive risk review; no forecast or entry recommendation.
// Thresholds are provisional research defaults, not calibrated probabilities.
function riskReview(h,phase,now){
 const names=['信号时效','波段末端','价格位置','动能衰减','量价背离','假反转风险','行情延迟','转折失效'];
 const checks=names.map(name=>({name,level:'unknown',note:'样本或证据不足'}));
 const set=(i,level,note)=>{checks[i]={name:names[i],level,note}};
 const result=()=>({version:'ssr-risk-v1',level:checks.some(x=>x.level==='high')?'high':checks.some(x=>x.level==='unknown')?'unknown':checks.some(x=>x.level==='medium')?'medium':'low',checks,method:'仅评估已观测异常；阈值未校准，不代表开仓安全或未来亏损概率'});
 if(!h?.buckets?.length||!Number.isFinite(h.latestAt))return result();
 const age=now-h.latestAt;
 if(age>MAX_GAP||age< -1000){set(6,'high','数据过期或时钟异常');return result()}
 set(6,'low','最新成交时间在有效范围内');
 const end=h.buckets.at(-1).t,a=h.buckets.filter(b=>b.t>=end-90000);
 if(a.length<75||end-a[0].t<85000||a.some((b,i)=>!Number.isFinite(b.close)||b.close<=0||(i&&(b.t<=a[i-1].t||b.t-a[i-1].t>3000))))return result();
 if(!/^(up|down)_(early|elapsed)$/.test(phase?.code||'')){
   set(0,'unknown','当前无已确认转折');return result();
 }
 const sign=phase.code.startsWith('up')?1:-1, pivot=a.find(b=>b.t===phase.turnAt);
 const after=a.filter(b=>b.t>=phase.turnAt),last=a.at(-1),th=phase.threshold;
 if(!pivot||!Number.isFinite(th)||th<=0||after.length<5)return result();
 const progress=b=>sign*100*(b.close/pivot.close-1);
 const move=progress(last),peak=Math.max(...after.map(progress)),retreat=peak-move;
 const tAge=(end-phase.turnAt)/1000;
 set(0,tAge>20?'medium':'low',`距采样转折 ${tAge} 秒（研究时效）`);
 const extreme=Math.max(...a.map(progress)),bottom=Math.min(...a.map(progress)),span=extreme-bottom;
 const pos=span>0?(move-bottom)/span:null;
 if(pos!==null)set(2,pos>=.9?'medium':'low',`在近期同方向价格区间的 ${(pos*100).toFixed(0)}% 位置`);
 set(1,retreat>=th&&peak>=2*th?'high':peak>=3*th||tAge>20?'medium':'low',`已观测最大位移 ${peak.toFixed(3)}%，回撤 ${retreat.toFixed(3)}%`);
 const recent=after.filter(b=>b.t>=end-5000),prev=after.filter(b=>b.t>=end-10000&&b.t<=end-5000);
 if(recent.length>=4&&prev.length>=4){
   const r=progress(recent.at(-1))-progress(recent[0]),p=progress(prev.at(-1))-progress(prev[0]);
   set(3,r< -th*.5?'high':p>th*.2&&r<p*.3?'medium':'low','对比已发生的两个短时价格变化');
 }
 if(recent.length>=4&&recent.every(b=>Number.isFinite(b.buy)&&b.buy>=0&&Number.isFinite(b.sell)&&b.sell>=0)){
   const buy=recent.reduce((s,b)=>s+b.buy,0),sell=recent.reduce((s,b)=>s+b.sell,0),total=buy+sell;
   if(total>0){const f=sign*(buy-sell)/total,r=progress(last)-progress(recent[0]);
   set(4,f>.4&&r< -th*.2?'high':f>.4&&r<th*.1?'medium':'low','比较已发生的主动成交与价格位移');}
 }
 set(5,retreat>=th?'high':retreat>=th*.5?'medium':'low','仅检测已经出现的反向回撤，无法提前排除假反转');
 set(7,move<th*.65?'high':move<th?'medium':'low','当前价格与已识别转折门槛对比');
 return result();
}
function swingView(h,now=Date.now()){
 const empty=reason=>({version:'ssr-research-v1',ready:false,reason,phase:{code:'waiting',reason},risk:riskReview(h,null,now),latestAt:h?.latestAt??null,periods:HORIZONS.map(minutes=>({minutes,ready:false}))});
 if(!h?.buckets?.length)return empty('等待交易所真实成交');
 if(now-h.latestAt>MAX_GAP||h.latestAt-now>1000)return empty('成交已延迟，暂停统计');
 const last=h.buckets.at(-1), end=last.t;
 const periods=HORIZONS.map(minutes=>{
   const target=end-minutes*60000;
   let i=h.buckets.length-1;while(i>=0&&h.buckets[i].t>target)i--;
   if(i<0||target-h.buckets[i].t>MAX_GAP)return {minutes,ready:false};
   const a=h.buckets.slice(i);if(a.some((b,j)=>j&&b.t-a[j-1].t>MAX_GAP))return {minutes,ready:false};
   const start=a[0];let low=start,high=start,buy=0,sell=0,count=0;
   for(const b of a){if(b.close<low.close)low=b;if(b.close>high.close)high=b;if(b.t>target){buy+=b.buy;sell+=b.sell;count+=b.buyCount+b.sellCount;}}
   return {minutes,ready:true,change:pct(start.close,last.close),rebound:pct(low.close,last.close),pullback:pct(high.close,last.close),low:low.close,high:high.close,lowAt:low.t,highAt:high.t,buyPct:buy+sell>0?round(100*buy/(buy+sell)):null,buy,sell,count};
 });
 // Non-overlapping completed 5-minute blocks, descriptive only; no signal or forecast.
 const blocks=[];
 for(let offset=5;offset<=25;offset+=5){
   const to=end-(offset-5)*60000,from=to-300000;
   const a=h.buckets.filter(b=>b.t>=from&&b.t<to);
   if(a.length<2||a[0].t-from>MAX_GAP||to-a.at(-1).t>MAX_GAP||a.some((b,j)=>j&&b.t-a[j-1].t>MAX_GAP))continue;
   let lo=a[0],hi=a[0];for(const b of a){if(b.close<lo.close)lo=b;if(b.close>hi.close)hi=b;}
   blocks.push({from,to,change:pct(a[0].close,a.at(-1).close),range:pct(lo.close,hi.close)});
 }
 const phase=observedPhase(h);
 return {version:'ssr-research-v1',ready:true,latestAt:h.latestAt,price:last.close,phase,risk:riskReview(h,phase,now),periods,blocks,reason:'公开成交 · 已发生行情'};
}
module.exports={swingView,riskReview};
