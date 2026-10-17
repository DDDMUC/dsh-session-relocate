import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { CHECKSUM_SUPPORTED, scanZstdFrames, isZstdArtifact, readFirstLine, replaceFirstLine, decodeAllFrames } from '../src/zstd.js';

const TMP = join(import.meta.dirname, '..', '.test-tmp', 'zstd');
const SESSIONS = join(homedir(), '.dsh', 'sessions');

function checksumOptions() {
  return { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
}

function findRealSessionFiles(limit) {
  const found = [];
  if (!existsSync(SESSIONS)) return found;
  for (const project of readdirSync(SESSIONS)) {
    const pdir = join(SESSIONS, project);
    let entries;
    try { entries = readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sdir = join(pdir, entry.name);
      for (const f of readdirSync(sdir)) {
        if (!f.endsWith('.jsonl.zstd')) continue;
        const p = join(sdir, f);
        if (readFileSync(p).length < 200) continue;
        found.push(p);
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

test('本机 Node 支持 zstd 与其校验和参数', () => {
  assert.ok(CHECKSUM_SUPPORTED, '需要 node:zlib 的 ZSTD_c_checksumFlag（Node >= 22.15）');
});

test('未压缩日志：首行替换只动第一行', () => {
  const original = Buffer.from('{"a":1}\nsecond\nthird\n', 'utf8');
  assert.equal(readFirstLine(original), '{"a":1}');
  const patched = replaceFirstLine(original, '{"a":2}');
  assert.equal(patched.toString('utf8'), '{"a":2}\nsecond\nthird\n');
  assert.equal(readFirstLine(patched), '{"a":2}');
});

test('拼接帧：只重编第一帧，其余字节完全不动', () => {
  const line1 = '{"type":"session","cwd":"E:\\\\A"}';
  const header = Buffer.from(line1, 'utf8');
  const frame1 = zstdCompressSync(Buffer.concat([header, Buffer.from('\n{"e":1}\n', 'utf8')]), checksumOptions());
  const frame2 = zstdCompressSync(Buffer.from('{"e":2}\n{"e":3}\n', 'utf8'), checksumOptions());
  const file = Buffer.concat([frame1, frame2]);

  assert.ok(isZstdArtifact(file));
  assert.equal(scanZstdFrames(file).frames.length, 2);
  assert.equal(readFirstLine(file), line1);

  const line2 = '{"type":"session","cwd":"E:\\\\B"}';
  const patched = replaceFirstLine(file, line2);
  assert.equal(readFirstLine(patched), line2);

  const before = scanZstdFrames(file).frames;
  const after = scanZstdFrames(patched).frames;
  assert.equal(after.length, 2);
  assert.deepEqual(patched.subarray(after[1].start), file.subarray(before[1].start));
  assert.equal(
    decodeAllFrames(patched).toString('utf8'),
    line2 + '\n{"e":1}\n{"e":2}\n{"e":3}\n',
  );
});

test('torn 尾帧被原样保留', () => {
  const frame1 = zstdCompressSync(Buffer.from('{"h":1}\nbody\n', 'utf8'), checksumOptions());
  const tornTail = Buffer.from([0x28, 0xb5, 0x2f]);
  const file = Buffer.concat([frame1, tornTail]);
  const scan = scanZstdFrames(file);
  assert.equal(scan.frames.length, 1);
  assert.equal(scan.tornStart, frame1.length);
  const patched = replaceFirstLine(file, '{"h":2}');
  assert.deepEqual(patched.subarray(patched.length - tornTail.length), tornTail);
  assert.equal(readFirstLine(patched), '{"h":2}');
});

test('真实会话日志：首行是合法 header，改 cwd 后其余明文逐字节一致', (t) => {
  const files = findRealSessionFiles(3);
  if (files.length === 0) {
    t.skip('本机没有真实会话日志，跳过');
    return;
  }
  mkdirSync(TMP, { recursive: true });
  try {
    for (const path of files) {
      const original = readFileSync(path);
      const line = readFirstLine(original);
      // DSH 自己的不变量：第一帧必须恰好是一行 header（换行只在末尾）。
      const frames = scanZstdFrames(original).frames;
      const firstPlain = zstdDecompressSync(original.subarray(frames[0].start, frames[0].end));
      assert.equal(firstPlain.indexOf(10), firstPlain.length - 1, '第一帧必须恰好是一行: ' + path);

      const header = JSON.parse(line);
      assert.equal(header.type, 'session');
      assert.equal(typeof header.id, 'string');
      assert.equal(typeof header.version, 'number');
      assert.equal(typeof header.cwd, 'string');

      const targetCwd = 'E:\\MOVED\\目标';
      const moved = { ...header, cwd: targetCwd };
      const patched = replaceFirstLine(original, JSON.stringify(moved));

      const reparsed = JSON.parse(readFirstLine(patched));
      assert.equal(reparsed.cwd, targetCwd);
      assert.equal(reparsed.id, header.id);
      assert.equal(reparsed.version, header.version);
      assert.equal(reparsed.createdAt, header.createdAt);
      assert.equal(reparsed.isSeeded, header.isSeeded);
      assert.equal(reparsed.delegationDepth, header.delegationDepth);
      assert.equal(reparsed.agentPreset, header.agentPreset);

      const wantLines = decodeAllFrames(original).toString('utf8').split('\n');
      const gotLines = decodeAllFrames(patched).toString('utf8').split('\n');
      assert.equal(gotLines.length, wantLines.length, '行数必须一致: ' + path);
      assert.deepEqual(gotLines.slice(1), wantLines.slice(1), '除首行外的明文必须一致: ' + path);
      assert.equal(gotLines[0], JSON.stringify(moved));

      // 改写后这条不变量必须继续成立（否则 DSH 会拒绝打开搬过去的会话）。
      const patchedFrames = scanZstdFrames(patched).frames;
      const patchedFirst = zstdDecompressSync(patched.subarray(patchedFrames[0].start, patchedFrames[0].end));
      assert.equal(patchedFirst.indexOf(10), patchedFirst.length - 1, '改写后第一帧仍须恰好一行: ' + path);
      assert.equal(patchedFirst.subarray(0, patchedFirst.length - 1).toString('utf8'), JSON.stringify(moved));

      const a = scanZstdFrames(original).frames;
      const b = scanZstdFrames(patched).frames;
      assert.equal(a.length, b.length, '帧数一致: ' + path);
      if (a.length > 1) {
        assert.deepEqual(patched.subarray(b[1].start), original.subarray(a[1].start), '第二帧起的原始字节必须一致: ' + path);
      }

      const out = join(TMP, 'patched-' + header.id + '.jsonl.zstd');
      writeFileSync(out, patched);
      assert.equal(readFirstLine(readFileSync(out)), JSON.stringify(moved));
    }
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});
