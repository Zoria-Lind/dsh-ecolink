;(async()=>{
  const {artifactPayload,decodeArtifactStream,decodeArtifactHistory,matchArtifactSource,pageArtifactMarkdown}=await import(chrome.runtime.getURL('core/artifact.mjs'))
  const sources=new Map(),buttons=new WeakMap()
  const HISTORY_WAIT_MS=35000
  let latest=null,dialogOpen=false,refreshEditor=null,historyStatus=null
  function remember(value){
    if(value.ok&&typeof value.content==='string'&&value.content.length<=1500000){
      const currentPath=window.location?.pathname
      // A newly created chat may change its route while its first response is streaming.
      if(value.sessionId!=null&&currentPath?.split('/').at(-1)===String(value.sessionId))value.pagePath=currentPath
      value.pagePath??=currentPath
      latest=value;sources.set(`${value.pagePath}:${value.id??value.content}`,value)
      while(sources.size>128||[...sources.values()].reduce((n,s)=>n+s.content.length,0)>6000000)sources.delete(sources.keys().next().value)
      refreshEditor?.()
    }
  }
  window.addEventListener('ecolink:artifact-source',e=>{try{remember(JSON.parse(e.detail))}catch{}})
  window.addEventListener('ecolink:artifact-stream',e=>{try{
    const stream=JSON.parse(e.detail),value=decodeArtifactStream(stream.raw)
    remember({...value,sessionId:value.sessionId??stream.sessionId,pagePath:stream.pagePath})
  }catch{}})
  window.addEventListener('ecolink:artifact-history',e=>{try{
    const history=JSON.parse(e.detail)
    for(const source of decodeArtifactHistory(history.payload,history))remember(source)
    historyStatus?.(history)
  }catch{}})
  function editor(answer) {
    if(dialogOpen)return;dialogOpen=true
    const host=document.createElement('div'),root=host.attachShadow({mode:'closed'})
    host.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#0008;display:grid;place-items:center'
    const css=document.createElement('style');css.textContent=`
      :host{color-scheme:light}*{box-sizing:border-box}
      .card{background:#fff;color:#111;padding:20px;width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;border-radius:12px;font:14px/1.5 system-ui}
      h3{margin:0 0 12px}p{margin:10px 0}input,textarea,button{font:inherit;color:#111;background:#fff;border:1px solid #aaa;border-radius:6px;padding:8px}
      input,textarea{display:block;width:100%;margin:10px 0}textarea{height:min(45vh,420px);white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace}
      .wrap-option{display:flex;align-items:center;gap:6px;margin:10px 0}.wrap-option input{display:inline-block;width:auto;margin:0;padding:0}
      button{cursor:pointer;margin:4px 8px 4px 0}button:disabled{opacity:.5;cursor:default}
    `;root.append(css)
    const card=document.createElement('div');card.className='card';card.setAttribute('role','dialog');card.setAttribute('aria-label','保存完整成果')
    const title=document.createElement('h3');title.textContent='保存完整成果'
    const note=document.createElement('p'),name=document.createElement('input'),body=document.createElement('textarea'),status=document.createElement('p')
    name.placeholder='成果名称（例如：项目迭代方案）';name.setAttribute('aria-label','成果名称')
    body.setAttribute('aria-label','完整 Markdown 正文')
    const wrapOption=document.createElement('label'),wrapToggle=document.createElement('input'),wrapText=document.createElement('span')
    wrapOption.className='wrap-option';wrapToggle.type='checkbox';wrapToggle.checked=true
    wrapToggle.setAttribute('aria-label','自动换行');wrapText.textContent='自动换行'
    const updateWrap=()=>{body.setAttribute('wrap',wrapToggle.checked?'soft':'off');body.style.whiteSpace=wrapToggle.checked?'pre-wrap':'pre';body.style.overflowWrap=wrapToggle.checked?'anywhere':'normal'}
    wrapToggle.onchange=updateWrap;updateWrap();wrapOption.append(wrapToggle,wrapText)
    const container=answer.closest('[data-message-id],[data-messageid],[data-ds-message-id],[data-id]')
    const id=container?.getAttribute('data-message-id')??container?.getAttribute('data-messageid')??container?.getAttribute('data-ds-message-id')??container?.getAttribute('data-id')
    const findSource=()=>matchArtifactSource(sources.values(),{id,text:answer.innerText??answer.textContent,pagePath:window.location?.pathname})
    const matched=findSource()
    body.value=matched?.content??''
    const save=document.createElement('button'),cancel=document.createElement('button');save.textContent='确认保存全文';cancel.textContent='取消'
    const retry=document.createElement('button');retry.textContent='尝试联网读取原始 Markdown'
    const choices=document.createElement('select');choices.setAttribute('aria-label','选择完整回答');choices.style.cssText='display:none;width:100%;padding:8px;margin:10px 0'
    let reading=false,requestId=null,timeout=null,dirty=false,contentMode=matched?'original':null
    const pagePath=window.location?.pathname
    const readyNote='已取得该回答原文。请核对完整正文后命名保存。'
    const pageNote='已从所选回答的页面还原正文，无需联网。并非服务器原始 Markdown；请核对末尾、公式和图表。若还在生成，完成后请重新读取页面正文。'
    const contentNote=()=>contentMode==='original'?readyNote:contentMode==='page'?pageNote:''
    const refresh=()=>{
      if(window.location?.pathname!==pagePath)return
      const source=findSource()
      if(source&&(!body.value||contentMode==='page'&&!dirty)){body.value=source.content;contentMode='original'}
      save.disabled=!body.value.trim()
      if(source){choices.style.display='none';if(!reading)note.textContent=dirty?'已保留你编辑的正文，请核对后保存。':contentNote();return}
      const candidates=[...sources.values()].filter(s=>s.pagePath===pagePath)
      choices.replaceChildren?.()
      // replaceChildren is native in Chrome/Edge; the fallback is for older lightweight hosts.
      if(!choices.replaceChildren)choices.textContent=''
      const first=document.createElement('option');first.value='';first.textContent='选择回答后自动填入全文';choices.append(first)
      candidates.forEach((value,index)=>{
        const option=document.createElement('option');option.value=String(index)
        option.textContent=String(index+1)+' · '+value.content.replace(/\s+/g,' ').slice(0,100)
        choices.append(option)
      })
      choices.style.display=candidates.length?'block':'none'
      choices.onchange=()=>{const value=candidates[Number(choices.value)];if(choices.value!==''&&value){body.value=value.content;dirty=true;contentMode='original';note.textContent=readyNote;save.disabled=false}}
      if(!reading&&body.value)note.textContent=dirty?'已保留你编辑的正文，请核对后保存。':contentNote()
      if(!reading&&!body.value)note.textContent=candidates.length?'已读到 '+candidates.length+' 条完整回答。请选择要保存的一条，正文会自动填入。':'页面正文尚不可读取。请等待回答显示后重新读取页面正文，或尝试联网读取原文。'
    }
    refreshEditor=refresh;refresh()
    if(matched)note.textContent=readyNote
    body.oninput=()=>{dirty=true;save.disabled=!body.value.trim()}
    const local=document.createElement('button');local.textContent='重新读取页面正文（不联网）'
    const readPage=()=>{
      if(window.location?.pathname!==pagePath||answer.isConnected===false){note.textContent='所选回答已离开页面，请关闭此窗口后重新选择。';return}
      if(dirty&&body.value&&!window.confirm('重新读取页面正文会替换你编辑的内容，是否继续？'))return
      try{
        const value=pageArtifactMarkdown(answer)
        if(!value.trim()){note.textContent='页面正文尚不可读取。请等待回答显示后重试，或尝试联网读取原文。';return}
        body.value=value;contentMode='page';dirty=false;save.disabled=false;note.textContent=pageNote
      }catch{note.textContent='页面正文读取失败，已保留当前正文。可尝试联网读取原文。'}
    }
    local.onclick=readPage
    const readHistory=()=>{
      if(window.location?.pathname!==pagePath){note.textContent='已切换对话，请关闭此窗口后重新选择回答。';return}
      requestId=crypto.randomUUID();reading=true;retry.disabled=true
      note.textContent='正在读取当前对话的完整原文，网络较慢时可能需要约30秒…'
      clearTimeout(timeout)
      timeout=setTimeout(()=>{reading=false;retry.disabled=false;refresh();note.textContent=body.value?'联网读取原文暂未完成，已保留当前正文，可以直接保存。':'联网读取原文暂未完成，可读取页面正文，或检查网络后重试。'},HISTORY_WAIT_MS);timeout?.unref?.()
      window.dispatchEvent(new CustomEvent('ecolink:artifact-history-request',{detail:JSON.stringify({requestId,pagePath})}))
    }
    historyStatus=history=>{
      if(history.pagePath!==pagePath||history.requestId&&history.requestId!==requestId)return
      reading=false;retry.disabled=false;clearTimeout(timeout);refresh()
      if(history.error)note.textContent=history.error+(body.value?' 已保留当前正文，可以直接保存。':' 可点击“重新读取页面正文（不联网）”。')
    }
    retry.onclick=readHistory
    let pending=null
    const close=()=>{clearTimeout(timeout);host.remove();dialogOpen=false;refreshEditor=null;historyStatus=null};cancel.onclick=close
    save.onclick=async()=>{
      save.disabled=true
      try{
        const payload=artifactPayload({name:name.value,content:body.value,requestId:pending?.requestId??crypto.randomUUID()})
        if(!pending||pending.name!==payload.name||pending.content!==payload.content)payload.requestId=crypto.randomUUID()
        pending=payload // retain the same retry key and original body when disconnected
        status.textContent='正在保存…'
        let result=await chrome.runtime.sendMessage({kind:'artifact-save',...payload})
        if(result?.conflict){
          if(!window.confirm(`已有同名成果“${payload.name}”。保存新版本并保留旧版？`)){status.textContent='已取消，正文保留在此';return}
          result=await chrome.runtime.sendMessage({kind:'artifact-save',...payload,expectedVersion:result.version})
        }
        if(!result?.ok)throw new Error(result?.error??'保存未成功，请保留正文后重试')
        status.textContent=`已保存全文，版本 ${result.revision}。旧版本保留。`
      }catch(e){status.textContent=`保存失败：${e.message}。正文仍保留，可重试。`}finally{save.disabled=!body.value.trim()}
    }
    card.append(title,note,name,local,retry,choices,wrapOption,body,save,cancel,status);root.append(card);document.body.append(host)
    if(!matched)readPage()
  }
  const markdownSelector='.ds-markdown,[data-message-role="assistant"] .markdown'
  function reasoning(answer){
    const boundary=answer.closest('.ds-message')
    const label=/^(?:已(?:深度)?思考|深度思考|思考过程|思考中|正在思考|thinking|reasoning|thought)(?:[\s（(:：]|$)/i
    let branch=null
    // Start at the markdown node: a generic outer content wrapper can hide its reason marker.
    for(let node=answer,depth=0;node&&node!==boundary&&depth<12;branch=node,node=node.parentElement,depth++){
      const meta=[node.className,node.getAttribute('aria-label'),node.getAttribute('data-testid'),node.getAttribute('data-role')].join(' ')
      if(/(?:^|[^a-z])(?:reason(?:ing)?|think(?:ing)?|thought)(?:[^a-z]|$)/i.test(meta))return true
      // Only surrounding UI labels classify a block; a final answer may itself discuss reasoning.
      const outside=node===answer?[]:[...(node.childNodes??[])].filter(child=>child!==branch&&!child.contains?.(answer))
      const first=outside.map(child=>child.textContent?.trim()).find(Boolean)??''
      if(label.test(first)&&node.querySelectorAll?.(markdownSelector).length===1)return true
    }
    return false
  }
  function scan(){
    for(const answer of document.querySelectorAll(markdownSelector)) {
      const excluded=answer.parentElement?.closest(markdownSelector)||answer.closest('[data-message-role="user"]')||reasoning(answer)
      if(excluded){buttons.get(answer)?.remove();buttons.delete(answer);continue}
      if(buttons.has(answer))continue
      const host=document.createElement('span'),root=host.attachShadow({mode:'closed'}),button=document.createElement('button')
      button.textContent='保存完整成果';button.style.cssText='cursor:pointer;margin:8px;padding:4px 10px'
      // A header can arrive before the debounced scan; recheck at the moment of the click.
      button.onclick=()=>{if(!reasoning(answer))editor(answer)}
      root.append(button);answer.insertAdjacentElement('afterend',host);buttons.set(answer,host)
    }
    refreshEditor?.()
  }
  let timer=null
  const observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(scan,250)})
  const start=()=>{scan();observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','aria-label','data-testid','data-role']})}
  if(document.body)start();else document.addEventListener('DOMContentLoaded',start,{once:true})
})().catch(()=>{})
