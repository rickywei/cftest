# Edgetunnel 链式 SOCKS5 代理自动优选与定时更新

基于 **GitHub Actions** 每天定时自动从公网代理源抓取 SOCKS5 代理，利用 [check.socks5.cmliussss.net](https://check.socks5.cmliussss.net/) 进行高并发连通性、真实出口地区、纯净度及延迟测速，遵循 **“延迟优先（Low Latency First）”** 原则筛选出 **TW、SG、HK、JP、US 各 3 个** 极低延迟且稳定的优质落地代理，并输出为符合 **Edgetunnel / Cloudflare Worker 自定义优选节点** 规范的列表文件。

---

## 📌 项目特性

1. **定时自动化**：通过 GitHub Actions 每天北京时间 **19:30**（UTC 11:30）准时自动运行并提交。
2. **延迟优先调度（解决 AI 对话卡顿）**：
   - 彻底摒弃单纯追求 IP 纯净度而牺牲速度的逻辑，以 **真实响应延迟（responseTime）** 为核心排序指标。
   - 延迟相近区间（<=100ms）内自动优先选择高纯净度与家宽节点。
3. **真实地区校准与有效性过滤**：
   - 接入 [check.socks5.cmliussss.net](https://check.socks5.cmliussss.net/) 验证真实出口（`exit.country_code`）。
   - 严格过滤 Bogon 等无效内网 IP。
4. **历史节点回退**：自动读取上一天的有效节点，若当天源中某国数量不足，自动保留历史可用节点。
5. **无缝对接 Edgetunnel**：输出格式与 `bestcf.pages.dev` 优选格式完全一致，直接兼容链式代理语法。

---

## 📄 输出格式示例 (`proxies.txt`)

```text
ladder.easedays.com#US 链式SOCKS5代理$socks5://162.120.16.210:1080
ladder.easedays.com#US 链式SOCKS5代理$socks5://209.50.255.91:1080
ladder.easedays.com#HK 链式SOCKS5代理$socks5://8.217.224.41:1081
ladder.easedays.com#JP 链式SOCKS5代理$socks5://43.165.133.188:1081
```

- `ladder.easedays.com`：前置 Cloudflare 优选域名 / 反代域名。
- `#US 链式SOCKS5代理`：客户端显示的节点地区备注。
- `$socks5://...`：用于 Edgetunnel 转发流量的真实落地 SOCKS5 出口代理。

---

## 🚀 如何在 Edgetunnel 中使用

将本仓库生成的 `proxies.txt` URL 填入 Edgetunnel 脚本的环境变量或订阅配置中：

### 选项 1：使用 CDN 加速链接（推荐，免挂代理即可直连拉取）
```text
https://cdn.jsdelivr.net/gh/你的GitHub用户名/你的仓库名@main/proxies.txt
```
> **注意**：每次 GitHub Actions 更新后均会自动触发 jsDelivr 全球边缘缓存刷新。如需手动即时刷新，可直接访问：
> `https://purge.jsdelivr.net/gh/你的GitHub用户名/你的仓库名@main/proxies.txt`


### 选项 2：使用 GitHub Raw 链接
```text
https://raw.githubusercontent.com/你的GitHub用户名/你的仓库名/main/proxies.txt
```

### 选项 3：开启 GitHub Pages（类似 pages.dev 静态订阅）
1. 在仓库的 **Settings** -> **Pages**。
2. **Build and deployment** -> **Source** 选择 `Deploy from a branch`。
3. Branch 选择 `main` / `root` 并保存。
4. 部署完成后即可通过类似以下链接直接访问：
   ```text
   https://你的GitHub用户名.github.io/你的仓库名/proxies.txt
   ```

---

## ⚙️ 自定义参数配置

你可以在 `.github/workflows/update-proxies.yml` 中调整环境变量：

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `CF_DOMAIN` | `ladder.easedays.com` | 前置优选域名 / 伪装域名 |
| `COUNT_PER_COUNTRY` | `3` | 每个地区保留的优质代理数量 |
| `MAX_WORKERS` | `6` | 并发检测线程数 |
| `CHECK_TIMEOUT` | `10` | 单个节点检测超时时间（秒） |

---

## 🛠️ 本地运行与测试

如果你想在本地手动立即测试更新，在项目根目录运行：

```bash
# Node.js 运行
node scripts/update_proxies.js

# 或 Python 运行 (需 Python 3.8+)
python scripts/update_proxies.py
```
