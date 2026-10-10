# minecraft-mcp-bridge

独立程序：**MCP over stdio**，把本机 Minecraft 客户端模组的共享 HTTP 接口
（`127.0.0.1:3420` 上的 `/ctl`、`/aif`、`/op`）暴露成 MCP 工具。
不依赖 DeepSeek Harness，任何支持 stdio 的 MCP 客户端都能直接启动它。

```
        MCP client (stdio)  ──►  minecraft-mcp-bridge  ──HTTP──►  127.0.0.1:3420
                                                            ├─ /ctl  mcctl              控制
                                                            ├─ /aif  AdvancedInfoFetcher 只读状态
                                                            └─ /op   Craft Command      容器操作
```

## 要求

- Node.js ≥ 20（本机 `/usr/bin/node`）
- 游戏侧：`.minecraft/mods` 里加载 `httpdprovider` + `mcctl` +
  `advanced-info-fetch` + `craftcmd`，共享服务监听 `127.0.0.1:3420`
  （服务起来后游戏窗口标题会带 ` - 3420`）
- 本程序只做 HTTP 桥接，**不启动游戏**；游戏没在跑时工具返回可读的中文错误

## 运行

```bash
git clone git@github.com:MineAgent/MCPServer.git
cd MCPServer
npx --yes pnpm@12 install

node bin/minecraft-mcp-bridge.mjs                     # 在 stdin/stdout 上提供 MCP
node bin/minecraft-mcp-bridge.mjs --help              # 用法
node bin/minecraft-mcp-bridge.mjs --version           # 版本
node bin/minecraft-mcp-bridge.mjs --url http://127.0.0.1:3421
```

| 选项 / 环境变量 | 说明 |
| --- | --- |
| `--url <地址>` | 游戏侧共享 HTTP 服务的根地址，默认 `http://127.0.0.1:3420` |
| `MC_BRIDGE_URL` | 同上，`--url` 优先 |
| `-h, --help` / `-V, --version` | 本地回答，不启动服务 |

装成命令（可选，`package.json` 里已声明 `bin`）：

```bash
npm i -g .            # 之后可直接 minecraft-mcp-bridge
```

## 挂到 MCP 客户端

按客户端自己的配置格式填一个 stdio server 即可，例如：

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "/usr/bin/node",
      "args": ["/path/to/MCPServer/bin/minecraft-mcp-bridge.mjs"]
    }
  }
}
```

在 DSH 里，它由 `@deepseek-ai/dsh-mcp-client` 以 `serverName: minecraft` 启动，
工具名就是 `mcp__minecraft__*`。

## 工具（11 个）

| 工具 | 对应接口 | 说明 |
| --- | --- | --- |
| `status` | `GET /` + 三个前缀 | 自检：服务在不在、哪个模组没挂、有没有进世界 |
| `help` | `GET /ctl/`、`/aif/`、`/op/` | 取模组自带的权威完整说明 |
| `player` | `GET /aif/info` | 坐标 / 朝向 / 生命 / 饱食 / 状态效果 |
| `inventory` | `GET /aif/inventory` | 背包 / 副手 / 盔甲 / 快捷栏 / 打开的容器 |
| `world` | `GET /aif/world` | 维度 / 时间 / 天数 / 天气 |
| `chat` | `GET /aif/msg` | 增量聊天回显，**读取即清空** |
| `sounds` | `GET /aif/keysnd`（默认）或 `/aif/sound` | 增量声音，**读取即清空** |
| `screenshot` | `GET /ctl/prtsc` | 当前帧 PNG，作为图片内容返回 |
| `cursor` | `GET /ctl/mouse` | 光标像素坐标 / GUI 坐标 / 界面类名 |
| `control` | `POST /ctl/` | 按键 / 鼠标 / 视角 / `bt` / `chat` / `type` |
| `op` | `POST /op/` | `craft` / `inventory` / `furnace` / `chest` / `look` |

`control` 的 `waitMs`（0–60000）在命令被接受后再等一会儿才返回，
用来等 `W 500` 这类定时输入做完，省掉一次单独的读状态。

超时：读接口 15s、截图 20s、`control` 150s、`op` 180s（`/op` 的合成最长约 2 分钟）。
挂到 DSH 时，`toolCallTimeoutMs` 要大于这些值（bundle 里用的是 240000），
否则长命令会先被宿主掐断。

## 当库用

`exports` 指向 `src/server.mjs`，可以只取 server 实例自己接传输：

```js
import { createServer, DEFAULT_BASE_URL, SERVER_INFO } from 'minecraft-mcp-bridge';

const server = createServer({ baseUrl: process.env.MC_BRIDGE_URL ?? DEFAULT_BASE_URL });
// server.connect(<你的 Transport>)
```

## 自检

```bash
node test/list-tools.mjs
```

用宿主（DSH）自己那份 MCP 客户端按 stdio 启动本程序：检查 `--help` /
`--version` / 未知参数退出码，列出 11 个工具，逐个把 `inputSchema` 送进
`@deepseek-ai/dsh-tools` 的子集校验器，再调一次 `status`（错误路径）和一次
缺参数的 `control`（schema 校验）。游戏不开也能跑；其中 schema 子集校验器取自
DSH 安装目录（用 `DSH_CHECKOUT` 指定，本机没有就自动跳过那一步）。

> DSH 只接受 `type/oneOf/properties/required/additionalProperties/items/enum/const`
> + 注解这些关键字，所以 `src/server.mjs` 里的 zod schema 不能用
> `.min()`、`.max()`、`.int()`、`.default()`，根上的 `$schema` 也要去掉
> （由 `inputSchema()` 帮助函数处理）。其他 MCP 客户端不在意这些。

## 许可证

GPL-3.0-only，全文见 [LICENSE](LICENSE)。
