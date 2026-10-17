import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { encodeSegment, projectKey, projectDir, sessionDir, isCanonicalGenerationName } from '../src/paths.js';

const DSH_HOME = join(homedir(), '.dsh');
const SESSIONS = join(DSH_HOME, 'sessions');
const WORKSPACE_JSON = join(DSH_HOME, 'storages', 'workspace.json');

test('projectKey 复刻后端：分隔符折叠 + 非 ASCII 转义', () => {
  // 期望值按 src/paths.js 头部写死的规则手推（分隔符→'-'、非 ASCII→~+UTF-16 十六进制大写补 4 位），
  // 不是把函数跑一遍抄回来的；这里是合成路径，不含任何本机目录。
  assert.equal(projectKey('D:\\示例\\A'), '--D-~793A~4F8B-A--');
  assert.equal(projectKey('E:\\工作\\AI\\甲'), '--E-~5DE5~4F5C-AI-~7532--');
  assert.equal(projectKey('E:\\默认'), '--E-~9ED8~8BA4--');
});

test('projectKey 折叠连续分隔符，只剥前导分隔符', () => {
  assert.equal(projectKey('E:/work/ws'), '--E-work-ws--');
  assert.equal(projectKey('E://work//ws'), '--E-work-ws--');
  assert.equal(projectKey('/usr/local'), '--usr-local--');
  assert.equal(projectKey('/'), '--root--');
  // 后端只 replace(/^-+/)，末尾的分隔符会留下 —— 这里是忠实复刻，不是笔误。
  assert.equal(projectKey('C:\\'), '--C---');
});

test('encodeSegment 对安全字符原样保留，其余转义', () => {
  assert.equal(encodeSegment('session-107063e5-76ba-4f53-a8c0-187122bc8e5c'), 'session-107063e5-76ba-4f53-a8c0-187122bc8e5c');
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
  assert.equal(encodeSegment('a/b'), 'a~002Fb');
  assert.equal(encodeSegment('~'), '~007E');
  // 只有整个段就是 . 或 .. 时才特殊处理；段内的 . 属于安全字符，保持原样。
  assert.equal(encodeSegment('../x'), '..~002Fx');
  assert.throws(() => encodeSegment(''), /empty path segment/);
});

test('generation 文件名判定只认规范名', () => {
  assert.ok(isCanonicalGenerationName('session.jsonl.zstd'));
  assert.ok(isCanonicalGenerationName('session.v4.jsonl.zstd'));
  assert.ok(isCanonicalGenerationName('session.jsonl'));
  assert.ok(isCanonicalGenerationName('session.v12.jsonl'));
  assert.ok(!isCanonicalGenerationName('session.v0.jsonl.zstd'));
  assert.ok(!isCanonicalGenerationName('session.v4.jsonl.zstd.tmp'));
  assert.ok(!isCanonicalGenerationName('session.migration.abc.tmp'));
  assert.ok(!isCanonicalGenerationName('session.lock'));
});

test('projectKey 与真实 ~/.dsh/sessions 目录逐一吻合', (t) => {
  if (!existsSync(WORKSPACE_JSON) || !existsSync(SESSIONS)) {
    t.skip('本机没有 DSH 会话存储，跳过真实数据比对');
    return;
  }
  const store = JSON.parse(readFileSync(WORKSPACE_JSON, 'utf8'));
  const rows = Object.values(store.tables?.workspaces ?? {});
  assert.ok(rows.length > 0, '注册表里应当至少有一个工作区');
  for (const row of rows) {
    const key = projectKey(row.path);
    const dir = join(SESSIONS, key);
    assert.ok(existsSync(dir), 'projectKey(' + row.path + ') = ' + key + ' 应当在 ~/.dsh/sessions 下存在');
    for (const id of row.sessionIds ?? []) {
      assert.ok(existsSync(sessionDir(SESSIONS, row.path, id)), '会话目录缺失: ' + id + ' @ ' + row.path);
    }
  }
});

test('sessionDir / projectDir 组合正确', () => {
  assert.equal(projectDir('R', undefined), join('R', '_no-cwd'));
  assert.equal(sessionDir('R', 'D:\\示例\\A', 's1'), join('R', '--D-~793A~4F8B-A--', 's1'));
});
