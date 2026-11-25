'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const E = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (v,d) => {
    if(v===null||v===undefined||!Number.isFinite(+v))return '—';
    const x=+v,dec=d??(Math.abs(x)>=1000?2:Math.abs(x)>=100?3:Math.abs(x)>=1?4:Math.abs(x)>=.01?5:8);
    return x.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:dec});
  };
  const pct=(v,d=2)=>v===null||v===undefined?'—':`${+v>=0?'+':''}${fmt(v,d)}%`;
  const money=v=>{if(!Number.isFinite(+v))return '—';const x=+v;
    return Math.abs(x)>=1e9?`${fmt(x/1e9,2)}B`:Math.abs(x)>=1e6?`${fmt(x/1e6,2)}M`:Math.abs(x)>=1e3?`${fmt(x/1e3,1)}K`:fmt(x,0);
  };
  const clock=t=>t?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'—';
  const dateTime=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'—';
  const dirClass=d=>d==='up'?'up':d==='down'?'down':'neutral';
  const store={snapshot:null,detail:null,selected:'BTCUSDT',filter:'all',query:'',view:'radar',running:false,
    refreshPending:false,lastDetailTime:0,lastSnapshotTime:0,connectionFailures:0};
  const FAVORITES_KEY='contract-lens-pro-favorites-v1';
  function savedFavorites(){
    try {const data=JSON.parse(localStorage.getItem(FAVORITES_KEY)||'[]');
      return new Set(Array.isArray(data)?data.filter(x=>typeof x==='string'&&/^[A-Z0-9:_-]{3,60}$/.test(x)):[]);
    } catch {return new Set()}
  }
  store.favorites=savedFavorites();
  store.venue='all';store.visibleLimit=150;
  // PRO_FAVORITE_SNAPSHOTS_V2: keep original symbol array for backwards compatibility.
  const FAVORITES_META_KEY='contract-lens-pro-favorites-snapshot-v1';
  function loadFavoriteSnapshots(){
    try {
      const saved=JSON.parse(localStorage.getItem(FAVORITES_META_KEY)||'{}');
      if(!saved||typeof saved!=='object'||Array.isArray(saved))return {};
      const result={};
      for(const [sym,row] of Object.entries(saved)){
        if(!store.favorites.has(sym)||!row||typeof row!=='object')continue;
        const time=Number(row.savedAt),price=Number(row.price),strength=Number(row.strength);
        result[sym]={
          savedAt:Number.isFinite(time)&&time>0?time:null,
          price:row.price!==null&&Number.isFinite(price)&&price>0?price:null,
          direction:row.direction==='up'||row.direction==='down'?row.direction:'flat',
          strength:row.strength!==null&&Number.isFinite(strength)&&strength>=0&&strength<=100?strength:null,
          signalObserved:row.signalObserved===true
        };
      }
      return result;
    }catch{return {}}
  }
  store.favoriteSnapshots=loadFavoriteSnapshots();
  // PRO_FAVORITE_DIFFERENCE_V3:
  // A fixed-price quote difference, sampled only once every 180 seconds.
  store.favoriteDifferences={};
  store.favoriteDifferenceUpdatedAt=0;
  const FAVORITE_DIFFERENCE_INTERVAL=180000;
  function computeFavoriteDifference(m){
    const saved=store.favoriteSnapshots[m.symbol];
    const purchase=Number(saved?.price);
    const current=Number(m.price);
    if(!saved||saved.price===null||!Number.isFinite(purchase)||purchase<=0||
       !Number.isFinite(current)||current<=0||m.stale)return null;
    return {amount:Number((purchase-current).toPrecision(13)),at:Date.now(),quotedPrice:current};
  }
  function refreshFavoriteDifferences(symbols){
    const now=Date.now();
    const due=!store.favoriteDifferenceUpdatedAt||now-store.favoriteDifferenceUpdatedAt>=FAVORITE_DIFFERENCE_INTERVAL;
    if(due)store.favoriteDifferenceUpdatedAt=now;
    for(const m of symbols){
      if(!store.favorites.has(m.symbol))continue;
      if(due||!Object.prototype.hasOwnProperty.call(store.favoriteDifferences,m.symbol)){
        store.favoriteDifferences[m.symbol]=computeFavoriteDifference(m);
      }
    }
  }
  function favoriteDifferenceLabel(amount){
    if(!Number.isFinite(amount))return '暂无';
    const n=Math.abs(amount);
    const decimals=n>=1?6:n>=.01?8:n>=.0001?10:12;
    const rounded=Number(n.toFixed(decimals));
    return (rounded===0?'':amount<0?'-':amount>0?'+':'')+fmt(rounded,decimals);
  }
  function renderFavoriteSnapshot(m){
    const entry=store.favoriteSnapshots[m.symbol];
    if(!entry)return '<div class="favorite-snapshot legacy">旧收藏未记录当时数据，取消★后重新收藏即可保存。</div>';
    const at=entry.savedAt?new Date(entry.savedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'未记录';
    const direction=entry.signalObserved?(entry.direction==='up'?'偏多':'偏空'):'观望/未确认';
    const level=entry.signalObserved&&entry.strength!==null?fmt(entry.strength,0)+'/100':'—';
    const price=entry.price!==null?fmt(entry.price)+' '+(m.quoteAsset||'USDT'):'未能确认';
    const color=entry.signalObserved?dirClass(entry.direction):'neutral';
    const spread=store.favoriteDifferences[m.symbol];
    const spreadValid=spread&&Number.isFinite(spread.amount);
    const spreadText=spreadValid?favoriteDifferenceLabel(spread.amount)+' '+(m.quoteAsset||'USDT'):'数据不足/行情延迟';
    const spreadAt=spreadValid?new Date(spread.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'—';
    return '<div class="favorite-snapshot">'+
      '<div class="favorite-snapshot-line"><span>收藏时间</span><strong>'+E(at)+'</strong></div>'+
      '<div class="favorite-snapshot-line"><span>收藏信号</span><strong class="'+color+'">'+E(direction)+'</strong><em>强度 '+E(level)+'</em></div>'+
      '<div class="favorite-snapshot-line"><span>收藏价格</span><strong>'+E(price)+'</strong></div>'+
      '<div class="favorite-snapshot-line favorite-price-difference"><span>与现价相差</span><strong>'+E(spreadText)+'</strong></div>'+
      '<div class="favorite-difference-time">每3分钟更新一次 · 上次计算 '+E(spreadAt)+'</div>'+
      '</div>';
  }
  function toggleFavorite(symbol){
    if(store.favorites.has(symbol)){
      store.favorites.delete(symbol);
      delete store.favoriteSnapshots[symbol];
      delete store.favoriteDifferences[symbol];
    }else{
      const m=store.snapshot?.symbols?.find(row=>row.symbol===symbol);
      const observed=!!m?.matches?.length&&(m.direction==='up'||m.direction==='down');
      const price=Number(m?.price);
      store.favorites.add(symbol);
      delete store.favoriteDifferences[symbol];
      store.favoriteSnapshots[symbol]={
        savedAt:Date.now(),price:m&&!m.stale&&Number.isFinite(price)&&price>0?price:null,
        direction:observed?m.direction:'flat',strength:observed&&Number(m.strength)>0?Number(m.strength):null,
        signalObserved:observed
      };
    }
    try{
      localStorage.setItem(FAVORITES_KEY,JSON.stringify([...store.favorites]));
      localStorage.setItem(FAVORITES_META_KEY,JSON.stringify(store.favoriteSnapshots));
    }catch{}
    renderMarkets();
  }
  function setView(name){
    store.view=name;
    for(const n of ['radar','alerts','stats','paper','method'])$(n+'View').classList.toggle('hidden',name!==n);
    document.querySelectorAll('.nav-link').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===name));
    $('pageBreadcrumb').textContent={radar:'实时雷达',alerts:'预警记录',stats:'验证统计',paper:'模拟下单确认项',method:'数据与规则'}[name];
    if(name==='alerts')renderAlerts();if(name==='stats')renderStats();if(name==='paper')void refreshPaper();
  }
  async function get(url){const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),16000);
    try{const r=await fetch(url,{signal:ctrl.signal,cache:'no-store'});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }finally{clearTimeout(t)}
  }
  function sourcePill(id,status){
    const el=$(id),ready=!!status?.ws;
    el.className='dot-label '+(ready?'online':status?.error?'offline':'');
    el.innerHTML=`<i class="status-dot"></i>${ready?'实时在线':status?.error?'连接失败':'连接中'}`;
  }
  function showConnection(snapshot){
    const b=snapshot.sources.binance,o=snapshot.sources.okx;
    sourcePill('binancePill',{...b,ws:b.ws||b.rest});sourcePill('okxPill',{...o,ws:o.rest});
    const c=snapshot.counts;
    $('topConnection').textContent=c.ready?'15 / 30分钟形态扫描中':'正在加载交易所K线';
    $('connectionBanner').className='status-banner '+(c.ready?'ok':'');
    $('connectionText').textContent='已加载 '+c.loaded+' / '+c.eligible+' 个合约的历史K线，'+c.ready+' 个至少有一个周期可扫描。';
  }
  function renderCounts(s){
    const c=s.counts;
    $('countTotal').textContent=c.eligible||'—';$('countEarly').textContent=c.up;
    $('countConfirm').textContent=c.down;$('countReady').textContent=c.ready;
    $('countSplit').textContent=`币安U ${c.venues?.binance||0} · 币本位 ${c.venues?.coin||0} · 欧易永续 ${c.venues?.okxSwaps||0} · 欧易交割 ${c.venues?.okxFutures||0}`;
    $('scannedNum').textContent=c.loaded||0;
    $('scanCopy').textContent=`${c.loaded}/${c.eligible||'—'} 历史已加载`;
    $('scanProgress').style.width=c.eligible?`${Math.min(100,c.loaded/c.eligible*100)}%`:'0%';
    $('pollTime').textContent=s.lastAnalysis?clock(s.lastAnalysis):'初始化中';
    $('navCount').textContent=c.eligible||'—';
  }
  function sortMarkets(list){return list.sort((a,b)=>{
    const rank=x=>x.matches?.length?2:x.historyReady?1:0;
    return rank(b)-rank(a)||b.quoteVolume24h-a.quoteVolume24h;
  })}
  function activityLabel(m){
    const a=m.activity;
    if(!a||Date.now()-a.end>305000)return '盘中资金活跃度 · 等待5分钟数据';
    return '盘中资金活跃度 · '+E(a.level)+' · '+clock(a.end);
  }
  function renderMarkets(){
    const data=store.snapshot;
    if(!data)return;
    const filter=store.filter,q=store.query;
    const all=sortMarkets(data.symbols.filter(m=>(!q||(m.symbol+' '+(m.displaySymbol||'')).toLowerCase().includes(q))&&
      (store.venue==='all'||store.venue==='binance'&&m.exchange==='binance'||
       store.venue==='coin'&&m.exchange==='coin'||store.venue==='okx'&&m.exchange==='okx'||
       store.venue==='okxSwap'&&m.exchange==='okx'&&m.contractType==='SWAP'||
       store.venue==='okxFutures'&&m.exchange==='okx'&&m.contractType==='FUTURES')&&
      (filter==='all'||filter==='favorites'&&store.favorites.has(m.symbol)||
       filter==='multiple'&&(m.matches??[]).reduce((count,hit)=>count+hit.names.length,0)>=2||
       filter==='reviewed'&&m.review?.status==='passed'||
       filter==='selected'&&m.selected&&!m.stale||
       filter==='twenty'&&m.twenty?.reviewed||
       ['up','down'].includes(filter)&&m.matches?.some(hit=>hit.direction===filter))));
    if(filter==='favorites'){
      refreshFavoriteDifferences(data.symbols);
      all.sort((a,b)=>{
        const x=store.favoriteDifferences[a.symbol]?.amount;
        const y=store.favoriteDifferences[b.symbol]?.amount;
        const hasX=Number.isFinite(x),hasY=Number.isFinite(y);
        if(hasX!==hasY)return hasX?-1:1;
        if(hasX&&hasY&&Math.abs(x)!==Math.abs(y))return Math.abs(y)-Math.abs(x);
        return a.symbol.localeCompare(b.symbol);
      });
    }
    const el=$('marketList'),scroll=el.scrollTop;
    const visible=all.slice(0,store.visibleLimit);
    $('loadMoreMarkets').hidden=all.length<=store.visibleLimit;
    $('loadMoreMarkets').textContent='加载更多 · '+visible.length+'/'+all.length;
    if(!all.length){el.innerHTML=filter==='favorites'?`<div class="empty-state"><span class="empty-icon">☆</span><strong>${store.favorites.size?'自选合约暂未匹配':'自选列表还是空的'}</strong><p>到“全部候选”，点击币种旁边的 ☆ 加入自选。点击 ★ 可取消。自选仅用于关注，不代表交易信号。</p></div>`:`<div class="empty-state"><span class="empty-icon">⌕</span><strong>${data.counts.eligible?'暂时没有符合筛选的合约':'正在加载行情'}</strong><p>${filter==='selected'?'等待同向多形态、5分钟回踩或反抽确认，以及扣除成本后仍有足够空间的合约。':filter==='twenty'?'等待15分钟形态、5分钟回踩／反抽收盘确认及30分钟方向检查。':filter==='reviewed'?'通过位置、回踩和成交复核的合约会显示在这里。':filter==='multiple'?'当前命中至少两个形态信号的合约会显示在这里。':'最新收盘的15分钟或30分钟K线命中后显示。'}</p></div>`;}
    else el.innerHTML=visible.map(m=>{
      const name=m.displaySymbol||m.symbol;
      const quote=m.quoteAsset||'USDT';
      const d=['up','down'].includes(filter)?filter:m.direction;
      const label=d==='up'?'看多':d==='down'?'看空':d==='mixed'?'多空均命中':m.phase;
      return `<div class="market-row ${m.symbol===store.selected?'selected':''}" data-symbol="${E(m.symbol)}" role="button" tabindex="0" aria-label="查看 ${E(name)} 合约分析">
        <div><div class="market-name">${E(name)}<small>/ ${E(quote)}</small><button type="button" class="favorite-toggle ${store.favorites.has(m.symbol)?'on':''}" data-favorite="${E(m.symbol)}" aria-pressed="${store.favorites.has(m.symbol)}" aria-label="${store.favorites.has(m.symbol)?'移出':'加入'}自选：${E(name)}" title="${store.favorites.has(m.symbol)?'取消自选':'加入自选'}">${store.favorites.has(m.symbol)?'★':'☆'}</button></div><div class="market-sub">${E(m.exchangeLabel||"币安U本位")} · ${E(m.contractType==="PERPETUAL"||m.contractType==="SWAP"?"永续":"交割")}</div>${patternTags(m,['up','down'].includes(filter)?filter:null)}<div class="market-sub">${activityLabel(m)}</div><div class="market-flow">${flowLabel(m)}${m.flow?.partial?' · 部分成交':''}</div>${filter==='selected'&&m.selected?`<div class="review-summary passed">5分钟确认 · 扣成本后空间 / 风险 ${fmt(m.selected.ratio,2)} 倍 · 点差 ${fmt(m.selected.spreadPct,3)}%</div>`: ''}${m.twenty?`<div class="review-summary ${m.twenty.reviewed?'passed':E(m.twenty.status)}">20分钟方案 · ${E(m.twenty.reason)}</div>`:''}${m.review?`<div class="review-summary ${E(m.review.status)}">${E(m.review.reason)} · ${m.review.distinct} 个不同形态${m.review.duplicate?' · 双周期同形态':''}</div>`:''}${filter==='favorites'?renderFavoriteSnapshot(m):''}</div>
        <div><div class="market-price">${fmt(m.price)}</div><div class="market-change ${m.change24h>=0?'green':'red'}">${pct(m.change24h)}</div></div>
        <div class="market-side"><div class="direction-label ${dirClass(d)}">${label}</div></div>
      </div>`;
    }).join('');
    el.scrollTop=scroll;
    $('listCount').textContent=filter==='favorites'?`显示 ${visible.length} / ${store.favorites.size} 只自选合约`:`显示 ${visible.length} / 筛选结果 ${all.length} / 已收录 ${data.counts.eligible} 个合约`;
    $('favCount').textContent=store.favorites.size;
    $('clearFavoritesWrap').hidden=filter!=='favorites';
    $('clearFavorites').disabled=store.favorites.size===0;
    $('clearFavorites').textContent='清空全部自选（'+store.favorites.size+'）';
  }
  
  function patternTags(m,side){
    return (m.matches||[]).filter(hit=>!side||hit.direction===side)
      .map(hit=>'<div class="pattern-tags"><span class="pattern-period">'+hit.period+'分钟 · '+
        (hit.direction==='up'?'看多':'看空')+'</span>'+hit.names.map(name=>'<span class="pattern-chip '+dirClass(hit.direction)+'">'+E(name)+'</span>').join('')+'</div>').join('');
  }
  function flowLabel(m){
    if(!m.flow)return '主动买 — / 主动卖 —';
    const flow=m.flow;
    return '主动买 '+fmt(flow.buyPct,1)+'% / 主动卖 '+fmt(flow.sellPct,1)+'%';
  }
  function renderAlerts(){
    const rows=store.snapshot?.alerts||[];
    const render=items=>items.length?items.map(s=>'<div class="alert-item"><div class="alert-name">'+
      E(s.displaySymbol||s.symbol)+' <small>'+E(s.exchangeLabel)+'</small></div><div class="alert-meta">'+
      dateTime(s.closedAt)+' 收盘</div><div class="alert-why">'+s.period+'分钟 · '+
      (s.direction==='up'?'看多':'看空')+' · '+E(s.names.join('、'))+'</div><div class="alert-result">'+
      (s.result?'下根收盘变化 '+pct(s.result.change,3):'待下一根收盘')+'</div></div>').join('')
      :'<div class="empty-mini">正在等待形态命中。</div>';
    $('recentAlerts').innerHTML=render(rows.slice(0,6));
    $('allAlerts').innerHTML=render(rows);
  }
  function renderTwentyStats(){
    const groups=store.snapshot?.comparison20;
    const labels={base20:'15分钟形态',confirm20:'15＋5分钟收盘确认',filtered20:'15＋5＋30分钟方向检查'};
    $('twentyStats').innerHTML=groups?Object.entries(labels).map(([key,title])=>{
      const row=groups[key];
      return `<div class="stat-card"><div class="stat-name">${title}</div>
        <div class="review-windows">${successWindows(row)}</div>
        <div class="stat-note">平均净收益 ${pct(row.windows[0].net,3)}</div>
        <div class="stat-note">前5分钟平均最大逆向 ${row.adverse==null?'—':fmt(row.adverse,3)+'%'}（${row.paths}笔）</div>
        ${key!=='base20'?`<div class="stat-note">可对照 ${row.baseline} 笔 · 未纳入 ${row.missed} 笔</div>
        <div class="stat-note">未纳入中，原本盈利 ${row.missedWins} 笔 · 先逆向≥0.3%且15分钟内未覆盖假定成本 ${row.missedAdverse} 笔</div>`:''}</div>`;
    }).join(''):'';
  }
  function renderStats(){
    renderTwentyStats();
    const rows=store.snapshot?.stats||[];
    const groups=store.snapshot?.reviewStats;
    const labels={single:'单形态',multiple:'同向多个不同形态',conflict:'多空冲突',reviewed:'通过复核'};
    $('reviewStats').innerHTML=groups?Object.entries(labels).map(([key,title])=>{
      const g=groups[key];
      return `<div class="stat-card"><div class="stat-name">${title}</div>
        <div class="review-windows">${successWindows(g)}</div>
        <div class="stat-note">前5分钟平均最大逆向 ${g?.adverse==null?'—':fmt(g.adverse,3)+'%'}（${g?.paths||0} 笔）</div>
        <div class="stat-note">先逆向0.3%且15分钟未覆盖假定交易成本 ${g?.unrecovered||0} 笔</div>
        <div class="stat-note">平均净收益 15分 ${pct(g?.windows[0].net)} · 30分 ${pct(g?.windows[1].net)}</div>
      </div>`;
    }).join(''):'';

    $('statsNote').textContent='按形态所在周期，比较信号K线与下一根K线的收盘价，用于观察方向是否一致。';
    $('statsCards').innerHTML=rows.map(s=>'<div class="stat-card"><div class="stat-name">'+s.period+
      '分钟</div><div class="stat-rate">'+(s.samples?fmt(s.aligned/s.samples*100,1)+'%':'暂无样本')+
      '</div><div class="stat-note">同向 '+s.aligned+' / '+s.samples+' 条 · 待观察 '+s.pending+' 条</div></div>').join('');
  }
function drawCandles(candles){
    const cv=$('candleChart');if(!cv)return;
    const host=cv.parentElement,rect=cv.getBoundingClientRect();
    if(!rect.width)return;
    const DPR=Math.min(window.devicePixelRatio||1,2),w=Math.max(rect.width,100),h=194;
    cv.width=Math.floor(w*DPR);cv.height=Math.floor(h*DPR);
    const ctx=cv.getContext('2d');ctx.scale(DPR,DPR);
    ctx.clearRect(0,0,w,h);
    const data=candles.slice(-52).filter(x=>Number.isFinite(x.c));
    if(data.length<15){ctx.fillStyle='#859b89';ctx.font='12px sans-serif';
      ctx.fillText('正在获取历史K线数据…',16,h/2);return;}
    const chartTop=8,chartH=130,volumeBase=182,volH=28;
    const min=Math.min(...data.map(x=>x.l)),max=Math.max(...data.map(x=>x.h));
    const range=Math.max(max-min,max*.0003),scaleY=p=>chartTop+chartH-(p-min)/range*chartH;
    const itemW=w/data.length,width=Math.max(1,Math.min(7,itemW*.60));
    ctx.strokeStyle='#253d30';ctx.lineWidth=.7;
    for(let i=0;i<4;i++){const y=chartTop+i*chartH/3;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
    const topVolume=Math.max(...data.map(x=>x.v),1);
    data.forEach((x,i)=>{
      const center=(i+.5)*itemW,up=x.c>=x.o,col=up?'#87dca5':'#ed8e88';
      ctx.strokeStyle=col;ctx.fillStyle=col;
      ctx.beginPath();ctx.moveTo(center,scaleY(x.h));ctx.lineTo(center,scaleY(x.l));ctx.stroke();
      const cy=Math.min(scaleY(x.o),scaleY(x.c)),height=Math.max(1.1,Math.abs(scaleY(x.o)-scaleY(x.c)));
      ctx.fillRect(center-width/2,cy,width,height);
      ctx.fillStyle=up?'#416f4d':'#77463d';
      ctx.fillRect(center-width/2,volumeBase-x.v/topVolume*volH,width,x.v/topVolume*volH);
    });
    function drawMA(period,color){
      if(data.length<period)return;
      ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.3;
      for(let i=period-1;i<data.length;i++){
        const v=data.slice(i-period+1,i+1).reduce((n,k)=>n+k.c,0)/period;
        const x=(i+.5)*itemW,y=scaleY(v);
        if(i===period-1)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }ctx.stroke();
    }
    drawMA(7,'#ddba7c');drawMA(25,'#a4a6e7');
    ctx.fillStyle='#6c8978';ctx.font='10px sans-serif';ctx.textAlign='right';
    ctx.fillText(fmt(max),w-5,11);ctx.fillText(fmt(min),w-5,chartTop+chartH+9);
  }
  function successWindows(result){
    return (result?.windows||[]).map(row=>`<div class="review-window">
      <span>${row.period}分钟后</span>
      <strong>${row.rate===null?'样本不足':fmt(row.rate,1)+'%'}</strong>
      <small>净收益为正 ${row.wins} / ${row.samples} 笔</small></div>`).join('');
  }
  function contractReview(d){
    const result=d.review;
    const success=d.success;
    const checks=result?result.hits.filter(h=>h.setup).map(h=>`<div class="review-prices">
      <strong>${h.period}分钟 · ${h.direction==='up'?'看多':'看空'}</strong>
      <span>确认价 ${fmt(h.setup.key)}</span>
      <span>现价距确认价 ${d.stale||!(d.price>0)?'—':pct((d.price/h.setup.key-1)*100)}</span>
      <span>失效位 ${fmt(h.setup.invalid)}</span>
      <span>下一个压力／支撑 ${fmt(h.setup.obstacle)}</span></div>`).join(''):'';
    return `
      ${result?`<div class="detail-section-title">位置与成交复核</div>
      <div class="review-summary ${E(result.status)}">${E(result.reason)} · ${result.distinct} 个不同形态${result.duplicate?' · 双周期同形态':''}${result.spread!=null?' · 点差 '+fmt(result.spread,3)+'%':''}</div>
      ${result.flowNote?`<div class="market-sub">${E(result.flowNote)}</div>`:''}
      ${checks}`:''}
      <div class="detail-section-title">该合约模拟成功率</div>
      <div class="review-windows">${successWindows(success)}</div>
      <div class="market-sub">取各信号首次可见的新鲜报价模拟。20分钟一档使用15分钟原始信号。净收益为正计成功，每档至少20笔结算后显示百分比。</div>
      ${success?.paths?`<div class="market-sub">前5分钟已观测的平均最大逆向波动 ${fmt(success.adverse,3)}% · 先逆向0.3%且15分钟内未观测到覆盖假定交易成本 ${success.unrecovered} 笔</div>`:''}
      ${success?.fundingUnknown?`<div class="market-sub">资金费数据待核或缺失 ${success.fundingUnknown} 笔，未计入成功率。</div>`:''}`;
  }
  function twentyDetail(d){
    const assessment=d.twenty;
    if(!assessment)return '';
    return `<div class="detail-section-title">持仓20分钟方案</div>
      <div class="review-summary ${assessment.reviewed?'passed':E(assessment.status)}">${E(assessment.reason)}</div>
      ${assessment.key?`<div class="review-prices"><span>15分钟确认价 ${fmt(assessment.key)}</span>
        <span>失效位 ${fmt(assessment.invalid)}</span>
        <span>下一道压力／支撑 ${fmt(assessment.obstacle)}</span></div>`:''}
      ${assessment.confirmedAt?`<div class="market-sub">5分钟收盘确认 ${clock(assessment.confirmedAt)}</div>`:''}`;
  }
  function renderDetail(){
    const d=store.detail;
    if(!d)return;
    const period=store.chartPeriod===5&&!d.charts?.[5]?.length?15:store.chartPeriod||15;
    $('detailTitle').textContent=(d.displaySymbol||d.symbol)+' · '+(d.exchangeLabel||'');
    $('detailTag').textContent=d.phase;
    $('detailTag').className='signal-tag '+dirClass(d.direction);
    const source=d.exchange==='okx'?'欧易主动成交张数':'币安K线主动成交量';
    const flow=d.flow;
    const flowNote=flow?(flow.partial?'当前15分钟 · 欧易只计本次连接收到的成交':'当前15分钟K线开盘至今'):'当前15分钟暂无可验证的主动成交';
    $('detailBody').innerHTML=`
      <div class="detail-quote"><div><div class="big-price">${fmt(d.price)} <small>${E(d.quoteAsset)}</small></div>
      <div class="quote-sub">24H ${pct(d.change24h)} · 报价 ${d.stale?'延迟 · ':''}${clock(d.priceAt)}</div></div></div>
      <div class="detail-section-title">已命中形态</div>
      ${patternTags(d)||'<div class="empty-mini">当前收盘K线暂无形态命中。</div>'}
      ${twentyDetail(d)}
      ${contractReview(d)}
      <div class="detail-section-title">主动买卖占比 <span>${source}</span></div>
      ${flow?`<div class="orderbar"><div class="buy" style="width:${flow.buyPct}%"></div><div class="sell"></div></div>`:''}
      <div class="market-sub">${activityLabel(d)}</div><div class="market-flow">${flowLabel(d)}</div><div class="market-sub">${flowNote}</div>
      <div class="chart-frame"><div class="chart-head"><span>已收盘K线</span>
        <div class="period-switch">${(d.charts?.[5]?.length?[5,15,30]:[15,30]).map(p=>`<button type="button" data-period="${p}" aria-pressed="${p===period}">${p}分钟</button>`).join('')}</div></div>
        <canvas id="candleChart" role="img" aria-label="${period}分钟K线"></canvas></div>`;
    requestAnimationFrame(()=>drawCandles(d.charts?.[period]||[]));
  }
  $('detailBody').addEventListener('click',event=>{
    const control=event.target.closest('[data-period]');
    if(!control)return;
    store.chartPeriod=Number(control.dataset.period);
    renderDetail();
  });
  let paperLoading=false;
  const moneyU=n=>fmt(n,2)+' U';
  function orderPanel(p,closed){
    const title=p.side===1?'模拟做多':'模拟做空';
    const status=closed?p.exit.reason:p.exit?'已退出 · 待核资金费':p.delayed?'已到期 · 等待可成交盘口':'模拟持仓中';
    return `<article class="paper-order">
      <div class="paper-order-header"><strong>${E(p.displaySymbol||p.symbol)}</strong>
        <span class="${p.side===1?'up':'down'}">${title} · ${E(p.exchangeLabel||p.exchange)}</span></div>
      <div class="market-sub">${p.allMultiple?'多个信号确认项 · ':p.trialId?'一轮试单 · ':''}${E(p.names.join('、'))}${p.sample?' · 同方向历史样本 '+p.sample.wins+'/'+p.sample.samples:''}</div>
      ${p.id.startsWith('reverse-')?'<div class="market-sub">原信号'+(p.signalDirection==='up'?'看涨':'看跌')+' · 反向成交</div>':''}
      <div class="paper-fields">
        <span>开仓 ${dateTime(p.start)}</span><span>名义仓位 ${moneyU(p.notional)}</span><span>成交均价 ${fmt(p.entry)}</span>
        <span>${E(status)}${p.exit?' · '+dateTime(p.exit.at):''}</span>
        <span>${p.exit?'退出均价 '+fmt(p.exit.price):'最新估算退出价 '+fmt(p.mark)}</span>
        <span>已观测最大逆向 ${fmt(p.mae*100,3)}%</span>
        <span>前1分钟 ${p.firstMinuteSamples?fmt(p.firstMinuteMae*100,3)+'%':'—'} · 前5分钟 ${p.firstSamples?fmt(p.firstMae*100,3)+'%':'—'}</span>
        ${closed?`<span>手续费 ${moneyU(p.exit.tradingFees)} · 资金费 ${moneyU(p.fundingCost)}</span>
          <strong class="${p.net>0?'up':'down'}">净盈亏 ${moneyU(p.net)} · 保证金回报 ${pct(p.marginReturn)}</strong>`:
          `<strong>浮动盈亏 ${p.floating==null?'—':moneyU(p.floating)}</strong>`}
      </div></article>`;
  }
  async function refreshPaper(){
    if(paperLoading)return;
    paperLoading=true;
    try{
      const data=await get('/api/paper');
      const s=data.stats;
      const c=data.config;
      $('paperCapital').textContent=(data.reverse?'反向模拟本金 '+moneyU(c.capital):'累计投入 '+moneyU(c.capital)+' · 追加 '+moneyU(data.capitalTopUp||0))+
        ' · 每笔保证金 '+moneyU(c.margin)+' · '+c.leverage+' 倍 · '+c.holdMin+' 分钟到期 · 最多 '+c.maxPositions+' 笔并行';
      $('paperSummary').innerHTML=[
        ['账面余额',moneyU(data.balance)],['可用余额',moneyU(data.available)],['占用保证金',moneyU(data.locked)],
        ['已结算净盈亏',moneyU(s.net)],['盈利 / 已结算',s.wins+' / '+s.count],
        ['前5分钟逆向≥0.3%',s.paths?s.fastAdverse+' / '+s.paths:'样本不足']
      ].map(([label,value])=>`<div class="stat-card"><div class="stat-name">${label}</div><div class="stat-rate">${value}</div></div>`).join('');
      const count=data.funnel;
      const trial=data.trial;
      const trialOpen=trial?data.open.filter(p=>p.trialId===trial.id).length:0;
      const trialClosed=trial?data.closed.filter(p=>p.trialId===trial.id):[];
      const trialNet=trialClosed.reduce((sum,p)=>sum+p.net,0);
      $('paperTrial').textContent=trial?'一轮试单 · 多个同向形态直接按盘口模拟 · '+
        (Date.now()<trial.entryUntil?'正在选单':'已结束选单')+' · 已开 '+trial.entered+' 笔 · 待结算 '+trialOpen+
        ' 笔 · 已结算 '+trialClosed.length+' 笔'+(trialClosed.length?' · 净盈亏 '+moneyU(trialNet):''):'';
      $('paperStatus').textContent=data.loadError||'后台最近扫盘 '+clock(data.lastRun)+' · USDT合约通过20分钟确认 '+count.confirmed+
        ' 只 · 至少两个同向形态 '+count.multiple+' 只 · 达样本门槛 '+count.qualified+' 只';
      $('paperRule').textContent=data.multiple?
        '自动模拟「多个信号确认项」里的同向合约。只使用可按 USDT 线性合约模型成交的盘口。':
        '自动单需通过20分钟确认，至少两个不同的同向形态。每个合约同方向至少20笔验证样本、净盈利率≥55%且平均净收益为正。';
      if(data.multiple){
        const labels={conflict:'多空冲突 · 跳过',unsupported:'当前未支持此合约的保证金结算方式',
          ready:'等待尝试成交',open:'已模拟开仓或待结算',done:'本信号已模拟',
          capacity:'等待可用保证金或仓位',book:'等待有效盘口',depth:'盘口深度不足 · 等待重试'};
        $('paperStatus').textContent=data.loadError||'后台最近扫盘 '+clock(data.lastRun)+' · 同向模拟运行中 · '+
          '当前候选 '+data.multiple.filter(row=>row.status!=='conflict').length+' 只';
        $('paperCandidates').innerHTML=data.multiple.length?'<h3>当前筛选</h3>'+data.multiple.map(row=>
          '<div class="empty-mini"><strong>'+E(row.displaySymbol||row.symbol)+'</strong> · '+E(row.exchangeLabel||'')+
          ' · '+E(labels[row.status]||row.status)+'</div>').join(''):'';
      }
      if(data.stoppedAt){
        $('paperRule').textContent='模拟盘已停止开新仓。剩余持仓按最新可成交盘口退出。';
        $('paperStatus').textContent=data.open.length?'模拟盘已停止开仓 · '+data.open.length+' 笔待完成退出或结算':
          '模拟盘已停止 · 所有持仓已结算';
      }
      if(data.reverse){
        $('paperRule').textContent='从「多个信号确认项」取方向一致的合约。原信号看涨模拟做空，原信号看跌模拟做多。';
        $('paperStatus').textContent=data.loadError||'反向模拟运行中 · 后台最近扫盘 '+clock(data.lastRun);
      }
      $('paperOpen').innerHTML=data.open.length?data.open.map(p=>orderPanel(p,false)).join(''):
        '<div class="empty-mini">'+(data.multiple?'暂无模拟持仓，等待同向候选和有效盘口。':
          '暂无模拟持仓，等待形态、样本和盘口满足条件。')+'</div>';
      $('paperClosed').innerHTML=data.closed.length?data.closed.map(p=>orderPanel(p,true)).join(''):
        '<div class="empty-mini">暂无已结算的模拟订单。</div>';
      $('paperNotes').innerHTML=data.notes.map(n=>'<li>'+E(n)+'</li>').join('');
      $('paperStorage').textContent=data.durable?'':'当前账本保存在服务运行磁盘，服务重新部署时可能重置。';
    }catch(e){
      $('paperStatus').textContent='暂时无法读取后台模拟账本，稍后自动重试。';
    }finally{paperLoading=false;}
  }
  async function updateSnapshot(){
    if(store.refreshPending)return;
    store.refreshPending=true;
    try{
      const s=await get('/api/snapshot');store.snapshot=s;store.lastSnapshotTime=Date.now();
      store.connectionFailures=0;
      try{
        showConnection(s);renderCounts(s);renderMarkets();renderAlerts();renderStats();
      }catch(uiError){
        console.error('PRO_UI_RENDER_ERROR',uiError);
        const detail=String(uiError?.message||uiError).slice(0,160);
        $('topConnection').textContent='行情接口在线 · 页面显示有异常';
        $('connectionBanner').className='status-banner error';
        $('connectionText').textContent='行情接口已返回数据，但网页显示出现异常：'+detail+'。请关闭页面后重新打开。';
        void fetch('/api/ui-error?message='+encodeURIComponent(detail),{cache:'no-store'}).catch(()=>{});
        return;
      }
      if(!s.symbols.some(x=>x.symbol===store.selected)&&s.symbols.length){store.selected=s.symbols[0].symbol;store.lastDetailTime=0}
      if(store.view==='radar'&&Date.now()-store.lastDetailTime>4500)updateDetail();
    }catch(e){
      store.connectionFailures++;
      console.warn('PRO_API_POLL_FAILURE',e);
      const staleFor=Date.now()-(store.lastSnapshotTime||0);
      const definitelyDown=store.connectionFailures>=2&&staleFor>15000;
      $('topConnection').textContent=definitelyDown?'行情接口暂时不可用':'行情请求波动 · 自动重试中';
      $('connectionBanner').className='status-banner '+(definitelyDown?'error':'');
      $('connectionText').textContent=definitelyDown?
        '连续请求行情接口失败：'+String(e?.message||e).slice(0,120)+'。正在重试，数据未确认时不发布信号。':
        '临时网络波动：'+String(e?.message||e).slice(0,120)+'。正在重试，稍后可刷新网页。';
      sourcePill('binancePill',{error:e.message});sourcePill('okxPill',{error:e.message});
      if(store.snapshot&&staleFor>30000){
        const pause=m=>({...m,stale:true,selected:null,matches:[],flow:null,review:null,twenty:null,direction:'neutral',phase:'行情待更新'});
        store.snapshot={...store.snapshot,symbols:store.snapshot.symbols.map(pause),
          counts:{...store.snapshot.counts,ready:0,up:0,down:0}};
        renderCounts(store.snapshot);renderMarkets();
        if(store.detail){store.detail=pause(store.detail);renderDetail();}
      }
    }finally{store.refreshPending=false}
  }
  async function updateDetail(){
    if(!store.snapshot?.symbols?.length)return;
    const symbol=store.selected;
    try{
      const v=await get(`/api/detail?symbol=${encodeURIComponent(symbol)}`);
      if(symbol!==store.selected)return;
      store.detail=v;store.lastDetailTime=Date.now();
      renderDetail();
    }catch(e){$('detailTitle').textContent=`${symbol} · 暂无详细数据`}
  }
  document.querySelectorAll('.nav-link').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
  document.querySelectorAll('.filter-btn').forEach(button=>button.addEventListener('click',()=>{
    store.filter=button.dataset.filter;store.visibleLimit=150;
    document.querySelectorAll('.filter-btn').forEach(x=>x.classList.toggle('active',x===button));
    renderMarkets();
  }));
  $('search').addEventListener('input',event=>{store.query=event.target.value.trim().toLowerCase();store.visibleLimit=150;renderMarkets()});
  $('venueFilter').addEventListener('change',event=>{store.venue=event.target.value;store.visibleLimit=150;renderMarkets()});
  $('loadMoreMarkets').addEventListener('click',()=>{store.visibleLimit+=150;renderMarkets()});
  $('clearFavorites').addEventListener('click',()=>{
    const count=store.favorites.size;
    if(!count)return;
    if(!window.confirm('确定清空全部 '+count+' 只自选合约？\n收藏时的价格、时间、信号记录将被删除且不可恢复。'))return;
    store.favorites.clear();
    store.favoriteSnapshots={};
    store.favoriteDifferences={};
    store.favoriteDifferenceUpdatedAt=0;
    try{
      localStorage.setItem(FAVORITES_KEY,'[]');
      localStorage.setItem(FAVORITES_META_KEY,'{}');
    }catch(err){console.warn('保存自选清空状态失败',err)}
    renderMarkets();
  });
  $('marketList').addEventListener('click',event=>{
    const star=event.target.closest('[data-favorite]');
    if(star){event.preventDefault();event.stopPropagation();toggleFavorite(star.dataset.favorite);return}
    const target=event.target.closest('[data-symbol]');if(!target)return;
    store.selected=target.dataset.symbol;store.lastDetailTime=0;renderMarkets();updateDetail();
    if(window.innerWidth<940)$('detailTitle').scrollIntoView({behavior:'smooth',block:'center'});
  });
  $('marketList').addEventListener('keydown',event=>{
    if(event.target.closest('[data-favorite]'))return;
    if(event.key!=='Enter'&&event.key!==' ')return;
    const target=event.target.closest('[data-symbol]');if(!target)return;
    event.preventDefault();target.click();
  });
  $('seeAlerts').addEventListener('click',()=>{setView('alerts');window.scrollTo({top:0,behavior:'smooth'})});
  setInterval(()=>{$('clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false})},1000);
  window.addEventListener('resize',()=>{if(store.view==='radar'&&store.detail)drawCandles(store.detail.charts?.[store.chartPeriod||15]||[])});
  setView(window.location?.hash==='#paper'?'paper':'radar');updateSnapshot();setInterval(updateSnapshot,5000);
  setInterval(()=>{if(store.view==='paper')void refreshPaper();},5000);
})();
