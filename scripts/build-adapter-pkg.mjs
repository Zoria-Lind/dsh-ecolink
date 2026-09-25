// 构建 @zoria-lind/dsh-ecolink-adapter 的 npm 发布包(staging 目录)。
// 为什么需要:adapter 源码的 import 路径按仓库布局书写
//   (memoryInject.js → '../../../extension/core/selector.mjs';
//    prompt.mjs → '../../service/pool.mjs')。
// npm 包若只装 adapter/ 一个目录,这些路径全部悬空 → 装上即崩。
// 因此发布包必须镜像仓库布局:adapter/ + extension/core/ + service/ 三块平铺在包根。
// 用法:node scripts/build-adapter-pkg.mjs <输出目录>(默认 ../.publish-adapter)
// 然后 cd <输出目录> && npm publish --access public

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] ?? join(REPO, '.publish-adapter')

const adapterPkg = JSON.parse(readFileSync(join(REPO, 'adapter/package.json'), 'utf8'))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
// 镜像布局:adapter/ + extension/core/ + service/
cpSync(join(REPO, 'adapter'), join(OUT, 'adapter'), { recursive: true })
cpSync(join(REPO, 'extension/core'), join(OUT, 'extension/core'), { recursive: true })
cpSync(join(REPO, 'service'), join(OUT, 'service'), { recursive: true })
cpSync(join(REPO, 'LICENSE'), join(OUT, 'LICENSE'))
cpSync(join(REPO, 'adapter/README.md'), join(OUT, 'README.md'))

// 包根 package.json:入口与 bundle 指向 adapter/ 子目录
const pkg = {
  name: adapterPkg.name,
  version: adapterPkg.version,
  description: adapterPkg.description,
  license: adapterPkg.license,
  type: 'module',
  main: 'adapter/src/index.js',
  exports: { '.': './adapter/src/index.js' },
  files: ['adapter/src', 'adapter/cordis.patch.yml', 'extension/core', 'service', 'README.md', 'LICENSE'],
  engines: adapterPkg.engines,
  repository: { type: 'git', url: 'git+https://github.com/Zoria-Lind/dsh-ecolink.git' },
  dsh: { bundle: { patch: './adapter/cordis.patch.yml' } },
  keywords: adapterPkg.keywords,
}
writeFileSync(join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`[build-adapter-pkg] ${OUT} 就绪(version ${pkg.version})`)
