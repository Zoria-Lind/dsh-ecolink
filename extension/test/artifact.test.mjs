import test from 'node:test'
import assert from 'node:assert/strict'
import {decodeArtifactHistory,decodeArtifactStream,artifactPayload,matchArtifactSource,pageArtifactMarkdown} from '../core/artifact.mjs'
import {selectMemories} from '../core/selector.mjs'
const sse=frames=>frames.map(f=>'data: '+(typeof f==='string'?f:JSON.stringify(f))).join('\n\n')
const full='  # 标题\n[原文] {对象}\n```js\nx="<DSM:memory_write>标签字面值</DSM:memory_write>"\n```\n'+('正文😀\n'.repeat(600))+'尾部  '
test('artifact payload preserves original Unicode/whitespace/Markdown beyond short-fact length and rejects oversize',()=>{
 assert.equal(artifactPayload({name:' 名称 ',content:full,requestId:'request-001'}).content,full);assert.throws(()=>artifactPayload({name:' ',content:full}),/名称/);assert.throws(()=>artifactPayload({name:'x',content:'中'.repeat(500001)}),/1.5MB/)
})
test('OpenAI stream reconstruction requires complete valid answer and never accepts length-truncated/broken streams',()=>{
 assert.equal(decodeArtifactStream(sse([{choices:[{delta:{content:full.slice(0,400)}}]},{choices:[{delta:{content:full.slice(400)},finish_reason:'stop'}]},'[DONE]'])).content,full)
 assert.equal(decodeArtifactStream(sse([{choices:[{delta:{content:full}}]}])).ok,false);assert.equal(decodeArtifactStream(sse([{choices:[{delta:{content:full},finish_reason:'length'}]},'[DONE]'])).ok,false);assert.equal(decodeArtifactStream('data: {broken\ndata: [DONE]').ok,false)
})
test('DeepSeek typed fragments reconstruct original answer, omit reasoning, and reject untyped content patches',()=>{
 const raw=sse([{v:{response:{message_id:17,chat_session_id:'chat',status:'WIP'}}},{p:'response/fragments',o:'APPEND',v:[{type:'THINK',content:'私有推理不保存'}]},{p:'response/fragments/-1/content',o:'APPEND',v:'思考'},{p:'response/fragments',o:'APPEND',v:[{type:'RESPONSE',content:full.slice(0,200)}]},{p:'response/fragments/-1/content',o:'APPEND',v:full.slice(200,900)},{v:full.slice(900)},{p:'response/status',o:'SET',v:'FINISHED'}])
 const r=decodeArtifactStream(raw);assert.equal(r.ok,true);assert.equal(r.content,full);assert.equal(r.id,17);assert.equal(r.content.includes('私有推理'),false)
 assert.equal(decodeArtifactStream(sse([{p:'response/fragments/0/content',o:'APPEND',v:'未确认正文'},'[DONE]'])).ok,false)
})
test('explicit artifact stays out of legacy automatic short-memory selection',()=>{
 const pool={shared_pool:[{id:'a',key:'artifact',content:full,kind:'artifact',importance:'key'},{id:'f',key:'fact',content:'普通事实',importance:'key'}],session_pools:{}}
 const r=selectMemories(pool.shared_pool,'artifact fact',10000);assert.equal(JSON.stringify(r).includes(full.slice(0,70)),false)
})

// Shape from local deepseek-stream-reasoning.test.ts captured fixture; body is synthetic.
test('captured DeepSeek metadata/BATCH shape retains the full answer and excludes thinking',()=>{
 const frames=[{response_message_id:6},{v:{response:{message_id:6,status:'WIP',fragments:[{type:'THINK',content:'思考正文'}]}}},
 {p:'response/fragments/-1/elapsed_secs',o:'SET',v:1.4},
 {p:'response/fragments',o:'APPEND',v:[{type:'RESPONSE',content:full.slice(0,500)}]},
 {p:'response/fragments/-1/elapsed_secs',o:'SET',v:2},
 {p:'response/fragments/-1/content',v:full.slice(500,1000)},{v:full.slice(1000)},
 {p:'response',o:'BATCH',v:[{p:'quasi_status',v:'FINISHED'}]},
 {p:'response/status',o:'SET',v:'FINISHED'}]
 const result=decodeArtifactStream(sse(frames));assert.equal(result.ok,true);assert.equal(result.content,full);assert.equal(result.id,6)
 assert.equal(decodeArtifactStream(sse(frames.slice(0,-1))).ok,false,'quasi_status alone does not prove completion')
 assert.equal(decodeArtifactStream(sse([...frames,{error:{message:'interrupted'}}])).ok,false)
})
test('nested response batch applies explicit content operations and final status',()=>{
 const frames=[{v:{response:{fragments:[{type:'RESPONSE',content:'开头'}],status:'WIP'}}},
 {p:'response',o:'BATCH',v:[{p:'fragments/-1/content',o:'APPEND',v:'结尾'},{p:'status',o:'SET',v:'FINISHED'}]}]
 assert.equal(decodeArtifactStream(sse(frames)).content,'开头结尾')
 assert.equal(decodeArtifactStream(sse([...frames,{p:'response/fragments/0/type',o:'SET',v:'THINK'}])).ok,false)
})
test('source matching supports no DOM id, full plain/Markdown text and scopes reused ids to the current page',()=>{
 const plain={id:1,pagePath:'/chat/A',content:'测试项目：星舟计划\n截止时间：2031-03-18 17:20\n校验码：Q7-蓝莓-482'}
 const rich={id:2,pagePath:'/chat/A',content:'# 策划\n\n**关键内容**\n\n```js\nconst x = 7;\n```'}
 const items=[plain,rich,{id:1,pagePath:'/chat/B',content:'其他对话正文'}]
 assert.equal(matchArtifactSource(items,{pagePath:'/chat/A',text:plain.content}),plain)
 assert.equal(matchArtifactSource(items,{pagePath:'/chat/A',text:'策划\n关键内容\nconst x = 7;'}),rich)
 assert.equal(matchArtifactSource(items,{id:1,pagePath:'/chat/B'}).content,'其他对话正文')
 assert.equal(matchArtifactSource(items,{pagePath:'/chat/A',text:'测试项目：星舟计划'}),null,'partial rendered output cannot select a full source')
 assert.equal(matchArtifactSource(items,{pagePath:'/chat/C',text:plain.content}),null)
 assert.equal(matchArtifactSource([{content:'[链接](https://a.invalid)'},{content:'[链接](https://b.invalid)'}],{text:'链接'}),null,'ambiguous visible text cannot select a different link')
})

test('history includes complete assistant text and typed answer fragments, excludes user/thoughts and rejected sessions',()=>{
 const payload={data:{biz_code:0,biz_data:{chat_session:{id:'test'},chat_messages:[
 {message_role:'user',content:'不保存用户输入'},
 {message_role:'assistant',message_id:17,content:'  # 完整原文\n😀  '},
 {message_role:'assistant',message_id:18,fragments:[{type:'THINK',content:'不保存思考'},{type:'RESPONSE',content:'正文'}]},
 {message_role:'assistant',status:'WIP',content:'半截内容'},
 {message_role:'assistant',truncated:true,content:'截断内容'}
 ]}}}
 const values=decodeArtifactHistory(payload,{sessionId:'test',pagePath:'/chat/test'})
 assert.equal(values.length,2);assert.equal(values[0].content,'  # 完整原文\n😀  ');assert.equal(values[1].content,'正文')
 assert.deepEqual(decodeArtifactHistory(payload,{sessionId:'other'}),[])
})

function dom(tag,attrs={},...children){
 const node={nodeType:1,tagName:tag.toUpperCase(),childNodes:children.flat().map(c=>typeof c==='string'?{nodeType:3,nodeValue:c}:c),getAttribute:k=>attrs[k]??null,hasAttribute:k=>Object.hasOwn(attrs,k),className:attrs.class??''}
 Object.defineProperty(node,'textContent',{get:()=>node.childNodes.map(c=>c.nodeValue??c.textContent??'').join('')})
 node.querySelector=selector=>{const all=n=>[n,...(n.childNodes??[]).filter(c=>c.nodeType===1).flatMap(all)];return all(node).slice(1).find(n=>selector==='code'?n.tagName==='CODE':n.tagName==='ANNOTATION'&&n.getAttribute('encoding')==='application/x-tex')??null}
 return node
}
test('local page reconstruction preserves rich structure and code without touching the network or UI labels',()=>{
 const answer=dom('div',{},dom('h2',{},'本地成果'),'\n  ',dom('p',{},dom('strong',{},'重点'),'：',dom('a',{href:'https://example.invalid/a?b=1&c=2'},'来源')),
 dom('ul',{},dom('li',{},'甲',dom('ol',{start:'3'},dom('li',{},'子项'))),dom('li',{},'乙')),
 dom('div',{},dom('button',{},'复制代码'),dom('pre',{},dom('code',{class:'language-js'},'const x = 1;\n    const fence = ' + String.fromCharCode(96).repeat(3) + ';\n'))),
 dom('table',{},dom('thead',{},dom('tr',{},dom('th',{},'名称'),dom('th',{},'值'))),dom('tbody',{},dom('tr',{},dom('td',{},'a|b'),dom('td',{},'😀')))),
 dom('blockquote',{},dom('p',{},'备注')),dom('span',{class:'katex'},dom('span',{'aria-hidden':'true'},'重复公式'),dom('annotation',{encoding:'application/x-tex'},'x^2')),
 dom('div',{'aria-hidden':'true'},'隐藏内容'),dom('script',{},'危险脚本'),dom('img',{src:'https://example.invalid/image.png',alt:'示意图'}))
 const markdown=pageArtifactMarkdown(answer)
 assert.ok(markdown.startsWith('## 本地成果\n\n**重点**'));assert.ok(markdown.includes('>)\n\n- 甲'));assert.ok(markdown.includes('**重点**'));assert.ok(markdown.includes('[来源](<https://example.invalid/a?b=1&c=2>)'))
 assert.ok(markdown.includes('    const fence = '));assert.ok(markdown.includes(String.fromCharCode(96).repeat(4)+'js'))
 assert.ok(markdown.includes('  3. 子项'));assert.ok(markdown.includes('| a'+String.fromCharCode(92)+'|b | 😀 |'));assert.match(markdown,/> 备注/);assert.ok(markdown.includes('$x^2$'))
 assert.ok(markdown.includes('![示意图]'));assert.doesNotMatch(markdown,/复制代码|隐藏内容|危险脚本|重复公式/)
})
test('local page extraction never treats an absent answer or unsafe URLs as raw source',()=>{
 assert.equal(pageArtifactMarkdown(null),'')
 assert.equal(pageArtifactMarkdown(dom('div',{},dom('a',{href:'javascript:alert(1)'},'标签'))),'标签')
 assert.equal(pageArtifactMarkdown(dom('div',{},dom('pre',{},dom('code',{},'  line\n\n\n  tail\n')))).includes('line\n\n\n  tail'),true)
 const long='细节😀'.repeat(16000)+'结尾';assert.equal(pageArtifactMarkdown(dom('div',{},dom('p',{},long))),long)
})
