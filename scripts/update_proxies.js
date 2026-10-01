#!/usr/bin/env node
/**
 * Edgetunnel 链式优选代理自动更新脚本 (Node.js 版)
 * 本地与 GitHub Actions 均可直接运行
 * 
 * 核心优化：
 * 1. 协议：SOCKS5 为主，HTTPS 自动补位（解决新加坡 SG 等地区 SOCKS5 极度匮乏的问题）
 * 2. 算法：综合评分模型（体验等效延迟法），兼顾物理延迟与 IP 纯净度
 *    - 住宅家宽 IP 提供 200ms 的等效延迟补偿（慢 200ms 内优先选住宅）
 *    - 纯净度每高 10 分抵扣 18ms 等效延迟
 *    - 超过 2000ms 的高延迟节点施加非线性惩罚，杜绝慢速住宅 IP 霸榜
 * 3. 地区：TW, SG, HK, JP, US 全面覆盖
 */

const fs = require('fs');
const path = require('path');

const TARGET_COUNTRIES = ['TW', 'SG', 'HK', 'JP', 'US'];
const PROXIES_PER_COUNTRY = parseInt(process.env.COUNT_PER_COUNTRY || '3', 10);
const CF_DOMAIN = process.env.CF_DOMAIN || 'ladder.easedays.com';
const OUTPUT_FILE = process.env.OUTPUT_FILE || path.join(__dirname, '..', 'proxies.txt');
const MAX_CONCURRENCY = parseInt(process.env.MAX_WORKERS || '8', 10);
const CHECK_TIMEOUT = parseInt(process.env.CHECK_TIMEOUT || '8', 10) * 1000;

const PROXIFLY_SOCKS5_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.json';
const PROXIFLY_HTTPS_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.json';
const PROXIFLY_ALL_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.json';
const CHECK_API_URL = 'https://check.socks5.cmliussss.net/check?proxy=';

async function fetchJson(url, timeoutMs = 15000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(`[WARN] 抓取失败 ${url}:`, err.message);
    return null;
  }
}

function loadPreviousProxies(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const matches = content.matchAll(/\$((?:socks5|https):\/\/[0-9a-zA-Z.:]+)/g);
    const proxies = [];
    for (const match of matches) {
      proxies.push({
        proxy: match[1],
        from_history: true,
        geolocation: {}
      });
    }
    return proxies;
  } catch (err) {
    console.error(`[WARN] 读取历史代理异常:`, err.message);
    return [];
  }
}

/**
 * 核心算法：计算综合体验等效延迟 (Effective Latency) 与综合效用得分 (Composite Score)
 * 逻辑：
 * 1. 物理延迟是基础体验核心。
 * 2. 住宅 IP（家宽）抗风控能力极强，赋予 200ms 的等效延迟补偿。
 * 3. 纯净度加分每高 10 分抵扣 18ms 延迟。
 * 4. 物理延迟超过 2000ms 时加收 60% 的超额惩罚，杜绝选出太卡的住宅节点。
 */
function calculateScore(node) {
  const rt = node.responseTime;
  // 住宅家宽提供 200ms 的延迟抵扣
  const residentialDiscount = node.is_datacenter ? 0 : 200;
  // 纯净度增益：基准分 100 分，高出部分每分抵扣 1.8ms
  const purityDiscount = Math.max(0, (node.purity_score - 100) * 1.8);
  // 极高延迟恶性惩罚
  let highLatencyPenalty = 0;
  if (rt > 2000) {
    highLatencyPenalty = (rt - 2000) * 0.6;
  }

  // 等效体验延迟（越低越优）
  const effectiveLatency = Math.round(rt - residentialDiscount - purityDiscount + highLatencyPenalty);
  // 归一化综合得分 (10 ~ 100 分，越高越优)
  const compositeScore = Math.max(10, Math.min(100, Math.round(100 - effectiveLatency / 35)));

  return { effectiveLatency, compositeScore };
}

async function getCandidates() {
  const candidates = new Map();

  console.log('[INFO] 正在获取 Proxifly SOCKS5 代理列表...');
  const socks5List = await fetchJson(PROXIFLY_SOCKS5_URL);
  if (Array.isArray(socks5List)) {
    for (const item of socks5List) {
      if (item.proxy && item.proxy.startsWith('socks5://')) {
        candidates.set(item.proxy, {
          proxy: item.proxy,
          geolocation: item.geolocation || {},
          anonymity: item.anonymity || '',
          score: item.score || 0,
          protocol: 'socks5'
        });
      }
    }
  }

  console.log('[INFO] 正在获取 Proxifly HTTPS 代理列表 (为稀缺地区自动补位)...');
  const httpsList = await fetchJson(PROXIFLY_HTTPS_URL);
  if (Array.isArray(httpsList)) {
    for (const item of httpsList) {
      if (item.proxy && item.proxy.startsWith('https://')) {
        // 如果候选池中没有该代理，加入候选池
        if (!candidates.has(item.proxy)) {
          candidates.set(item.proxy, {
            proxy: item.proxy,
            geolocation: item.geolocation || {},
            anonymity: item.anonymity || '',
            score: item.score || 0,
            protocol: 'https'
          });
        }
      }
    }
  }

  console.log('[INFO] 正在获取 Proxifly 综合列表作为补充...');
  const allList = await fetchJson(PROXIFLY_ALL_URL);
  if (Array.isArray(allList)) {
    for (const item of allList) {
      const isSocks5 = item.protocol === 'socks5' || item.socks5 === true;
      const isSocksPort = [1080, 1081, 10808, 10809].includes(item.port);
      if (isSocks5 || isSocksPort) {
        let proxy = item.proxy;
        if (proxy && !proxy.includes('://')) {
          proxy = `socks5://${proxy}`;
        }
        if (proxy && proxy.startsWith('socks5://') && !candidates.has(proxy)) {
          candidates.set(proxy, {
            proxy: proxy,
            geolocation: item.geolocation || {},
            anonymity: item.anonymity || '',
            score: item.score || 0,
            protocol: 'socks5'
          });
        }
      }
    }
  }

  const history = loadPreviousProxies(OUTPUT_FILE);
  console.log(`[INFO] 从历史文件中加载了 ${history.length} 个候选代理`);
  for (const h of history) {
    if (!candidates.has(h.proxy)) {
      candidates.set(h.proxy, h);
    }
  }

  console.log(`[INFO] 汇集去重后多源候选代理总数: ${candidates.size}`);
  return Array.from(candidates.values());
}

async function checkProxy(candidate) {
  const proxyUrl = candidate.proxy;
  const targetApi = CHECK_API_URL + encodeURIComponent(proxyUrl);
  try {
    const res = await fetch(targetApi, { signal: AbortSignal.timeout(CHECK_TIMEOUT) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;

    const responseTime = Number(data.responseTime);
    if (!responseTime || responseTime <= 0) return null;

    const exit = data.exit || {};
    const country = String(exit.country_code || '').toUpperCase();
    if (!country) return null;

    const privacy = exit.privacy || {};
    if (privacy.is_bogon || exit.is_bogon) return null;

    let purityScore = 100;
    if (privacy.is_abuser || exit.is_abuser) purityScore -= 40;
    const isDatacenter = exit.is_datacenter ?? true;
    if (!isDatacenter) purityScore += 50;
    if (!privacy.is_proxy) purityScore += 20;
    if (!privacy.is_vpn) purityScore += 15;
    if (!privacy.is_tor) purityScore += 25;
    if (!privacy.is_hosting) purityScore += 15;
    if (candidate.anonymity === 'elite') purityScore += 20;
    else if (candidate.anonymity === 'anonymous') purityScore += 10;

    const rawNode = {
      proxy: proxyUrl,
      country,
      responseTime: Math.round(responseTime),
      is_datacenter: isDatacenter,
      purity_score: purityScore,
      city: exit.city || '',
      isp: exit.asn?.name || ''
    };

    // 计算综合模型得分
    const scoreInfo = calculateScore(rawNode);
    return {
      ...rawNode,
      effectiveLatency: scoreInfo.effectiveLatency,
      compositeScore: scoreInfo.compositeScore
    };
  } catch {
    return null;
  }
}

async function runPool(items, limit, handler, shouldStop) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      if (shouldStop && shouldStop()) break;
      const i = index++;
      await handler(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const startTime = Date.now();
  console.log('='.repeat(60));
  console.log('开始执行 Edgetunnel 链式代理更新 (综合评分模型: 延迟与纯净度权衡)');
  console.log(`目标地区: ${TARGET_COUNTRIES.join(', ')} (各 ${PROXIES_PER_COUNTRY} 个)`);
  console.log(`优选域名: ${CF_DOMAIN}`);
  console.log('='.repeat(60));

  const candidates = await getCandidates();
  if (candidates.length === 0) {
    console.error('[ERROR] 未获取到候选代理');
    process.exit(1);
  }

  const targetSet = new Set(TARGET_COUNTRIES);
  const prioritizedByCountry = {};
  TARGET_COUNTRIES.forEach(c => prioritizedByCountry[c] = []);
  const others = [];

  for (const c of candidates) {
    const geo = (c.geolocation?.country || '').toUpperCase();
    if (targetSet.has(geo)) {
      prioritizedByCountry[geo].push(c);
    } else if (c.from_history) {
      others.unshift(c);
    } else {
      others.push(c);
    }
  }

  // 针对稀缺地区（TW, SG），全面放入测试队列，不进行前置截断
  // 针对丰富地区（HK, JP, US），SOCKS5 优先测试前 40 个
  const testQueue = [];
  for (const country of TARGET_COUNTRIES) {
    const nodes = prioritizedByCountry[country];
    // SOCKS5 节点优先排前，HTTPS 节点随其后
    nodes.sort((a, b) => {
      const aIsS5 = a.proxy.startsWith('socks5://') ? 0 : 1;
      const bIsS5 = b.proxy.startsWith('socks5://') ? 0 : 1;
      return aIsS5 - bIsS5;
    });

    const sampleLimit = (country === 'TW' || country === 'SG') ? nodes.length : Math.min(nodes.length, 45);
    testQueue.push(...nodes.slice(0, sampleLimit));
  }
  testQueue.push(...others.slice(0, 40));

  console.log(`[INFO] 即将对 ${testQueue.length} 个候选代理进行连通性、纯净度与综合评分测速 (并发: ${MAX_CONCURRENCY})...`);

  const verified = {};
  TARGET_COUNTRIES.forEach(c => verified[c] = []);

  let testedCount = 0;
  let passedCount = 0;

  await runPool(testQueue, MAX_CONCURRENCY, async (candidate) => {
    testedCount++;
    const res = await checkProxy(candidate);
    if (res && verified[res.country]) {
      verified[res.country].push(res);
      passedCount++;
      const dcLabel = res.is_datacenter ? '机房' : '家宽';
      const proto = res.proxy.startsWith('socks5://') ? 'SOCKS5' : 'HTTPS';
      console.log(`  [PASS] [${res.country}] [${proto}] ${res.proxy} - 物理延迟: ${res.responseTime}ms | 等效延迟: ${res.effectiveLatency}ms | 综合得分: ${res.compositeScore} | 纯净度: ${res.purity_score} | 类型: ${dcLabel}`);
    }
  }, () => {
    // 每个目标地区收集满 (PROXIES_PER_COUNTRY + 3) 个候选有效节点后可提前退出
    return TARGET_COUNTRIES.every(c => verified[c].length >= (PROXIES_PER_COUNTRY + 3));
  });

  console.log(`[INFO] 测试完成。共检测 ${testedCount} 个，有效且匹配目标国家节点数: ${passedCount}`);

  const lines = [
    `# Edgetunnel 优选节点列表 - 自动生成于 ${new Date().toISOString()}`
  ];

  let totalWritten = 0;
  for (const country of TARGET_COUNTRIES) {
    const nodes = verified[country] || [];
    
    // 核心：基于“综合体验等效延迟 (effectiveLatency)”升序排序（即综合得分降序）
    nodes.sort((a, b) => a.effectiveLatency - b.effectiveLatency);

    const topNodes = nodes.slice(0, PROXIES_PER_COUNTRY);
    for (const n of topNodes) {
      const isSocks = n.proxy.startsWith('socks5://');
      const typeLabel = isSocks ? '链式SOCKS5代理' : '链式HTTPS代理';
      lines.push(`${CF_DOMAIN}#${country} ${typeLabel}$${n.proxy}`);
      totalWritten++;
    }
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n', 'utf-8');
  console.log(`[INFO] 已生成优选代理文件: ${OUTPUT_FILE} (共 ${totalWritten} 个节点)`);

  // GitHub Actions 运行汇报表格
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      const summaryLines = [
        '## 🚀 Edgetunnel 链式优选代理更新报告 (纯净度与延迟综合评分)',
        '',
        `- **更新时间**: \`${new Date().toISOString()}\``,
        `- **优选域名**: \`${CF_DOMAIN}\``,
        `- **评价算法**: **综合体验等效延迟模型**（住宅家宽奖励 200ms 等效抵扣，高纯净度奖励递增，超 2000ms 高延迟惩罚）`,
        '',
        '| 地区 | 协议 | 优选配置行 | 物理延迟 | 等效延迟 | 综合得分 | 类型 | 纯净度 | ISP / 运营商 |',
        '| :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |'
      ];

      for (const country of TARGET_COUNTRIES) {
        const nodes = (verified[country] || []).slice(0, PROXIES_PER_COUNTRY);
        if (nodes.length === 0) {
          summaryLines.push(`| **${country}** | - | *(今日未获取到存活节点)* | - | - | - | - | - | - |`);
        }
        for (const n of nodes) {
          const typeLabel = n.is_datacenter ? '🏢 机房' : '🏠 家宽';
          const proto = n.proxy.startsWith('socks5://') ? 'SOCKS5' : 'HTTPS';
          const typeTag = n.proxy.startsWith('socks5://') ? '链式SOCKS5代理' : '链式HTTPS代理';
          summaryLines.push(
            `| **${country}** | \`${proto}\` | \`${CF_DOMAIN}#${country} ${typeTag}$${n.proxy}\` | \`${n.responseTime}ms\` | \`${n.effectiveLatency}ms\` | **${n.compositeScore}** | ${typeLabel} | \`${n.purity_score}\` | ${n.isp || '未知'} |`
          );
        }
      }

      summaryLines.push('', '> 提示：已将结果推送至 `proxies.txt`，可通过 GitHub Pages 或 jsDelivr 导入 Edgetunnel。');
      fs.appendFileSync(summaryFile, summaryLines.join('\n') + '\n', 'utf-8');
    } catch (e) {
      console.warn('[WARN] 写入 GITHUB_STEP_SUMMARY 失败:', e.message);
    }
  }

  console.log('='.repeat(60));
  console.log(`耗时: ${((Date.now() - startTime) / 1000).toFixed(2)} 秒`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
