#!/usr/bin/env node
/**
 * Edgetunnel 链式 HTTPS 优选代理自动更新脚本 (Node.js 版)
 * 本地与 GitHub Actions 均可直接运行
 */

const fs = require('fs');
const path = require('path');

const TARGET_COUNTRIES = ['TW', 'SG', 'HK', 'JP', 'US'];
const PROXIES_PER_COUNTRY = parseInt(process.env.COUNT_PER_COUNTRY || '3', 10);
const CF_DOMAIN = process.env.CF_DOMAIN || 'ladder.easedays.com';
const OUTPUT_FILE = process.env.OUTPUT_FILE || path.join(__dirname, '..', 'proxies.txt');
const MAX_CONCURRENCY = parseInt(process.env.MAX_WORKERS || '6', 10);
const CHECK_TIMEOUT = parseInt(process.env.CHECK_TIMEOUT || '10', 10) * 1000;

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
    const matches = content.matchAll(/\$(https:\/\/[0-9a-zA-Z.:]+)/g);
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

async function getCandidates() {
  const candidates = new Map();

  console.log('[INFO] 正在获取 Proxifly HTTPS 代理列表...');
  const httpsList = await fetchJson(PROXIFLY_HTTPS_URL);
  if (Array.isArray(httpsList)) {
    for (const item of httpsList) {
      if (item.proxy) {
        candidates.set(item.proxy, {
          proxy: item.proxy,
          geolocation: item.geolocation || {},
          anonymity: item.anonymity || '',
          score: item.score || 0
        });
      }
    }
  }

  console.log('[INFO] 正在获取 Proxifly 综合列表作为补充...');
  const allList = await fetchJson(PROXIFLY_ALL_URL);
  if (Array.isArray(allList)) {
    for (const item of allList) {
      const isHttps = item.https === true || item.protocol === 'https';
      const isSslPort = [443, 8443, 2053, 2083, 2087, 2096].includes(item.port);
      if ((isHttps || isSslPort) && item.proxy && item.proxy.startsWith('https://')) {
        if (!candidates.has(item.proxy)) {
          candidates.set(item.proxy, {
            proxy: item.proxy,
            geolocation: item.geolocation || {},
            anonymity: item.anonymity || '',
            score: item.score || 0
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

  console.log(`[INFO] 汇集去重后候选 HTTPS 代理总数: ${candidates.size}`);
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
    if (privacy.is_abuser || exit.is_abuser) return null;
    if (privacy.is_bogon || exit.is_bogon) return null;

    let purityScore = 100;
    const isDatacenter = exit.is_datacenter ?? true;
    if (!isDatacenter) purityScore += 50;
    if (!privacy.is_proxy) purityScore += 20;
    if (!privacy.is_vpn) purityScore += 15;
    if (!privacy.is_tor) purityScore += 25;
    if (!privacy.is_hosting) purityScore += 15;
    if (candidate.anonymity === 'elite') purityScore += 20;
    else if (candidate.anonymity === 'anonymous') purityScore += 10;

    return {
      proxy: proxyUrl,
      country,
      responseTime: Math.round(responseTime),
      is_datacenter: isDatacenter,
      purity_score: purityScore,
      city: exit.city || '',
      isp: exit.asn?.name || ''
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
  console.log('开始执行 Edgetunnel 链式 HTTPS 代理更新');
  console.log(`目标地区: ${TARGET_COUNTRIES.join(', ')} (各 ${PROXIES_PER_COUNTRY} 个)`);
  console.log(`优选域名: ${CF_DOMAIN}`);
  console.log('='.repeat(60));

  const candidates = await getCandidates();
  if (candidates.length === 0) {
    console.error('[ERROR] 未获取到候选代理');
    process.exit(1);
  }

  const targetSet = new Set(TARGET_COUNTRIES);
  const prioritized = [];
  const others = [];

  for (const c of candidates) {
    const geo = (c.geolocation?.country || '').toUpperCase();
    if (targetSet.has(geo) || c.from_history) {
      prioritized.push(c);
    } else {
      others.push(c);
    }
  }

  const testQueue = [...prioritized, ...others.slice(0, 100)];
  console.log(`[INFO] 即将对 ${testQueue.length} 个候选代理进行连通性与纯净度测试 (并发: ${MAX_CONCURRENCY})...`);

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
      console.log(`  [PASS] [${res.country}] ${res.proxy} - 延迟: ${res.responseTime}ms | 纯净度: ${res.purity_score} | 类型: ${dcLabel} | ISP: ${res.isp}`);
    }
  }, () => {
    return TARGET_COUNTRIES.every(c => verified[c].length >= (PROXIES_PER_COUNTRY + 2));
  });

  console.log(`[INFO] 测试完成。共检测 ${testedCount} 个，有效且匹配目标国家节点数: ${passedCount}`);

  const lines = [
    `# Edgetunnel 优选节点列表 - 自动生成于 ${new Date().toISOString()}`
  ];

  let totalWritten = 0;
  for (const country of TARGET_COUNTRIES) {
    const nodes = verified[country] || [];
    nodes.sort((a, b) => {
      const effA = a.responseTime - (a.is_datacenter ? 0 : 500);
      const effB = b.responseTime - (b.is_datacenter ? 0 : 500);
      if (b.purity_score !== a.purity_score) {
        return b.purity_score - a.purity_score;
      }
      return effA - effB;
    });

    const topNodes = nodes.slice(0, PROXIES_PER_COUNTRY);
    for (const n of topNodes) {
      lines.push(`${CF_DOMAIN}#${country} 链式HTTPS代理$${n.proxy}`);
      totalWritten++;
    }
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n', 'utf-8');
  console.log(`[INFO] 已生成优选代理文件: ${OUTPUT_FILE} (共 ${totalWritten} 个节点)`);

  // 如果在 GitHub Actions 环境中，写入漂亮的汇总表格
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      const summaryLines = [
        '## 🚀 Edgetunnel 链式 HTTPS 优选代理每日更新报告',
        '',
        `- **更新时间**: \`${new Date().toISOString()}\``,
        `- **优选域名**: \`${CF_DOMAIN}\``,
        `- **筛选指标**: 真实出口为 TW, SG, HK, JP, US；纯净度优先，延迟最低`,
        '',
        '| 国家/地区 | 优选配置行 | 延迟 (ms) | 类型 | 纯净度 | 运营商 / ISP |',
        '| :---: | :--- | :---: | :---: | :---: | :--- |'
      ];

      for (const country of TARGET_COUNTRIES) {
        const nodes = (verified[country] || []).slice(0, PROXIES_PER_COUNTRY);
        if (nodes.length === 0) {
          summaryLines.push(`| **${country}** | *(今日未获取到存活节点)* | - | - | - | - |`);
        }
        for (const n of nodes) {
          const typeLabel = n.is_datacenter ? '🏢 机房' : '🏠 家宽';
          summaryLines.push(
            `| **${country}** | \`${CF_DOMAIN}#${country} 链式HTTPS代理$${n.proxy}\` | \`${n.responseTime}\` | ${typeLabel} | \`${n.purity_score}\` | ${n.isp || '未知'} |`
          );
        }
      }

      summaryLines.push('', '> 提示：已将结果推送至 `proxies.txt`，可通过 GitHub Pages 或 Raw 链接导入 Edgetunnel。');
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
