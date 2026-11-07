export function patchDesktopHost(main, preload) {
  function replace(source, before, after) {
    if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before))
      throw new Error('Unexpected desktop bundle: ' + before)
    return source.replace(before, () => after)
  }
  const change = (before, after) => { main = replace(main, before, after) }
  main = 'import { loadMemoryBridge, isDeepSeekDocument, ECOLINK_CHANNEL } from "./ecolink-memory.mjs";\nimport * as compression from "./ecolink-compression.mjs";\n' + main
  change('acquire(owner, workspace) {', [
    'acquire(owner, workspace, ecolink = false) {',
    '    if (ecolink && [...this.leases.values()].some(lease => lease.owner === owner && lease.ecolink))',
    '      throw new Error("ecolink view is already open");',
  ].join('\n'))
  change('partition = `dsh-sidebar-browser-${randomUUID()}`;', 'partition = ecolink ? "persist:dsh-ecolink-chat" : `dsh-sidebar-browser-${randomUUID()}`;')
  change('\t\t\tattached: false', '\t\t\tecolink,\n\t\t\tattached: false')
  change('params.httpreferrer = "";', [
    'if (lease.ecolink) preferences.preload = fileURLToPath(new URL("./ecolink-guest.cjs", import.meta.url));',
    '\t\t\tparams.httpreferrer = "";',
  ].join('\n'))
  change('postBody === void 0 && this.allowedNavigation(url)', 'postBody === void 0 && !lease.ecolink && this.allowedNavigation(url)')
  change('if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault();',
    'if (event.isMainFrame && !allowedGuestNavigation(event.url)) event.preventDefault();')
  change('if (mainFrame && !this.allowedNavigation(url)) event.preventDefault();',
    'if (mainFrame && !allowedGuestNavigation(url)) event.preventDefault();')
  change('let attachedLease;', [
    'let attachedLease;',
    '\t\t\tconst allowedGuestNavigation = url => this.leases.get(attachedLease)?.ecolink',
    '\t\t\t  ? isDeepSeekDocument(url) : this.allowedNavigation(url);',
  ].join('\n'))
  change('\tconfigureSession(browserSession) {', [
    '\tisEcolinkGuest(sender) {',
    '\t\treturn [...this.leases.values()].some(lease => lease.ecolink && lease.guest === sender);',
    '\t}',
    '\tconfigureSession(browserSession) {',
  ].join('\n'))
  change('\tconst browserGuests = new DesktopBrowserGuests(() => hostUrl);', [
    '\tconst browserGuests = new DesktopBrowserGuests(() => hostUrl);',
    '\tconst ecolinkBridge = loadMemoryBridge(undefined, process.env, { stateDir: app.getPath("userData"), compression });',
  ].join('\n'))
  change('\t\treturn browserGuests.acquire(event.sender, workspace);', [
    '\t\tif (workspace === null) {',
    '\t\t\tif (!ecolinkBridge) throw new Error("内嵌 ecolink 尚未启用");',
    '\t\t\treturn browserGuests.acquire(event.sender, "ecolink:deepseek", true);',
    '\t\t}',
    '\t\tif (workspace === "ecolink:deepseek") throw new Error("reserved ecolink workspace");',
    '\t\treturn browserGuests.acquire(event.sender, workspace);',
  ].join('\n'))
  change('\tipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease) => {', [
    '\tipcMain.handle(ECOLINK_CHANNEL, (event, message) => {',
    '\t\tconst frame = event.senderFrame;',
    '\t\tif (!ecolinkBridge || !browserGuests.isEcolinkGuest(event.sender) ||',
    '\t\t    !frame || frame !== event.sender.mainFrame || !isDeepSeekDocument(frame.url))',
    '\t\t\tthrow new Error("Rejected memory IPC from an unowned document");',
    '\t\treturn ecolinkBridge(message);',
    '\t});',
    '\tipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease) => {',
  ].join('\n'))
  preload = replace(preload, '\t\tacquire: (workspace) => electron.ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace),',
    '\t\tacquire: (workspace) => electron.ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace),\n' +
    '\t\tacquireEcolink: () => electron.ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, null),')
  return { main, preload }
}
