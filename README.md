# Edgetunnel 链式 HTTPS 代理自动优选与定时更新

基于 **GitHub Actions** 每天定时自动从公网代理源抓取 HTTPS 代理，利用 [check.socks5.cmliussss.net](https://check.socks5.cmliussss.net/) 进行高并发连通性、纯净度及延迟检测，筛选出 **TW、SG、HK、JP、US 各 3 个**（共 15 个）高纯净度、低延迟的优质落地代理，并输出为符合 **Edgetunnel / Cloudflare Worker 自定义优选节点** 规范的列表文件。

---

## 📌 项目特性

1. **定时自动化**：通过 GitHub Actions 每天北京时间 **08:00**（UTC 00:00）准时自动运行并提交。
2. **多重纯净度校验**：
   - 接入 [check.socks5.cmliussss.net](https://check.socks5.cmliussss.net/) 进行落地验证。
   - 严格过滤已知滥用（`is_abuser`）、Bogon、恶意节点。
   - 优先选择并加权住宅家宽（`is_datacenter: false`）与高匿名度（`elite`）代理。
3. **真实地区校准**：以测试接口实际出口归属地（`exit.country_code`）为准，杜绝虚假标注。
4. **延迟排序**：同等高纯净度级别下，按真实响应延迟（`responseTime`）从低到高选取前 3 个。
5. **历史节点回退**：自动读取上一天的有效节点，若当天源中某国数量不足，自动保留历史可用节点。
6. **无缝对接 Edgetunnel**：输出格式与 `bestcf.pages.dev` 优选格式完全一致，直接兼容链式代理语法。

---

## 📄 输出格式示例 (`proxies.txt`)

```text
ladder.easedays.com#TW 链式HTTPS代理$https://114.33.6.158:443
ladder.easedays.com#TW 链式HTTPS代理$https://211.72.236.159:443
ladder.easedays.com#TW 链式HTTPS代理$https://47.243.181.85:42532
ladder.easedays.com#SG 链式HTTPS代理$https://47.129.55.159:443
ladder.easedays.com#SG 链式HTTPS代理$https://165.22.60.108:443
ladder.easedays.com#SG 链式HTTPS代理$https://35.198.241.84:443
ladder.easedays.com#HK 链式HTTPS代理$https://221.126.247.53:22
ladder.easedays.com#HK 链式HTTPS代理$https://38.55.192.122:443
ladder.easedays.com#HK 链式HTTPS代理$https://43.154.249.2:443
ladder.easedays.com#JP 链式HTTPS代理$https://210.236.6.162:443
ladder.easedays.com#JP 链式HTTPS代理$https://210.236.6.168:443
ladder.easedays.com#JP 链式HTTPS代理$https://210.236.6.164:443
ladder.easedays.com#US 链式HTTPS代理$https://146.189.217.231:443
ladder.easedays.com#US 链式HTTPS代理$https://146.189.216.139:443
ladder.easedays.com#US 链式HTTPS代理$https://146.189.216.138:443
```

- `ladder.easedays.com`：前置 Cloudflare 优选域名 / 反代域名。
- `#TW 链式HTTPS代理`：客户端显示的节点地区备注。
- `$https://...`：用于 Edgetunnel 转发流量的真实落地 HTTPS 出口代理。

---

## 🚀 如何在 Edgetunnel 中使用

将本仓库生成的 `proxies.txt` URL 填入 Edgetunnel 脚本的环境变量或订阅配置中：

### 选项 1：使用 CDN 加速链接（推荐，免挂代理即可直连拉取）
```text
https://cdn.jsdelivr.net/gh/你的GitHub用户名/你的仓库名@main/proxies.txt
```

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
