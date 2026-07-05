# kilocode-free-gate

[![Docker Image](https://img.shields.io/badge/ghcr.io-kilocode--free--gate-blue?logo=docker)](https://github.com/GuJi08233/kilocode-free-gate/pkgs/container/kilocode-free-gate)

[Kilo Code](https://kilo.ai) 免费模型的**自动代理反代网关**。

从公共代理池自动获取 S 级代理，2 个 IP 轮换使用，失败自动切换，解除免费模型的额度/频率限制。  
兼容 **OpenAI** API 格式，任何客户端只需改 `base_url` 即可接入。

---

## 支持的免费模型

| 模型 ID | 名称 |
|---------|------|
| `kilo-auto/free` | Kilo Auto (Free Router) - 自动路由 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Nemotron 3 Ultra 550B |
| `nvidia/nemotron-3-super-120b-a12b:free` | Nemotron 3 Super 120B |
| `poolside/laguna-m.1:free` | Poolside Laguna M.1 |
| `poolside/laguna-xs.2:free` | Poolside Laguna XS.2 |
| `stepfun/step-3.7-flash:free` | Step 3.7 Flash |
| `nex-agi/nex-n2-pro:free` | Nex N2 Pro |

---

## 快速开始

### 方式一：Docker（推荐）

```bash
docker run -d --name kilo-gate \
  -p 13339:13339 \
  --restart unless-stopped \
  ghcr.io/GuJi08233/kilocode-free-gate:latest
```

### 方式二：从源码运行

```bash
# 安装 Bun（如未安装）
curl -fsSL https://bun.sh/install | bash

# 克隆
git clone https://github.com/GuJi08233/kilocode-free-gate.git
cd kilocode-free-gate
bun install
bun run gate.ts

# 指定端口
PORT=8080 bun run gate.ts
```

服务默认在 `http://localhost:13339` 启动。

### docker-compose

```yaml
services:
  kilo-gate:
    image: ghcr.io/GuJi08233/kilocode-free-gate:latest
    container_name: kilo-gate
    restart: unless-stopped
    ports:
      - "13339:13339"
    environment:
      - PORT=13339
      # - PROXY_PROBE_TIMEOUT=8000
      # - PROXY_REFRESH_MS=300000
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:13339/v1/models"]
      interval: 30s
      timeout: 10s
      retries: 3
```

```bash
docker compose up -d
```

---

## 客户端配置

### OpenAI 格式

| 客户端 | 设置 |
|---|---|
| Python OpenAI SDK | `client = OpenAI(base_url="http://localhost:13339/v1", api_key="any")` |
| curl | `curl http://localhost:13339/v1/chat/completions -H 'Content-Type: application/json' -d '...'` |
| 任何 OpenAI 兼容客户端 | `base_url = http://localhost:13339/v1` |

### 通过前缀访问

也支持带前缀的路径：
- `http://localhost:13339/openai/v1/chat/completions`
- `http://localhost:13339/openai/v1/models`

### 查看可用模型

```bash
curl http://localhost:13339/v1/models
```

### 示例请求

```bash
curl http://localhost:13339/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "nvidia/nemotron-3-super-120b-a12b:free",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

---

## 部署到海外 VPS

中国大陆访问 `proxy.amux.ai` 不稳定，建议部署到海外（香港/日本/美国）VPS。

```bash
# 1. 在 VPS 上拉镜像
docker pull ghcr.io/GuJi08233/kilocode-free-gate:latest

# 2. 后台运行
docker run -d --name kilo-gate \
  -p 13339:13339 \
  --restart unless-stopped \
  ghcr.io/GuJi08233/kilocode-free-gate:latest

# 3. 验证
curl http://your-vps-ip:13339/v1/models

# 4. 更新镜像
docker pull ghcr.io/GuJi08233/kilocode-free-gate:latest && \
docker restart kilo-gate
```

---

## 架构

```
客户端 ──→ gate.ts (:13339) ──→ 代理池 ──→ api.kilo.ai/api/gateway
                │
                ├── /v1/*             → 转发到 /chat/completions
                ├── /openai/v1/*      → 转发到 /v1/* (兼容 OpenAI 格式)
                ├── 2 IP 轮换        → round-robin 轮询
                ├── 失败重试         → 3 次重试，换 IP 再试
                └── 直连回退         → 全部失败直连上游
```

### 核心流程

1. **启动时**从 `proxy.amux.ai/api/proxies` 拉取 S 级免费代理（候选池），按延迟排序
2. **选 2 个**延迟最低的代理，探活后放入 slot
3. **轮询分发**：每个请求 round-robin 选一个 slot
4. **失败处理**：
   - 代理连不上 / 超时 → 丢弃该 slot，异步补位
   - 重试最多 3 次（换不同 slot）
   - 全部失败 → 直连上游
   - 上游 5xx 不算代理失败，直接返回给客户端
5. **每 5 分钟**自动刷新候选池，补位 slot
6. **流式支持**：自动识别 `Accept: text/event-stream` 或 body 中的 `stream: true`，直接透传原始 SSE 流

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `13339` | 监听端口 |
| `PROXY_API` | `https://proxy.amux.ai/api/proxies` | 第一个代理池 API |
| `PROXY_API_2` | 空 | 第二个代理池 API（可选，增加 IP 池） |
| `SLOT_COUNT` | `4` | 轮换代理数量（增加可提高并发） |
| `ZENPROXY_KEY` | 空 | 启用 ZenProxy 备用通道（[申请 Key](https://zenproxy.top)） |
| `ZENPROXY_RELAY` | `https://zenproxy.top/api/relay` | 自定义 relay 端点 |
| `FORCE_RELAY` | `0` | 设为 `1` 跳过代理池强制走 ZenProxy（调试用） |
| `PROXY_PROBE_TIMEOUT` | `8000` | 新代理探活超时（ms） |
| `PROXY_REFRESH_MS` | `300000` | 候选池刷新间隔（ms，默认 5 分钟） |

### 双代理池配置

使用两个代理池可以获得更多 IP，提高并发和上限：

```bash
bun run gate.ts \
  PROXY_API=https://proxy.amux.ai/api/proxies \
  PROXY_API_2=https://your-second-pool/api/proxies \
  SLOT_COUNT=6
```

### 关于 ZenProxy 备用通道

主路径（免费代理池）失败时，自动回退到 ZenProxy 的 `/api/relay` 转发。回退触发条件：

1. 启动时 `proxy.amux.ai` 拉不到代理
2. 2 个 slot 全部失败，重试耗尽
3. `FORCE_RELAY=1` 强制使用

---

## 依赖

- [hpagent](https://github.com/delvedor/hpagent) — HTTP CONNECT 代理隧道
- [socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) — SOCKS5 代理

Bun 会自动安装。

---

## 与 opencode-free-gate 的区别

| 特性 | opencode-free-gate | kilocode-free-gate |
|------|-------------------|-------------------|
| 上游 API | opencode.ai/zen | api.kilo.ai/api/gateway |
| API Key | 需要 `authorization: Bearer public` | 不需要 |
| 模型 | OpenCode 免费模型 | Kilo 免费模型 |
| ZenProxy 备用 | 支持 | 不支持（Kilo 本身免费） |

---

## 许可证

MIT
