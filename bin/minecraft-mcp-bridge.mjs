#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * minecraft-mcp-bridge 的命令行入口。
 *
 * 只用 Node 内置模块解析参数，然后把 stdin/stdout 交给 MCP stdio 服务。
 * `--help` / `--version` 直接在本地回答，不启动服务。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const USAGE = `minecraft-mcp-bridge ${pkg.version} — 用 MCP over stdio 控制本机 Minecraft 客户端

用法
  minecraft-mcp-bridge [选项]

选项
  --url <地址>     游戏侧共享 HTTP 服务的根地址（默认 http://127.0.0.1:3420）
  -h, --help       显示本说明
  -V, --version    显示版本

环境变量
  MC_BRIDGE_URL    同 --url；命令行参数优先

说明
  本程序只做 HTTP 桥接，不启动游戏。stdin/stdout 是 MCP 协议通道，
  日志一律走 stderr。游戏没在跑时，工具返回一句可读的错误文本。
  游戏侧需要 .minecraft/mods 里加载共享 HTTP 服务的模组：
  httpdprovider + mcctl + advanced-info-fetch + craftcmd。
`;

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{help?: true, version?: true, url?: string, error?: string}}
 */
function parseArgv(argv) {
	const result = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '-h' || arg === '--help') return { help: true };
		if (arg === '-V' || arg === '--version') return { version: true };
		if (arg === '--url') {
			const value = argv[index + 1];
			if (value === undefined) return { error: '--url 后面要跟一个地址' };
			result.url = value;
			index += 1;
			continue;
		}
		if (arg.startsWith('--url=')) {
			result.url = arg.slice('--url='.length);
			continue;
		}
		return { error: `无法识别的参数 ${JSON.stringify(arg)}` };
	}
	return result;
}

const parsed = parseArgv(process.argv.slice(2));

if (parsed.error !== undefined) {
	process.stderr.write(`minecraft-mcp-bridge: ${parsed.error}\n\n${USAGE}`);
	process.exit(2);
}
if (parsed.help === true) {
	process.stdout.write(USAGE);
	process.exit(0);
}
if (parsed.version === true) {
	process.stdout.write(`${pkg.version}\n`);
	process.exit(0);
}

const { start, DEFAULT_BASE_URL } = await import('../src/server.mjs');

start({ baseUrl: parsed.url ?? process.env.MC_BRIDGE_URL ?? DEFAULT_BASE_URL });
