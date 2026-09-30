#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Edgetunnel 链式 HTTPS 优选代理自动更新脚本
- 数据源: proxifly/free-proxy-list (https & all) 以及历史有效节点
- 验证接口: https://check.socks5.cmliussss.net/check?proxy=https://ip:port
- 筛选标准: 真实出口为 TW, SG, HK, JP, US；高纯净度（无滥用、非Bogon/Tor）；低延迟
- 输出格式: ladder.easedays.com#TW 链式HTTPS代理$https://ip:port
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

TARGET_COUNTRIES = ["TW", "SG", "HK", "JP", "US"]
PROXIES_PER_COUNTRY = int(os.environ.get("COUNT_PER_COUNTRY", 3))
CF_DOMAIN = os.environ.get("CF_DOMAIN", "ladder.easedays.com")
OUTPUT_FILE = os.environ.get("OUTPUT_FILE", "proxies.txt")
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", 6))
CHECK_TIMEOUT = int(os.environ.get("CHECK_TIMEOUT", 10))

PROXIFLY_HTTPS_URL = "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.json"
PROXIFLY_ALL_URL = "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.json"
CHECK_API_URL = "https://check.socks5.cmliussss.net/check?proxy="


def fetch_url(url, timeout=15):
    """抓取 URL 内容并返回文本"""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="ignore")
    except Exception as e:
        print(f"[WARN] 抓取失败 {url}: {e}", file=sys.stderr)
        return None


def load_previous_proxies(filepath):
    """读取历史有效 proxies.txt，作为候选池备份"""
    if not os.path.exists(filepath):
        return []
    
    proxies = []
    pattern = re.compile(r"\$(https://[0-9a-zA-Z.:]+)")
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                match = pattern.search(line)
                if match:
                    proxy_url = match.group(1)
                    proxies.append({
                        "proxy": proxy_url,
                        "from_history": True,
                        "geolocation": {}
                    })
    except Exception as e:
        print(f"[WARN] 读取历史代理文件失败: {e}", file=sys.stderr)
    return proxies


def get_candidate_proxies():
    """从多渠道汇集候选 HTTPS 代理"""
    candidates = {}

    # 1. 抓取 Proxifly HTTPS 专门列表
    print("[INFO] 正在获取 Proxifly HTTPS 代理列表...")
    https_data = fetch_url(PROXIFLY_HTTPS_URL)
    if https_data:
        try:
            items = json.loads(https_data)
            for item in items:
                proxy_url = item.get("proxy")
                if proxy_url:
                    candidates[proxy_url] = {
                        "proxy": proxy_url,
                        "geolocation": item.get("geolocation") or {},
                        "anonymity": item.get("anonymity", ""),
                        "score": item.get("score", 0),
                        "protocol": item.get("protocol", "https")
                    }
        except Exception as e:
            print(f"[WARN] 解析 HTTPS 列表 JSON 异常: {e}", file=sys.stderr)

    # 2. 如果目标国家数量不足，从 Proxifly ALL 补充匹配国家或常规 HTTPS 端口的代理
    print("[INFO] 正在获取 Proxifly 综合列表作为补充...")
    all_data = fetch_url(PROXIFLY_ALL_URL)
    if all_data:
        try:
            items = json.loads(all_data)
            for item in items:
                is_https = item.get("https") is True or item.get("protocol") == "https"
                port = item.get("port")
                is_ssl_port = port in [443, 8443, 2053, 2083, 2087, 2096]
                if is_https or is_ssl_port:
                    proxy_url = item.get("proxy")
                    if proxy_url and proxy_url.startswith("https://") and proxy_url not in candidates:
                        candidates[proxy_url] = {
                            "proxy": proxy_url,
                            "geolocation": item.get("geolocation") or {},
                            "anonymity": item.get("anonymity", ""),
                            "score": item.get("score", 0),
                            "protocol": "https"
                        }
        except Exception as e:
            print(f"[WARN] 解析 ALL 列表 JSON 异常: {e}", file=sys.stderr)

    # 3. 加入历史已保存的代理作为候选（保证稳定性）
    history_proxies = load_previous_proxies(OUTPUT_FILE)
    print(f"[INFO] 从历史文件中加载了 {len(history_proxies)} 个候选代理")
    for hp in history_proxies:
        p_url = hp["proxy"]
        if p_url not in candidates:
            candidates[p_url] = hp

    print(f"[INFO] 汇集去重后候选 HTTPS 代理总数: {len(candidates)}")
    return list(candidates.values())


def check_single_proxy(candidate):
    """
    通过 check.socks5.cmliussss.net 检测代理
    返回代理详细信息、真实出口国家、延迟和纯净度评分
    """
    proxy_url = candidate["proxy"]
    target_api = CHECK_API_URL + urllib.parse.quote(proxy_url, safe="")

    req = urllib.request.Request(
        target_api,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    )

    try:
        with urllib.request.urlopen(req, timeout=CHECK_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    if not data.get("success"):
        return None

    response_time = data.get("responseTime")
    if not isinstance(response_time, (int, float)) or response_time <= 0:
        return None

    exit_info = data.get("exit") or {}
    country_code = str(exit_info.get("country_code") or "").upper()
    if not country_code:
        return None

    privacy = exit_info.get("privacy") or {}

    # 严格过滤已知黑名单/恶意/Bogon
    if privacy.get("is_abuser") or exit_info.get("is_abuser"):
        return None
    if privacy.get("is_bogon") or exit_info.get("is_bogon"):
        return None

    # 计算纯净度综合得分 (Purity Score)
    purity_score = 100
    is_datacenter = exit_info.get("is_datacenter", True)
    if not is_datacenter:
        purity_score += 50  # 住宅家宽 IP 具有更高纯净度加分
    if not privacy.get("is_proxy", False):
        purity_score += 20
    if not privacy.get("is_vpn", False):
        purity_score += 15
    if not privacy.get("is_tor", False):
        purity_score += 25
    if not privacy.get("is_hosting", True):
        purity_score += 15

    # 来源匿名度加分
    anonymity = candidate.get("anonymity", "")
    if anonymity == "elite":
        purity_score += 20
    elif anonymity == "anonymous":
        purity_score += 10

    return {
        "proxy": proxy_url,
        "country": country_code,
        "responseTime": int(response_time),
        "is_datacenter": is_datacenter,
        "purity_score": purity_score,
        "city": exit_info.get("city", ""),
        "isp": (exit_info.get("asn") or {}).get("name", "")
    }


def filter_and_rank_proxies(candidates):
    """
    并发验证代理，并按国家、纯净度与延迟筛选各 3 个
    """
    # 优先筛选目标国家相关候选，减少无谓的请求
    target_set = set(TARGET_COUNTRIES)
    prioritized = []
    others = []

    for c in candidates:
        geo_country = (c.get("geolocation") or {}).get("country", "").upper()
        if geo_country in target_set or c.get("from_history"):
            prioritized.append(c)
        else:
            others.append(c)

    # 优先检测针对目标国家的代理，如果不够再检测其他
    test_queue = prioritized + others[:100]
    print(f"[INFO] 即将对 {len(test_queue)} 个候选代理进行连通性与纯净度测试 (并发数: {MAX_WORKERS})...")

    verified_by_country = {code: [] for code in TARGET_COUNTRIES}
    total_tested = 0
    total_passed = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_map = {executor.submit(check_single_proxy, c): c for c in test_queue}
        for future in as_completed(future_map):
            total_tested += 1
            result = future.result()
            if result:
                country = result["country"]
                if country in verified_by_country:
                    verified_by_country[country].append(result)
                    total_passed += 1
                    dc_label = "机房" if result["is_datacenter"] else "家宽"
                    print(
                        f"  [PASS] [{country}] {result['proxy']} - "
                        f"延迟: {result['responseTime']}ms | 纯净度: {result['purity_score']} | "
                        f"类型: {dc_label} | ISP: {result['isp']}"
                    )

            # 检查是否每个目标国家都已经集齐足够数量（例如每个国家已有 5 个候选可供挑优）
            ready_counts = [len(verified_by_country[c]) >= (PROXIES_PER_COUNTRY + 2) for c in TARGET_COUNTRIES]
            if all(ready_counts):
                print("[INFO] 所有目标国家均已找到足够数量的有效代理，提前完成测试。")
                break

    print(f"[INFO] 测试完成。共检测 {total_tested} 个，有效且匹配目标国家节点数: {total_passed}")

    # 筛选排序：各国家选出最优的前 N 个
    selected_proxies = {}
    for country in TARGET_COUNTRIES:
        nodes = verified_by_country[country]
        if not nodes:
            print(f"[WARN] 国家 [{country}] 未找到可用节点！", file=sys.stderr)
            selected_proxies[country] = []
            continue

        # 排序规则：
        # 1. 优先纯净度高的等级
        # 2. 同纯净度级别内，按 responseTime 延迟从低到高排序
        # 家宽 IP (is_datacenter=False) 延迟有 500ms 抵扣优势
        def rank_key(item):
            effective_latency = item["responseTime"] - (500 if not item["is_datacenter"] else 0)
            return (-item["purity_score"], effective_latency)

        nodes.sort(key=rank_key)
        selected_proxies[country] = nodes[:PROXIES_PER_COUNTRY]

    return selected_proxies


def write_output_file(selected_proxies, filepath):
    """
    格式化输出到文件:
    ladder.easedays.com#TW 链式HTTPS代理$https://107.167.191.95:8443
    """
    lines = []
    lines.append(f"# Edgetunnel 优选节点列表 - 自动生成于 {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")
    
    total_count = 0
    for country in TARGET_COUNTRIES:
        nodes = selected_proxies.get(country, [])
        for node in nodes:
            total_count += 1
            proxy_url = node["proxy"]
            # 格式: [域名]#[地区] 链式HTTPS代理$[https代理地址]
            line = f"{CF_DOMAIN}#{country} 链式HTTPS代理${proxy_url}"
            lines.append(line)

    content = "\n".join(lines) + "\n"
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"[INFO] 已生成优选代理文件: {filepath} (共 {total_count} 个节点)")
    return total_count


def write_github_step_summary(selected_proxies):
    """如果处于 GitHub Actions 环境，向 Job Summary 输出直观表格"""
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_file:
        return

    try:
        with open(summary_file, "a", encoding="utf-8") as f:
            f.write("## 🚀 Edgetunnel 链式 HTTPS 代理每日更新报告\n\n")
            f.write(f"- **更新时间**: `{time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}`\n")
            f.write(f"- **优选域名**: `{CF_DOMAIN}`\n\n")
            f.write("| 国家/地区 | 落地 HTTPS 代理 | 延迟 (ms) | IP 类型 | 纯净度评分 | 运营商 / ISP |\n")
            f.write("| :---: | :--- | :---: | :---: | :---: | :--- |\n")
            for country in TARGET_COUNTRIES:
                nodes = selected_proxies.get(country, [])
                if not nodes:
                    f.write(f"| {country} | *(暂未获取到可用节点)* | - | - | - | - |\n")
                for n in nodes:
                    ip_type = "🏠 家宽" if not n["is_datacenter"] else "🏢 机房"
                    f.write(f"| **{country}** | `{n['proxy']}` | `{n['responseTime']}` | {ip_type} | `{n['purity_score']}` | {n['isp']} |\n")
            f.write("\n> 提示：可在 edgetunnel 中配置订阅此文件链接自动同步优选节点。\n")
    except Exception as e:
        print(f"[WARN] 写入 GITHUB_STEP_SUMMARY 失败: {e}", file=sys.stderr)


def main():
    start_time = time.time()
    print("=" * 60)
    print("开始执行 Edgetunnel 链式 HTTPS 代理自动更新")
    print(f"目标地区: {', '.join(TARGET_COUNTRIES)} (各 {PROXIES_PER_COUNTRY} 个)")
    print(f"优选域名: {CF_DOMAIN}")
    print("=" * 60)

    candidates = get_candidate_proxies()
    if not candidates:
        print("[ERROR] 未获取到任何候选代理，退出！", file=sys.stderr)
        sys.exit(1)

    selected = filter_and_rank_proxies(candidates)
    total_written = write_output_file(selected, OUTPUT_FILE)
    write_github_step_summary(selected)

    elapsed = round(time.time() - start_time, 2)
    print("=" * 60)
    print(f"更新完成！耗时: {elapsed} 秒，共保留 {total_written} 个高质量落地代理。")
    print("=" * 60)


if __name__ == "__main__":
    main()
