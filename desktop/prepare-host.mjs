import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildGuestPreload } from './build-guest.mjs'
import { patchDesktopHost } from './patch-host.mjs'

export async function prepareHost(input, output) {
  if (resolve(input) === resolve(output)) throw new Error('Output must be separate from the installed app')
  const source = await open(input, 'r')
  try {
    const prefix = Buffer.alloc(16)
    await source.read(prefix, 0, prefix.length, 0)
    const payloadOffset = 8 + prefix.readUInt32LE(4)
    const raw = Buffer.alloc(prefix.readUInt32LE(12))
    await source.read(raw, 0, raw.length, 16)
    const tree = JSON.parse(raw.toString())
    async function read(entry) {
      const buffer = Buffer.alloc(entry.size)
      const { bytesRead } = await source.read(buffer, 0, buffer.length, payloadOffset + Number(entry.offset))
      if (bytesRead !== buffer.length) throw new Error('Truncated Electron package')
      return buffer
    }
    const version = JSON.parse(await read(tree.files['package.json'])).version
    if (version !== '0.2.2-rc.1') throw new Error('Unsupported desktop baseline: ' + version)
    const lib = tree.files.lib.files
    const { main, preload } = patchDesktopHost(
      (await read(lib['main.js'])).toString(), (await read(lib['preload-app.cjs'])).toString(),
    )
    const root = new URL('../', import.meta.url)
    const data = new Map([
      [lib['main.js'], Buffer.from(main)],
      [lib['preload-app.cjs'], Buffer.from(preload)],
    ])
    for (const [name, text] of [
      ['ecolink-guest.cjs', await buildGuestPreload(root)],
      ['ecolink-memory.mjs', await readFile(new URL('./memory-bridge.mjs', import.meta.url), 'utf8')],
    ]) {
      if (lib[name]) throw new Error('Desktop package already contains ' + name)
      lib[name] = { size: 0, offset: '0' }
      data.set(lib[name], Buffer.from(text))
    }
    const chunks = []
    let nextOffset = 0
    const sha = bytes => createHash('sha256').update(bytes).digest('hex')
    function collect(entries) {
      for (const item of Object.values(entries)) {
        if (item.files) collect(item.files)
        if (item.unpacked || item.offset === undefined) continue
        const patched = data.get(item)
        const original = { size: item.size, offset: item.offset }
        if (patched) {
          const blockSize = 4 * 1024 * 1024
          const blocks = []
          for (let start = 0; start < patched.length; start += blockSize)
            blocks.push(sha(patched.subarray(start, start + blockSize)))
          item.size = patched.length
          item.integrity = { algorithm: 'SHA256', hash: sha(patched), blockSize, blocks }
        }
        item.offset = String(nextOffset)
        nextOffset += item.size
        chunks.push({ patched, original })
      }
    }
    collect(tree.files)
    const json = Buffer.from(JSON.stringify(tree))
    const aligned = Math.ceil(json.length / 4) * 4
    const header = Buffer.alloc(16 + aligned)
    header.writeUInt32LE(4, 0)
    header.writeUInt32LE(8 + aligned, 4)
    header.writeUInt32LE(4 + aligned, 8)
    header.writeUInt32LE(json.length, 12)
    json.copy(header, 16)
    const destination = await open(output, 'wx')
    try {
      await destination.writeFile(header)
      for (const { patched, original } of chunks)
        await destination.writeFile(patched ?? await read(original))
    } finally {
      await destination.close()
    }
    return { version, main, preload, guest: data.get(lib['ecolink-guest.cjs']).toString() }
  } finally {
    await source.close()
  }
}
