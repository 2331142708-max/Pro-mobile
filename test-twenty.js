'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {evaluateTwenty,FIVE}=require('./twenty');
const {updateObservation,settle,MIN}=require('./review');

const closeAt=30*MIN;
const past=Array.from({length:15},(_,i)=>({o:100,h:i===6?104:i===14?100.2:100,l:99.6,c:i===14?100.15:100,v:100,closed:true}));
const match={period:15,direction:'up',names:['W底'],levels:[100],closedAt:closeAt};
const first={t:closeAt,o:100.02,h:100.25,l:99.97,c:100.2,closed:true};
const second={...first,t:closeAt+FIVE};
const scan=(matches=[match],ready=[15,30])=>({bars:{15:past},matches,ready});
const market=(bars5,priceAt,price=100.2)=>({price,priceAt,bars5});
const at=closeAt+FIVE+5000;

test('5-minute timing needs a closed continuous candle and a fresh post-confirmation quote',()=>{
  assert.equal(evaluateTwenty(market([{...first,closed:false}],at),scan(),at).reviewed,false);
  assert.equal(evaluateTwenty(market([first],at),scan(),at).reviewed,true);
  assert.equal(evaluateTwenty(market([first],at,101),scan(),at).status,'extended');
  assert.equal(evaluateTwenty(market([first],closeAt+FIVE-1000),scan(),at).reviewed,false);
  assert.equal(evaluateTwenty(market([second],at+FIVE),scan(),at+FIVE).reviewed,false);
  assert.equal(evaluateTwenty(market([first],at,99),scan(),at).status,'invalid');
});
test('5-minute-only comparison may qualify while 30-minute opposite or missing data are excluded',()=>{
  const m=market([first],at);
  const missing=evaluateTwenty(m,scan([match],[15]),at);
  assert.equal(missing.fiveConfirmed,true);
  assert.equal(missing.reviewed,false);
  const mixed=evaluateTwenty(m,scan([match,{period:30,direction:'down'}]),at);
  assert.equal(mixed.fiveConfirmed,true);
  assert.equal(mixed.status,'conflict');
  assert.equal(evaluateTwenty(m,scan([{period:30,direction:'up'}]),at),null);
});
test('short confirmation mirrors price and support, and an old setup expires at next 15-minute close',()=>{
  const mirror=b=>({...b,o:200-b.o,h:200-b.l,l:200-b.h,c:200-b.c});
  const down={...match,direction:'down',names:['M顶']};
  const m=market([mirror(first)],at,99.8);
  assert.equal(evaluateTwenty(m,{bars:{15:past.map(mirror)},matches:[down],ready:[15,30]},at).reviewed,true);
  const late=closeAt+15*MIN;
  assert.equal(evaluateTwenty(market([first,second],late),scan(),late).reviewed,false);
});
test('20 minute observation settles only its own horizon with simulated cost',()=>{
  const r={mode:'filtered20',start:at,entry:100,lastAt:at,side:-1,exchange:'okx',ends:{},outcomes:{},adverse:0,firstCount:0};
  const feed=(elapsed,price)=>updateObservation(r,{price,priceAt:at+elapsed*MIN},at+elapsed*MIN);
  assert.equal(feed(3,100.4),false);
  assert.equal(feed(15,100),false);
  assert.equal(feed(20,99.6),true);
  settle(r,[]);
  assert.ok(r.adverse>=.003);
  assert.deepEqual(Object.keys(r.outcomes),['20']);
  assert.ok(r.outcomes[20].win);
});
