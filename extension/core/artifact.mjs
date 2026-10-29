// Only return a complete, recognised answer. Rendered text is used for identity, never as saved content.
export function decodeArtifactStream(raw) {
  const failure=()=>({ok:false,error:'尚未取得完整回答原文'})
  let text='',path='',operation='APPEND',finished=false,id=null,sessionId=null,mode=null
  let fragments=[]
  const validFragment=f=>f&&['RESPONSE','THINK'].includes(f.type)&&typeof f.content==='string'
  function response(value) {
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('unknown response')
    id=value.message_id??id;sessionId=value.chat_session_id??sessionId
    if(Array.isArray(value.fragments)){
      if(!value.fragments.every(validFragment))throw Error('unknown fragments')
      fragments=value.fragments.map(f=>({...f}));finished=false
    }else if(typeof value.content==='string'){fragments=[{type:'RESPONSE',content:value.content}];finished=false}
    if(value.status==='FINISHED')finished=true
    else if(value.status&&value.status!=='WIP')throw Error('incomplete response')
  }
  function patch(p,o,v,depth=0) {
    if(depth>8)throw Error('nested patch')
    if(o==='BATCH'){
      if(!Array.isArray(v))throw Error('unknown batch')
      for(const child of v){
        if(!child||typeof child.p!=='string')throw Error('unknown child')
        patch(p?p+'/'+child.p:child.p,child.o??'APPEND',child.v,depth+1)
      }
    }else if(p==='response'){mode='deepseek';response(v)}
    else if(p==='response/fragments'){
      if(!Array.isArray(v)||!v.every(validFragment))throw Error('unknown fragments')
      mode='deepseek';finished=false
      if(o==='APPEND')fragments.push(...v.map(f=>({...f})))
      else if(o==='SET')fragments=v.map(f=>({...f}))
      else throw Error('unknown operation')
    }else if(/^response\/fragments\/-?\d+\/content$/.test(p)){
      const n=Number(p.split('/')[2]),index=n<0?fragments.length+n:n,fragment=fragments[index]
      if(!validFragment(fragment)||typeof v!=='string')throw Error('unknown content')
      finished=false
      if(o==='APPEND')fragment.content+=v
      else if(o==='SET')fragment.content=v
      else throw Error('unknown operation')
    }else if(p==='response/status'){
      if(v==='FINISHED')finished=true
      else if(v==='WIP')finished=false
      else throw Error('incomplete response')
    }else if(/^response\/fragments\/-?\d+\/(elapsed_secs|references|stage_id|id|status)$/.test(p)){
      // Timing and reference metadata do not alter the typed answer content.
    }else if(p.includes('content')||p.includes('fragment'))throw Error('unknown content path')
  }
  try {
    for(const block of String(raw).split(/\r?\n\r?\n/)){
      // SSE permits multiple data lines in one event.
      const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n').trim()
      if(!data)continue
      if(data==='[DONE]'){finished=true;continue}
      const e=JSON.parse(data)
      if(!e||e.error) return failure()
      id=e.response_message_id??e.message_id??id;sessionId=e.chat_session_id??sessionId
      if(Array.isArray(e.choices)){
        if(mode&&mode!=='openai')return failure();mode='openai'
        const c=e.choices[0]
        if(typeof c?.delta?.content==='string'){text+=c.delta.content;finished=false}
        if(c?.finish_reason){if(c.finish_reason!=='stop')return failure();finished=true}
        continue
      }
      if(e.v?.response){mode='deepseek';response(e.v.response);continue}
      if(typeof e.p==='string'){
        path=e.p
        // A new explicit path without o defaults to APPEND; bare v reuses the last path/op.
        operation=e.o??'APPEND'
      }else if(typeof e.o==='string')operation=e.o
      if(Object.hasOwn(e,'v'))patch(path,operation,e.v)
    }
    if(mode==='deepseek')text=fragments.filter(f=>f.type==='RESPONSE').map(f=>f.content).join('')
    return mode&&finished&&text.length?{ok:true,content:text,id,sessionId}:failure()
  }catch{return failure()}
}

export function decodeArtifactHistory(payload,{sessionId,pagePath}={}) {
  const data=payload?.data?.biz_data??payload?.biz_data??payload?.data??payload
  if(!data||(payload?.data?.biz_code && payload.data.biz_code!==0))return []
  const sid=data.chat_session?.id??data.chat_session_id??sessionId
  if(sessionId!=null&&sid!=null&&String(sid)!==String(sessionId))return []
  const messages=data.chat_messages??data.messages
  if(!Array.isArray(messages))return []
  return messages.flatMap(message=>{
    const role=String(message?.message_role??message?.role??'').toLowerCase()
    if(role!=='assistant'||message.truncated||message.is_incomplete)return []
    if(message.status && !['FINISHED','SUCCESS','COMPLETED'].includes(String(message.status).toUpperCase()))return []
    let content
    if(Array.isArray(message.fragments)){
      if(!message.fragments.every(f=>f&&['RESPONSE','THINK'].includes(f.type)&&typeof f.content==='string'))return []
      content=message.fragments.filter(f=>f.type==='RESPONSE').map(f=>f.content).join('')
    }else content=message.content
    return typeof content==='string'&&content.length
      ?[{ok:true,id:message.message_id??message.id??message.messageId,sessionId:sid,pagePath,content}]:[]
  })
}

const visible=text=>String(text??'').replace(/\s+/g,' ').trim()
function markdownText(text){
  return text
    // Hidden short-memory tags affect identity only; saved source remains intact.
    .replace(/(?:<|&lt;)DSM:memory_write\b[\s\S]*?(?:<|&lt;)\/DSM:memory_write(?:>|&gt;)/gi,'')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm,'')
    .replace(/!\[([^\]]*)\]\([^\n]*?\)/g,'$1')
    .replace(/\[([^\]]+)\]\([^\n]*?\)/g,'$1')
    .replace(/^ {0,3}(#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm,'')
    .replace(/(\*\*|__)([^\n]+?)\1/g,'$2')
    .replace(/(`+)([^\n]+?)\1/g,'$2')
    .replace(/\*([^*\n]+)\*/g,'$1')
    .replace(/\\([\\`*_{}[\]()#+.!|>-])/g,'$1')
}
export function matchArtifactSource(sources,{id,text,pagePath}){
  const candidates=[...sources].filter(s=>!s.pagePath||s.pagePath===pagePath)
  if(id!=null){
    const byId=candidates.filter(s=>s.id!=null&&String(s.id)===String(id))
    if(byId.length===1)return byId[0]
  }
  const ownText=visible(text)
  if(!ownText)return null
  // Exact full text only: no last-answer/order/prefix guess. Page reconstruction is a separate, labeled fallback.
  const matches=candidates.filter(s=>visible(s.content)===ownText||visible(markdownText(s.content))===ownText)
  return matches.length&&new Set(matches.map(s=>s.content)).size===1?matches[0]:null
}
export function artifactPayload({name,content,requestId,expectedVersion}) {
  if(typeof name!=='string'||!name.trim()||name.trim().length>200)throw new Error('请输入1–200字符的名称')
  if(typeof content!=='string'||!content.trim())throw new Error('正文不能为空')
  if(new TextEncoder().encode(content).length>1500000)throw new Error('正文超过1.5MB，未保存')
  return {name:name.trim(),content,requestId,...(expectedVersion?{expectedVersion}:{})}
}

// Reconstruct only the clicked answer's rendered content. This is not server-original Markdown.
// No fetch, clipboard access, page scripts or document-wide text extraction.
export function pageArtifactMarkdown(answer){
  if(!answer)return ''
  const tick=String.fromCharCode(96)
  const tag=n=>String(n?.tagName??'').toUpperCase()
  const children=n=>Array.from(n?.childNodes??[])
  const attr=(n,k)=>n?.getAttribute?.(k)
  const escape=s=>String(s).replace(/[\\*_{}[\]<>#\x60]/g,'\\$&')
  const url=value=>{
    try{
      const parsed=new URL(value,answer.ownerDocument?.baseURI??'https://chat.deepseek.com/')
      return /^(https?:|mailto:)$/.test(parsed.protocol)?parsed.href.replace(/</g,'%3C').replace(/>/g,'%3E'):''
    }catch{return ''}
  }
  const excluded=n=>['BUTTON','SCRIPT','STYLE','NOSCRIPT','INPUT','TEXTAREA','SELECT'].includes(tag(n))||
    n?.hasAttribute?.('hidden')||attr(n,'aria-hidden')==='true'||attr(n,'role')==='button'||
    /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(n,'style')??'')
  const plain=n=>excluded(n)?'':n?.nodeType===3?String(n.nodeValue??''):children(n).map(plain).join('')
  const inner=n=>children(n).reduce((text,node)=>{
    const part=render(node)
    // Merge adjacent block separators; keep code contents and explicit line breaks intact.
    if(node.nodeType===3&&!part.trim()&&/\n$/.test(text))return text
    const overlap=tag(node)==='BR'?0:Math.min(text.match(/\n+$/)?.[0].length??0,part.match(/^\n+/)?.[0].length??0)
    return text+part.slice(overlap)
  },'')
  function render(n){
    if(n?.nodeType===3)return escape(String(n.nodeValue??'').replace(/\s+/g,' '))
    if(n?.nodeType!==1||excluded(n))return ''
    const t=tag(n),classes=String(attr(n,'class')??'')
    if(t==='PRE'){
      const code=n.querySelector?.('code'),text=code?code.textContent:plain(n)
      const fence=tick.repeat(Math.max(3,...(text.match(/\x60+/g)??[]).map(s=>s.length+1)))
      const language=(attr(code,'class')??'').match(/(?:^|\s)language-([a-z0-9_+-]+)/i)?.[1]??''
      return '\n\n'+fence+language+'\n'+text+(text.endsWith('\n')?'':'\n')+fence+'\n\n'
    }
    if(/\bkatex(?:-display)?\b/.test(classes)||t==='MATH'){
      const tex=n.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent
      if(tex)return classes.includes('katex-display')?'\n\n$$\n'+tex+'\n$$\n\n':'$'+tex+'$'
    }
    if(t==='CODE'){
      const text=plain(n),fence=tick.repeat(Math.max(1,...(text.match(/\x60+/g)??[]).map(s=>s.length+1)))
      return fence+' '+text+' '+fence
    }
    if(t==='BR')return '\n'
    if(t==='HR')return '\n\n---\n\n'
    if(t==='SVG'||t==='CANVAS')return '[页面图形：请核对原页面]'
    if(t==='IMG'){
      const src=url(attr(n,'src')),alt=escape(attr(n,'alt')??'图片')
      return src?'!['+alt+'](<'+src+'>)':'['+alt+']'
    }
    if(t==='TABLE'){
      const rows=[]
      const walk=node=>{for(const child of children(node)){if(tag(child)==='TR')rows.push(children(child).filter(c=>['TD','TH'].includes(tag(c))));else if(['THEAD','TBODY','TFOOT'].includes(tag(child)))walk(child)}}
      walk(n)
      if(!rows.length)return inner(n)
      const width=Math.max(...rows.map(r=>r.length)),line=cells=>'| '+Array.from({length:width},(_,i)=>cells[i]?inner(cells[i]).trim().replace(/\|/g,'\\|').replace(/\n+/g,'<br>'):'').join(' | ')+' |'
      const caption=children(n).find(c=>tag(c)==='CAPTION')
      return '\n\n'+(caption?inner(caption)+'\n\n':'')+line(rows[0])+'\n| '+Array(width).fill('---').join(' | ')+' |\n'+rows.slice(1).map(line).join('\n')+'\n\n'
    }
    if(t==='UL'||t==='OL'){
      const start=Number(attr(n,'start'))||1
      return '\n'+children(n).filter(c=>tag(c)==='LI').map((li,i)=>{
        const prefix=t==='OL'?String(start+i)+'. ':'- '
        return prefix+inner(li).trim().replace(/\n/g,'\n'+' '.repeat(prefix.length))
      }).join('\n')+'\n'
    }
    const content=inner(n)
    if(/^H[1-6]$/.test(t))return '\n\n'+'#'.repeat(Number(t[1]))+' '+content.trim()+'\n\n'
    if(t==='STRONG'||t==='B')return '**'+content+'**'
    if(t==='EM'||t==='I')return '*'+content+'*'
    if(t==='DEL'||t==='S')return '~~'+content+'~~'
    if(t==='A'){const href=url(attr(n,'href'));return href?'['+content+'](<'+href+'>)':content}
    if(t==='BLOCKQUOTE')return '\n\n'+content.trim().split('\n').map(l=>'> '+l).join('\n')+'\n\n'
    if(['P','DIV','SECTION','ARTICLE','DETAILS'].includes(t))return '\n\n'+content.trim()+'\n\n'
    return content
  }
  return inner(answer).trim()
}
