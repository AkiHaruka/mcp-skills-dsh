/**
 * yaml@2.9.1 的 vendored ESM 入口。
 *
 * yaml/dist 是 CommonJS（package.json "type": "commonjs"），这里用一个 .mjs
 * 薄封装把它以「默认导出」暴露给 ESM 消费者：Node 的 ESM→CJS 互操作会把
 * module.exports 作为 default 给出。这样 lib/yaml-io.mjs 只需：
 *
 *     import YAML from '../vendor/yaml/index.mjs'
 *
 * 全程相对路径、与磁盘绝对位置无关，且 tarball 内零外部 npm 依赖。
 */
import YAML from './index.js'

export default YAML

// 同时显式转出常用命名导出，便于 ESM 侧按需 import（CJS 命名导出探测不可靠）。
export const {
  parse,
  parseDocument,
  parseAllDocuments,
  stringify,
  isAlias,
  isCollection,
  isDocument,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  Document,
  Scalar,
  YAMLMap,
  YAMLSeq,
  Pair,
  Composer,
  Schema,
  visit,
  CST
} = YAML
