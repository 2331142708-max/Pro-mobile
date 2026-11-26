(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=(x,d=2)=>Number.isFinite(Number(x))?Number(x).toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
  const price=x=>{const v=+x;if(!(v>0))return '—';return n(v,v<.01?7:v<1?5:v<100?3:2)};
  const amount=x=>!Number.isFinite(+x)?'—':Math.abs(+x)>=1e8?n(+x/1e8,2)+'亿':Math.abs(+x)>=1e4?n(+x/1e4,1)+'万':n(+x,0);
  const tm=t=>t?new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
  const since=t=>t?Math.max(0,Math.round((Date.now()-t)/1000))+'秒前':'—';
  const cls=d=>d==='up'?'up':d==='down'?'down':'';
  const direction=d=>d==='up'?'看多':d==='down'?'看空':d==='mixed'?'方向冲突':'无形态';
  const store={classicOpen:false,snap:null,detail:null,symbol:'BTCUSDT',filter:'all',exchange:'all',query:'',max:100,pins:new Set(),favorites:new Set(),favoriteMeta:{},lastDetail:0,fetching:false,errors:0};
  const accountKey=key=>'pro-account:'+document.documentElement.dataset.proAccount+':'+key;
  function read(key,fallback){try{const value=JSON.parse(localStorage.getItem(accountKey(key)));return value??fallback}catch{return fallback}}
  const five=new Set(['BTCUSDT','BTCUSDC','ETHUSDT','ETHUSDC','ZECUSDT']);
  store.pins=new Set(read('nk-pro2-pinned',[]).filter(x=>five.has(x)));store.favorites=new Set(read('contract-lens-pro-favorites-v1',[]).filter(x=>five.has(x)));
  store.favoriteMeta=Object.fromEntries(Object.entries(read('nk-pro2-favorite-meta',{})).filter(([x])=>five.has(x)));
  store.favoriteDiff={};
  function save(){try{localStorage.setItem(accountKey('nk-pro2-pinned'),JSON.stringify([...store.pins]));localStorage.setItem(accountKey('contract-lens-pro-favorites-v1'),JSON.stringify([...store.favorites]));localStorage.setItem(accountKey('nk-pro2-favorite-meta'),JSON.stringify(store.favoriteMeta));}catch{toast('浏览器未能保存自选设置')}}
  let toastTimer;
  function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2700)}
  function togglePin(symbol){if(store.pins.has(symbol))store.pins.delete(symbol);else store.pins.add(symbol);save();renderMarkets();toast(store.pins.has(symbol)?'已蓝色置顶':'已取消置顶')}
  function toggleFavorite(symbol){if(store.favorites.has(symbol)){store.favorites.delete(symbol);delete store.favoriteMeta[symbol];}else{
    store.favorites.add(symbol);const m=store.snap?.symbols?.find(x=>x.symbol===symbol);
    store.favoriteMeta[symbol]={at:Date.now(),price:m?.price||0,direction:m?.direction||'neutral',names:m?.matches?.flatMap(x=>x.names||[]).slice(0,4)||[]};
  }delete store.favoriteDiff[symbol];save();renderMarkets();renderDetail()}
  async function get(url){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),13000);
    try{const res=await fetch(url,{cache:'no-store',signal:controller.signal});if(res.status===401){window.location.replace('/login');throw Error('登录已失效')}if(!res.ok)throw Error('HTTP '+res.status);return await res.json()}finally{clearTimeout(timer)}}
  function renderOverview(){const s=store.snap;if(!s)return;const c=s.counts;
    $('totalCount').textContent=c.eligible.toLocaleString();$('upCount').textContent=c.up;$('downCount').textContent=c.down;$('multiCount').textContent=c.multiple;
    $('readyHero').textContent=c.ready.toLocaleString();$('totalHero').textContent=c.eligible.toLocaleString();
    $('scanProgress').style.width=(c.eligible?Math.min(100,c.ready/c.eligible*100):0)+'%';
    $('scanHint').textContent=`已获取 ${c.loaded} 份 2H 历史 · 通过收盘完整性检查 ${c.ready} 份`;
    $('updated').textContent=tm(s.serverTime);$('live').classList.toggle('good',c.eligible>0);
    $('live').innerHTML='<i></i>'+(c.eligible?'行情接口在线':'等待行情目录');
    $('notice').classList.toggle('warning',c.ready===0);
    $('noticeText').textContent=c.eligible===0?'等待币安五个指定合约目录...':c.ready===0?'已获取合约目录，但2小时已收盘历史K线尚未加载完成；不输出方向信号。':
      `已检查 ${c.ready}/${c.eligible} 个合约的连续2小时已收盘K线。未检查、盘口过期与行情断线的合约不会进入精选。历史加载可能需要数分钟。`;
    const v=s.verification||{};
    $('alignment').textContent=v.samples>=30?`${n(100*v.aligned/v.samples,1)}%`:'样本不足';
    $('sampleCount').textContent=v.samples||0;$('pendingCount').textContent=v.pending||0;
    $('pinNum').textContent=store.pins.size;$('favNum').textContent=store.favorites.size;
  }
  function activeRows(){const query=store.query;const list=(store.snap?.symbols||[]).filter(m=>{
    if(store.exchange!=='all'&&m.exchange!==store.exchange)return false;
    if(query&&!String(m.symbol+' '+m.displaySymbol).toLowerCase().includes(query))return false;
    if(store.filter==='pinned')return store.pins.has(m.symbol);
    if(store.filter==='favorite')return store.favorites.has(m.symbol);
    if(store.filter==='multi')return m.multi;
    if(store.filter==='selected')return m.selected;
    if(store.filter==='up'||store.filter==='down')return m.matches?.some(x=>x.direction===store.filter);
    return true;
  });
    const sort=(a,b)=>Number(store.pins.has(b.symbol))-Number(store.pins.has(a.symbol))||
      Number(b.selected)-Number(a.selected)||Number(b.ready)-Number(a.ready)||
      Number(b.multi)-Number(a.multi)||(b.quoteVolume24h||0)-(a.quoteVolume24h||0);
    return list.sort(sort);
  }
  function row(m){const pinned=store.pins.has(m.symbol),faved=store.favorites.has(m.symbol),name=m.displaySymbol||m.symbol;
    const tags=m.matches?.flatMap(h=>h.names.slice(0,3).map(x=>`<span class="tag ${cls(h.direction)}">${esc(x)}</span>`))||[];
    const signal=tags.length?tags.slice(0,4).join(''):'<span class="tag">'+(m.ready?'未命中形态':'待2H数据')+'</span>';
    const meta=store.favoriteMeta[m.symbol],diff=meta?.price>0&&m.price>0?`收藏价 ${price(meta.price)} · 变化 ${n((m.price/meta.price-1)*100,2)}%`:'';
    const trade=m.trade;
    const coverage=trade?.covered?`100万${esc(m.quoteAsset||'USDT')}聚合成交 买 ${amount(trade.buy)} / 卖 ${amount(trade.sell)}`:'大额成交：未监测';
    return `<article class="market-row ${pinned?'pinned':''} ${store.symbol===m.symbol?'selected':''}" data-row="${esc(m.symbol)}" tabindex="0" role="button" aria-label="查看${esc(name)}分析">
      <div class="market-row-main"><div class="market-name-line"><strong class="sym">${esc(name)}</strong>
        <button class="mini-btn star ${faved?'active':''}" data-fav="${esc(m.symbol)}" aria-label="${faved?'取消':'加入'}自选" title="${faved?'取消':'加入'}自选">${faved?'★':'☆'}</button>
        <button class="mini-btn ${pinned?'active':''}" data-pin="${esc(m.symbol)}" aria-label="${pinned?'取消蓝色置顶':'蓝色置顶'}" title="${pinned?'取消置顶':'置顶'}">${pinned?'◆':'◇'}</button>
        ${m.selected?'<span class="tag blue">精选</span>':''}
      </div><div class="row-meta"><span class="venue">${esc(m.exchangeLabel)}</span>${signal}</div>
      <div class="market-sub">${m.ready?'2H收盘 '+tm(m.closedAt):esc(m.reason||'待真实K线')}${diff?' · '+esc(diff):''}</div>
      <div class="market-sub">${esc(coverage)}</div></div>
      <div class="market-side"><div class="market-price">${price(m.price)}</div><div class="market-change ${m.change24h>=0?'positive':'negative'}">${m.stale?'报价待更新':(m.change24h>=0?'+':'')+n(m.change24h)+'%'}</div><div class="market-dir ${cls(m.direction)}">${direction(m.direction)}</div></div>
    </article>`;
  }
  function renderMarkets(){const all=activeRows(),shown=all.slice(0,store.max);
    $('resultsCount').textContent=all.length+' 个结果';$('pinNum').textContent=store.pins.size;$('favNum').textContent=store.favorites.size;
    $('more').hidden=all.length<=store.max;$('more').textContent=`加载更多 · ${shown.length}/${all.length}`;
    $('markets').innerHTML=shown.length?shown.map(row).join(''):
      `<div class="empty">${store.filter==='pinned'?'没有置顶合约，点击任一合约旁的◇即可置顶。':store.filter==='favorite'?'自选为空，请在全部合约旁点击☆。':store.filter==='selected'?'暂时没有符合多形态、盘口与成交量条件的精选合约。':store.filter==='all'&&!store.snap?.symbols?.length?'正在加载真实合约目录…':'没有符合筛选条件的合约；这不表示一定不会涨跌。'}</div>`;
  }
  function renderAlerts(){const alerts=store.snap?.alerts||[];
    $('alerts').innerHTML=alerts.length?alerts.slice(0,15).map(a=>`<div class="alert-item"><span class="tag ${cls(a.direction)}">${direction(a.direction)}</span><strong>${esc(a.displaySymbol||a.symbol)}</strong><span>${(a.names||[]).map(esc).join('、')}</span><small>2H 收盘 ${tm(a.closedAt)} · 观测 ${tm(a.observedAt)} · ${a.result?('下一根2H变动 '+n(a.result.change,2)+'%'):'下一根2H结果待检查'}</small></div>`).join(''):
      '<div class="empty">目前没有真实已收盘2H形态记录，等待数据积累。</div>';
  }
  function chartSvg(bars){if(!bars?.length)return '<div class="empty">2小时K线数据尚未加载。</div>';
    const a=bars.slice(-44),W=620,H=220,padX=17,padY=15;
    const low=Math.min(...a.map(x=>x.l)),high=Math.max(...a.map(x=>x.h)),d=Math.max(high-low,high*.00005);
    const y=p=>padY+(high-p)/d*(H-2*padY),dx=(W-2*padX)/a.length;
    let shapes='';for(let i=0;i<a.length;i++){const b=a[i],x=padX+dx*(i+.5),c=b.c>=b.o?'chart-up':'chart-down';
      shapes+=`<line class="${c}" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${y(b.h).toFixed(2)}" y2="${y(b.l).toFixed(2)}" stroke-width="1.4"/>`;
      const top=Math.min(y(b.o),y(b.c)),height=Math.max(1,Math.abs(y(b.o)-y(b.c)));
      shapes+=`<rect class="${c}" x="${(x-dx*.32).toFixed(2)}" y="${top.toFixed(2)}" width="${(dx*.64).toFixed(2)}" height="${height.toFixed(2)}" rx=".3"/>`;
    }
    return `<svg class="candles" viewBox="0 0 ${W} ${H}" role="img" aria-label="最近${a.length}根真实已收盘2小时K线">${[.25,.5,.75].map(f=>`<line class="chart-grid" x1="0" x2="${W}" y1="${H*f}" y2="${H*f}"/>`).join('')}${shapes}<text class="chart-axis" x="${W-83}" y="13">高 ${price(high)}</text><text class="chart-axis" x="${W-83}" y="${H-5}">低 ${price(low)}</text></svg>`;
  }
  function tradeInfo(t){if(!t||!t.covered)return `<div class="disclaimer">该合约未纳入百万计价币种单位 聚合成交监测。这里不推算买卖额，也不识别账户身份。</div>`;
    return `<div class="trade-box"><div class="detail-desc">100万计价币种单位 以上聚合成交 · 本小时累计（监测接入后，非全天、非全部交易）</div><div class="trade-pair"><div><strong style="color:#168568">${amount(t.buy)} ${esc(t.quoteAsset||'USDT')}</strong><small>主动买 · ${t.buyCount} 条</small></div><div><strong style="color:#dc5860">${amount(t.sell)} ${esc(t.quoteAsset||'USDT')}</strong><small>主动卖 · ${t.sellCount} 条</small></div></div><div class="detail-desc">整点清零 · 监测起始 ${tm(t.firstObservedAt)} · 不是特定大户的账户交易额</div></div>`;
  }
  function fmtDiff(value){return value===null||!Number.isFinite(value)?'—':(value>0?'+':'')+(value===0?'0':price(Math.abs(value)))+(value<0?'（低于收藏价）':value>0?'（高于收藏价）':'');}
  function favoriteSnapshot(d){
    const meta=store.favoriteMeta[d.symbol];
    if(!store.favorites.has(d.symbol)||!meta)return `<div class="aux-empty">尚未收藏。点击合约旁 ☆ 收藏后，将保存收藏时间、当时信号、价格，并每 3 分钟采样一次与现价的差值。</div>`;
    const state=store.favoriteDiff[d.symbol];
    if(!state||Date.now()-state.at>=180000){
      if(!d.stale&&meta.price>0&&d.price>0)store.favoriteDiff[d.symbol]={at:Date.now(),current:d.price,difference:d.price-meta.price};
    }
    const diff=store.favoriteDiff[d.symbol];
    const directionLabel=meta.direction==='up'?'看多形态':meta.direction==='down'?'看空形态':meta.direction==='mixed'?'多空冲突':'观望／未确认';
    return `<div class="favorite-lines"><div><span>收藏时间</span><strong>${tm(meta.at)}</strong></div><div><span>收藏信号</span><strong>${esc(directionLabel)}</strong></div><div><span>收藏形态</span><strong>${esc((meta.names||[]).join('、')||'无确认形态')}</strong></div><div><span>收藏价格</span><strong>${price(meta.price)} ${esc(d.quoteAsset||'')}</strong></div><div><span>现价 − 收藏价</span><strong>${diff?fmtDiff(diff.difference):'等待新鲜报价'}</strong></div><div class="minor">每 3 分钟取一次真实新鲜报价 · 上次采样 ${diff?tm(diff.at):'—'}</div></div>`;
  }
  function pctText(v){return v===null||v===undefined?'—':n(v,1)+'%'}
  function sideBar(pct,extra=''){
    if(!Number.isFinite(+pct))return `<div class="aux-empty">等待有效成交样本</div>`;
    const buy=Math.max(0,Math.min(100,+pct));
    return `<div class="side-bars ${extra}" role="img" aria-label="主动买入 ${pctText(buy)}，主动卖出 ${pctText(100-buy)}"><span style="width:${buy}%"></span><span style="width:${100-buy}%"></span></div>`;
  }
  function sparkBars(rows){
    if(!rows?.length)return '<div class="aux-empty">近 30 分钟内暂无达到 10 万计价币种单位 的监测成交。</div>';
    const by=new Map(rows.map(x=>[x.t,x])),now=Date.now(),bucket=60000;
    const data=Array.from({length:30},(_,i)=>by.get(Math.floor(now/bucket)*bucket-(29-i)*bucket)||{buy:0,sell:0});
    const scale=Math.max(1,...data.map(x=>x.buy+x.sell));
    return `<div class="trade-spark" role="img" aria-label="最近30分钟监测到的每分钟10万计价币种单位以上买卖额分布">${data.map(x=>{const total=x.buy+x.sell,h=Math.max(1,total/scale*48);
      return `<div class="spark-column" title="${amount(x.buy)} U买 / ${amount(x.sell)} U卖" style="height:${h}px"><i style="height:${total?Math.max(0,x.buy/total*100):0}%"></i></div>`}).join('')}</div><div class="minor">每柱 1 分钟，绿色为主动买、红色为主动卖；仅含已监测到的大额成交。</div>`;
  }
  function verificationBlock(d){
    const signals=(store.snap?.alerts||[]).filter(a=>a.symbol===d.symbol),done=signals.filter(a=>a.result&&typeof a.result.aligned==='boolean');
    const aligned=done.filter(a=>a.result.aligned).length;
    return `<div class="aux-card"><div class="aux-card-title"><strong>历史信号验证</strong><span>仅已收盘 2H</span></div><div class="aux-hero-value">${done.length>=20?pctText(aligned/done.length*100):'样本不足'}</div><div class="minor">该合约最近已保存记录：${aligned} / ${done.length} 次下一根 2H 方向一致 · ${signals.filter(a=>!a.result).length} 条待验证</div><div class="minor">这是方向一致率，不是扣除手续费、滑点后的净收益或交易成功率。旧版 20 分钟模拟未与 2H 主信号混用。</div></div>`;
  }
  function shortBlock(m){
    if(!m?.covered||!m.ready)return `<div class="aux-empty">${esc(m?.reason||'监测尚未接入')}。短时信息只对公开成交监测覆盖的合约开放。</div>`;
    const s=m.short||{},r=m.forwardChecks||{};
    const label=s.direction==='up'?'偏多压力':s.direction==='down'?'偏空压力':'观望';
    return `<div class="aux-card short-direction"><div class="aux-card-title"><strong>未来 2 分钟方向 · 实验性观察</strong><span>公开成交 · 页面约5秒刷新</span></div><div class="aux-hero-value ${cls(s.direction)}">${label}</div><div class="short-score">信号一致性 ${s.score===null?'数据不足':s.score+'/100'} · ${esc(s.explanation||'暂无足够数据')}</div><p>30 秒主动成交、5 分钟主动成交与近 1 分钟成交价格变化同向才提示偏向。规则分数不是预测概率，不等于下一笔交易应做多或做空。</p>
      <div class="aux-card-title"><strong>30 分钟短时压力跟踪</strong><span>每 10 分钟取样</span></div><div class="minor">历史方向一致 ${r.aligned||0} / ${r.total||0} 笔 · 待检 ${r.pending||0} 笔 · 数据中断 ${r.missed||0} 笔</div><div class="minor">仅追踪启用监测之后的真实报价；未到30分钟的不计为命中。</div></div>`;
  }
  function activityBlock(m){
    if(!m?.covered||!m.ready)return `<div class="aux-empty">${esc(m?.reason||'未监测成交')}。</div>`;
    const w=m.last30||m.sample30,w5=m.last5m;
    return `<div class="aux-card"><div class="aux-card-title"><strong>近 30 秒 · 主动买卖占比</strong><span>${tm(m.latestAt)} 最新成交</span></div>
      <div class="flow-values"><b class="up">主动买 ${pctText(w?.buyPct)}</b><b class="down">主动卖 ${pctText(w?.sellPct)}</b></div>${sideBar(w?.buyPct)}
      <div class="minor">近30秒已观测聚合成交：${w?(w.buyCount+w.sellCount):'样本不足'} 条${m.sample30Partial?'（接入不足30秒的部分样本）':''} · 总额 ${w?amount(w.buy+w.sell)+' U':'—'} · ${w5?'5分钟买盘占比 '+pctText(w5.buyPct):'等待5分钟样本'}</div>
      <div class="mini-four"><div><span>盘中资金活跃度</span><strong>${esc(m.activity)}</strong></div><div><span>5分钟成交额 / 前5分钟</span><strong>${m.activityRatio===null?'样本不足':n(m.activityRatio,2)+' 倍'}</strong></div><div><span>近1分钟价格变化</span><strong>${m.change1m===null?'—':n(m.change1m,3)+'%'}</strong></div><div><span>近10分钟价格变化</span><strong>${m.change10m===null?'—':n(m.change10m,3)+'%'}</strong></div></div>
      <div class="aux-inline-status">5分钟多空强度：<strong>${!w5?'样本不足':w5.buyPct>=60?'主动买占优':w5.buyPct<=40?'主动卖占优':'中性'}</strong>${w5?' · 主动买 '+pctText(w5.buyPct)+' / 主动卖 '+pctText(w5.sellPct):''}</div>
      <div class="minor">活跃度只比较本次连接接收到的公开成交额，不能识别主力、机构或真实资金流入。</div></div>`;
  }
  function marketPulseBlock(p){
    if(!p?.ready)return `<div class="aux-empty">10分钟五合约样本情绪（名义额合计，未换汇）：${esc(p?.reason||'正在收集五合约短时统计')}。仅覆盖有监测且数据连续的合约。</div>`;
    return `<div class="aux-card"><div class="aux-card-title"><strong>10 分钟五合约样本情绪</strong><span>监测样本 ${p.monitored} 个合约</span></div>
      <div class="aux-hero-value">${esc(p.sentiment)}</div><div class="flow-values"><b class="up">看多强度 ${p.longScore}/100</b><b class="down">看空强度 ${p.shortScore}/100</b></div>${sideBar(p.longScore)}
      <div class="mini-four"><div><span>5分钟主动买占比</span><strong>${pctText(p.buyPct)}</strong></div><div><span>10分钟价格广度</span><strong>涨 ${p.up} / 跌 ${p.down}</strong></div><div><span>BTC近10分钟</span><strong>${p.btc10m===null?'—':n(p.btc10m,3)+'%'}</strong></div><div><span>ETH近10分钟</span><strong>${p.eth10m===null?'—':n(p.eth10m,3)+'%'}</strong></div></div>
      <div class="minor">${esc(p.note||'规则强度不等于预测胜率')} · 未接入的市场无法代表整个市场。</div></div>`;
  }
  function microLargeBlock(m){
    if(!m?.covered||!m.ready)return `<div class="aux-empty">${esc(m?.reason||'成交监测未启用')}。</div>`;
    const w=m.large30m||{};const count=(w.largeBuyCount||0)+(w.largeSellCount||0);
    return `<div class="aux-card"><div class="aux-card-title"><strong>大额实时买卖 · 笔数对比</strong><span>聚合成交单条 ≥ 10 万计价币种单位</span></div>
      <div class="flow-values"><b class="up">买 ${w.largeBuyCount||0} 条 · ${pctText(count>0?100*w.largeBuyCount/count:null)}</b><b class="down">卖 ${w.largeSellCount||0} 条</b></div>${sideBar(count>0?100*w.largeBuyCount/count:null)}
      ${sparkBars(m.largeMinuteSeries)}<div class="mini-four"><div><span>30分钟累计主动买</span><strong class="up">${amount(w.largeBuy)} U</strong></div><div><span>30分钟累计主动卖</span><strong class="down">${amount(w.largeSell)} U</strong></div></div><div class="minor">共 ${count} 条 · ${w.partial?'未满30分钟，当前为部分样本':'滚动30分钟样本'} · 不能视为独立大户订单数。</div></div>`;
  }
  function factorBlock(d){
    const m=d.micro,p=store.snap?.marketPulse;
    const items=[
      ['近30秒主动成交',m?.last30?.buyPct==null?null:m.last30.buyPct>55?'up':m.last30.buyPct<45?'down':'neutral'],
      ['5分钟成交价格',m?.change5m==null?null:m.change5m>.05?'up':m.change5m<-.05?'down':'neutral'],
      ['大额成交倾向',m?.large30m&&!m.large30m.partial&&m.large30m.largeBuy+m.large30m.largeSell>0?(m.large30m.largeBuy>m.large30m.largeSell?'up':'down'):null],
      ['合约24H涨跌',d.stale?null:d.change24h>.1?'up':d.change24h<-.1?'down':'neutral'],
      ['监测合约价格广度',p?.ready?(p.up>p.down?'up':p.down>p.up?'down':'neutral'):null],
      ['BTC与ETH近10分钟',p?.ready&&p.btc10m!==null&&p.eth10m!==null?(p.btc10m>0&&p.eth10m>0?'up':p.btc10m<0&&p.eth10m<0?'down':'neutral'):null]
    ];
    return `<div class="factor-box"><div class="aux-card-title"><strong>多因子方向条件</strong><span>↑/↓ 是观察结果，不代表下一步</span></div>${items.map(([name,val])=>`<div><span>${esc(name)}</span><b class="${cls(val)}">${val==='up'?'↑':val==='down'?'↓':val==='neutral'?'—':'数据不足'}</b></div>`).join('')}</div>`;
  }
  // Classic Pro Mobile detail panel, faithful to the old mobile visual hierarchy.
  // Observations are always based on the currently available public API fields.
  function classicPct(v){return Number.isFinite(+v)&&v!==null&&v!==undefined?Math.max(0,Math.min(100,+v)):null}
  function classicNumber(v){return Number.isFinite(+v)&&v!==null&&v!==undefined?n(v,0):'—'}
  function classicBuySell(buy,sell){const a=Number(buy)||0,b=Number(sell)||0;return a+b>0?100*a/(a+b):null}
  function classicWave(pct,key){
    const path=(a,b)=>{let s='';for(let x=a;x<=b;x+=2){const y=10+5*Math.sin((x/600)*Math.PI*42);s+=(s?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)+' '}return s};
    if(pct===null)return `<svg class="classic-waves is-waiting" viewBox="0 0 600 20" preserveAspectRatio="none" role="img" aria-label="数据不足，灰色波浪线不代表任何买卖方向"><path d="${path(0,600)}" stroke="#adb7ae"/></svg><div class="classic-wave-placeholder">数据不足，等待有效大额成交</div>`;
    const ratio=Math.max(0,Math.min(100,pct)),split=600*ratio/100;
    const x=Math.max(0,Math.min(600,split));const left=path(0,Math.max(0,x));const right=path(x,600);
    return `<svg class="classic-waves" viewBox="0 0 600 20" preserveAspectRatio="none" role="img" aria-label="买卖占比波浪进度条：买${pctText(ratio)}卖${pctText(100-ratio)}"><path d="${left}" stroke="#4bc99a"/><path d="${right}" stroke="#ee737c"/></svg>`;
  }
  function classicBar(buy,sell,key){
    const pct=classicBuySell(buy,sell),left=pct===null?0:pct,right=pct===null?0:100-pct;
    return `<div class="classic-trade-bar-wrap">
      <div class="classic-progress ${pct===null?'is-waiting':''}" role="img" aria-label="${pct===null?'样本不足':`买入${pctText(left)}，卖出${pctText(right)}`}">
        <div class="classic-progress-green" style="width:${left.toFixed(2)}%"></div>
        <div class="classic-progress-red" style="width:${right.toFixed(2)}%"></div>
        <div class="classic-pencil ${pct===null?'is-waiting':''}" style="left:${pct===null?'50':left.toFixed(2)}%" aria-hidden="true"><svg viewBox="0 0 40 52"><path fill="${pct===null?'#c5cfc6':'#e5c392'}" d="M0 0 L19 25 L0 50 Z"/><path fill="${pct===null?'#e8eeea':'#fdfaf1'}" d="M40 0 L21 25 L40 50 Z"/></svg></div>
        <div class="classic-progress-label left"><b>买 ${classicNumber(buy)}笔</b><strong>${pct===null?'—':pctText(left)}</strong></div>
        <div class="classic-progress-label right"><b>卖 ${classicNumber(sell)}笔</b><strong>${pct===null?'—':pctText(right)}</strong></div>
      </div>
      ${classicWave(pct,key)}
    </div>`;
  }
  function classicFactors(d){
    const m=d.micro,p=store.snap?.marketPulse;
    const values=[
      ['主动成交',m?.last30?.buyPct===null||m?.last30?.buyPct===undefined?null:m.last30.buyPct>55?'up':m.last30.buyPct<45?'down':'neutral'],
      ['成交后价格',m?.change5m==null?null:m.change5m>.05?'up':m.change5m<-.05?'down':'neutral'],
      ['大单',m?.large30m?.partial===false?m.large30m.largeBuy>m.large30m.largeSell?'up':m.large30m.largeBuy<m.large30m.largeSell?'down':'neutral':null],
      ['合约24H',d.stale?null:d.change24h>.1?'up':d.change24h<-.1?'down':'neutral'],
      ['合约涨跌广度',p?.ready?p.up>p.down?'up':p.up<p.down?'down':'neutral':null],
      ['BTC/ETH',p?.ready&&p.btc10m!=null&&p.eth10m!=null?(p.btc10m>0&&p.eth10m>0?'up':p.btc10m<0&&p.eth10m<0?'down':'neutral'):null]
    ];
    return values.map(([name,dir])=>`<span>${esc(name)}${dir==='up'?'↑':dir==='down'?'↓':dir==='neutral'?'→':'·'}</span>`).join(' · ');
  }
  function classicLarge(m){
    const w=m?.ready&&m?.covered?m.large30m:null;
    const buy=w?.largeBuyCount??null,sell=w?.largeSellCount??null;
    const valid=buy!==null&&sell!==null;
    return `<section class="classic-large">
      <div class="classic-large-title"><strong>大额实时买卖 · 笔数对比</strong><span>单笔 ≥ 10 万计价币种单位</span></div>
      ${classicBar(valid?buy:0,valid?sell:0,'large')}
      <div class="classic-totals">30分钟累计买入 <strong>${w?classicNumber(w.largeBuy):'—'} U</strong> / 卖出 <strong>${w?classicNumber(w.largeSell):'—'} U</strong></div>
      <div class="classic-totals-note">${!m?.covered||!m.ready?esc(m?.reason||'连接等待中'):w?.partial?'未满30分钟，当前为部分样本':'滚动30分钟监测样本'} · 仅为聚合成交事件，不代表独立大户账户</div>
      ${m?.ready&&m?.largeMinuteSeries?.length?`<div class="classic-spark-head">近30分钟大额买卖分布</div>${sparkBars(m.largeMinuteSeries)}`:''}
    </section>`;
  }

  let classicLive=null,classicLiveBusy=false,classicLiveGeneration=0,classicLiveTimer=null,classicAgeTimer=null,classicLiveMono=0,classicLiveRtt=0;
  const classicStamp=t=>Number.isFinite(t)&&t>0?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'—';
  function classicElapsed(){return Math.max(0,performance.now()-classicLiveMono)+classicLiveRtt/2}
  function paintClassicAge(){
    const q=$('classicLivePrice'),note=$('classicQuoteAge'),flow=$('classicFlowAge');
    if(!q||!note)return;
    const live=classicLive?.symbol===store.symbol?classicLive:null,quote=live?.quote;
    if(!quote||!Number.isFinite(quote.ageMs)||!(quote.price>0)){
      q.textContent='—';q.style.color='';note.textContent='等待最新公开报价';note.style.color='';if(flow)flow.textContent='等待实时成交统计';return;
    }
    const elapsed=classicElapsed(),age=quote.ageMs+elapsed,fresh=quote.fresh&&age<=2500;
    q.textContent=price(quote.price);q.style.color=fresh?'':'#a36b20';
    note.textContent=(fresh?'':'报价延迟 · ')+(quote.source==='aggTrade'?'最新公开成交':'公开行情报价')+' · '+classicStamp(quote.at)+' · 估计延迟 '+(age/1000).toFixed(1)+'秒';note.style.color=fresh?'':'#a36b20';
    if(flow){
      const at=live.micro?.latestAt;
      const ms=Number.isFinite(at)&&at>0?Math.max(0,live.serverTime-at)+elapsed:null;
      const stale=elapsed>3500||ms===null||ms>3500;
      flow.textContent=ms===null?'成交统计等待真实样本':(stale?'成交数据延迟 · ':'成交采样 · ')+classicStamp(at)+' · 估计延迟 '+(ms/1000).toFixed(1)+'秒';
      flow.style.color=stale?'#a36b20':'';
      const area=$('classicFlowArea');if(area)area.style.opacity=stale?'.65':'1';
    }
  }
  async function refreshClassicLive(){
    if(!store.classicOpen||classicLiveBusy||document.visibilityState!=='visible')return;
    const gen=classicLiveGeneration,symbol=store.symbol,start=performance.now(),controller=new AbortController();
    classicLiveBusy=true;const timer=setTimeout(()=>controller.abort(),2800);
    try{
      const r=await fetch('/api/pro2/classic-live?symbol='+encodeURIComponent(symbol),{cache:'no-store',signal:controller.signal});
      if(r.status===401){location.replace('/login');return}
      if(!r.ok)throw Error('实时详情暂不可用');
      const v=await r.json(),end=performance.now();
      if(store.classicOpen&&gen===classicLiveGeneration&&symbol===store.symbol&&v.symbol===symbol){classicLive=v;classicLiveMono=end;classicLiveRtt=end-start;renderClassicDetail()}
    }catch{if(gen===classicLiveGeneration)paintClassicAge()}
    finally{clearTimeout(timer);classicLiveBusy=false}
  }
  function renderClassicDetail(){
    if(!store.classicOpen)return;
    const d=store.detail,body=$('classicBody');if(!body)return;
    if(!d||d.symbol!==store.symbol){body.innerHTML='<div class="classic-loading">正在读取合约详情…</div>';return}
    const live=classicLive?.symbol===d.symbol?classicLive:null;
    const hold=body.scrollTop,m=live?.micro||d.micro,p=live?.marketPulse||store.snap?.marketPulse;
    const tracks=m?.forwardChecks||{},checked=tracks.total||0,aligned=tracks.aligned||0;
    const signals=(store.snap?.alerts||[]).filter(a=>a.symbol===d.symbol);
    const done=signals.filter(a=>typeof a.result?.aligned==='boolean');
    const correct=done.filter(a=>a.result.aligned).length;
    const recent=m?.last30||m?.sample30;
    const pct30=m?.ready?recent?.buyPct:null,pct5=m?.ready?m.last5m?.buyPct:null;
    const active30=m?.ready&&pct30!==null;
    const liveCount=m?.ready&&recent?recent.buyCount+recent.sellCount:0;
    const large=live?.largeTrades||d.largeTrades||{};
    const readyPulse=Boolean(p?.ready);
    const future=m?.ready&&m.short?(m.short.direction==='up'?'偏多':m.short.direction==='down'?'偏空':'观望'):'观望';
    const rawScore=m?.short?.score??null;
    const largeBuy=large.covered?large.buy:0,largeSell=large.covered?large.sell:0;
    const nextClear=new Date(Math.floor(Date.now()/3600000)*3600000+3600000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
    const savedMeta=store.favoriteMeta[d.symbol];
    const saved=store.favorites.has(d.symbol)&&savedMeta;
    const sampled=store.favoriteDiff[d.symbol];
    const statusLabel=savedMeta?.direction==='up'?'看多':savedMeta?.direction==='down'?'看空':'观望/未确认';
    const savedPrice=savedMeta?.price||0;
    const lastSample=sampled?.at?tm(sampled.at):'—';
    const savedDiff=sampled&&savedPrice?fmtDiff(sampled.difference):'数据不足/行情延迟';
    const sentiment=readyPulse?esc(p.sentiment):'多空分歧 · 样本不足';
    const longStrength=readyPulse?p.longScore:null,shortStrength=readyPulse?p.shortScore:null;
    const twoHours=d.ready?'真实已收盘2H确认':'等待2H收盘确认';
    $('classicTitle').textContent=`${d.displaySymbol||d.symbol} · 原版详情`;
    body.innerHTML=`<div class="classic-content-inner">
      <div class="classic-kicker">MARKET SCANNER <span>● 自动观察 · ${classicStamp(live?.serverTime||d.priceAt)}</span></div>
      <div class="classic-headline"><strong>${esc(d.displaySymbol||d.symbol)}</strong><span>${esc(d.exchangeLabel)} · ${esc(twoHours)}</span></div>
      <div class="classic-live-quote"><strong id="classicLivePrice">—</strong><div id="classicQuoteAge">等待最新公开报价</div></div>
      <div class="classic-sample"><strong>${done.length>=20?pctText(100*correct/done.length):'样本不足'}</strong><div>2小时下一根方向一致 ${correct} / ${done.length} 笔<br>净收益率：未计算（不是交易胜率）</div></div>
      <div class="classic-desc">取各信号首次可见的新鲜报价模拟观察。每10分钟一档，30分钟后按真实报价复核；不使用未收盘2小时K线做主信号。</div>
      <div class="classic-saved">
        <div>收藏时间 <b>${saved?tm(savedMeta.at):'未收藏'}</b></div>
        <div>收藏信号 <b>${saved?esc(statusLabel):'观望/未确认'} · 强度 ${saved?esc((savedMeta.names||[]).join('、')||'—'):'—'}</b></div>
        <div>收藏价格 <b>${saved?price(savedPrice):'—'} ${esc(d.quoteAsset||'USDT')}</b></div>
        <hr><div>与现价相差 <b>${saved?esc(savedDiff):'未收藏'}</b></div>
        <div>每3分钟更新一次 · 上次计算 ${lastSample}</div>
      </div>
      <section class="classic-future">
        <div class="classic-future-row"><strong>未来2分钟方向</strong><span>历史规则复核 · 独立于实时报价</span></div>
        <div class="classic-future-value ${cls(m?.short?.direction)}">${future}</div>
        <div class="classic-future-score">信号一致性 ${rawScore==null?'—':rawScore}/100</div>
        <div class="classic-future-text">${!m?.ready?esc(m?.reason||'该合约缺少连续公开成交数据'):esc(m?.short?.explanation||'多项条件未同向确认')}</div>
        <div class="classic-future-foot">公开成交持续接收，2H K线按收盘更新。80分为规则评分，非成功率。</div>
      </section>
      <section class="classic-flows" id="classicFlowArea"><div class="classic-muted" id="classicFlowAge">等待实时成交统计</div>
        <div class="classic-section-row"><strong>大户实时买卖额</strong><span>单笔 &gt; 100万计价币种单位</span></div>
        <div class="classic-line">主动买入 ${large.covered?classicNumber(largeBuy):'—'} ${esc(d.quoteAsset||'USDT')} / 主动卖出 ${large.covered?classicNumber(largeSell):'—'} ${esc(d.quoteAsset||'USDT')}</div>
        <div class="classic-muted">${nextClear} 整点清零 · ${large.covered?'已收到真实成交，本小时累计（非全市场数据）':esc(large.reason||'等待公开成交数据流')}</div>
        <div class="classic-muted">盘中资金活跃度 · ${m?.ready?esc(m.activity||'数据不足'):'等待5分钟数据'}</div>
        <div class="classic-line">近30秒（页面约1秒刷新） · 主动买 ${active30?pctText(pct30):'—'} / 主动卖 ${active30?pctText(100-pct30):'—'}</div>
        ${active30?`<div class="classic-liveflow-caption">近30秒公开成交（不设大单门槛）：${amount((recent?.buy||0)+(recent?.sell||0))} ${esc(d.quoteAsset||'USDT')} · ${liveCount} 条${m.sample30Partial?'（接入不足30秒）':''} · 更新于 ${classicStamp(m.latestAt)}</div>${sideBar(pct30)}`:`<div class="classic-muted">${esc(m?.reason||'等待连续30秒有效成交')}</div>`}
        <div class="classic-line classic-strong">5分钟多空强度 · ${pct5===null||pct5===undefined?'数据不足':pct5>=60?'主动买占优':pct5<=40?'主动卖占优':'中性'}</div>
        <div class="classic-line classic-strong">10分钟五合约样本情绪（名义额合计，未换汇） · ${sentiment}</div>
        <div class="classic-line">看多强度 ${longStrength??'—'} / 看空强度 ${shortStrength??'—'} （满分100） · ${tm(p?.updatedAt)}</div>
        <div class="classic-line classic-factor-line">${classicFactors(d)}</div>
        <div class="classic-line">每10分钟评估 · 30分钟方向命中 ${aligned}/${checked} 笔（积累样本中）</div>
      </section>
      ${classicLarge(m)}
      <div class="classic-extra"><strong>2小时主信号：</strong>${d.ready?esc(direction(d.direction)):'尚未确认'} · ${d.selected?'多条件筛选通过':d.multi?'多形态待复核':'未达到精选条件'}<br>2小时成交量相对20根均量 ${d.volumeRatio==null?'—':n(d.volumeRatio,2)+'倍'} · 点差 ${d.spreadPct==null?'—':n(d.spreadPct,3)+'%'}</div>
      <div class="classic-warning">数据仅覆盖实际接入并持续监测的合约，不是全部成交。公开聚合成交无法判定大户身份；规则强度不是胜率。本页面不执行交易。</div>
    </div>`;
    body.scrollTop=hold;paintClassicAge();
  }
  function openClassicModal(){
    store.classicOpen=true;classicLiveGeneration++;classicLive=null;
    clearInterval(classicLiveTimer);clearInterval(classicAgeTimer);
    $('classicBackdrop').hidden=false;
    document.body.classList.add('classic-open');
    renderClassicDetail();
    $('classicClose').focus({preventScroll:true});
    void refreshClassicLive();classicLiveTimer=setInterval(refreshClassicLive,1000);classicAgeTimer=setInterval(paintClassicAge,250);
  }
  function closeClassicModal(){
    store.classicOpen=false;classicLiveGeneration++;classicLive=null;clearInterval(classicLiveTimer);clearInterval(classicAgeTimer);
    $('classicBackdrop').hidden=true;
    document.body.classList.remove('classic-open');
  }

  function renderDetail(){const d=store.detail;if(!d||d.symbol!==store.symbol)return;
    $('detailTitle').textContent=d.displaySymbol||d.symbol;
    $('detailLabel').textContent=d.ready?'2H 已确认':'2H 数据待确认';
    const names=d.matches?.flatMap(x=>x.names.map(name=>`<span class="tag ${cls(x.direction)}">${esc(name)} · ${direction(x.direction)}</span>`))||[];
    const meta=store.favoriteMeta[d.symbol],added=meta?.at?`收藏于 ${tm(meta.at)} · 当时价格 ${price(meta.price)}`:'未收藏';
    $('detailContent').innerHTML=`<div class="detail-content">
      <div class="detail-price-line"><div><div class="detail-price">${price(d.price)}</div><div class="detail-desc">${esc(d.exchangeLabel)} · ${d.stale?'报价较旧，暂停精选判断':'报价时间 '+since(d.priceAt)}</div></div><span class="tag ${cls(d.direction)}">${direction(d.direction)}</span></div>
      <h3 class="detail-section-title">已保存信号与价格差</h3>${favoriteSnapshot(d)}
      ${verificationBlock(d)}
      <div class="info-grid"><div class="info-cell"><span>最后 2H 收盘</span><strong>${tm(d.closedAt)}</strong></div><div class="info-cell"><span>形态确认状态</span><strong>${d.ready?'真实K线已确认':'待最新已收盘K线'}</strong></div>
      <div class="info-cell"><span>成交量 / 20根均量</span><strong>${d.volumeRatio==null?'—':n(d.volumeRatio,2)+' 倍'}</strong></div><div class="info-cell"><span>盘口点差</span><strong>${d.spreadPct==null?'待盘口报价':n(d.spreadPct,3)+'%'}</strong></div></div>
      <h3 class="detail-section-title">2 小时 K 线形态</h3><div class="detail-tags">${names.length?names.join(''):`<span class="tag">${esc(d.reason||'暂无形态')}</span>`}</div>
      <div class="signal-card"><strong>${d.selected?'已通过精选复核':d.multi?'同向多个形态，仍待其他条件确认':'暂未通过精选条件'}</strong><p>筛选需要多形态、较新的行情和盘口、成交量与价格位置条件同时满足。形态出现不等于入场许可。</p></div>
      <h3 class="detail-section-title">最近已收盘 2 小时 K 线</h3>${chartSvg(d.charts?.[120])}<div class="detail-desc">图表只包含已确认收盘的历史K线。未收盘数据不参加形态判断。</div>
      <h3 class="detail-section-title">未来2分钟方向 · 短时辅助观察</h3>${shortBlock(d.micro)}
      <h3 class="detail-section-title">盘中主动成交与资金活跃度</h3>${activityBlock(d.micro)}
      <h3 class="detail-section-title">10分钟五合约样本情绪（名义额合计，未换汇）</h3>${marketPulseBlock(store.snap?.marketPulse)}
      <h3 class="detail-section-title">多因子趋势条件</h3>${factorBlock(d)}
      <h3 class="detail-section-title">大户实时买卖额 · 百万计价币种单位门槛</h3>${tradeInfo(d.largeTrades)}
      <h3 class="detail-section-title">大额实时买卖 · 10万计价币种单位门槛</h3>${microLargeBlock(d.micro)}
      <div class="detail-desc">${esc(added)} · 短时指标独立于2H主信号，数据缺失时不输出推测值。</div>
      <div class="disclaimer">交易所公开数据无法证明某笔成交来自哪个“大户”，也不能准确预测下一根K线。该页面不执行买卖、不显示未经验证的胜率。</div>
    </div>`;
    renderClassicDetail();
  }
  async function refreshDetail(){const symbol=store.symbol;
    try{const detail=await get('/api/pro2/detail?symbol='+encodeURIComponent(symbol));if(symbol!==store.symbol)return;store.detail=detail;store.lastDetail=Date.now();renderDetail()}
    catch(e){$('detailLabel').textContent='详情读取失败';console.warn(e)}}
  async function refresh(){if(store.fetching)return;store.fetching=true;
    try{const data=await get('/api/pro2/snapshot');if(!data||data.intervalMinutes!==120)throw Error('返回的不是2小时信号接口');
      store.snap=data;store.errors=0;
      if(!data.symbols.some(x=>x.symbol===store.symbol)&&data.symbols.length){store.symbol=data.symbols.find(x=>x.symbol==='BTCUSDT')?.symbol||data.symbols[0].symbol;store.lastDetail=0}
      renderOverview();renderMarkets();renderAlerts();
      if(Date.now()-store.lastDetail>4000)void refreshDetail();
    }catch(e){store.errors++;$('live').classList.remove('good');$('live').innerHTML='<i></i>数据待连接';
      $('notice').classList.add('warning');$('noticeText').textContent='2小时行情接口请求失败（'+esc(e.message)+'）。将自动重试；无法确认数据时不生成信号。';
    }finally{store.fetching=false}}
  $('tabs').addEventListener('click',e=>{const btn=e.target.closest('[data-filter]');if(!btn)return;
    store.filter=btn.dataset.filter;store.max=100;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===btn));renderMarkets()});
  $('search').addEventListener('input',e=>{store.query=e.target.value.trim().toLowerCase();store.max=100;renderMarkets()});
  $('exchange').addEventListener('change',e=>{store.exchange=e.target.value;store.max=100;renderMarkets()});
  $('more').addEventListener('click',()=>{store.max+=100;renderMarkets()});
  $('markets').addEventListener('click',e=>{const pin=e.target.closest('[data-pin]');if(pin){e.stopPropagation();togglePin(pin.dataset.pin);return}
    const fav=e.target.closest('[data-fav]');if(fav){e.stopPropagation();toggleFavorite(fav.dataset.fav);return}
    const item=e.target.closest('[data-row]');if(!item)return;store.symbol=item.dataset.row;store.lastDetail=0;renderMarkets();openClassicModal();void refreshDetail();
    if(window.innerWidth<1050)$('detailSection').scrollIntoView({block:'start',behavior:'smooth'});
  });
  $('markets').addEventListener('keydown',e=>{if(e.target.closest('button'))return;if(e.key==='Enter'||e.key===' '){e.preventDefault();e.target.closest('[data-row]')?.click()}});
  $('classicClose').addEventListener('click',closeClassicModal);
  $('classicBackdrop').addEventListener('click',e=>{if(e.target===$('classicBackdrop'))closeClassicModal()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&store.classicOpen)closeClassicModal()});
  $('classicOpen').addEventListener('click',openClassicModal);
  // SSR is independent of the 2H model. Only actual elapsed public trades are displayed.
  const swingDialog=$('swingDialog');let swingTimer=null,swingBusy=false,swingGeneration=0,quoteTimer=null,quoteAgeTimer=null,quoteBusy=false,swingQuote=null,quoteReceivedMono=0,quoteRoundTrip=0;
  const swingNum=(x,d=3)=>x==null||!Number.isFinite(x)?'—':n(x,d);
  const swingPct=x=>x==null?'—':(x>0?'+':'')+swingNum(x)+'%';

  function renderSwingQuote(){
    const p=$('swingLivePrice'),note=$('swingQuoteStatus');
    if(!p||!note)return;
    const q=swingQuote;
    if(!q||q.symbol!==store.symbol||!Number.isFinite(q.ageMs)||!(q.price>0)){
      p.textContent='—';p.style.color='';note.textContent='等待独立公开报价';return;
    }
    const age=q.ageMs+Math.max(0,performance.now()-quoteReceivedMono)+quoteRoundTrip/2;
    const fresh=q.fresh&&age<=2500;
    p.textContent=price(q.price);p.style.color=fresh?'':'#a36b20';
    const source=q.source==='aggTrade'?'最新公开成交':'公开行情报价（非成交时间）';
    note.textContent=(fresh?'':'报价延迟 · ')+source+' · '+new Date(q.at).toLocaleTimeString('zh-CN',{hour12:false})+' · 估计延迟 '+(age/1000).toFixed(1)+'秒';
    note.style.color=fresh?'':'#a36b20';
  }
  async function refreshSwingQuote(){
    if(!swingDialog.open||quoteBusy||document.visibilityState!=='visible')return;
    const generation=swingGeneration,symbol=store.symbol,start=performance.now(),controller=new AbortController();
    quoteBusy=true;const timer=setTimeout(()=>controller.abort(),2500);
    try{
      const res=await fetch('/api/pro2/quote?symbol='+encodeURIComponent(symbol),{cache:'no-store',signal:controller.signal});
      if(res.status===401){window.location.replace('/login');return}
      if(!res.ok)throw Error('报价接口不可用');
      const q=await res.json(),end=performance.now();
      if(swingDialog.open&&generation===swingGeneration&&symbol===store.symbol&&q.symbol===symbol){
        swingQuote=q;quoteReceivedMono=end;quoteRoundTrip=end-start;renderSwingQuote();
      }
    }catch{if(generation===swingGeneration)renderSwingQuote()}
    finally{clearTimeout(timer);quoteBusy=false}
  }



  function swingStudies(v){
    const d=v.shortStudy;
    const header='<section class="swing-card swing-study"><h3>五模型 · 历史结果</h3>';
    if(!d?.supported)return header+'<p>'+esc(d?.reason||'等待研究接口')+'</p></section>';
    if(!Array.isArray(d.models)||d.models.length!==5)return header+'<p>研究数据尚未就绪</p></section>';
    const f=x=>Number.isFinite(x)?swingNum(x,3)+'%':'—';
    const stamp=x=>Number.isFinite(x)&&x>0?new Date(x).toLocaleTimeString('zh-CN',{hour12:false}):'—';
    const rows=d.models.map((m,i)=>{
      const counts=Number.isFinite(m.samples)?m.samples:0,last=m.lastCompleted;
      const valid=last&&Number.isFinite(last.change)&&['回升','回落'].includes(last.direction);
      const observed=valid?(last.change>.005?'同向':last.change<-.005?'反向':'平坦'):'暂无结果';
      const risk=!d.enabled?'研究暂停':!d.fresh?'成交延迟/不足':m.code==='ofi'&&!d.bookFresh?'盘口待更新':counts===0?'样本不足':m.code==='ofi'?'快照近似':'规则未验证';
      const note=valid?last.direction+'观察 · '+observed+' '+f(last.change):'尚无已完成观察';
      const regime=m.code==='vwap'?'<p>震荡 / 方向性样本：'+esc(m.byRegime?.['震荡']?.samples??0)+' / '+esc(m.byRegime?.['方向性']?.samples??0)+'</p>':'';
      return '<details class="swing-mini-model" data-swing-fold="model-'+esc(m.code)+'"><summary><div><b>'+String(i+1).padStart(2,'0')+' · '+esc(m.label)+'</b><small>'+esc(note)+'</small></div><span class="swing-mini-meta"><b>'+esc(counts)+'笔</b><small>'+esc(risk)+'</small></span></summary><div class="swing-mini-detail"><p>'+esc(m.status||'等待样本')+' · '+esc(m.note)+'</p><div class="swing-study-grid"><div>同向 / 反向 / 平坦<strong>'+esc(m.aligned??0)+' / '+esc(m.opposite??0)+' / '+esc(m.flat??0)+'</strong></div><div>历史同向比例<strong>'+f(m.alignment)+'</strong></div><div>平均同向变化<strong>'+f(m.mean)+'</strong></div><div>作废样本<strong>'+esc(m.invalid??0)+'</strong></div></div><p>最近完成 '+stamp(m.lastCompletedAt)+'</p>'+regime+'</div></details>';
    }).join('');
    return header+'<p>BTCUSDT · 60秒历史观察 · '+(!d.enabled?'研究暂停':d.fresh?'成交采集正常':'数据待更新')+' · '+stamp(d.latestAt)+'</p>'+rows+'<p>最近完成结果不表示当前走势。各模型未校准风险概率；同向比例不是交易胜率。</p></section>';
  }


  function swingFollowCard(v){
    const f=v.follow;
    if(!f)return '<section class="swing-card"><h3>60秒观察记录</h3><p>等待追踪接口</p></section>';
    const p=f.active,last=f.last,st=f.stats||{};
    const labels={paused:'观察已暂停',checking:'待确认 · 连续样本检查',observing:'已确认变化 · 持续观察',lost:'原条件已失效 · 保留记录',gap:'数据中断 · 等待复核',reviewed:'历史结果已复核',waiting:'等待已发生的转折'};
    const stamp=t=>Number.isFinite(t)&&t>0?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'—';
    const dir=x=>x?.direction===1?'回升':x?.direction===-1?'回落':'—';
    const sec=x=>Number.isFinite(x)?swingNum(x/1000,1)+'秒':'—';
    const elapsed=p?Math.max(0,Math.min(60,Number(p.elapsedSeconds)||0)):last&&last.reason==='complete'?60:0;
    const result=r=>!r?'暂无':r.reason==='gap'?'断流作废':r.reason==='restart'?'重启作废':r.signed>.005?'同向变化':r.signed<-.005?'反向变化':'基本不变';
    return '<section class="swing-card swing-follow"><h3>四阶段 · 60秒追踪</h3><p class="swing-follow-state">'+esc(labels[f.stage]||'等待数据')+'</p><div class="swing-follow-steps"><span>待确认</span><span>确认变化</span><span>60秒观察</span><span>结果复核</span></div>'+(p?'<div class="swing-follow-time">'+elapsed+' / 60秒</div><div class="swing-follow-track"><i style="width:'+elapsed/60*100+'%"></i></div><p>已观察类别 '+dir(p)+' · 首次采样 '+stamp(p.firstAt)+' · 确认 '+stamp(p.confirmedAt)+'</p><p>记录参考价 '+price(p.reference)+' · '+(p.lostAt?esc(p.lossReason)+'（'+stamp(p.lostAt)+'）':f.stage==='gap'?'数据未更新':'仅持续记录，不代表走势持续')+'</p>':'')+(last?'<p>最近完成：'+dir(last)+' · '+esc(result(last))+' · '+(Number.isFinite(last.change)?swingPct(last.change):'—')+' · '+stamp(last.endedAt)+'</p>':'<p>暂无完成的60秒记录</p>')+'<details data-swing-fold="follow"><summary><b>持续时间与历史复核</b><span class="swing-fold-hint">详情 ›</span></summary><div class="swing-study-grid"><div>完成 / 中断<strong>'+esc(st.completed??0)+' / '+esc(st.interrupted??0)+'</strong></div><div>同向 / 反向 / 平坦<strong>'+esc(st.aligned??0)+' / '+esc(st.opposite??0)+' / '+esc(st.flat??0)+'</strong></div><div>原条件保持60秒<strong>'+esc(st.kept??0)+'笔</strong></div><div>原条件提前失效<strong>'+esc(st.conditionLost??0)+'笔</strong></div><div>平均确认耗时<strong>'+sec(st.meanConfirmMs)+'</strong></div><div>平均条件保持时长<strong>'+sec(st.meanConditionMs)+'</strong></div></div>'+ (f.history||[]).map(r=>'<div class="swing-history-row"><span>'+stamp(r.endedAt)+' · '+dir(r)+'</span><b>'+esc(result(r))+' / '+sec(r.conditionMs)+'</b></div>').join('')+'</details><p>原识别条件失效即标记，仍可记录实际60秒结果；不是交易信号或有效期保证。</p></section>';
  }


  function swingHorizonAudit(v){
    const d=v.horizonAudit;
    if(!d)return '<section class="swing-card"><h3>2—5分钟复核</h3><p>新增周期验证仅覆盖 BTCUSDT。</p></section>';
    const f=x=>Number.isFinite(x)?swingNum(x,3)+'%':'—';
    const stamp=x=>Number.isFinite(x)&&x>0?new Date(x).toLocaleTimeString('zh-CN',{hour12:false}):'—';
    const recent=d.enabled&&d.latestAt&&d.serverAt-d.latestAt<=6000;
    const rows=(d.models||[]).map(m=>'<details class="swing-mini-model" data-swing-fold="horizon-'+esc(m.code)+'"><summary><div><b>'+esc(m.label)+'</b><small>2 / 3 / 4 / 5分钟：'+m.windows.map(w=>esc(w.n)).join(' / ')+' 笔已完成</small></div><small>'+(!d.enabled?'研究暂停':!recent?'数据待更新':m.pending?'采样中':'等待样本')+'</small></summary><div class="swing-table-scroll"><table class="swing-mini-table"><thead><tr><th>周期</th><th>样本</th><th>同向/反向/平</th><th>平均同向变化</th><th>平均最大反向</th><th>未明显反向</th><th>作废</th></tr></thead><tbody>'+m.windows.map(w=>'<tr><td>'+w.minute+'分</td><td>'+w.n+'</td><td>'+w.same+'/'+w.opposite+'/'+w.flat+'</td><td>'+f(w.mean)+'</td><td>'+f(w.meanAdverse)+'</td><td>'+w.held+'</td><td>'+w.interrupted+'</td></tr>').join('')+'</tbody></table></div><p>重叠事件跳过 '+esc(m.skipped??0)+' 笔。样本未完成不计入统计。</p></details>').join('');
    return '<section class="swing-card"><h3>2—5分钟 · 实际延续复核</h3><p>'+(!d.enabled?'复核已暂停：'+esc(d.error||'未启用'):recent?'公开成交持续采集':'等待有效成交')+' · '+stamp(d.latestAt)+'</p><p>六类研究同时采用固定2、3、4、5分钟窗口，不用事后最有利的价格选周期。</p>'+rows+'<p>未明显反向：已完成窗口内反向位移不超过0.005%，且结束时同向位移超过0.005%。这是研究统计，不表示下一次走势或预计结束时间。</p></section>';
  }


  function swingClosedLab(v){
    const d=v.closedLab,guard=d?.lossGuard;
    if(!d)return '<section class="swing-card"><h3>模拟阈值 · 历史复核</h3><p>仅 BTCUSDT 四类原模型的已完成样本。</p></section>';
    const signed=x=>Number.isFinite(x)?(x>0?'+':'')+x.toFixed(2)+' U':'—';
    const stamp=t=>Number.isFinite(t)?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'—';
    const rows=(d.history||[]).map(x=>'<div class="swing-closed-row"><div><b>'+esc(x.label)+'</b><small>'+stamp(x.exitAt)+' · 已完成 · '+(x.reason==='tp'?'历史正阈值触及':'历史负阈值触及')+'</small></div><div class="swing-closed-prices"><span>历史参考价<strong>'+price(x.entry)+'</strong></span><span>实际结束价<strong>'+price(x.exit)+'</strong></span><span>观测理论结果<strong>'+signed(x.observedPnl)+'</strong></span></div></div>').join('');
    const state=!d.enabled?'模拟数据暂不可用':guard?.stoppedAt?'模拟累计净亏损达到上限 · 已停止新增':'仅后台模拟研究';
    return '<section class="swing-card"><h3>模拟止盈止损 · 历史复核</h3><p><b>'+esc(state)+'</b></p>'+(guard?'<p>四账本累计理论净盈亏 '+signed(guard.net)+' · 模拟停止上限 '+esc(guard.limit)+' U</p>':'')+(rows?rows:'<p>暂无完整阈值触及记录</p>')+'<p>仅显示已经结束的研究记录，不生成当前进场、止盈或止损指令。理论结果未计实际费用、滑点及强平。</p></section>';
  }


  function swingHistoricalPrices(v){
    const d=v.closedLab,history=Array.isArray(d?.history)?d.history:[];
    const last=history.find(x=>Number.isFinite(x.entry)&&x.entry>0&&Number.isFinite(x.exit)&&x.exit>0&&['tp','sl'].includes(x.reason));
    const stamp=t=>Number.isFinite(t)&&t>0?new Date(t).toLocaleString('zh-CN',{hour12:false}):'—';
    const cell=(label,value)=>'<div><small>'+label+'</small><strong>'+ (Number.isFinite(value)&&value>0?price(value):'—')+'</strong></div>';
    return '<section class="swing-card swing-history-prices"><div class="swing-stage-caption">已结束模拟 · 非当前下单价格</div><div class="swing-history-price-grid">'+cell('模拟参考价',last?.entry)+cell('止盈复核价',last?.reason==='tp'?last.exit:null)+cell('止损复核价',last?.reason==='sl'?last.exit:null)+'</div><p>'+ (last?esc(last.label)+' · '+stamp(last.exitAt)+' 已结束 · '+(last.reason==='tp'?'仅触及正向阈值':'仅触及反向阈值'):v.symbol!=='BTCUSDT'?'此合约暂无对应模拟记录':'暂无完整历史阈值记录')+'</p></section>';
  }


  let swingFullView='overview',swingFullData=null;
  function swingDashboard(v){
    const d=v.horizonAudit,short=v.shortStudy,phase=v.ready?v.phase:null,code=phase?.code||'waiting',risk=v.risk||{};
    const observed=/^(up|down)_(early|elapsed)$/.test(code);
    const stage=observed?(code.startsWith('up')?'回升':'回落')+(code.endsWith('_early')?' · 已观察起步':' · 已发生变化'):code==='neutral'?'尚未确认转折':'等待有效样本';
    const riskLabels={low:'已观测异常较少',medium:'中风险警示',high:'高风险警示',unknown:'风险未评估'};
    const level=Object.hasOwn(riskLabels,risk.level)?risk.level:'unknown';
    const riskNotes=(risk.checks||[]).filter(x=>x.level==='high'||x.level==='medium').slice(0,2).map(x=>esc(x.name)).join(' · ');
    const f=v.follow,active=f?.active,elapsed=active?Math.max(0,Math.min(60,Number(active.elapsedSeconds)||0)):null;
    const fLabels={paused:'已暂停',checking:'待确认',observing:'持续观察',lost:'原条件失效',gap:'数据中断',reviewed:'历史已复核',waiting:'等待转折'};
    const definitions=[['ssr','原SSR'],['exhaustion','动能衰竭'],['failed_break','假突破回归'],['absorption','主动成交吸收'],['ofi','订单流失衡'],['vwap','VWAP均值回归']];
    const fresh=!!(d?.enabled&&d.latestAt&&d.serverAt-d.latestAt<=6000&&d.latestAt<=d.serverAt+1000);
    const pct=x=>Number.isFinite(x)?swingNum(x,2)+'%':'—';
    const models=definitions.map(([key,name])=>{
      const m=d?.models?.find(x=>x.code===key),sm=short?.models?.find(x=>x.code===key);
      const last=sm?.lastCompleted;
      const note=!d?'无独立样本':!d.enabled?'研究暂停':!fresh?'数据待更新':key==='ofi'&&!short?.bookFresh?'盘口待更新':last&&Number.isFinite(last.change)?'历史 '+esc(last.direction)+' · '+(last.change>.005?'同向':last.change<-.005?'反向':'平坦'):key==='ssr'?'独立历史复核':'样本未验证';
      const cells=[2,3,4,5].map(minute=>{const w=m?.windows?.find(x=>x.minute===minute);
        return '<td>'+(w?.n?'<b>'+esc(w.same)+'/'+esc(w.n)+'</b><small>'+pct(w.meanAdverse)+'</small>':'—')+'</td>';
      }).join('');
      return '<tr><th scope="row"><button type="button" data-swing-screen="models"><b>'+name+'</b><small>'+note+'</small></button></th>'+cells+'</tr>';
    }).join('');
    const periods=[1,3,5].map(minutes=>{const r=v.periods?.find(x=>x.minutes===minutes),ok=v.ready&&r?.ready;
      return '<tr><th scope="row">'+minutes+'分</th><td>'+(ok?swingPct(r.change):'—')+'</td><td>'+(ok?swingPct(r.rebound):'—')+'</td><td>'+(ok?swingPct(r.pullback):'—')+'</td><td>'+(ok&&r.buyPct!=null?pct(r.buyPct):'—')+'</td></tr>';
    }).join('');
    const dLab=v.closedLab,guard=dLab?.lossGuard,last=(dLab?.history||[]).find(x=>Number.isFinite(x.entry)&&x.entry>0&&Number.isFinite(x.exit)&&x.exit>0&&['tp','sl'].includes(x.reason));
    const priceCell=(label,x)=>'<div><small>'+label+'</small><b>'+ (Number.isFinite(x)&&x>0?price(x):'—')+'</b></div>';
    const stamp=t=>Number.isFinite(t)&&t>0?new Date(t).toLocaleString('zh-CN',{hour12:false}):'—';
    return '<div class="swing-dashboard">'+
      '<section class="sd-quote"><div class="sd-quote-line"><span>'+esc(v.symbol||store.symbol)+' · 公开行情</span><strong id="swingLivePrice">—</strong></div><div id="swingQuoteStatus">等待独立公开报价</div></section>'+
      '<section class="sd-box sd-historical"><button class="sd-section-title" type="button" data-swing-screen="prices">已结束模拟 · 历史价格 <span>详情 ›</span></button><div class="sd-prices">'+priceCell('模拟参考价',last?.entry)+priceCell('止盈复核价',last?.reason==='tp'?last.exit:null)+priceCell('止损复核价',last?.reason==='sl'?last.exit:null)+'</div><div class="sd-foot">'+(last?esc(last.label)+' · '+stamp(last.exitAt):'暂无对应历史记录')+(guard?.stoppedAt?' · 模拟已停止新增':'')+'</div></section>'+
      '<div class="sd-state-grid"><button type="button" data-swing-screen="risk" class="sd-box sd-risk sd-risk-'+level+'"><small>已观测风险 ›</small><b>'+riskLabels[level]+'</b><small>'+ (riskNotes||'仅评估已观测项目')+'</small></button><button type="button" data-swing-screen="stage" class="sd-box sd-stage"><small>原SSR · 已发生阶段 ›</small><b>'+esc(stage)+'</b><small>前：未确认　中：'+(observed?'已观察':'未确认')+'　后：未确认</small></button></div>'+
      '<button type="button" class="sd-box sd-follow" data-swing-screen="follow"><span>60秒追踪 · '+esc(fLabels[f?.stage]||'等待数据')+'</span><b>'+(elapsed===null?'—':elapsed+'/60秒')+' ›</b></button>'+
      '<section class="sd-box sd-models"><button class="sd-section-title" type="button" data-swing-screen="models">六模型 · 2–5分钟历史复核 <span>详情 ›</span></button><div class="sd-foot">同向/完成笔数 · 下方小字为平均最大反向幅度</div><table class="sd-table"><thead><tr><th scope="col">模型</th><th scope="col">2分</th><th scope="col">3分</th><th scope="col">4分</th><th scope="col">5分</th></tr></thead><tbody>'+models+'</tbody></table></section>'+
      '<section class="sd-box sd-periods"><button class="sd-section-title" type="button" data-swing-screen="periods">1 / 3 / 5分钟已发生变化 <span>详情 ›</span></button><table class="sd-table"><thead><tr><th scope="col">周期</th><th scope="col">涨跌</th><th scope="col">回升</th><th scope="col">回落</th><th scope="col">主动买</th></tr></thead><tbody>'+periods+'</tbody></table></section>'+
      '<div class="sd-bottom"><span>只读研究 · 历史结果非交易信号</span><button type="button" data-swing-screen="history">历史区间 ›</button></div></div>';
  }

  function swingRender(v){
    swingFullData=v;
    const body=$('swingBody'),scroll=body.scrollTop,expanded=new Set([...body.querySelectorAll('details[open][data-swing-fold]')].map(x=>x.dataset.swingFold));
    const phase=v.ready?v.phase:null,code=phase?.code||'waiting';
    const observed=/^(up|down)_(early|elapsed)$/.test(code);
    const early=observed&&code.endsWith('_early'),dir=observed?(code.startsWith('up')?'回升':'回落'):'';
    const label=observed?dir+(early?' · 已观察起步':' · 已发生一段变化'):code==='neutral'?'尚未确认转折':'等待有效数据';
    const risk=v.risk||{level:!v.ready&&/延迟|断开|不可用|异常/.test(v.reason||'')?'high':'unknown',checks:[]};
    const riskLabels={low:'已观测异常较少',medium:'中风险警示',high:'高风险警示',unknown:'风险未评估'};
    const level=Object.hasOwn(riskLabels,risk.level)?risk.level:'unknown';
    const checks=Array.isArray(risk.checks)?risk.checks:[];
    const alerts=checks.filter(x=>x.level==='high'||x.level==='medium').sort((a,b)=>Number(b.level==='high')-Number(a.level==='high'));
    const riskSummary=alerts.length?alerts.slice(0,3).map(x=>esc(x.name)).join(' · '):level==='unknown'?'证据不足，不能判断风险':level==='low'?'仅代表已观测项目':'详见风险复核';
    const riskCard='<details class="swing-card swing-risk swing-risk-'+level+'" data-swing-fold="risk"><summary class="swing-risk-summary"><div><div class="swing-stage-caption">已观测风险</div><h3>'+riskLabels[level]+'</h3><p>'+riskSummary+'</p></div><span class="swing-fold-hint">详情 ›</span></summary>'+checks.map(x=>'<div class="swing-risk-row"><div><b>'+esc(x.name)+'</b><small>'+esc(x.note)+'</small></div><span class="swing-risk-tag-'+(Object.hasOwn(riskLabels,x.level)?x.level:'unknown')+'">'+(riskLabels[x.level]||riskLabels.unknown)+'</span></div>').join('')+'<p>仅评估已观测异常，不代表开仓安全或未来亏损概率。</p></details>';
    const stage='<section class="swing-card swing-stage swing-compact-stage"><div class="swing-stage-caption">原 SSR · 已发生阶段</div><h3>'+esc(label)+'</h3><div class="swing-stage-strip"><div><b>前</b><small>不提前确认</small></div><div class="'+(observed?'swing-stage-active':'')+'"><b>中</b><small>'+esc(observed?(early?'已观察起步':'已发生变化'):'尚未确认')+'</small></div><div><b>后</b><small>结束未确认</small></div></div>'+(observed?'<div class="swing-stage-foot">距采样转折 '+esc(phase.ageSeconds)+'秒 · 已发生变化 '+swingPct(phase.change)+'</div>':'')+'<p>'+esc(phase?.reason||v.reason||'等待有效样本')+'</p></section>';
    const rows=[1,3,5].map(minutes=>{const r=v.periods?.find(x=>x.minutes===minutes);
      return '<tr><td>'+minutes+'分钟</td><td>'+ (v.ready&&r?.ready?swingPct(r.change):'—')+'</td><td>'+(v.ready&&r?.ready?swingPct(r.rebound):'—')+'</td><td>'+(v.ready&&r?.ready?swingPct(r.pullback):'—')+'</td><td>'+(v.ready&&r?.ready&&r.buyPct!=null?swingNum(r.buyPct,1)+'%':'—')+'</td></tr>';
    }).join('');
    const blocks=v.ready&&v.blocks?.length?v.blocks.map(x=>'<div class="swing-history-row"><span>'+tm(x.from)+'–'+tm(x.to)+'</span><b>'+swingPct(x.change)+' / '+swingPct(x.range)+'</b></div>').join(''):'<p>连续样本不足</p>';
    const periodDetails='<section class="swing-card"><h3>1 / 3 / 5分钟实际变化</h3><div class="swing-table-scroll"><table class="swing-mini-table"><thead><tr><th>周期</th><th>涨跌</th><th>回升</th><th>回落</th><th>主动买</th></tr></thead><tbody>'+rows+'</tbody></table></div></section>';
    const historyDetails='<section class="swing-card"><h3>历史5分钟区间复核</h3><p>已发生区间涨跌 / 振幅</p>'+blocks+'</section>';
    const views={risk:riskCard,stage,follow:swingFollowCard(v),prices:swingHistoricalPrices(v)+swingClosedLab(v),models:swingHorizonAudit(v)+swingStudies(v),periods:periodDetails,history:historyDetails};
    const main=swingFullView==='overview';
    body.classList.toggle('sd-overview',main);
    body.innerHTML=main?swingDashboard(v):'<button type="button" class="sd-back" data-swing-screen="overview">‹ 返回全屏总览</button>'+ (views[swingFullView]||views.models);
    for(const x of body.querySelectorAll('details[data-swing-fold]'))x.open=expanded.has(x.dataset.swingFold);
    if(swingFullView==='risk'){const r=body.querySelector('details[data-swing-fold="risk"]');if(r)r.open=true;}
    body.scrollTop=scroll;renderSwingQuote();
  }


  // Optional quiet reminder for completed five-minute research records only.
  // Never reacts to a live direction, a candidate event or a quotation.
  function completedReviewStamp(v){
    if(v?.symbol!=='BTCUSDT'||!Array.isArray(v.horizonAudit?.history))return null;
    return v.horizonAudit.history.reduce((n,r)=>r?.reason==='complete'&&r.minutes===5&&Number.isFinite(r.endedAt)&&r.endedAt>0&&r.endedAt<=v.horizonAudit.serverAt+1000?Math.max(n,r.endedAt):n,0);
  }
  let reviewSound=false,reviewAudio=null,reviewSeen=null,reviewLastNotice=0;
  const reviewToggle=$('swingReviewSound'),reviewNotice=$('swingReviewNotice');
  function paintReviewToggle(){reviewToggle.textContent=reviewSound?'提醒开':'提醒关';reviewToggle.setAttribute('aria-pressed',String(reviewSound));}
  function resetReviewReminder(){reviewSound=false;reviewSeen=null;reviewLastNotice=0;reviewNotice.hidden=true;reviewNotice.textContent='';paintReviewToggle()}
  reviewToggle.addEventListener('click',async()=>{
    if(reviewSound){reviewSound=false;reviewNotice.hidden=true;paintReviewToggle();return}
    const generation=swingGeneration;
    try{
      const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw Error('not supported');
      if(!reviewAudio||reviewAudio.state==='closed')reviewAudio=new Audio();
      if(reviewAudio.state!=='running')await reviewAudio.resume();
      if(!swingDialog.open||generation!==swingGeneration)return;
      if(reviewAudio.state!=='running')throw Error('audio unavailable');
      reviewSound=true;reviewSeen=completedReviewStamp(swingFullData);reviewNotice.textContent='已开启：5分钟复核完成时轻提示';reviewNotice.hidden=false;paintReviewToggle();
    }catch{reviewSound=false;paintReviewToggle();reviewNotice.textContent='声音不可用，请重新点击开启';reviewNotice.hidden=false}
  });
  function reviewCompleted(v){
    const latest=completedReviewStamp(v);
    if(latest===null)return;
    const prev=reviewSeen;reviewSeen=prev===null?latest:Math.max(prev,latest);
    if(!reviewSound||prev===null||latest<=prev||document.visibilityState!=='visible'||!swingDialog.open)return;
    const t=Date.now();
    if(t-reviewLastNotice<60000)return;
    reviewLastNotice=t;reviewNotice.textContent='已有新的5分钟历史复核结果';reviewNotice.hidden=false;
    if(reviewAudio?.state!=='running')return;
    try{
      const at=reviewAudio.currentTime,o=reviewAudio.createOscillator(),g=reviewAudio.createGain();
      o.type='sine';o.frequency.value=523.25;g.gain.setValueAtTime(.0001,at);g.gain.exponentialRampToValueAtTime(.045,at+.035);g.gain.exponentialRampToValueAtTime(.0001,at+.22);
      o.connect(g);g.connect(reviewAudio.destination);o.start(at);o.stop(at+.23);
    }catch{}
  }

  async function refreshSwing(){if(!swingDialog.open||swingBusy)return;const generation=swingGeneration,symbol=store.symbol;swingBusy=true;
    try{const v=await get('/api/pro2/swing?symbol='+encodeURIComponent(symbol));if(swingDialog.open&&generation===swingGeneration&&symbol===store.symbol){reviewCompleted(v);swingRender(v)}}catch{if(swingDialog.open&&generation===swingGeneration)swingRender({symbol,ready:false,reason:'数据接口暂不可用，停止统计'})}finally{swingBusy=false}}
  $('swingBody').addEventListener('click',e=>{const btn=e.target.closest('[data-swing-screen]');if(!btn||!swingFullData)return;swingFullView=btn.dataset.swingScreen;swingRender(swingFullData);$('swingBody').scrollTop=0;});
  $('swingOpen').addEventListener('click',()=>{if(swingDialog.open)return;resetReviewReminder();swingFullView='overview';swingGeneration++;swingRender({symbol:store.symbol,ready:false,reason:'等待真实成交'});swingQuote=null;swingDialog.showModal();$('swingBody').scrollTop=0;void refreshSwingQuote();void refreshSwing();swingTimer=setInterval(refreshSwing,2000);quoteTimer=setInterval(refreshSwingQuote,500);quoteAgeTimer=setInterval(renderSwingQuote,250)});
  $('swingClose').addEventListener('click',()=>swingDialog.close());
  swingDialog.addEventListener('close',()=>{resetReviewReminder();swingGeneration++;clearInterval(swingTimer);clearInterval(quoteTimer);clearInterval(quoteAgeTimer);swingTimer=null;quoteTimer=null;quoteAgeTimer=null;swingQuote=null});

  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){if(swingDialog.open){void refreshSwingQuote();void refreshSwing()}if(store.classicOpen)void refreshClassicLive()}});
  void refresh();setInterval(refresh,9000);setInterval(()=>{if(store.snap&&Date.now()-store.lastDetail>=4700)void refreshDetail()},5000);
})();
