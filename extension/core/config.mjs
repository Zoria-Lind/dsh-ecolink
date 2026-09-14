// dsh-ecolink 扩展默认配置单一来源(E6/F6:此前 background/popup/inject 三处默认值
// 互不一致——background 8 键、popup 7 键少 tagName、inject 4 键)。
// 消费方式:
//   - background.js(MV3 module)与 popup.js(popup.html 以 type=module 加载):直接 import
//   - inject.js 是经典脚本不能 import → 页内镜像仅保留它真正需要的 4 键,注释锁死同步
//   - content.js 不读配置(只透传)

export const DEFAULT_CONFIG = {
  bridgeUrl: 'http://127.0.0.1:17520',
  token: '',
  injectEnabled: true,
  harvestEnabled: true,
  singleInjection: true, // 内容通道(2026-09-14 恢复):true=首条全量+后续 diff;false=每轮全量。压缩块沿用每页一次去重
  contentInjectionEnabled: true, // 内容注入逃生舱(E1 逃生舱键,默认开):false=回到 E1 纯指令行为
  maxInjectionChars: 3000,
  compressMinAgeDays: 5,
  tagName: 'DSM:memory_write', // 注意:F11——当前全仓消费点均硬编码 'DSM:memory_write',此键暂为死配置,改它不生效
  panelEnabled: true, // E6:网页端只读面板
  muted: false, // E7:一键静音(注入+收割全关;优先级高于两个分开关)
  debug: false, // 背景层 console 日志门控(默认关;隐私卫生,收割内容片段不入 console)
}
