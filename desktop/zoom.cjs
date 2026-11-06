function installEcolinkZoom(webFrame) {
  function zoom(direction) {
    const factor = direction === 0 ? 1 : webFrame.getZoomFactor() * (1.2 ** direction)
    webFrame.setZoomFactor(Math.min(3, Math.max(0.5, factor)))
  }

  function isZoomGesture(event) {
    return event.isTrusted && event.ctrlKey && !event.altKey && !event.metaKey
  }

  window.addEventListener('wheel', event => {
    if (!isZoomGesture(event) || event.deltaY === 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
    zoom(event.deltaY < 0 ? 1 : -1)
  }, { capture: true, passive: false })

  window.addEventListener('keydown', event => {
    if (!isZoomGesture(event)) return
    const key = event.key
    if (key !== '+' && key !== '=' && key !== '-' && key !== '0') return
    event.preventDefault()
    event.stopImmediatePropagation()
    zoom(key === '0' ? 0 : key === '-' ? -1 : 1)
  }, true)
}
