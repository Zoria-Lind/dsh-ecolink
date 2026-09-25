// 构建 ecolink 的两个 npm 发布包(staging 目录,镜像仓库布局)。
// 为什么需要:源码 import 路径按仓库布局书写——
//   adapter: memoryInject.js → '../../../extension/core/selector.mjs';prompt.mjs → '../../service/pool.mjs'
//   service: compress.mjs → '../extension/core/harvest.mjs'
// npm 包若只装单个目录,这些路径全部悬空 → 装上即崩。
// 因此两个发布包都镜像仓库布局:adapter/ + extension/core/ + service/ 平铺在包根。
// 用法:node scripts/build-npm-pkgs.mjs
//   然后 cd <repo>/.publish-adapter && npm publish --access public
//       cd <repo>/.publish-service && npm publish --access public

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ADAPTER = join(REPO, '.publish-adapter')
const OUT_SERVICE = join(REPO, '.publish-service')

const adapterPkg = JSON.parse(readFileSync(join(REPO, 'adapter/package.json'), 'utf8'))
const servicePkg = JSON.parse(readFileSync(join(REPO, 'service/package.json'), 'utf8'))

function stage(out, pkg, { main, exports, bin, files, dsh }) {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  cpSync(join(REPO, 'adapter'), join(out, 'adapter'), { recursive: true })
  cpSync(join(REPO, 'extension/core'), join(out, 'extension/core'), { recursive: true })
  cpSync(join(REPO, 'service'), join(out, 'service'), { recursive: true })
  cpSync(join(REPO, 'LICENSE'), join(out, 'LICENSE'))
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: 'module',
    main,
    exports,
    ...(bin ? { bin } : {}),
    files,
    engines: pkg.engines,
    repository: { type: 'git', url: 'git+https://github.com/Zoria-Lind/dsh-ecolink.git' },
    ...(dsh ? { dsh } : {}),
    keywords: pkg.keywords,
  }
  writeFileSync(join(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`[build-npm-pkgs] ${out} 就绪(${manifest.name}@${manifest.version})`)
}

// ① adapter 包:入口与 bundle 指向 adapter/ 子目录
stage(OUT_ADAPTER, adapterPkg, {
  main: 'adapter/src/index.js',
  exports: { '.': './adapter/src/index.js' },
  files: [
    'adapter/src', 'adapter/cordis.patch.yml', 'extension/core', 'service', 'README.md', 'LICENSE',
    // 2026-09-25:发布包绝不允许带本机配置(service/config.json 含真实 token;
    // config.json.bak-* 是本地备份)——发布事故级排除项
    '!service/config.json', '!service/config.json.bak-*', '!service/*.log',
    '!service/test.mjs', '!service/fix-pool.mjs',
  ],
  dsh: { bundle: { patch: './adapter/cordis.patch.yml' } },
})
cpSync(join(REPO, 'adapter/README.md'), join(OUT_ADAPTER, 'README.md'))

// ② service 包:入口与 bin 指向 service/ 子目录
stage(OUT_SERVICE, servicePkg, {
  main: 'service/server.mjs',
  exports: { '.': './service/server.mjs' },
  bin: { 'ecolink-service': 'service/server.mjs' },
  files: [
    'service', 'extension/core', 'README.md', 'LICENSE',
    // 同 adapter:本机配置/日志/测试/一次性工具不出包
    '!service/config.json', '!service/config.json.bak-*', '!service/*.log',
    '!service/test.mjs', '!service/fix-pool.mjs',
  ],
})
cpSync(join(REPO, 'service/README.md'), join(OUT_SERVICE, 'README.md'))
