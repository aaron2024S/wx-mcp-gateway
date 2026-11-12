# 微信 MCP 网关

[![构建并推送镜像](https://github.com/aaron2024S/wx-mcp-gateway/actions/workflows/docker.yml/badge.svg)](https://github.com/aaron2024S/wx-mcp-gateway/actions/workflows/docker.yml)

用微信控制任何 MCP server。不用公网 IP、不用端口映射、不用内网穿透。

```
手机微信  ⇄  iLink 网关（腾讯）  ⇄  本容器  ⇄  各应用的 MCP 端点
              ↑ 容器主动出站长轮询，没有任何入站连接
```

零第三方依赖，一个 Node 进程，一个数据目录。

---

## 它解决什么

单个 MCP server 很好写，但它只能被 MCP 客户端调用——而大多数 MCP 客户端是"你问它答"的，不会自己盯着消息。

这个网关补的就是那段：

| 能力 | 谁提供 |
|---|---|
| 收发微信消息 | iLink 长轮询（本文网关） |
| **一直转的循环**：有新消息 → 决定 → 执行 → 回复 | 本文网关 |
| **决定调用哪个工具** | AI：先按需检索工具，再选一个 |
| 工具本身 | 各应用的 `tools/list`，网关自动发现 |

所以加一个应用 = 在网页里填一个地址。**不用改代码，不用重发镜像。**

出厂**不带任何应用**：第一次打开时应用列表是空的，连什么、叫什么、放开哪些操作，都由你自己决定。文档里的「邮箱」只是截图时的示例数据。

---

## 界面

第一次打开是设置密码，之后是登录：

![登录](docs/07-login.png)

进去以后是零构建的单页控制台，五个页面：概览、应用、工具、调用日志、设置。

![概览](docs/01-overview.png)

![工具](docs/03-tools.png)

微信绑定、应用管理、AI provider 都在设置页：

![设置](docs/05-settings-online.png)

---

## 快速开始

**方式一：compose 拉现成镜像**（推荐，不用 clone）

把下面存成 `docker-compose.yml`，同目录执行 `docker compose up -d`：

```yaml
services:
  wx-mcp-gateway:
    # latest 一直指向最新版本（也可换成具体版本号钉死）
    image: aaron2024s/wx-mcp-gateway:latest
    container_name: wx-mcp-gateway
    restart: unless-stopped

    ports:
      # 冒号右边是容器内端口，必须和下面 PORT 一致。
      # 想改端口：两处一起改，或者用 ${PORT:-7337} 配合 .env。
      - "7337:7337"

    environment:
      - TZ=Asia/Shanghai
      - PORT=7337
      - GATEWAY_DATA=/data
      - GATEWAY_CONFIG=/data/config.json
      # 这里不用放任何令牌或 API key。
      # 应用的访问令牌、AI 服务商的密钥都在网页里填，存进 /data/secrets.json。

    volumes:
      # 这一个目录装了全部状态：配置、登录密码、微信绑定、调用日志、AI 密钥
      - ./data:/data

    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "2"
```

首次启动时 `data/` 里没有 `config.json`，容器会自己从镜像内的示例复制一份，所以不用先准备文件。起来后打开 `http://<NAS的IP>:7337` 设置访问密码。

**凭据全部在网页里填**，不用改文件、不用重启：应用页加应用时填它的访问令牌，设置页加 AI 服务商时填 API Key。它们存在 `data/secrets.json`（0600），接口不会把原值回传，界面上只显示「已设置」。

**要连其他应用（如 MailNest）时，网关必须和它在同一个 docker 网络**，否则 `http://mailnest:8006/mcp` 这种服务名解析不到。在 compose 里补上：

```yaml
    networks:
      - nas

networks:
  nas:
    external: true
    name: nas        # 换成 docker network ls 里看到的真实网络名
```

不确定网络名就先去目标应用的 compose 里看，或者 `docker network ls`。连不上时的表现是日志里出现“解析主机失败”，而不是配置报错。

**方式二：docker run**（不用 compose 的单条命令）

```bash
mkdir -p /volume1/docker/wx-mcp-gateway/data
cd /volume1/docker/wx-mcp-gateway

docker run -d --name wx-mcp-gateway \
  -p 7337:7337 \
  -e PORT=7337 \
  -v "$PWD/data:/data" \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  aaron2024s/wx-mcp-gateway:latest
```

镜像同时提供 `linux/amd64` 与 `linux/arm64`，Intel 的 NAS 和 ARM 的群晖都能直接拉。

**方式三：从源码构建**

```bash
git clone https://github.com/aaron2024S/wx-mcp-gateway.git
cd wx-mcp-gateway
mkdir -p data
cp config.example.json data/config.json
# 改 data/config.json 里的 apps[].url 和 allow_risk

docker compose up -d --build
```

### 换端口

默认 `7337`。`-p` 的左右两边、`PORT` 环境变量三处是同一个值，改的时候要一起改：

```yaml
ports:
  - "8123:8123"      # 左边是宿主机端口，可以任意；右边必须等于 PORT
environment:
  - PORT=8123        # 容器内监听端口
```

嫌改两处麻烦，就在 compose 同目录建个 `.env` 写 `PORT=8123`，然后把 compose 里那两行换成
`"${PORT:-7337}:${PORT:-7337}"` 和 `- PORT=${PORT:-7337}`，以后只改 `.env`。

### 第一次打开

打开 `http://<NAS的IP>:7337`，会先让你**设置一个访问密码**（至少 8 位，不能纯数字）。
设完自动进入，之后每次打开用它登录。

为什么强制设：这个进程手里是 `data/` 的全部内容——微信 `bot_token`、各应用访问令牌、AI 的 API key。
不设密码等于把"用你的微信驱动你的 NAS"交给同网段的任何人。

> 忘了密码只能重置：删掉 `data/auth.json` 重启容器，会回到设置密码那一步。
> 网关不存明文、也不联网，所以没有"找回"这条路。

进去之后：

1. **设置 → 微信通道 → 生成二维码**，用手机微信扫
2. 扫完在微信里给那个新出现的机器人发一句：`/status`
3. 回话就说明整条链路通了

> **注意**：刚绑定时网关不知道"推给谁"（它只从收到的消息里学），所以别急着点"推一条测试消息"。先在微信里发一句话。

不用 Docker 也行：

```bash
GATEWAY_CONFIG=./data/config.json GATEWAY_DATA=./data node src/server.js
```

Node ≥ 20。

---

## 配置

**凭据都在网页里填，不用碰文件，也不用配环境变量。**

| 填什么 | 在哪填 |
|---|---|
| 应用的访问令牌（MailNest 等） | **应用** 页 → 该应用 → 编辑 → 「访问令牌」 |
| AI 服务商的 API key | **设置** 页 → AI 模型 → 「添加服务商」 → 「API Key」 |
| 网关自己的登录密码 | 首次打开时设；之后在 **设置 → 通用 → 修改密码** |

存进 `data/secrets.json`（0600），接口永不回传原值，界面上只显示「已设置」。所以 `docker-compose.yml` 的 `environment` 里不需要放任何令牌——那些值一旦写进 compose 文件，反而容易跟着文件一起被备份、截图、传群。

`config.json` 只放**结构**（有哪些应用、地址是什么、风险上限、检索条数），不放凭据，因此可以安心进 git。

下面这份是**格式示例**，不是默认值——出厂配置里 `apps` 是空数组，什么都不连：

```json
{
  "gateway": {
    "confirm_risk": ["high"],   // 这些等级必须回「确认」
    "confirm_ttl": 60,          // 确认窗口（秒），过期作废
    "call_timeout": 20,         // 单次工具调用超时
    "async_after": 10,          // 超过这么久先回「还在跑」
    "default_app": null         // 多个应用有同名工具时优先给谁
  },
  "routing": {
    "search_limit": 8           // 每次检索返回几个候选工具给模型
  },
  "agent": {
    "max_rounds": 6,            // 一句话最多几轮工具调用
    "max_ms": 45000             // 整轮时间预算，超了先把查到的发出去
  },
  "llm": {
    "enabled": false,
    "default": "",              // 在设置页添加服务商后指定，留空则用第一个
    "fallback": [],             // 按顺序重试，比如 ["backup"]
    "providers": {}             // 出厂为空，去设置页添加（见下文）
  },
  "apps": [
    {
      "id": "mail",
      "label": "邮箱",
      "aliases": ["邮件", "信箱"],
      "transport": "mcp-http",
      "url": "http://mailnest:8006/mcp",
      "auth": { "token": "" },    // 留空，去网页里填
      "allow_risk": ["read"],
      "tools": {
        "aliases": { "list_messages": ["未读"] },
        "risk_overrides": { "delete_messages": "high" },
        "include": [],
        "exclude": []
      }
    }
  ]
}
```

### 可选：用环境变量注入凭据

上面所有 `token` / `api_key` 都是空串，去网页里填就行。如果因为某些原因必须让凭据**不出现在 `data/` 目录里**（比如这个卷会跟别人共享），`config.json` 支持 `${VAR}` 占位，启动时从容器环境变量取值：

```json
"api_key": "${MY_LLM_API_KEY}",
"auth": { "token": "${MAILNEST_TOKEN}" }
```

代价要说清楚：**环境变量在 `docker inspect` 里是明文可见的**，安全性并不比 `secrets.json` 高，只是把文件换成了进程环境。没设这个变量时启动会打印警告并按空串处理（不会拒绝启动，因为有些应用免鉴权）。两种方式可以并存：界面里填过的值优先，没填过就沿用配置文件里的。

### 几个不直观但要紧的字段

**`allow_risk`** —— 网关的硬上限。应用自己声明的风险等级**不能突破它**。只写 `["read"]` 就永远只能读，哪怕应用说某个工具是只读、另一个是高危。这是"双保险"里网关那一层。

**`aliases`** —— 用户不会说 id，会说"邮件""信箱"。这个字段比 `label` 影响大得多。

**`tools.aliases`** —— 只在检索排得不对时补。实测大多数中文 MCP server 一条都不用写（见下）。

**`tools.include`** —— 留空 = 全放开。它是**白名单**，名单之外的工具连检索都搜不到，所以只在你确实想限制能力时才用；单纯想控制上下文长度没必要动它——检索一次只给模型 8 个候选，不会把几百个工具塞进去。

---

## 微信里怎么用

直接说人话：

```
你：查一下未读
网关：「列出邮件」共 5 条：
      1. 合同确认 · 张三 · 今天 09:12  [未读]
      2. 十月报价单 · 李四 · 昨天  [未读]
      ...
      回复序号可对某一条继续操作。

你：1
网关：（读出第 1 封正文）

你：总结一下大概内容
网关：（3-5 句说清这封讲了什么、要不要你做什么）
```

**可以顺着上一轮往下接。** 网关记着最近三轮「你说了什么 / 调了哪个工具 / 回了什么」，所以
「总结一下」「那封是几号发的」「再详细点」都接得住——不会把上一轮当没发生过重新列一遍。
上一轮只搜到一条时，「总结一下」指的就是它；列了好几条时会先问你「要总结哪一条」。
摘要算一次 AI 调用，日志里能看到它的 token。

内置指令：

| 指令 | 作用 |
|---|---|
| `/help` | 说明 |
| `/list` | 已接入的应用和状态 |
| `/menu` | 全部操作（带风险等级） |
| `/status` | 网关状态 |
| `/cancel` | 取消当前待确认/待选择 |

**多轮是常态，不是缺陷**：微信只有文本，`send_message` 要 `to`/`subject`/`text` 三个参数，一句话说不全。所以缺参数时会逐项问——而写操作恰好应该慢一点、多确认一次。

### 绑定与解绑

两件事都在**设置 → 微信通道**里完成，不需要重启容器、不需要删数据目录。

| 按钮 | 什么时候用 | 做了什么 |
|---|---|---|
| 生成二维码 / 扫码 | 首次接入 | 扫码确认后自动上线，不用回来点任何按钮 |
| 推一条测试消息 | 验证"发得出去" | 给最后一个跟你说过话的会话发一条 |
| 重新扫码 | 换号、会话失效（`-14`） | 先解绑，再立刻生成新码 |
| **解除绑定** | 不想让微信再控制它 | 通知服务端停止推送 → 清空内存与磁盘凭据 → 回到「未绑定」 |

解绑的边界要说清楚：

- **只切断微信这条入口。** 应用连接、工具勾选、AI 配置、调用日志全部保留，重新扫码后一切照旧。
- **微信里的会话不会自己消失。** 那个机器人条目还在你的聊天列表里，需要你在微信侧手动删掉；本机解绑只是不再持有它的 token。
- **解绑后指令立即失效**（长轮询停止、凭据清空），不会出现"点了解绑但还能用"的中间态。
- 解绑是单侧动作：网关照常运行，只是不再收发微信消息，控制台其余功能不受影响。

### 工具是怎么被认出来的

**没有本地匹配置信表，也不靠关键词命中。** 你说一句话，模型先看一份**应用目录**（每个应用一行：叫什么、有哪些工具），觉得不够就自己问一次"检索工具"，网关把最像的 8 个排出来交给它，它选一个调——或者判断根本没有合适的工具，直接回答你。

为什么不做成本地匹配：本地匹配一旦没命中，就是一次**不可恢复的过滤**——你那句话在模型看见之前就被扔掉了。改成"模型自己检索"后，检索器只负责**排序**、不做决定，最坏情况是候选排得靠后，而不是永远搜不到。

目录有多大：一个 22 个工具的应用，全量 schema 塞给模型约 4,500 token，只给目录约 700 token。所以工具**一个都不用砍**，接得再多也不会把上下文撑爆——模型按需把真正要用的那几个 schema 拉进来。

排序用的信号（中文按"一元 + 二元"分词后乘 idf，所以单字不会被无限放大）：

| 信号 | 权重 | 谁维护 |
|---|---|---|
| 应用别名 | 2.2 | `aliases`（用户不会说 id，会说"邮件""信箱"） |
| 工具 `title` | 1.6 | 应用自己声明，网关现场建索引 |
| 工具 `name` | 1.4 | 同上 |
| 工具 `description` | 1.0 | 同上 |
| `tools.aliases` 手写别名 | — | 只在排序明显不对时补 |

早先踩过一个坑：按 title 首字（甚至单字）直接当硬命中，等于谁含这个字谁赢——「有几封**未读**邮件」里的「读」被 title「**读**取附件内容」抢走，明明在问未读数却去读附件，还回头让你补 uid。生成 title 的是第三方，网关不能假设它按动词开头，所以现在单字权重被 idf 压得很低，`title` 也不再是硬命中。

**风险等级同样从工具名推出来**，不用逐个手标：动词按 `-`/`_` 切开（`delete_messages` → `delete`），`list/get/read/search/count` 算只读，`create/update/set/send` 算写，`delete/remove/purge` 算高危；带 `--force/--purge/--yes` 的一律升高危；**认不出的动词按写处理**——宁可拦住，也不要默认放行。这只是默认值，`allow_risk` 才是硬上限。

---

## AI 是唯一的大脑

**这里没有"本地模式"。** 你用自然语言说一句话，理解它、决定调哪个工具、把结果讲成人话，全靠模型。没配模型时网关会直接说清楚：

```
网关：还没有配置 AI 模型——去「设置 → AI 模型」加一个服务商，填接口地址、模型名和 API Key。
      在那之前只能执行 /help /list /menu /status 这几个指令。
```

这样比"假装听懂"要诚实：本地匹配在中文长句上本来就只有五成把握，猜错一次还反过来问你要 uid，比直接说"我不会"更耗人。

模型在闭环里做的事，按顺序：

1. 看应用目录，判断该不该检索、检索什么词（这一步是它自己发起的，不是网关替它决定）
2. 拿到 8 个候选工具，挑一个，按 `params` schema 填参数
3. 读回执行结果，不够就再检索、再调，最多 `agent.max_rounds` 轮（默认 6）
4. 用中文说结论

它的输出**必须过 `registry.find()` 校验**，编出来的工具名直接丢掉；风险判断、二次确认、审计全在执行层，模型碰不到。所以最坏情况是"选错工具"，不可能是"乱执行"。

**边界在时间上**：整轮有 `agent.max_ms`（默认 45 秒）预算。超时不会丢结果，而是先把已经查到的发出来，再补一句"还在跑"。多轮工具调用天然慢，这条保证你永远不会对着一个不动的对话框等。

**哪一步会把业务内容发出去**：检索那步只发工具清单和你的原话；你说「总结一下」时才会把**上一轮那条结果的正文**（最多 4000 字）交给模型写成 3-5 句。不想让邮件正文出本机，就只做只读查询、别用摘要；或者干脆把 `allow_risk` 收窄。

哪次花了钱，控制台看得见。调用日志的「识别」列写着这次 AI 闭环走了几步、调了谁（`AI 闭环（3 步）：list_messages→get_message`），「Token」列是这次的总用量（把鼠标停上去能看到输入/输出拆分和服务商；服务商没返回用量时显示「未上报」——那说明这个兼容端点不带 `usage` 字段，不是没花钱）。

一次典型的一句话（搜一下 → 读正文 → 摘要）在 DeepSeek 上是 3 次请求、约 2,500 token。

支持任何兼容 `/chat/completions` 的服务（DeepSeek、通义、Kimi、智谱、硅基流动、OpenRouter、Groq、xAI、Ollama、vLLM、LM Studio……名单还在变，所以**代码里不写死厂商**），Claude 单走 `/v1/messages`。**设置页点「添加服务商」，填厂商文档里的接口地址、模型名和 key 就能用**——下拉里的预设只是替你把这几个字段填好，没列进去的选「自定义」一样加。

出厂 `providers` 是空的：默认不预设任何厂商，也不带任何 key。想直接用某家，就加一条：

| 字段 | 填什么 | 例子 |
|---|---|---|
| 标识 | 自己起的名，字母数字下划线短横线 | `my-llm` |
| 协议 | 绝大多数选「OpenAI 兼容」 | `openai` |
| 接口地址 | 厂商给的基础地址，**要含 `/v1` 这种版本段，不要带 `/chat/completions`** | `https://api.example.com/v1` |
| 模型 | 点「拉取列表」按地址和 Key 问服务商要一份，再挑；也可手输 | `deepseek-flash` |
| API Key | 没有鉴权的本地服务留空 | `sk-...` |

模型名是这一块最容易踩的坑：厂商迭代时常直接改名或下线旧名，比如 DeepSeek 的 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07 退役，现在只有 `deepseek-flash` 和 `deepseek-v4-pro`。**所以模型那一行别照抄老教程，点「拉取列表」让端点自己把能用的名字报回来**——它走的是标准的 `GET /models`（Claude 走 `/v1/models`），已经存过 Key 的不必重填。

地址填错、模型名不存在、key 无效，都点一次「测试」就能看出来，不用先保存再试。保存即生效，没有额外的开关要拨。

想知道它到底怎么理解你那句话，用设置页下方那句「贴一句话试试」——它跑的是**和线上完全一样的闭环**，只是把最后那步执行换成"到此为止"，所以不会真的动你的数据。回给你的三段是：

1. 模型搜了哪些词、每个词命中了哪些工具（这能直接看出是工具没被检索到，还是检索到了没选对）
2. 它最终选了哪个工具、参数是什么，或者它判断没有合适工具而直接答
3. 耗时和这次用掉的 token

调不通时先看这里再改配置：绝大多数"它怎么这么笨"的原因，是工具 `description` 写得太抽象，或者那个工具压根没在 `allow_risk` 放行的等级里。

---

## 安全模型

| 层 | 做法 |
|---|---|
| 风险等级 | 应用声明的 `annotations` 只作默认值，`allow_risk` 是硬上限 |
| 二次确认 | 高危操作必须回「确认」，窗口 TTL 到点作废 |
| 凭据 | `data/secrets.json`（0600），API 永不回传原值，界面只显示"已设置" |
| 控制台 | 首启强制设置访问密码，`scrypt` 哈希落盘，HttpOnly 会话，连错 5 次锁定 5 分钟 |
| 容器 | 非 root 运行 |

三条要自己守的：

1. **`data/` 目录就是全部机密**（微信 token、应用令牌、AI key）。备份它等于备份全部权限，别扔进公开网盘。
2. **不要把这个端口暴露到公网。** 虽然有一道密码，但它是给局域网用的单用户面板，没有账号体系、没有二级验证、也没有审计日志导出。
3. **微信只能是第二遥控器。** 这条通道是逆向实现，协议随时可能变。关键链路（定时同步、白名单自愈）必须还在 Web 控制台独立跑。

---

## 加一个 MCP 应用

1. 确认那个应用有 HTTP 的 MCP 端点：
   ```bash
   curl -i -X POST http://<容器名>:<端口>/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
   ```
   回 `serverInfo` 就是能用；回 `<html>` 说明那是前端页面，不是 MCP。
2. 控制台「应用 → 添加应用」走一遍向导，接入方式保持「MCP 服务」。**先点「测试连接」**——它会告诉你协议版本、服务端名、工具数，连不上还会区分是 DNS、端口、鉴权、路径还是 Accept 头的问题。
3. 勾工具，保存。

整个流程不动代码。如果你发现要改 `.js`，那是设计坏了。

## 加一个 CLI 应用

有些东西不提供 MCP，只给一个命令行工具——NAS 厂商的 `unc`、`docker`、`gh`、云厂商 CLI 都是这种。网关可以在容器里替它跑，把它也变成能被微信调用的工具。

**前提两条**：那个二进制得在容器里（下面第 2 步解决），并且它的 `--help` 是 cobra/pflag 那套格式（`Usage:` / `Available Commands:` / `Flags:`）。Go 写的 CLI 基本都符合。

1. 应用 → 添加应用 → 接入方式选 **CLI 连接器**，先填个标识（比如 `nas`）——它决定装到哪个目录。
2. **下载安装**：填二进制包的 `tar.gz`/`zip` 地址，有 sha256 就一起填上去。点「下载并解包」，网关会**下载 → 校验哈希 → 自己解包**到 `/data/connectors/nas/bin/`，然后把绝对路径填回上面的输入框。这里刻意不做 `curl | sh`：远程脚本一旦执行，等于把容器交出去。
3. **环境变量**：一行一个 `KEY=VALUE`，一般就是 `NAS_URL=…` 和 `NAS_TOKEN=…`。它只注入这个应用的子进程，不污染网关自身；值存进 `secrets.json`，界面不回显，编辑时留空表示"沿用上次的"。
4. 点「测试连接」——它会真的跑几十次 `<bin> --help` 把子命令树和参数抽出来（`unc`：108 个工具、约 7 秒），然后把工具列表摊开给你勾。
5. 勾上你要的（第一次建议只勾只读那几个），保存。

工具表是这样长出来的：解析 `Usage:` / `Available Commands:` / `Flags:`，往下最多挖三代子命令（`storage` → `ls` → 参数），参数名、类型和帮助文字直接变成工具的 schema，所以**不用手写一张命令表**。风险等级同样按动词推：`ls/list/get` 只读，`rm/delete` 高危。

存下来的 `config.json` 长这样（`tools` 是数组，每个元素就是一个能被模型调用的工具）：

```json
{
  "id": "nas",
  "label": "绿联 NAS",
  "aliases": ["nas", "网盘"],
  "transport": "cli",
  "allow_risk": ["read"],
  "cli": {
    "bin": "/data/connectors/nas/bin/unc",
    "args": ["--format", "json"],
    "env": { "NAS_URL": "https://192.168.1.2:9443" },
    "tools": [
      {
        "name": "storage_ls",
        "title": "列出存储空间",
        "description": "列出存储空间 / 查看磁盘",
        "command": ["storage", "ls"],
        "risk": "read",
        "params": [
          { "name": "disk", "flag": "--disk", "type": "string", "desc": "磁盘名" }
        ]
      }
    ]
  }
}
```

`params` 里每一项都会被翻成工具 schema 的一个字段：`type` 只有 `string`/`number`/`boolean` 三种，`flag` 是拼 argv 时用的真实选项名（`--disk`），`required: true` 的会进 `required`。最终命令是 `bin` + `prefix` + `command` + 参数 + `args`——固定的 `--format json` 这类全局开关故意排在最后，因为 pflag 允许持久参数写在子命令之后，写前面反而可能被当成子命令的一部分。

环境变量的值建议在界面里填——它落在 `secrets.json`，`overrides.json` 里只留一串 `envKeys`（哪几个键有值），这样配置文件可以随便备份、截图、进 git。

`cli.prefix` 是给"可执行文件本身是解释器"的场景留的：`bin=node` + `prefix=["/data/xxx/tool.js"]` → 实际跑 `node /data/xxx/tool.js <子命令>`。直接用二进制工具就留空。

**帮不了的那种**：`--help` 输出不是这套格式的（POSIX 手写帮助、或者干脆没有帮助），解析出来一个工具都没有。这时勾上「允许执行任意子命令」——模型自己拼参数跑，风险按最高算、每次调用都要你确认。这是兜底，不是推荐路径。

**换版本不用重建容器**：二进制装在数据卷里，不随镜像走。重新「下载并解包」覆盖同一个目录，再点一次编辑页的「测试连接」刷新工具表即可。

## 应用那边更新了能力，这边要做什么

**不用重新添加。** 网关每 5 分钟重拉一次每个应用的 `tools/list`（`REFRESH_INTERVAL_MS` 可改），新工具自己就进索引了。不依赖 MCP 的 `capabilities.listChanged`——无状态的 HTTP MCP 实现根本不会发那个通知。

只有一种情况需要你动手：添加应用时**没有把工具全勾上**。勾选结果会写成 `tools.include` 白名单，名单之外的工具进不了索引。这时打开应用编辑页，新工具已经在列表里（标着「未启用」），勾上保存即可，不用删了重加。

反过来，如果当初是全勾的，保存时会写成空 `include`（= 全放开），以后应用侧加什么工具都自动生效。**推荐这么用**：用 `allow_risk` 限制危险等级，而不是用白名单把自己锁死——白名单的代价就是每次上游加功能都得回来改一次。

想立刻同步、不等那 5 分钟：编辑页点一次「测试连接」，它拉的就是实时清单。

---

## 开发与测试

```bash
npm test           # 端到端：假 iLink 网关 + 假 MCP + 假 CLI + 假 AI 端点，145 + 27 + 49 项断言
npm run test:auth  # 登录：起真服务走完设密码→登录→改密→锁定，57 项断言
npm run test:llm   # AI 闭环：假 OpenAI/Anthropic 端点 + 模型清单 + 检索累积 + 用量归一化 + 工具名转义，40 项断言
npm run test:store # 配置合并：三层覆盖顺序 + 凭据不外泄 + 删 config 里的服务商，44 项断言
npm run demo       # 拉起真的 MailNest 跑一遍中文检索
```

`npm test` 里那三段各管一块：`e2e.js` 是消息从进到出的整条链路（含多轮、确认、超时、AI 挂掉），`test-loop.js` 只钉闭环本身（轮数上限、预算、schema 累积），`test-cli.js` 用 `scripts/fixtures/fake-cli.js`（一个 cobra 风格的假 CLI，6 个叶子命令）钉住 help 解析、argv 拼装、输出归一化和错误翻译。

前端那一层没有测试框架，只有一行守门：e2e 里有个用例跑 `node --check src/web/app.js`。别嫌它土——一个漏写的 `async` 会让整段脚本被浏览器丢掉，界面骨架还在、所有按钮全死，这种错冒烟截图看不出来。

本地看界面（两个终端）：

```bash
npm run mock:mcp     # 假 MCP server，:7799
npm run mock:ilink   # 假 iLink 网关，:7788（约 18 秒后自动"扫码确认"）

GATEWAY_CONFIG=./config.example.json GATEWAY_DATA=./.tmp-run \
  ILINK_BASE=http://127.0.0.1:7788 node src/server.js
```

测试里为什么要有假网关：iLink 的字段名和请求头无法从公开文档核对，写错一个字母的表现是"消息不进来"，在真机上要等绑完才会发现。假网关把字段固定住，改坏了立刻红。

### 代码结构

```
src/
  server.js     常驻服务：HTTP 控制台 API + 微信循环 + 应用定时刷新
  auth.js       访问密码：scrypt 哈希、会话 Cookie、失败锁定
  ilink.js      微信 iLink 协议：扫码、长轮询、发消息、-14 失效
  mcp.js        MCP 客户端：Streamable HTTP + JSON-RPC，7 类错误分类
  cli.js        CLI 客户端：子进程、argv 拼装、JSON 输出归一化
  cli-tools.js  CLI 工具表：解析 --help 生成参数 schema、按动词推风险等级
  cli-install.js 安装：下载 → 校验 sha256 → 自解包（tar/zip 自己实现，零依赖）
  registry.js   工具索引：MCP 与 CLI 统一成一张表，中文检索用 idf 加权
  router.js     自检：拿一句话走完整闭环，但把最后执行换成「到此为止」
  agent.js      会话编排：指令 / 待决状态 / 补参 / 风险 / 执行
  llm.js        AI 闭环：多 provider、按需检索工具、逐轮累积 schema
  exec.js       执行层：风险闸门、参数收集、结果渲染成人话
  session.js    会话状态：确认、候选、补参、序号引用
  appstore.js   配置合并：手写配置 / 界面改动 / 密钥 三层分离
  calllog.js    调用日志字段：AI 闭环步数 + token 用量
  web/          单页控制台 + 登录页，零构建
vendor/
  qrcode.cjs    QR 编码（MIT, kazuhikoarase）
```

---

## 已知限制

**iLink 不是公开接口。** 它是腾讯随 OpenClaw 放出的那条通道，社区逆向 + 官方实现并存。`bot_type=3` 随时可能改、可能限流。旁证：连 `iLink-App-ClientVersion` 这种常量，不同实现给的都不是一个值。

**一个微信号只能绑一个机器人。** 想在多个应用里各扫一次，结果不是"一个机器人管所有"，而是通讯录里多出几个联系人、各自要重扫。所以要么只接这一个网关（推荐），要么接受多个入口。

**`-14` 之后必须人工重扫。** 机器替不了。所以控制台上的「重新扫码」不会藏起来。

**微信是纯文本管道。** 图片、语音、文件会被降级成 `[图片]` 这类占位符。要传大文件的场景不适合。

**没有用户体系。** 它假设"这个机器人只有一个人用"。想给家人用，得各自扫码绑各自的机器人。

**首次设密码有一个窗口期。** 从容器起来到你设完密码之间，任何能访问到这个端口的人都可以抢先设一个。
彻底堵住要么让首启只允许本机访问、要么在日志里打一次性口令，两种做法都会把"打开就能用"这个体验做坏。
现在的缓解是限流 + 记录：设置密码时会写一条带来源 IP 的日志，事后能看出是谁设的。所以装完先把密码设了。

---

## 协议参考

| 动作 | 接口 |
|---|---|
| 取登录二维码 | `POST /ilink/bot/get_bot_qrcode?bot_type=3` |
| 轮询扫码状态 | `POST /ilink/bot/get_qrcode_status?bot_type=3&qrcode=…` |
| 上线 / 下线 | `POST /ilink/bot/msg/notifystart` / `notifystop` |
| 收消息 | `POST /ilink/bot/getupdates`（服务端扣约 35 秒，游标增量返回） |
| 发消息 | `POST /ilink/bot/sendmessage`（必须回带 `context_token`） |

请求头固定带 `AuthorizationType: ilink_bot_token`、`iLink-App-Id`、`iLink-App-ClientVersion`、`X-WECHAT-UIN`；body 里塞 `base_info{channel_version}`。扫码确认返回 `bot_token` / `ilink_bot_id` / `baseurl`，之后所有请求打 `baseurl`。

**绑定这件事的全部内容，就是扫码换一个 `bot_token`；"在线"就是循环不停地挂着一条 getupdates。** 没有注册回调地址、没有白名单 IP、没有反向隧道。

---

## 许可证

MIT，见 [LICENSE](LICENSE)。

`vendor/qrcode.cjs` 来自 [kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)，同为 MIT。
