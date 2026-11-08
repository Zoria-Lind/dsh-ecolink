function escapeShadowHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function shadowLink(href, label) {
  const url = URL.parse(href)
  if (!url || !['https:', 'http:', 'mailto:'].includes(url.protocol)) return label
  return '<a href="' + escapeShadowHtml(url.href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
}

const shadowMarkdown = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeShadowHtml(text),
    link({ href, tokens }) { return shadowLink(href, this.parser.parseInline(tokens)) },
    // A linked image label avoids fetching remote content when the transcript appears.
    image: ({ href, text }) => shadowLink(href, escapeShadowHtml(text || '图片')),
  },
})
