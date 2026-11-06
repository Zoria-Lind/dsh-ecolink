import { readFile } from 'node:fs/promises'

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error('Expected one occurrence of: ' + before)
  }
  return source.replace(before, () => after)
}

export async function buildGuestPreload(root) {
  const read = name => readFile(new URL(name, root), 'utf8')
  const [inject, content, artifact, core, selection, zoom] = await Promise.all([
    read('extension/inject.js'),
    read('extension/content.js'),
    read('extension/artifact.js'),
    read('extension/core/artifact.mjs'),
    read('desktop/selection.cjs'),
    read('desktop/zoom.cjs'),
  ])
  let editor = replaceOnce(
    artifact,
    "  const {artifactPayload,decodeArtifactStream,decodeArtifactHistory,matchArtifactSource,pageArtifactMarkdown}=await import(chrome.runtime.getURL('core/artifact.mjs'))",
    '',
  )
  editor = replaceOnce(editor, '    save.onclick=async()=>{', '    save.onclick=async event=>{\n      if(!event.isTrusted)return')
  editor = replaceOnce(editor, "    const readPage=()=>{", "    const readPage=(force=false)=>{")
  editor = replaceOnce(editor, "if(dirty&&body.value&&!window.confirm", "if(!force&&dirty&&body.value&&!window.confirm")
  editor = replaceOnce(editor, "    local.onclick=readPage", "    local.onclick=async()=>{if(!dirty||!body.value||await confirmInside('重新读取页面正文会替换你编辑的内容，是否继续？'))readPage(true)}")
  const nativeConfirm = editor.split('\n').find(line => line.includes('已有同名成果') && line.includes('window.confirm'))
  if (!nativeConfirm) throw new Error('Cannot locate artifact version confirmation')
  editor = replaceOnce(editor, nativeConfirm, nativeConfirm.replace('!window.confirm', '!await confirmInside'))
  editor = replaceOnce(editor, "    let pending=null", [
    '    function confirmInside(question) {',
    '      if(card.querySelector("[data-ecolink-confirm]"))return Promise.resolve(false)',
    '      return new Promise(resolve=>{',
    '        const row=document.createElement("div"),accept=document.createElement("button"),decline=document.createElement("button")',
    '        row.dataset.ecolinkConfirm="";row.setAttribute("role","group");row.setAttribute("aria-label",question)',
    '        accept.textContent="继续";decline.textContent="取消"',
    '        const done=value=>{row.remove();resolve(value)}',
    '        accept.onclick=()=>done(true);decline.onclick=()=>done(false)',
    '        row.append(document.createTextNode(question),accept,decline);card.append(row);accept.focus()',
    '      })',
    '    }',
    '    let pending=null',
  ].join('\n'))
  editor = replaceOnce(editor, '  function scan(){', [
    '  installEcolinkSelection((start,end)=>{',
    '    const element=node=>node.nodeType===1?node:node.parentElement',
    '    const userSelector=\'[data-message-role="user"], .ds-user-message\'',
    '    const user=element(start)?.closest(userSelector)',
    '    if(user)return user===element(end)?.closest(userSelector)?user:null',
    '    const answer=element(start)?.closest(markdownSelector)',
    '    return answer&&answer===element(end)?.closest(markdownSelector)&&!reasoning(answer)?answer:null',
    '  },chrome.runtime.sendMessage)',
    '  function scan(){',
  ].join('\n'))

  return [
    "'use strict'",
    "const { contextBridge, ipcRenderer, webFrame } = require('electron')",
    "if (process.isMainFrame && location.origin === 'https://chat.deepseek.com') {",
    "const chrome = { runtime: { sendMessage: message => ipcRenderer.invoke('dsh-desktop:ecolink-memory', message) } }",
    core.replace(/^export (?=function )/gm, ''),
    selection,
    zoom,
    'installEcolinkZoom(webFrame)',
    'contextBridge.executeInMainWorld({ func: function () {\n' + inject + '\n} })',
    content,
    editor,
    '}',
  ].join('\n')
}
