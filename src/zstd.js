/**
 * Zstandard 拼接帧容器的**帧级**外科手术。
 *
 * DSH 的会话日志是「一串彼此独立的 Zstandard 帧」，第一帧的第一行就是 header。
 * 要改 header 里的 cwd，最安全的做法是只重编第一帧，其余字节原样保留 ——
 * 这样连尾部未写完的（torn）帧都不会被我们碰坏，重建后的文件与后端自己的
 * 写入路径完全同构。
 *
 * scanZstdFrames 是从 @deepseek-ai/dsh-session-persistence-jsonl 内部移植的
 * 结构扫描器（只读帧头，不解压块），压缩参数也与后端一致
 * （ZSTD_c_checksumFlag: 1，即带校验和的帧）。
 *
 * @module dsh-session-relocate/zstd
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

/** Zstandard 魔数（小端读取：0xFD2FB528）。 */
const ZSTD_MAGIC = 4247762216;

/** 与后端一致的压缩参数：写校验和，让读路径能校验帧完整性。 */
const CHECKSUM_PARAM = constants.ZSTD_c_checksumFlag;
const CHECKSUM_OPTIONS = CHECKSUM_PARAM === undefined ? undefined : { params: { [CHECKSUM_PARAM]: 1 } };

/** 该 Node 版本是否支持后端期望的校验和参数。 */
export const CHECKSUM_SUPPORTED = CHECKSUM_PARAM !== undefined;

/**
 * 结构扫描拼接的 Zstandard 流，不解压任何块。
 * 完整帧按其字节范围返回；EOF 落在最后一帧中途时，返回该帧起点供修复。
 *
 * @param buffer - 会话文件当前的全部字节。
 * @param maxFrames - 最多扫描多少个完整帧（默认不限）。
 * @returns 完整帧范围，外加可选的未完成末帧起点。
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('corrupt Zstandard session log: invalid frame magic at byte ' + String(offset));
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error('corrupt Zstandard session log: reserved frame-header bit at byte ' + String(offset - 1));
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error('corrupt Zstandard session log: reserved block type at byte ' + String(offset - 3));
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * 文件是否以 Zstandard 帧开头（即 compression 为 zstd）。
 *
 * @param buffer - 文件字节。
 * @returns 是否是 zstd 会话日志。
 */
export function isZstdArtifact(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC;
}

/** 解出第一帧的明文（header 就住在它的第一行）。 */
function firstFramePlaintext(buffer) {
  const scan = scanZstdFrames(buffer, 1);
  const first = scan.frames[0];
  if (first === undefined) {
    throw new Error('session log carries no complete Zstandard frame (torn at byte ' + String(scan.tornStart ?? 0) + ')');
  }
  return { first, plain: zstdDecompressSync(buffer.subarray(first.start, first.end)) };
}

/**
 * 读出会话日志的第一行（header 行）。zstd 与未压缩两种编码都支持。
 *
 * @param buffer - 会话文件字节。
 * @returns 第一行的 UTF-8 文本。
 */
export function readFirstLine(buffer) {
  if (isZstdArtifact(buffer)) {
    const { plain } = firstFramePlaintext(buffer);
    const nl = plain.indexOf(10);
    if (nl < 0) throw new Error('the first Zstandard frame carries no complete line');
    return plain.subarray(0, nl).toString('utf8');
  }
  const nl = buffer.indexOf(10);
  if (nl < 0) throw new Error('the session log carries no complete line');
  return buffer.subarray(0, nl).toString('utf8');
}

/**
 * 只替换第一行，其余字节原样保留。
 *
 * 对 zstd：只重编第一帧（带校验和，与后端写入一致），从第二帧开始的原始字节
 * —— 包括任何 torn 尾帧 —— 一个字节都不动。
 * 对未压缩：直接在字节层面替换首个换行符之前的内容。
 *
 * @param buffer - 原文件字节。
 * @param newFirstLine - 新的第一行（不含换行符）。
 * @returns 新的文件字节。
 */
export function replaceFirstLine(buffer, newFirstLine) {
  const encoded = Buffer.from(newFirstLine, 'utf8');
  if (encoded.includes(10)) throw new Error('the replacement first line must not contain a newline');
  if (isZstdArtifact(buffer)) {
    const { first, plain } = firstFramePlaintext(buffer);
    const nl = plain.indexOf(10);
    if (nl < 0) throw new Error('the first Zstandard frame carries no complete line');
    const rebuilt = CHECKSUM_OPTIONS === undefined
      ? zstdCompressSync(Buffer.concat([encoded, plain.subarray(nl)]))
      : zstdCompressSync(Buffer.concat([encoded, plain.subarray(nl)]), CHECKSUM_OPTIONS);
    return Buffer.concat([buffer.subarray(0, first.start), rebuilt, buffer.subarray(first.end)]);
  }
  const nl = buffer.indexOf(10);
  if (nl < 0) throw new Error('the session log carries no complete line');
  return Buffer.concat([encoded, buffer.subarray(nl)]);
}

/**
 * 把整份日志按帧解压并顺序拼接成明文字节，用于搬移后的逐字节自校验。
 *
 * @param buffer - 会话文件字节。
 * @returns 全部完整帧的明文拼接。
 */
export function decodeAllFrames(buffer) {
  if (!isZstdArtifact(buffer)) return Buffer.from(buffer);
  const { frames } = scanZstdFrames(buffer);
  const parts = [];
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
  }
  return Buffer.concat(parts);
}
