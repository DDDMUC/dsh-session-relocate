/**
 * DSH 会话存储的路径布局。
 *
 * 这些函数是 @deepseek-ai/dsh-session-persistence-jsonl 内部算法（projectKey /
 * encodeSegment）的忠实移植：会话目录名由 header 里的 cwd 推导，插件必须能自己
 * 算出目标目录，才能在搬完之后让 DSH 仍然找得到日志。
 *
 * 移植正确性由 test/paths.test.js 用真实 DSH 数据（~/.dsh/sessions 下的真实目录名）
 * 与真实路径名逐一比对。
 *
 * @module dsh-session-relocate/paths
 */
import { join } from 'node:path';

/** 可以原样出现在路径段里的安全字符。 */
const SAFE_CODE_UNIT = /^[A-Za-z0-9._-]$/;

/**
 * 把一个任意字符串编码成一个安全的路径段（对全部 UTF-16 字符串都是单射的）。
 * 安全码元保持原样，其余（含 ~ 本身）转成 ~XXXX（大写十六进制、至少 4 位）。
 * 与后端一致：. 和 .. 被特殊处理，避免路径穿越。
 *
 * @param raw - 待编码字符串，不可为空。
 * @returns 安全的单段路径名。
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && SAFE_CODE_UNIT.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * 由 cwd 得到「项目目录」名：分隔符（/ \ :）折叠成 -，不安全码元走 ~XXXX，
 * 两端包 --，整体截断到 251 字符。该映射有意有损（便于人肉浏览），
 * 所以 cwd 不同的会话仍靠 session id 区分。
 *
 * @param cwd - 会话的项目目录。
 * @returns 单个安全的项目目录名。
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && SAFE_CODE_UNIT.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  const body = (readable.replace(/^-+/, '') || 'root').slice(0, 251);
  return '--' + body + '--';
}

/**
 * 配置的存储根目录下，某个 cwd 的项目目录；cwd 未定义时为 _no-cwd。
 *
 * @param root - 会话存储根目录。
 * @param cwd - 会话的项目目录。
 * @returns 项目目录的绝对路径。
 */
export function projectDir(root, cwd) {
  return cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd));
}

/**
 * 某个会话独占的目录。
 *
 * @param root - 会话存储根目录。
 * @param cwd - 会话的项目目录。
 * @param id - 会话 id。
 * @returns 会话目录的绝对路径。
 */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

/** 一个会话 generation 文件名：version 0 是 session.jsonl，否则是 session.vN.jsonl。 */
export function generationLogBasename(version) {
  return version === 0 ? 'session.jsonl' : 'session.v' + String(version) + '.jsonl';
}

/** 当前后端只可能产出这两种物理编码。 */
export const COMPRESSION_SUFFIX = { zstd: '.zstd', none: '' };

/**
 * 一个 generation 的文件名。
 *
 * @param version - 物理格式 generation。
 * @param compression - 物理编码。
 * @returns 文件名（不含目录）。
 */
export function generationLogFilename(version, compression) {
  const suffix = COMPRESSION_SUFFIX[compression];
  if (suffix === undefined) throw new Error('unknown session compression: ' + String(compression));
  return generationLogBasename(version) + suffix;
}

/**
 * 判断一个目录项是否是后端会认的 generation 文件（用于搬移时枚举全部历史）。
 * 故意只认规范名，避免误改迁移临时文件等。
 *
 * @param name - 目录项名字。
 * @returns 是否是规范 generation 文件名。
 */
export function isCanonicalGenerationName(name) {
  return /^session(\.v[1-9][0-9]*)?\.jsonl(\.zstd)?$/.test(name);
}
