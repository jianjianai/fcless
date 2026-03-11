# fcless 协议

(本项目代码80%手写20%AI编写，README.md文档100%AI编写)

fcless 是一个基于 **两条 HTTP 连接**实现的 **一次性 TCP 字节隧道**协议：

- **GET /socket**：建立到目标地址的 TCP 连接，并把 **TCP 下行数据**以 `application/octet-stream` 形式持续返回给客户端。
- **POST /socket**：把客户端的 **上行字节流**转发到同一条 TCP 连接；请求体写入完成后，本次会话结束（用完即弃）。

> 说明：协议按“字节透明转发”设计。若目标服务使用 TLS（例如 443 端口的 HTTPS），TLS 握手与加密数据会被当作普通字节直接穿透转发。

---

## 1. 基本信息

- **协议名**：`fcless`
- **Path**：`/socket`
- **数据类型**：二进制流（`application/octet-stream`）
- **缓存**：服务端建议禁用缓存（`Cache-Control: no-store`）
- **会话模型**：一次性会话（GET 建立，POST 写入一次，结束）

---

## 2. 接口概览

### 2.1 建立隧道并接收下行（TCP -> Client）

- **HTTP Method**：`GET`
- **URL**：`/socket?hostname=<host>&port=<port>[&...其他参数]`
- **返回**：
  - 响应头中包含会话 ID：`X-Fcless-Session-Id`
  - 响应体为字节流：持续输出目标 TCP 连接的下行数据，直到对端关闭或网络断开

#### Query 参数

| 参数名 | 必填 | 说明 |
|---|---:|---|
| `hostname` | 是 | 目标主机名（例如 `example.com`） |
| `port` | 是 | 目标端口（1-65535，例如 `443`） |

#### 响应头

| Header | 说明 |
|---|---|
| `X-Fcless-Session-Id` | 服务端生成的会话 ID，用于后续 POST 写入上行 |
| `Content-Type: application/octet-stream` | 二进制流 |
| `Cache-Control: no-store` | 不缓存 |
| `X-Content-Type-Options: nosniff` | 防止 MIME 嗅探 |

#### 状态码

| 状态码 | 含义 |
|---:|---|
| `200` | TCP 连接建立成功，开始输出下行字节流 |
| `400` | 缺少或非法的 `hostname` / `port` |
| `502` | 无法连接目标地址或隧道建立失败 |

---

### 2.2 写入上行（Client -> TCP）

- **HTTP Method**：`POST`
- **URL**：`/socket?sessionId=<sessionId>`
- **请求体**：`application/octet-stream`（任意二进制字节）
- **返回**：写入成功后返回无内容响应

#### Query 参数

| 参数名 | 必填 | 说明 |
|---|---:|---|
| `sessionId` | 是 | 来自 GET 响应头 `X-Fcless-Session-Id` |

#### 请求头

| Header | 必填 | 说明 |
|---|---:|---|
| `Content-Type: application/octet-stream` | 建议 | 上行内容为二进制流 |

#### 状态码

| 状态码 | 含义 |
|---:|---|
| `204` | 上行写入成功 |
| `400` | 缺少 `sessionId` |
| `404` | 会话不存在或隧道未打开（例如 GET 尚未建立成功） |
| `502` | 转发/写入失败 |

---

## 3. 客户端时序（推荐）

1. 客户端发起 `GET /socket?hostname=...&port=...`
2. 客户端收到 **响应头** 后，立即取出 `X-Fcless-Session-Id`
3. 客户端并行（或随后）发起 `POST /socket?sessionId=...`，把需要写入目标 TCP 的字节流作为请求体发送
4. 客户端持续读取 GET 的响应体，直到读到 EOF（目标关闭连接）或客户端主动结束

> 备注：该协议设计为“一次性上行 + 持续下行”。如需多次上行分片，请在单次 POST 中自行完成分片封装，或扩展协议。

---

## 4. 数据语义

- fcless **不关心应用层协议**，只做字节透明传输。
- 目标端若为 TLS 服务（例如 `hostname:443`），TLS ClientHello/ServerHello/加密数据均按字节流透传，**TLS 端到端发生在客户端与目标服务之间**。

---

## 5. 示例

### 5.1 建立连接（GET）

```bash
curl -v \
  "https://<your-worker-domain>/socket?hostname=example.com&port=443" \
  --output down.bin
```

从响应头中取出：

- `X-Fcless-Session-Id: <sessionId>`

### 5.2 发送上行（POST）

```bash
curl -v -X POST \
  "https://<your-worker-domain>/socket?sessionId=<sessionId>" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @up.bin
```

---

## 6. 错误处理建议（客户端）

- GET 返回非 200：不要继续 POST；应当重试或报告错误。
- POST 返回 404：通常表示隧道未就绪或已结束；建议重新走一遍 GET/POST 建立新会话。
- GET 流提前 EOF：表示目标连接已关闭或中途断开；此会话结束。

---

## 7. 实现约束（与当前实现保持sessionId一致）

- `sessionId` 由服务端生成（UUID）。
- 同一个 `sessionId` 对应一个 Durable Object 会话。
- 上行写入（POST）在当前实现中设计为 **单次写入**：完成后会话结束（服务端不保证可再次 POST）。
- 服务端响应 `Content-Type` 固定为 `application/octet-stream`。

---



---

## DNS-over-HTTPS 代理

为了后续实现自定义 DNS 解析，当前版本在 `/dns` 路径上提供一个简单的 DoH 转发功能，直接把请求转发到 Cloudflare 的公共 DNS-over-HTTPS 服务。客户端可以使用标准的 DoH 调用方式，无需改变请求内容。

- **Path**：`/dns`
- **功能**：转发至 `https://cloudflare-dns.com/dns-query` 并返回响应
- **支持**：`GET` 或 `POST`，请求头、查询字符串及请求体和原样转发
- **注意**：目前仅作为临时实现，后续可替换为内置解析逻辑或其它上游服务器。

### 使用示例

使用 GET 查询：

```bash
curl "https://<your-worker-domain>/dns?name=example.com&type=A" \
  -H "Accept: application/dns-json"
```

与 Cloudflare 直接调用等价：

```bash
curl "https://cloudflare-dns.com/dns-query?name=example.com&type=A" \
  -H "Accept: application/dns-json"
```

使用 POST 查询：

```bash
curl -X POST "https://<your-worker-domain>/dns" \
  -H "Content-Type: application/dns-message" \
  --data-binary @query.bin
```

> 响应会原封不动地返回上游服务器的内容。

---
