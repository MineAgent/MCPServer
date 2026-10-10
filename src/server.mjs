// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * Minecraft 客户端控制桥（MCP stdio server）。
 *
 * 把 `.minecraft/mods/` 里几个客户端模组挂在共享 HTTP 服务（默认
 * `http://127.0.0.1:3420`）上的接口，映射成 MCP 工具：
 *
 *   /ctl  mcctl               控制：按键 / 鼠标 / 视角 / 截图 / Baritone / 聊天 / 打字
 *   /aif  AdvancedInfoFetcher 只读状态：坐标 / 背包 / 聊天 / 声音 / 世界
 *   /op   Craft Command       容器操作：合成 / 熔炉 / 箱子 / 快捷栏 / 转向
 *
 * 本进程不碰游戏，只做 HTTP 桥接；游戏没开时工具返回可读的错误。
 * 这是一个独立程序：只依赖本包自己的依赖，任何 MCP 客户端都能通过 stdio 启动它。
 * stdin/stdout 走 MCP 协议，日志一律走 stderr。
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

/** 共享 HTTP 服务的默认地址；游戏窗口标题里的端口号就是它。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3420';

/** MCP 服务端身份，出现在 initialize 结果里。 */
export const SERVER_INFO = Object.freeze({
	name: 'minecraft-client-bridge',
	title: 'Minecraft 客户端控制桥',
	version: '0.2.0',
});

/** 归一化服务地址：去空白、去末尾斜杠。 */
function normalizeBaseUrl(value) {
	const text = String(value ?? '').trim();
	return (text.length > 0 ? text : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** 各类请求的超时：/op 的合成与含 type 的 /ctl 请求都会同步阻塞到执行结束。 */
const TIMEOUT = {
	read: 15_000,
	screenshot: 20_000,
	control: 150_000,
	op: 180_000,
};

/** HTTP 状态码的中文含义（模组自己的错误正文会附在后面）。 */
const STATUS_HINT = {
	400: '请求被拒',
	404: '路径不存在',
	405: '方法不允许',
	409: '客户端没在世界里',
	413: '请求体过大',
	500: '模组内部错误',
	503: '无法排队',
	504: '等客户端超时',
};

/** 桥接层自身的失败（连不上、超时、非 200）；正文直接给模型看。 */
class BridgeError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 造一个绑定到某个服务地址的请求函数，失败时抛出带中文说明的 {@link BridgeError}。
 *
 * @param {string} baseUrl 形如 `http://127.0.0.1:3420` 的根地址
 * @returns {(path: string, options?: {method?: string, body?: string, timeoutMs?: number, binary?: boolean}) => Promise<string|Buffer>}
 *   发起请求；`binary` 为真时返回 Buffer，否则返回文本
 */
function makeRequest(baseUrl) {
	return async function request(path, options = {}) {
		const { method = 'GET', body, timeoutMs = TIMEOUT.read, binary = false } = options;
		const url = baseUrl + path;

		let response;
		try {
			response = await fetch(url, {
				method,
				...(body === undefined ? {} : { body, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			if (error?.name === 'TimeoutError') {
				throw new BridgeError(
					`等待 ${url} 超过 ${timeoutMs}ms 没有响应：命令可能还在游戏里继续跑，稍后用 player / chat 对账。`,
				);
			}
			const cause = error?.cause?.code ?? error?.message ?? error;
			throw new BridgeError(
				`连不上 ${url}：Minecraft 客户端没在运行，或 MGHttpdProvider 没加载。（${cause}）`,
			);
		}

		if (!response.ok) {
			const detail = (await response.text().catch(() => '')).trim();
			const hint = STATUS_HINT[response.status] ?? '';
			throw new BridgeError(`HTTP ${response.status}${hint ? ` ${hint}` : ''}${detail ? `：${detail}` : ''}`);
		}

		if (binary) return Buffer.from(await response.arrayBuffer());
		return await response.text();
	};
}

/**
 * 把 zod 对象包成 SDK 接受的 StandardSchema，并在 JSON Schema 里去掉根上的
 * `$schema`：宿主只支持 type/oneOf/properties/required/additionalProperties/
 * items/enum/const + 注解，多一个关键字就拒绝注册。
 *
 * @param {import('zod').ZodObject} schema
 */
function inputSchema(schema) {
	const standard = schema['~standard'];
	const stripRoot = (value) => {
		const { $schema: _ignored, ...rest } = JSON.parse(JSON.stringify(value));
		return rest;
	};
	return {
		'~standard': {
			version: 1,
			vendor: 'dsh-minecraft-bridge',
			validate: (value) => standard.validate(value),
			jsonSchema: {
				input: (options) => stripRoot(standard.jsonSchema.input(options)),
				output: (options) => stripRoot(standard.jsonSchema.output(options)),
			},
		},
	};
}

const textResult = (text) => ({ content: [{ type: 'text', text: text.length > 0 ? text : '(空)' }] });

/** 工具回调：把任何失败变成给模型看的 isError 文本，不让 SDK 抛协议错误。 */
const tool = (run) => async (args) => {
	try {
		return await run(args ?? {});
	} catch (error) {
		const text = error instanceof BridgeError ? error.message : `桥接内部错误：${error?.stack ?? error}`;
		return { isError: true, content: [{ type: 'text', text }] };
	}
};

/** 一次快照式读取（/aif/*）。 */
const snapshot = (request, path, emptyText) =>
	tool(async () => {
		const text = (await request(path)).trim();
		return textResult(text.length > 0 ? text : emptyText);
	});

/** 从 PNG 的 IHDR 里读画面尺寸，用来在截图结果里说清坐标系。 */
function pngSize(buffer) {
	if (buffer.length >= 24 && buffer.toString('latin1', 1, 4) === 'PNG') {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	return undefined;
}

/** 服务端 instructions：随 initialize 返回，宿主会把它并入系统提示词。 */
const instructionsFor = (baseUrl) => `本桥控制本机 Minecraft 客户端（窗口 854×480、guiScale=2），游戏侧接口在 ${baseUrl}。

观测：player（坐标/朝向/生命/饱食）、inventory、world、chat、sounds、screenshot、cursor。
操作：control（按键/鼠标/视角/Baritone/聊天/打字）、op（合成/熔炉/箱子/快捷栏/转向）。

1. 一次只做一个动作，做完立刻用 player / inventory 对账；不确定刚才发生了什么就读 chat 与 sounds。
2. chat 与 sounds 是「读取即清空」的增量回显：指令输出、Baritone 输出、报错、关键声音都在里面，别靠截图猜结果。
3. GUI 优先用 op（精确、有结果）；手点鼠标只是兜底：先 screenshot 看界面，再 cursor 取坐标，最后用 control 的 \`mouse goto <x> <y>\`。
4. 命令被拒时返回的是原文原因（原料不足 / 没打开界面 / 配方未解锁 / 没有聚焦文本框），按原因补救。
5. 服务不通、模组缺失或刚启动游戏：先跑 status；语法细节用 help。`;

/**
 * 建一个 MCP server 实例并注册全部工具。每次连接调一次（SDK 的工厂约定），
 * 工具清单是静态的，构造成本可以忽略。
 *
 * @param {{baseUrl?: string}} [options] 覆盖游戏侧 HTTP 服务地址
 * @returns {McpServer}
 */
export function createServer(options = {}) {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const request = makeRequest(baseUrl);

	const server = new McpServer(SERVER_INFO, {
		capabilities: { tools: {} },
		instructions: instructionsFor(baseUrl),
	});

	const readOnly = { readOnlyHint: true };

	server.registerTool(
		'status',
		{
			title: '自检：服务与接口',
			description:
				'检查控制服务是否在跑、/ctl（控制）、/aif（只读状态）、/op（容器操作）三个接口各是否挂载、客户端是否已进入世界，并给出接口索引。刚启动游戏或任何调用异常时先跑它。',
			inputSchema: inputSchema(z.object({})),
			annotations: readOnly,
		},
		tool(async () => {
			const index = await request('/', { timeoutMs: 5_000 });
			const mounted = {};
			for (const prefix of ['ctl', 'aif', 'op']) {
				try {
					await request(`/${prefix}/`, { method: 'HEAD', timeoutMs: 5_000 });
					mounted[prefix] = true;
				} catch {
					mounted[prefix] = false;
				}
			}

			let world = '未知（/aif 不可用）';
			if (mounted.aif) {
				try {
					await request('/aif/info', { timeoutMs: 5_000 });
					world = '已进入世界';
				} catch (error) {
					world = error.message.includes('HTTP 409') ? '未进入世界（在主菜单或加载中）' : `未知（${error.message}）`;
				}
			}

			return textResult(
				[
					`服务：${baseUrl} 可连接`,
					`世界：${world}`,
					`/ctl 控制：${mounted.ctl ? '可用' : '不可用'}`,
					`/aif 只读状态：${mounted.aif ? '可用' : '不可用'}`,
					`/op 容器操作：${mounted.op ? '可用' : '不可用'}`,
					'',
					'接口索引：',
					index.trim(),
				].join('\n'),
			);
		}),
	);

	server.registerTool(
		'help',
		{
			title: '接口说明书',
			description:
				'返回某个接口的权威完整说明（游戏内模组自带的帮助文本）。语法、按键名、返回码与限制都以它为准。',
			inputSchema: inputSchema(
				z.object({
					prefix: z.enum(['ctl', 'aif', 'op']).describe('ctl=控制命令；aif=只读状态；op=容器操作'),
				}),
			),
			annotations: readOnly,
		},
		tool(async ({ prefix }) => textResult((await request(`/${prefix}/`)).trim())),
	);

	server.registerTool(
		'player',
		{
			title: '玩家状态',
			description: '坐标、朝向（yaw/pitch）、生命、饱食、经验、状态效果，纯文本。',
			inputSchema: inputSchema(z.object({})),
			annotations: readOnly,
		},
		snapshot(request, '/aif/info', '(没有读到玩家状态)'),
	);

	server.registerTool(
		'inventory',
		{
			title: '背包与容器',
			description: '背包、副手、盔甲、快捷栏，以及当前打开的熔炉/箱子里有什么，纯文本。',
			inputSchema: inputSchema(z.object({})),
			annotations: readOnly,
		},
		snapshot(request, '/aif/inventory', '(背包是空的)'),
	);

	server.registerTool(
		'world',
		{
			title: '世界状态',
			description: '当前维度、游戏时间与天数、天气。',
			inputSchema: inputSchema(z.object({})),
			annotations: readOnly,
		},
		snapshot(request, '/aif/world', '(没有读到世界状态)'),
	);

	server.registerTool(
		'chat',
		{
			title: '聊天回显（读取即清空）',
			description:
				'自上次读取以来聊天栏出现的一切：指令输出、Baritone 输出、报错、玩家发言。读取即清空，只返回新内容。',
			inputSchema: inputSchema(z.object({})),
			annotations: readOnly,
		},
		snapshot(request, '/aif/msg', '（没有新的聊天内容）'),
	);

	server.registerTool(
		'sounds',
		{
			title: '声音回显（读取即清空）',
			description: '自上次读取以来播放的声音，用来判断刚才发生了什么。读取即清空，只返回新内容。',
			inputSchema: inputSchema(
				z.object({
					filter: z
						.enum(['important', 'all'])
						.optional()
						.describe('important（默认）只保留方块破坏/放置、怪物、爆炸、拾取等关键声音；all 返回全部声音事件'),
				}),
			),
			annotations: readOnly,
		},
		tool(async ({ filter }) => {
			const text = (await request(filter === 'all' ? '/aif/sound' : '/aif/keysnd')).trim();
			return textResult(text.length > 0 ? text : '（没有新的声音）');
		}),
	);

	server.registerTool(
		'screenshot',
		{
			title: '截取当前画面',
			description: '截取当前游戏帧并作为图片返回（原生分辨率 PNG，不写入 screenshots 目录）。',
			inputSchema: inputSchema(z.object({})),
			annotations: readOnly,
		},
		tool(async () => {
			const png = await request('/ctl/prtsc', { timeoutMs: TIMEOUT.screenshot, binary: true });
			const size = pngSize(png);
			return {
				content: [
					{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
					{
						type: 'text',
						text: `当前帧已截取${size ? `：${size.width}×${size.height}` : ''}（PNG，窗口像素坐标系，cursor 与 mouse goto 用的是同一套坐标）`,
					},
				],
			};
		}),
	);

	server.registerTool(
		'cursor',
		{
			title: '光标位置',
			description:
				'鼠标光标现在的位置：窗口像素坐标、GUI 缩放坐标、是否被窗口抓取、当前界面类名。配合 control 的 `mouse goto` 做绝对定位点击。',
			inputSchema: inputSchema(z.object({})),
			annotations: readOnly,
		},
		snapshot(request, '/ctl/mouse', '(没有读到光标位置)'),
	);

	server.registerTool(
		'control',
		{
			title: '注入输入（按键/鼠标/Baritone/聊天）',
			description:
				'把一段输入序列交给游戏，走原版输入管线执行（不抢真实键鼠）。多行或用 `;` 分隔，严格按顺序执行。按键/鼠标这类定时动作是排队的，命令一被接受就返回，用 waitMs 等它做完。含 `bt`/`#` 需要装了 Baritone，含 `type`/`typeEnter` 需要当前有聚焦的文本框，否则整个请求失败、什么都不执行。',
			inputSchema: inputSchema(
				z.object({
					command: z
						.string()
						.describe(
							'mcctl 命令文本，不能为空。常用：`W 500` 按住 W 500ms（默认 50）；`W+Ctrl 100` 同时按住多键；`mouse left|right|mid [ms]`；`mouse move <dx> <dy>` 相对移动（+右 +下）；`mouse goto <x> <y>` 移到窗口像素坐标；`mouse scroll <n>`；`delay <ms> <命令>`；`release` 立刻松开全部；`bt <命令>` 或 `#<命令>` 执行 Baritone；`chat <文本>` 发聊天（`/` 开头当指令）；`type <文本>` 打进聚焦文本框（`\\n` 表示回车）；`typeEnter` 在文本框里回车。按键名不分大小写：A–Z、0–9、F1–F12、SPACE/TAB/ENTER/BACKSPACE/ESC/UP/DOWN/LEFT/RIGHT 等；单次时长与 delay 上限 600000ms。完整语法用 help。',
						),
					waitMs: z
						.number()
						.optional()
						.describe('命令被接受后等待这么久（毫秒，整数，0–60000，默认 0）再返回，用来等一次定时输入做完，省掉一次单独的状态读取'),
				}),
			),
		},
		tool(async ({ command, waitMs = 0 }) => {
			if (command.trim().length === 0) throw new BridgeError('命令不能为空。');
			const wait = Math.min(Math.max(Math.trunc(waitMs), 0), 60_000);
			const body = await request('/ctl/', { method: 'POST', body: command, timeoutMs: TIMEOUT.control });
			let summary = body.trim();
			try {
				const parsed = JSON.parse(body);
				const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
				summary = `已接受 ${actions.length} 个动作：${actions.join(' → ') || '(无)'}\n队列中：${parsed.queued} 个请求，在世界里：${parsed.inWorld}`;
			} catch {
				// 正文不是 JSON（理论上不会）时原样返回
			}
			if (wait > 0) {
				await sleep(wait);
				summary += `\n已等待 ${wait}ms。`;
			}
			return textResult(summary);
		}),
	);

	server.registerTool(
		'op',
		{
			title: '容器与合成操作',
			description: '执行一条容器操作命令并等它真正做完再返回：成功给结果文本，被拒给原因。合成可能需要数十秒。',
			inputSchema: inputSchema(
				z.object({
					command: z
						.string()
						.describe(
							'一条命令，不能为空：`craft <物品id> [数量]` 用背包里的材料合成（3×3 配方要先打开工作台界面）；`inventory <物品id> [1-9]` 把物品换到快捷栏第 N 格；`furnace put <raw|fuel> <物品id> [数量]` / `furnace get <raw|fuel|product> [数量]`（要先打开熔炉界面）；`chest put <物品id> [数量]` / `chest get <物品id> [数量]`（要先打开箱子界面）；`look <yaw|pitch> <角度>` 转视角，角度支持 `~` 相对值。物品 id 省略命名空间时默认 minecraft。',
						),
				}),
			),
		},
		tool(async ({ command }) => {
			if (command.trim().length === 0) throw new BridgeError('命令不能为空。');
			const text = (await request('/op/', { method: 'POST', body: command, timeoutMs: TIMEOUT.op })).trim();
			return textResult(text);
		}),
	);

	return server;
}

/**
 * 启动 stdio 服务：一个连接一个 server 实例，直到客户端关闭 stdin。
 *
 * @param {{baseUrl?: string}} [options] 覆盖游戏侧 HTTP 服务地址
 * @returns {import('@modelcontextprotocol/server/stdio').StdioServerHandle}
 */
export function start(options = {}) {
	return serveStdio(() => createServer(options), {
		onerror: (error) => process.stderr.write(`[minecraft-bridge] ${error?.stack ?? error}\n`),
	});
}
