'use strict';

const sides = {
  up: ['锤子线','阳包阴','三外升','早晨之星','三个白兵','刺透线','W底','上升三法','三重底','头肩底','下降楔形','上升三角'],
  down: ['上吊线','阴包阳','三外降','黄昏之星','三只乌鸦','乌云盖顶','M顶','下降三法','三重顶','头肩顶','上升楔形','下降三角','下降旗形']
};
const body = b => b.c - b.o;
const range = b => b.h - b.l;
const average = values => values.reduce((sum, n) => sum + n, 0) / values.length;
const bounds = b => [Math.min(b.o, b.c), Math.max(b.o, b.c)];
const mirror = b => ({...b, o:-b.o, c:-b.c, h:-b.l, l:-b.h});
const trend = (bars, side) => bars.length === 5 &&
  side * (bars[4].c - bars[0].c) >= average(bars.map(range)) * 0.65 &&
  bars.slice(1).filter((b,i) => side * (b.c - bars[i].c) > 0).length >= 2;

function candleHits(bars, side) {
  const b = side === 'up' ? bars : bars.map(mirror);
  const [first, ...middle] = b.slice(-5);
  const [a, p, c] = b.slice(-3);
  const before = count => b.slice(-count-5,-count);
  const normal = count => average(before(count).map(range));
  const context = count => trend(before(count), -1);
  const strong = (k, ref) => body(k)>0 && body(k)>=ref*0.55 && body(k)>=range(k)*0.5;
  const engulf = (x,y) => body(x)<0 && body(y)>0 && y.o<=x.c && y.c>=x.o &&
    (y.o<x.c || y.c>x.o);
  const shape = side === 'up' ? c : bars.at(-1);
  const [bottom,top] = bounds(shape);
  const size = Math.abs(body(shape));
  const result = new Set();
  const hit = (index, passes) => { if(passes) result.add(sides[side][index]); };

  hit(0, context(1) && size>0 && range(shape)>=normal(1)*0.65 &&
    bottom-shape.l>=2*size && shape.h-top<=range(shape)*0.18 && size<=range(shape)*0.35);
  hit(1, context(2) && engulf(p,c));
  hit(2, context(3) && engulf(a,p) && body(c)>0 && c.c>p.c);
  hit(3, context(3) && strong(mirror(a),normal(3)) && Math.abs(body(p))<=Math.abs(body(a))*0.32 &&
    Math.max(p.o,p.c) <= a.c+Math.abs(body(a))*0.25 && strong(c,normal(3)) && c.c>(a.o+a.c)/2);
  hit(4, [a,p,c].every(k=>strong(k,normal(3))) && p.c>a.c && c.c>p.c &&
    p.o>=a.o && p.o<=a.c+normal(3)*0.08 && c.o>=p.o && c.o<=p.c+normal(3)*0.08 &&
    [a,p,c].every(k=>k.h-k.c<=range(k)*0.25));
  // A small open tolerance allows continuous futures markets to trade near the previous close.
  hit(5, context(2) && strong(mirror(p),normal(2)) && strong(c,normal(2)) &&
    c.o<=p.c+normal(2)*0.08 && c.c>(p.o+p.c)/2 && c.c<p.o);
  hit(7, trend(before(5),1) && strong(first,normal(5)) && strong(c,normal(5)) && c.c>first.h &&
    middle.slice(0,3).every(k=>body(k)<0 && Math.abs(body(k))<=body(first)*0.55 &&
      k.h<=first.h && k.l>=first.l) && middle[2].c<middle[0].c);
  return result;
}

function pivots(bars, key, high) {
  return bars.flatMap((b,i) => {
    if(i<2 || i>=bars.length-2) return [];
    const points=[bars[i-2],bars[i-1],bars[i+1],bars[i+2]];
    const v=b[key], d=high?1:-1;
    return points.every(k=>d*(v-k[key])>=0) && points.some(k=>d*(v-k[key])>0)
      ? [{i,v}] : [];
  });
}
const distance = (points) => Math.max(...points.map(p=>p.v))-Math.min(...points.map(p=>p.v));
const line = (a,b,i) => a.v+(b.v-a.v)*(i-a.i)/(b.i-a.i);
const spaced = values => values.slice(1).every((x,i)=>x.i-values[i].i>=4);

function structureHits(bars, side, found, levels) {
  const b=(side==='up'?bars:bars.map(mirror)).slice(-56);
  const n=b.length-1, c=b[n], p=b[n-1];
  if(n<19 || body(c)<=0) return;
  const vol=average(b.slice(-21,-1).map(range));
  if(!vol) return;
  const lows=pivots(b,'l',false), highs=pivots(b,'h',true);
  const names=sides[side];
  const claim=(name,price)=>{
    found.add(name);
    if(levels)levels[name]=side==='up'?price:-price;
  };
  const crossed = boundary => c.c>boundary(n)+vol*0.10 && p.c<=boundary(n-1)+vol*0.10;
  const recent = points => n-points.at(-1).i<=14;
  const rise = (points, gap) => points.slice(1).every((x,i)=>x.v-points[i].v>=gap);
  const troughs=lows.slice(-3);
  for(const count of [2,3]){
    if(troughs.length<count) continue;
    const bottom=troughs.slice(-count);
    if(!spaced(bottom)||!recent(bottom)) continue;
    const humps=bottom.slice(1).map((x,i)=>highs.filter(h=>h.i>bottom[i].i&&h.i<x.i)
      .sort((a,b)=>b.v-a.v)[0]);
    if(humps.some(x=>!x)) continue;
    const neckline=Math.max(...humps.map(h=>h.v));
    if(distance(bottom)<=vol*0.8 && neckline-Math.max(...bottom.map(x=>x.v))>=vol*1.3 &&
      (count===2||distance(humps)<=vol*1.0) && crossed(()=>neckline)) claim(names[count===2?6:8],neckline);
    if(count===3 && Math.abs(bottom[0].v-bottom[2].v)<=vol*1.0 &&
      Math.min(bottom[0].v,bottom[2].v)-bottom[1].v>=vol*0.8 &&
      neckline-Math.max(bottom[0].v,bottom[2].v)>=vol*1.0 &&
      crossed(i=>line(humps[0],humps[1],i))) claim(names[9],line(humps[0],humps[1],n));
  }

  const tops=highs.slice(-3), floors=lows.slice(-3);
  if(tops.length>=2 && floors.length>=2 && recent(tops) && recent(floors)){
    const upper=tops.slice(-2), lower=floors.slice(-2);
    const top=i=>line(upper[0],upper[1],i), low=i=>line(lower[0],lower[1],i);
    const start=Math.max(upper[0].i,lower[0].i);
    const initial=top(start)-low(start), ending=top(n-1)-low(n-1);
    const contained=b.slice(start,n).filter((k,i) => k.c<=top(start+i)+vol*0.35 &&
      k.c>=low(start+i)-vol*0.35).length;
    if(n-start>=6 && initial>=vol*0.8 && ending>0 && ending<initial*0.9 &&
        contained>=(n-start)*0.8){
      if(rise(lower,vol*0.25) && distance(tops)<=vol*0.65 &&
        crossed(()=>Math.max(...tops.map(x=>x.v)))) claim(names[11],Math.max(...tops.map(x=>x.v)));
      if(rise([...upper].reverse(),vol*0.25) && rise([...lower].reverse(),vol*0.2) &&
        crossed(top)) claim(names[10],top(n));
    }
  }

  if(side==='down'){
    // In mirrored coordinates a bear flag is an upward impulse, a shallow descending channel and a breakout.
    for(let length=5;length<=12;length++){
      const start=n-length, flag=b.slice(start,n), pole=b.slice(start-5,start);
      if(pole.length!==5) continue;
      const impulse=pole.at(-1).c-pole[0].o;
      if(impulse<vol*3 || pole.filter(k=>body(k)>0).length<3) continue;
      const split=Math.floor(length/2);
      const first=flag.slice(0,split), last=flag.slice(split);
      const hi1=Math.max(...first.map(k=>k.h)), hi2=Math.max(...last.map(k=>k.h));
      const lo1=Math.min(...first.map(k=>k.l)), lo2=Math.min(...last.map(k=>k.l));
      if(hi1-hi2<vol*0.2 || lo1-lo2<vol*0.15 || Math.abs((hi1-hi2)-(lo1-lo2))>vol*0.8 ||
        pole.at(-1).c-lo2>impulse*0.55 || average(flag.map(k=>k.v))>=average(pole.map(k=>k.v))*0.9) continue;
      if(crossed(()=>hi2) && c.c>hi1-vol*0.25){claim(names[12],hi2);break;}
    }
  }
}

function matchPatterns(bars, levels) {
  if(bars.length<10) return {up:[],down:[]};
  return Object.fromEntries(['up','down'].map(side=>{
    const found=candleHits(bars,side);
    structureHits(bars,side,found,levels?(levels[side]={}):null);
    return [side,sides[side].filter(name=>found.has(name))];
  }));
}

module.exports={matchPatterns,sides};
