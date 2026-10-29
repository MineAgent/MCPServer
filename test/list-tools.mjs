#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * 离线自检：按 stdio 启动 `bin/minecraft-mcp-bridge.mjs`，列出工具，检查每个工具的
 * inputSchema 是否落在宿主支持的 JSON Schema 子集内（DSH 的 mcp-client 会把
 * tools/list 里的 inputSchema 原样交给 dsh-tools，多一个关键字就整体注册失败）。
 *
 * 游戏没开也能跑：顺带调一次 status 看错误路径是否可读，并用缺参数调一次 control
 * 看 schema 校验是否生效。MCP 客户端用本包的 devDependency；schema 子集校验器是
 * 可选加强项，指向 DSH 安装目录（`DSH_CHECKOUT`），本机没有就跳过。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const binPath = join(packageDir, 'bin', 'minecraft-mcp-bridge.mjs');
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** DSH 安装目录：只用来拿它的 schema 子集校验器，拿不到就跳过那一步。 */
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? '';
const DSH_TOOLS = DSH_CHECKOUT === '' ? '' : `${DSH_CHECKOUT}/@deepseek-ai/dsh-tools/lib/index.js`;

let failed = 0;
const fail = (message) => {
	console.error(message);
	failed += 1;
};

/* ---------- 命令行开关 ---------- */

const version = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
	fail(`--version 输出不符：status=${version.status} stdout=${JSON.stringify(version.stdout)}`);
} else {
	console.log(`--version → ${version.stdout.trim()}`);
}

const help = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' });
if (help.status !== 0 || !help.stdout.includes('minecraft-mcp-bridge')) {
	fail(`--help 失败：status=${help.status}`);
} else {
	console.log('--help → 正常');
}

const badArg = spawnSync(process.execPath, [binPath, '--nope'], { encoding: 'utf8' });
if (badArg.status !== 2) fail(`未知参数应以 2 退出，实际 ${badArg.status}`);
else console.log('未知参数 → 以 2 退出');

/* ---------- MCP 协议 ---------- */

const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [binPath],
	stderr: 'pipe',
});

const client = new Client({ name: 'bridge-selfcheck', version: pkg.version });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\n工具 ${tools.length} 个：`);
for (const tool of tools) console.log(`  - ${tool.name}`);

const EXPECTED_TOOLS = [
	'baritone',
	'chat',
	'control',
	'cursor',
	'help',
	'inventory',
	'killaura',
	'op',
	'player',
	'request',
	'screenshot',
	'sounds',
	'status',
	'world',
];
const actualTools = tools.map((tool) => tool.name).sort();
const missingTools = EXPECTED_TOOLS.filter((name) => !actualTools.includes(name));
const extraTools = actualTools.filter((name) => !EXPECTED_TOOLS.includes(name));
if (missingTools.length > 0) fail(`缺少工具：${missingTools.join(', ')}`);
if (extraTools.length > 0) fail(`多出未预期的工具：${extraTools.join(', ')}`);
if (actualTools.length !== EXPECTED_TOOLS.length) fail(`工具数应为 ${EXPECTED_TOOLS.length}，实际 ${actualTools.length}`);

let assertSupportedJsonSchema;
if (DSH_TOOLS === '') {
	console.warn('未设置 DSH_CHECKOUT，跳过 schema 子集校验。');
} else {
	try {
		({ assertSupportedJsonSchema } = await import(DSH_TOOLS));
	} catch (error) {
		console.warn(`未找到 DSH 的 dsh-tools，跳过 schema 子集校验（${error.message}）`);
	}
}

for (const tool of tools) {
	const schema = tool.inputSchema;
	if (schema === undefined) {
		fail(`[${tool.name}] 没有 inputSchema`);
		continue;
	}
	if (Array.isArray(schema.required) && schema.required.some((key) => !(key in (schema.properties ?? {})))) {
		fail(`[${tool.name}] required 里有未声明的参数`);
	}
	if (assertSupportedJsonSchema !== undefined) {
		try {
			assertSupportedJsonSchema(JSON.parse(JSON.stringify(schema)));
		} catch (error) {
			fail(`[${tool.name}] inputSchema 不在宿主支持子集内：${error.message}`);
		}
	}
}

console.log('\n调用 status（游戏没开时应返回可读的 isError）：');
const status = await client.callTool({ name: 'status', arguments: {} });
console.log(JSON.stringify(status).slice(0, 400));
if (status.isError !== true) console.warn('提示：status 没有报错，说明 3420 上确实有服务在跑。');

console.log('\n调用 control（缺参数应被 schema 拒绝）：');
const bad = await client.callTool({ name: 'control', arguments: {} });
console.log(JSON.stringify(bad).slice(0, 300));
if (bad.isError !== true) fail('[control] 缺参数没有被拒绝');

/** 调一次工具并断言得到可读的 isError。 */
async function expectToolError(name, args, label) {
	const result = await client.callTool({ name, arguments: args });
	console.log(`\n调用 ${name}（${label}）：`);
	console.log(JSON.stringify(result).slice(0, 300));
	if (result.isError !== true) fail(`[${name}] ${label}没有被拒绝`);
}

await expectToolError('request', {}, '缺 endpoint');
await expectToolError('request', { endpoint: 'ka/state' }, 'endpoint 不是 / 开头');
await expectToolError('request', { endpoint: '/', method: 'GET', body: 'x' }, 'GET 带 body');
await expectToolError('request', { endpoint: '/', headers: ['nope'] }, 'headers 格式错误');
await expectToolError('baritone', {}, '缺 command');
await expectToolError('killaura', {}, '缺 action');
await expectToolError('killaura', { action: 'config' }, 'config 缺字段');

await client.close();
console.log(failed === 0 ? '\n自检通过。' : `\n自检失败 ${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
