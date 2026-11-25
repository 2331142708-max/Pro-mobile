'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {evaluateReview,updateObservation,settle,MIN}=require('./review');

const now=36*MIN;
const bars=Array.from({length:15},(_,i)=>({o:100,h:i===6?104:100,l:99.6,c:100,v:100,closed:true}));
const bullish={direction:'up',period:15,names:['W底'],levels:[100],closedAt:30*MIN};
const market=(price=100.34)=>({price,priceAt:now,book:{bid:price-.01,ask:price+.01,at:now},bars15:[...bars,{o:100,v:90,t:30*MIN,closed:false}]});
test('duplicate pattern and opposite directions preserve the original hits',()=>{
  const scans={bars:{15:bars,30:bars},matches:[bullish,{...bullish,period:30}]};
  const assessment=evaluateReview(market(),scans,null,now);
  assert.equal(assessment.distinct,1);
  assert.equal(assessment.duplicate,true);
  assert.equal(assessment.hits.length,2);
  scans.matches[1]={...scans.matches[1],direction:'down',names:['M顶']};
  assert.equal(evaluateReview(market(),scans,null,now).status,'conflict');
});
test('price extension warns; retest and adequate space can pass',()=>{
  const scan={bars:{15:bars},matches:[bullish]};
  assert.equal(evaluateReview(market(102),scan,null,now).status,'extended');
  const m=market(100.28);
  assert.equal(evaluateReview(m,scan,null,now).status,'waiting');
  m.price=100.02;m.priceAt+=6000;
  assert.equal(evaluateReview(m,scan,null,m.priceAt).status,'waiting');
  m.price=100.27;m.priceAt+=6000;
  assert.equal(evaluateReview(m,scan,null,m.priceAt).status,'passed');
  m.price=99;m.priceAt+=6000;
  assert.equal(evaluateReview(m,scan,null,m.priceAt).status,'invalid');
});
test('quotes track adverse move, recovery, and signed funding economics',()=>{
  const rec={start:now,entry:100,lastAt:now,adverse:0,firstCount:0,ends:{},outcomes:{},side:1,exchange:'binance'};
  const feed=(t,price)=>updateObservation(rec,{priceAt:now+t*MIN,price},now+t*MIN);
  feed(1,99.6);feed(4,100.14);feed(15,100.2);
  assert.ok(rec.adverse>.003);
  assert.equal(rec.recovered,true);
  assert.equal(feed(30,100.5),true);
  settle(rec,[{at:now+10*MIN,rate:.001}]);
  assert.equal(rec.outcomes[15].win,false);
  assert.equal(rec.outcomes[30].win,true);
});
