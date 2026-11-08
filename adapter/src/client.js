window.__ModuleLoader__.load({id:'@zoria-lind/dsh-ecolink-adapter',factory:require=>{
  const React=require('react'), h=React.createElement
  const KIND='ecolink-memory', PAGE=1500
  const control={color:'inherit',background:'var(--dsw-alias-bg-layer-2, transparent)',border:'1px solid var(--dsw-alias-border-l2, #8886)',borderRadius:6,padding:'5px 8px'}
  const HEADER_BUTTON_CSS = `
    .ecolink-header-button {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      height: 28px;
      padding: 0 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--dsw-alias-label-secondary, inherit);
      font: inherit;
      font-size: 12px;
      white-space: nowrap;
      cursor: pointer;
    }
    .ecolink-header-button:hover,
    .ecolink-header-button:focus-visible {
      background: var(--dsw-alias-interactive-bg-hover, #8882);
      color: var(--dsw-alias-label-primary, inherit);
    }
    .ecolink-header-button:focus-visible {
      outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
      outline-offset: 2px;
    }
    .ecolink-titlebar {
      position: fixed;
      top: calc((var(--dsh-windows-titlebar-height, 40px) - 28px) / 2);
      left: 152px;
      z-index: 1800;
      display: flex;
      align-items: center;
      gap: 4px;
      -webkit-app-region: no-drag;
      app-region: no-drag;
    }
    [data-windows-titlebar] .ecolink-titlebar {
      left: calc(var(--dsh-windows-menu-start, 48px) + var(--ecolink-windows-menu-width, 98px) + 6px);
    }
    .ecolink-shadow-actions { display: flex; gap: 4px; }
    .ecolink-shadow-notice {
      position: absolute;
      top: calc(100% + 7px);
      left: 0;
      white-space: nowrap;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--dsw-alias-bg-layer-2, Canvas);
      pointer-events: none;
    }
    .ecolink-web-surface {
      position: fixed;
      inset: 40px 0 0;
      z-index: 1799;
      background: var(--dsw-alias-bg-layer-1, Canvas);
    }
    .ecolink-web-surface[hidden] { display: none; }
    .ecolink-web-guest, .ecolink-web-guest webview { width: 100%; height: 100%; }
    .ecolink-web-error { position: absolute; top: 8px; left: 20px; }
  `
  async function api(args,method='GET',signal) {
    const path='api/ecolink'
    const response=await fetch(method==='GET'?`${path}?${new URLSearchParams(args)}`:path,
      {method,signal,headers:method==='POST'?{'Content-Type':'application/json'}:{},...(method==='POST'?{body:JSON.stringify(args)}:{})})
    const value=await response.json();if(!response.ok||value.error)throw new Error(value.error??'记忆请求失败');return value
  }
  async function shadowApi(args) {
    const response=await fetch('api/ecolink-shadow',{
      method:'POST',headers:{'Content-Type':'application/json','X-Ecolink-Shadow':'1'},body:JSON.stringify(args),
    })
    const value=await response.json()
    if(!response.ok)throw new Error(value.error??'影子会话请求失败')
    return value
  }
  function timeLabel(value) {
    const date=new Date(value)
    return value && Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'时间未知'
  }
  function Panel({sessionId,inputActions}) {
    const [q,setQ]=React.useState(''),[page,setPage]=React.useState(null),[selected,setSelected]=React.useState(null),
      [read,setRead]=React.useState(null),[state,setState]=React.useState(null),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false),
      [loading,setLoading]=React.useState(false),[offset,setOffset]=React.useState(0),[policy,setPolicy]=React.useState('all')
    const generation=React.useRef(0), selection=React.useRef(0), active=React.useRef(sessionId), previewAbort=React.useRef(null)
    active.current=sessionId
    const clearPreview=()=>{selection.current++;previewAbort.current?.abort();setSelected(null);setRead(null);setLoading(false);setOffset(0)}
    React.useEffect(()=>{
      generation.current++;clearPreview();setMessage('');setState(null);setPage(null);setBusy(false)
      return()=>{generation.current++;selection.current++;previewAbort.current?.abort()}
    },[sessionId])
    const list=async(start=0,revision,filter=policy)=>{const gen=++generation.current;try{
      const v=await api({action:'list',query:q,offset:start,...(filter==='all'?{}:{injectionPolicy:filter}),...(revision?{revision}:{})})
      if(gen===generation.current)setPage(v)
    }catch(e){if(gen===generation.current)setMessage(e.message)}}
    React.useEffect(()=>{list()},[sessionId])
    React.useEffect(()=>{
      const abort=new AbortController();const update=()=>{if(sessionId)api({action:'status',sessionId},'GET',abort.signal).then(value=>{if(!abort.signal.aborted&&active.current===sessionId)setState(value)}).catch(e=>{if(!abort.signal.aborted&&active.current===sessionId)setMessage(e.message)})}
      update();const timer=setInterval(update,2000);return()=>{abort.abort();clearInterval(timer)}
    },[sessionId])
    async function preview(e) {
      clearPreview();const n=selection.current,target=sessionId,abort=new AbortController();previewAbort.current=abort
      setSelected({...e,sessionId:target});setMessage('');setLoading(true)
      let content='',start=0,total
      try{
        while(true) {
          const v=await api({action:'read',ref:e.ref,version:e.version,offset:start,limit:4000},'GET',abort.signal)
          if(selection.current!==n||active.current!==target||abort.signal.aborted)return
          const length=Array.from(v.content??'').length,end=start+length
          if(v.offset!==start||typeof v.content!=='string'||!Number.isSafeInteger(v.totalChars)||end>v.totalChars||
            (total!==undefined&&total!==v.totalChars)||(v.version&&v.version!==e.version)||
            (v.nextOffset!==null&&(v.nextOffset!==end||end<=start))||(v.nextOffset===null&&end!==v.totalChars))throw new Error('正文分页不完整，请重新打开这条记忆')
          total=v.totalChars;content+=v.content
          setRead({...v,content,offset:0,complete:v.nextOffset===null})
          if(v.nextOffset===null)break
          start=v.nextOffset
        }
      }catch(err){if(selection.current===n&&active.current===target&&!abort.signal.aborted)setMessage(err.message)}
      finally{if(selection.current===n&&active.current===target)setLoading(false)}
    }
    async function mutate(action,partial=false) {
      const target=sessionId,e=selected,p=read
      if(!e||!target||e.sessionId!==target||!p?.complete)return
      setBusy(true);setMessage(action==='inject'?'正在保存注入选择…':'正在保存记忆类型…')
      try{
        const result=await api({action,sessionId:target,ref:e.ref,version:e.version,
          ...(action==='inject'?{partial,offset:partial?offset:0,limit:partial?Math.min(PAGE,p.totalChars-offset):p.totalChars}:
            {injectionPolicy:e.injectionPolicy==='universal'?'manual':'universal'})},'POST')
        if(active.current!==target)return
        if(action==='inject'){setState(result);setMessage(result.duplicate?'该版本/分段已排队或已进入上下文':'已加入当前对话的待注入队列；下次发送或模型下一安全步骤进入上下文。')}
        else {setMessage('类型已保存。通用只对新对话开局生效；当前对话可点击注入。');clearPreview();list()}
      }catch(e){if(active.current===target)setMessage(e.message)}finally{if(active.current===target)setBusy(false)}
    }
    const button=(text,onClick,disabled=false)=>h('button',{type:'button',onClick,disabled:busy||disabled,style:{...control,margin:'3px'}},text)
    const insertDraft=()=>{
      if(!read?.complete||active.current!==selected?.sessionId||!inputActions?.captureInsertion)return
      const ok=inputActions.insertText(read.content,inputActions.captureInsertion())
      setMessage(ok?'已带入当前对话草稿。':'当前草稿暂时无法编辑，请稍后重试。')
    }
    const refresh=()=>{clearPreview();setMessage('');list()}
    const filter=value=>{setPolicy(value);clearPreview();setMessage('');setPage(null);list(0,undefined,value)}
    const detail=()=>h('section',{'aria-label':'记忆完整正文','aria-busy':busy,style:{padding:'8px 0'}},
      loading&&h('p',{role:'status'},`正在加载正文${read?`：${Array.from(read.content).length} / ${read.totalChars} 字`:''}…`),
      read&&h('div',null,h('small',null,read.complete?`完整正文 · ${read.totalChars} 字`:'已加载的正文（尚未完整）'),
        h('pre',{tabIndex:0,style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'50vh',overflow:'auto',padding:8,border:'1px solid #8884',borderRadius:6}},read.content)),
      message&&h('p',{role:'status','aria-live':'polite'},message),
      ...(state?.items??[]).filter(i=>i.ref===selected?.ref&&i.version===selected?.version).map(i=>h('p',{key:i.token,role:'status'},i.status==='admitted'?'这条记忆已进入当前对话上下文':`这条记忆已排队${i.partial?'（所选分段）':''}，下次发送时注入当前对话`)),
      read?.complete&&h('div',null,
        button('注入全文',()=>mutate('inject'),!sessionId),
        window.dshDesktop?.browser?.acquireEcolink&&inputActions?.insertText&&button('带入草稿',insertDraft,!sessionId),
        button(selected.injectionPolicy==='universal'?'改为非通用':'改为通用',()=>mutate('policy')),
        read.totalChars>PAGE&&h('details',null,h('summary',null,'长文分段注入'),
          h('p',null,`当前段 ${offset+1}–${Math.min(offset+PAGE,read.totalChars)} / ${read.totalChars} 字`),
          h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:180,overflow:'auto'}},Array.from(read.content).slice(offset,offset+PAGE).join('')),
          button('上一段',()=>setOffset(Math.max(0,offset-PAGE)),offset===0),
          button('下一段',()=>setOffset(offset+PAGE),offset+PAGE>=read.totalChars),
          button('仅注入当前段',()=>mutate('inject',true),!sessionId))))
    return h('div',{style:{padding:12,overflow:'auto',height:'100%',boxSizing:'border-box',fontSize:13,color:'var(--dsw-alias-label-primary, inherit)'}},
      h('p',null,'记忆池 · 点开条目查看完整正文，再选择注入当前对话'),
      h('div',{'aria-label':'记忆类型',style:{display:'flex',gap:4,flexWrap:'wrap'}},...([['all','全部记忆'],['universal','通用记忆'],['manual','非通用记忆']].map(([value,label])=>h('button',{type:'button','aria-pressed':policy===value,disabled:busy,onClick:()=>filter(value),style:{...control,fontWeight:policy===value?700:400}},label)))),
      h('small',null,'最新在上 · 按新增或内容更新时间排序。通用记忆在新对话开局自动注入；两类记忆都可手动注入当前对话。'),
      message&&h('p',{role:'status','aria-live':'polite'},message),
      h('form',{onSubmit:e=>{e.preventDefault();refresh()},style:{display:'flex',gap:4,flexWrap:'wrap'}},
        h('input',{value:q,onChange:e=>setQ(e.target.value),placeholder:'搜索名称、池名或正文','aria-label':'搜索记忆',style:{...control,minWidth:0,flex:1}}),button('搜索 / 刷新',refresh)),
      !sessionId&&h('p',{role:'alert'},'请先打开目标对话，再注入记忆。'),
      page&&h('small',null,`共 ${page.total} 条 · 第 ${Math.floor(page.offset/10)+1} 页 / ${Math.max(1,Math.ceil(page.total/10))} 页`),
      page?.total===0&&h('p',null,'没有匹配的记忆。'),
      h('div',null,...(page?.items??[]).map(e=>h('div',{key:e.ref,style:{borderBottom:'1px solid #8885',padding:'8px 0'}},
        h('button',{type:'button',onClick:()=>preview(e),'aria-expanded':selected?.ref===e.ref,disabled:busy,style:{...control,width:'100%',textAlign:'left'}},`${e.key??e.id} · ${e.injectionPolicy==='universal'?'通用':'非通用'}`),
        h('div',null,e.pool,' · ',e.chars,' 字 · ',h('time',{dateTime:e.timestamp??undefined,title:'新增或内容更新时间'},timeLabel(e.timestamp))),
        selected?.ref===e.ref&&selected.sessionId===sessionId?detail():h('small',null,e.preview)))),
      page&&button('上一页',()=>{clearPreview();list(Math.max(0,page.offset-10),page.revision)},page.offset===0),
      page&&button('下一页',()=>{clearPreview();list(page.nextOffset,page.revision)},page.nextOffset===null),
      state&&h('div',null,state.notice,state.omitted>0&&h('p',null,`开局超预算未注入 ${state.omitted} 条`),
        ...state.items.map(i=>h('div',{key:i.token},`${i.status==='admitted'?'已进入上下文':'待注入'}${i.partial?'（部分正文）':''} · ${i.ref}`))))
  }
  let boundSessions=new Map()
  const badgeListeners=new Set()
  const subscribeBadges=listener=>{
    badgeListeners.add(listener)
    return ()=>badgeListeners.delete(listener)
  }
  const badgeSnapshot=()=>boundSessions
  function publishBadges(bindings) {
    const next=new Map(bindings.map(({sessionId,webId})=>[sessionId,webId]))
    if(next.size===boundSessions.size&&[...next].every(([id,webId])=>boundSessions.get(id)===webId))return
    boundSessions=next
    for(const listener of badgeListeners)listener()
  }
  function ShadowBadge({sessionId}) {
    const ids=React.useSyncExternalStore(subscribeBadges,badgeSnapshot)
    return ids.has(sessionId)&&h('span',{title:'影子会话','aria-label':'影子会话',style:{opacity:.75,flexShrink:0}},'⇄')
  }
  const webRoot='https://chat.deepseek.com'
  function guestPage(guest) {
    try {
      const url=new URL(guest.getURL())
      if(url.origin!==webRoot)return null
      return url
    } catch { return null }
  }
  const pageWebId=url=>/^\/(?:a\/chat\/s|chat)\/([a-zA-Z0-9_-]{8,128})\/?$/.exec(url?.pathname)?.[1]
  function DeepSeekSwitch({workspace}) {
    const bridge=window.dshDesktop?.browser
    const [shown,setShown]=React.useState(false),[started,setStarted]=React.useState(false)
    const [error,setError]=React.useState('')
    const [syncing,setSyncing]=React.useState(false),[shadowMessage,setShadowMessage]=React.useState(null)
    const host=React.useRef(null),controls=React.useRef(null),refreshJob=React.useRef(null)
    const bindingMap=React.useSyncExternalStore(subscribeBadges,badgeSnapshot)
    const selection=workspace.selection
    const subscribe=React.useCallback(listener=>selection.subscribe(listener),[selection])
    const selected=React.useCallback(()=>selection.getSnapshot().sessionId,[selection])
    const sessionId=React.useSyncExternalStore(subscribe,selected)
    const webId=bindingMap.get(sessionId)
    function finishJob(job,text) {
      if(refreshJob.current!==job)return
      clearTimeout(job.timeout)
      refreshJob.current=null
      setSyncing(false)
      setShadowMessage({sessionId:job.sessionId,text})
    }
    function requestRefresh(id,target) {
      if(refreshJob.current)return
      const job={sessionId:id,webId:target,requestId:crypto.randomUUID()}
      job.timeout=setTimeout(()=>finishJob(job,'刷新同步超时，请重试'),75000)
      refreshJob.current=job
      setShadowMessage(null)
      setSyncing(true)
      setStarted(true)
      controls.current?.openTarget()
    }
    React.useEffect(()=>{
      function keydown(event) {
        if(!event.isTrusted||!event.ctrlKey||event.shiftKey||event.altKey||event.metaKey||event.key.toLowerCase()!=='r')return
        const id=selected(),target=boundSessions.get(id)
        if(!shown&&!target)return
        event.preventDefault()
        event.stopImmediatePropagation()
        if(event.repeat)return
        if(shown)controls.current?.reload()
        else requestRefresh(id,target)
      }
      window.addEventListener('keydown',keydown,true)
      return ()=>window.removeEventListener('keydown',keydown,true)
    },[shown,selected])
    React.useEffect(()=>()=>{
      clearTimeout(refreshJob.current?.timeout)
      refreshJob.current=null
    },[])
    React.useEffect(()=>{
      if(bridge?.acquireEcolink)shadowApi({action:'bindings'}).then(({bindings})=>publishBadges(bindings),()=>{})
    },[bridge])
    React.useEffect(()=>{
      if(!started||!bridge?.acquireEcolink)return
      let disposed=false,lease,guest
      const target=host.current
      const failure=()=>{if(!disposed)setError('DeepSeek 网页加载失败。可切回 Harness 后重新打开应用再试。')}
      async function mount(){
        const reservation=await bridge.acquireEcolink()
        lease=reservation.lease
        if(disposed){await bridge.release(lease);return}
        guest=document.createElement('webview')
        guest.dataset.sidebarBrowserFrame='webview'
        guest.setAttribute('aria-label','DeepSeek 网页')
        guest.setAttribute('name',lease)
        guest.setAttribute('partition',reservation.partition)
        guest.setAttribute('src','about:blank#'+lease)
        guest.addEventListener('dom-ready',()=>{
          if(disposed)return
          attached=true
          if(refreshJob.current)openTarget()
          else guest.loadURL(webRoot+'/').catch(failure)
        },{once:true})
        guest.addEventListener('did-fail-load',event=>{
          if(event.isMainFrame&&event.errorCode!==-3){
            failure()
            if(refreshJob.current)finishJob(refreshJob.current,'绑定的网页加载失败，请重试')
          }
        })
        guest.addEventListener('did-finish-load',()=>{
          if(!disposed){loaded=true;setError('')}
        })
        let pending=null,currentWebId=null,loaded=false,attached=false,reloadJob=null
        function reload() {
          const url=guestPage(guest)
          if(!url)return
          const target=pageWebId(url)
          if(refreshJob.current)finishJob(refreshJob.current,'网页正在刷新，可在加载后重试同步')
          reloadJob=target?{webId:target,requestId:crypto.randomUUID()}:null
          loaded=false
          guest.reload()
        }
        function openTarget() {
          const job=refreshJob.current
          if(!job||!attached)return
          if(job.webId===pageWebId(guestPage(guest)))return
          reloadJob=null
          loaded=false
          guest.loadURL(webRoot+'/a/chat/s/'+encodeURIComponent(job.webId)).catch(()=>{
            if(!disposed)finishJob(job,'无法打开绑定的网页，请检查登录后重试')
          })
        }
        guest.addEventListener('ipc-message',async event=>{
          if(event.channel==='ecolink-shadow-sync-done'){
            const result=event.args[0],job=refreshJob.current
            if(job?.requestId===result.requestId)finishJob(job,result.error??result.warning??(result.imported?
              '已同步 '+result.imported+' 轮网页问答':'已刷新同步，网页没有新增问答'))
            return
          }
          if(event.channel==='ecolink-shadow-reload'){reload();return}
          if(event.channel!=='ecolink-shadow')return
          const {id,action,...args}=event.args[0]
          let result
          try {
            if(action==='set-pending'){
              pending=args.workspaceId
              result={}
            }else if(action==='inspect'){
              if(args.webId!==pageWebId(guestPage(guest)))throw new Error('网页已切换，请重试')
              currentWebId=args.webId
              const [state,{bindings}]=await Promise.all([
                args.webId?shadowApi({action:'status',...args}):null,
                shadowApi({action:'bindings'})
              ])
              if(!disposed)publishBadges(bindings)
              result={pending,state,webIds:bindings.map(({webId})=>webId)}
              const job=refreshJob.current??reloadJob
              if(!disposed&&loaded&&job&&job.webId===args.webId&&currentWebId===args.webId&&args.webId===pageWebId(guestPage(guest))&&!job.sent){
                if(job.sessionId&&selected()!==job.sessionId)finishJob(job,'Harness 已切换会话，请重新刷新同步')
                else if(state?.binding?.ready&&(!job.sessionId||state.binding.sessionId===job.sessionId)){
                  job.sent=true
                  if(job===reloadJob)reloadJob=null
                  guest.send('ecolink-shadow-sync',{webId:job.webId,requestId:job.requestId})
                }else if(job===reloadJob)reloadJob=null
                else finishJob(job,'找不到绑定的影子会话')
              }
            }else if(action==='open'&&args.webId&&args.webId===currentWebId){
              const {binding}=await shadowApi({action:'status',webId:args.webId})
              if(!binding?.ready||currentWebId!==args.webId)throw new Error('请先打开并绑定目标网页会话')
              await workspace.openSession(binding.sessionId)
              setShown(false)
              result={}
            }else if(action==='projects'||args.webId&&args.webId===currentWebId&&args.webId===pageWebId(guestPage(guest))&&['bind','sync','handoff','returns','ack'].includes(action)){
              result=await shadowApi({action,...args})
            }else throw new Error('请先打开并绑定目标网页会话')
          }catch(error){result={error:error.message}}
          if(!disposed)guest.send('ecolink-shadow-result',{id,result})
        })
        guest.addEventListener('did-start-navigation',event=>{
          if(!event.isMainFrame)return
          if(!event.isInPlace)loaded=false
          currentWebId=null
          let destination
          try { destination=pageWebId(new URL(event.url)) } catch {}
          if(reloadJob&&reloadJob.webId!==destination)reloadJob=null
          const job=refreshJob.current
          if(job&&job.webId!==destination&&event.url!=='about:blank#'+lease)
            finishJob(job,'网页已切换，请重新刷新同步')
        })
        controls.current={openTarget,reload}
        target.append(guest)
      }
      mount().catch(()=>{
        failure()
        if(!disposed&&refreshJob.current)finishJob(refreshJob.current,'无法打开内嵌网页，请重试')
      })
      return ()=>{
        disposed=true
        controls.current=null
        guest?.remove()
        if(lease)bridge.release(lease).catch(()=>{})
      }
    },[started,bridge,workspace,selected])
    if(!bridge?.acquireEcolink)return null
    const toggle=()=>{
      if(!started)setStarted(true)
      setShown(!shown)
    }
    return h(React.Fragment,null,
      h('div',{className:'ecolink-titlebar'},
        h('button',{type:'button',className:'ecolink-header-button ecolink-switch','aria-pressed':shown,
          title:shown?'返回当前 Harness 对话':'在当前窗口打开 DeepSeek 网页',onClick:toggle},
          shown?'返回 Harness':'DeepSeek 网页'),
        !shown&&webId&&h('div',{className:'ecolink-shadow-actions'},
          h('button',{type:'button',className:'ecolink-header-button',title:'刷新当前影子会话（Ctrl+R）',
            disabled:syncing,onClick:()=>requestRefresh(sessionId,webId)},syncing?'正在刷新同步':'刷新同步')),
        !shown&&shadowMessage?.sessionId===sessionId&&shadowMessage?.text&&
          h('span',{className:'ecolink-shadow-notice',role:'status'},shadowMessage.text)),
      started&&h('section',{className:'ecolink-web-surface',hidden:!shown,'aria-label':'内嵌 DeepSeek 网页'},
        h('div',{ref:host,className:'ecolink-web-guest'}),
        error&&h('p',{className:'ecolink-web-error',role:'alert'},error)))
  }
  function OpenMemory({openMemory}) {
    return h('button',{type:'button',onClick:openMemory,title:'浏览完整记忆并注入当前对话','aria-label':'打开记忆池',className:'ecolink-header-button'},'记忆池')
  }
  return {inject:['slots','sidebarRightTabs','sidebarRight'],apply(ctx){
    ctx.effect(()=>{
      const style=document.createElement('style')
      style.textContent=HEADER_BUTTON_CSS
      document.head.appendChild(style)
      const root=document.documentElement, property='--ecolink-windows-menu-width'
      let menu, resize
      const watchMenu=()=>{
        menu=document.querySelector('[data-windows-menu]')
        if(!menu)return
        mounted.disconnect()
        const updateWidth=()=>root.style.setProperty(property,menu.getBoundingClientRect().width+'px')
        resize=new ResizeObserver(updateWidth)
        updateWidth()
        resize.observe(menu,{box:'border-box'})
      }
      const mounted=new MutationObserver(watchMenu)
      if(root.hasAttribute('data-windows-titlebar')){
        watchMenu()
        if(!menu)mounted.observe(document.body,{childList:true})
      }
      return ()=>{
        mounted.disconnect()
        resize?.disconnect()
        root.style.removeProperty(property)
        style.remove()
      }
    })
    if(window.dshDesktop?.browser?.acquireEcolink)ctx.inject(['uiWorkspace'],c=>c.effect(()=>c.slots.inject('shell.overlay',()=>c.slots.register({
      name:'shell.overlay',id:'ecolink-deepseek-switch',
      inject:()=>({workspace:c.uiWorkspace})
    },DeepSeekSwitch))))
    if(window.dshDesktop?.browser?.acquireEcolink)ctx.effect(()=>ctx.slots.inject('sidebar.session.row.trailing',()=>ctx.slots.register({
      name:'sidebar.session.row.trailing',id:'ecolink-shadow-badge'
    },ShadowBadge)))
    ctx.effect(()=>ctx.sidebarRightTabs.register({id:KIND,kind:KIND,title:()=> '记忆池',
      guide:[{id:'ecolink',order:50,title:()=> '记忆池',description:()=> '浏览完整正文并注入当前对话'}]}))
    ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:KIND},Panel)))
    ctx.effect(()=>ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({
      name:'conversation.session.header.utilities',id:'ecolink-memory-open',order:10,
      inject:()=>({openMemory:()=>ctx.sidebarRight.openTab(KIND)})
    },OpenMemory)))
  }}
}})
