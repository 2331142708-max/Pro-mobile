'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createObserver}=require('./pro2-observer');
const BASE=10_000_000_000;
function create(){let time=BASE;const markets=new Map();const observer=createObserver({markets,now:()=>time});return {observer,setTime:t=>time=t}}
test('30-second buy/sell pressure is observed, not faked before sufficient sampling',()=>{
 const {observer,setTime}=create();
 for(let i=0;i<305;i++){
   const t=BASE+i*1000;setTime(t);observer.record('BTCUSDT','buy',10000,60000+i,t);
   if(i%3===0)observer.record('BTCUSDT','sell',5000,60000+i,t);
 }
 setTime(BASE+306000);
 const s=observer.stats('BTCUSDT');
 assert.equal(s.covered,true);assert.equal(s.ready,true);
 assert.ok(s.last30.buyPct>65);
 assert.ok(s.last5m.buyPct>65);
 assert.equal(s.short.direction,'up');
 assert.equal(s.large30m.largeBuy,0);
 assert.equal(s.forwardChecks.total,0);
});
test('100k aggregated trade and 1h trade account boundaries differ, 30m labels partial',()=>{
 const {observer,setTime}=create();
 setTime(BASE);observer.record('ETHUSDT','buy',120000,3000,BASE);
 observer.record('ETHUSDT','sell',60000,3000,BASE);
 setTime(BASE+30000);
 const s=observer.stats('ETHUSDT');
 assert.equal(s.large30m.largeBuy,120000);
 assert.equal(s.large30m.largeSell,0);
 assert.equal(s.large30m.largeBuyCount,1);
 assert.equal(s.large30m.partial,true);
 assert.equal(s.last5m,null);
});
test('stale stream and disconnected symbols never get live labels',()=>{
 const {observer,setTime}=create();
 setTime(BASE);observer.record('BTCUSDT','buy',1e6,60000,BASE);
 setTime(BASE+60000);
 assert.equal(observer.stats('BTCUSDT').ready,false);
 assert.equal(observer.stats('BTCUSDT',false).covered,false);
 assert.equal(observer.marketPulse(()=>true).ready,false);
});
test('signal cannot be evaluated until a later observed price >=30 minutes',()=>{
 const {observer,setTime}=create();
 for(let i=0;i<=420;i++){
   const t=BASE+i*1000;setTime(t);
   observer.record('BTCUSDT','buy',200000,60000+i,t);
 }
 const first=observer.stats('BTCUSDT');
 assert.ok(first.forwardChecks.pending>=1);
 setTime(BASE+2100000);
 observer.record('BTCUSDT','buy',200000,60400,BASE+2100000);
 const after=observer.stats('BTCUSDT');
 assert.ok(after.forwardChecks.total>=1);
});
