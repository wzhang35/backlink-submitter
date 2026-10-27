import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { dirname, join } from 'node:path';

import {
  BASE_WRITE_LOCK_FILE,
  CIRCUIT_FILE,
  circuit403Domains,
  isCircuit403Blocked,
  normalizeCircuitDomain,
  readCircuit,
  updateCircuit,
  withFileLock,
  writeCircuit,
} from './run-state.mjs';
import { assertArtifactIdentity, assertNoTargetOverrides, getKitConfig, runtimePaths, targetIdentity } from './kit-config.mjs';

const runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const auditDate = runStamp.slice(0, 10);
const urlRe = /https?:\/\/[^\s)\]]+/g;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nonPublicIpv6Ranges = new BlockList();
for (const [subnet, prefix] of [
  ['::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['64:ff9b:1::', 48],
  ['100:0:0:1::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['3fff::', 20],
  ['5f00::', 16],
  ['100::', 64],
  ['ff00::', 8],
]) nonPublicIpv6Ranges.addSubnet(subnet, prefix, 'ipv6');

function unique(values) {
  return [...new Set(values.filter(Boolean).map((v) => v.replace(/[.,;，；。]+$/, '')))];
}

function domainOf(url) {
  return normalizeCircuitDomain(url);
}

function blockedDomainResult(url, blockedDomains) {
  const domain = domainOf(url);
  if (!domain || !blockedDomains?.has(domain)) return null;
  return {
    ok: false,
    status: 0,
    finalUrl: url,
    text: '',
    error: `Skipped request to batch-blocked domain ${domain}.`,
    blocked: true,
    batchBlockedDomain: domain,
  };
}

export function sameSiteDomain(left, right) {
  const leftDomain = domainOf(left);
  const rightDomain = domainOf(right);
  if (Boolean(leftDomain) && leftDomain === rightDomain) return true;
  try {
    return leftDomain === 'community.sanity.tools'
      && rightDomain === 'sanity.io'
      && new URL(right).pathname.startsWith('/exchange/community/');
  } catch {
    return false;
  }
}

function isTargetHost(host, kit = getKitConfig()) {
  const normalized = host.toLowerCase().replace(/^www\./, '');
  const target = new URL(kit.website).hostname.toLowerCase().replace(/^www\./, '');
  return normalized === target || normalized.endsWith(`.${target}`);
}

function normalizeIpHost(host) {
  return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    // IANA lists 192.0.0.9 and .10 as globally reachable exceptions.
    || (a === 192 && b === 0 && c === 0 && parts[3] !== 9 && parts[3] !== 10)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 0)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || (a >= 224);
}

function mappedIpv6ToIpv4(host) {
  if (!host.startsWith('::ffff:')) return null;
  const rest = host.slice('::ffff:'.length);
  if (rest.includes('.')) return rest;
  const parts = rest.split(':').map((part) => Number.parseInt(part || '0', 16));
  if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  return `${parts[0] >> 8}.${parts[0] & 255}.${parts[1] >> 8}.${parts[1] & 255}`;
}

function isPrivateIpAddress(address) {
  const host = normalizeIpHost(address);
  const mappedIpv4 = mappedIpv6ToIpv4(host);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  const ipType = isIP(host);
  if (ipType === 4) return isPrivateIpv4(host);
  if (ipType === 6) return nonPublicIpv6Ranges.check(host, 'ipv6');
  return false;
}

function assertPublicHttpUrlBasic(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Refusing non-HTTP URL: ${url}`);
  const host = normalizeIpHost(parsed.hostname);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error(`Refusing local hostname: ${url}`);
  if (isPrivateIpAddress(host)) throw new Error(`Refusing private IP URL: ${url}`);
  return parsed.href;
}

async function assertPublicHttpUrl(url) {
  const href = assertPublicHttpUrlBasic(url);
  const host = normalizeIpHost(new URL(href).hostname);
  if (!isIP(host)) {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.some((entry) => isPrivateIpAddress(entry.address))) {
      throw new Error(`Refusing hostname that resolves to a private IP: ${url}`);
    }
  }
  return href;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function attr(tag, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(re);
  return decodeEntities(match?.[2] || match?.[3] || match?.[4] || '');
}

export function anchors(html, baseUrl) {
  const visibleHtml = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript|textarea|title|xmp|iframe|noembed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<plaintext\b[^>]*>[\s\S]*$/i, '');
  return [...visibleHtml.matchAll(/<a\b[^>]*>/gi)].map((match) => {
    const href = attr(match[0], 'href');
    if (!href) return null;
    try {
      return { href: new URL(href, baseUrl).href, rel: attr(match[0], 'rel') };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function targetLinks(html, baseUrl) {
  return anchors(html, baseUrl).filter((a) => isTargetHost(domainOf(a.href)));
}

export function dofollowForLinks(links) {
  if (!links.length) return null;
  return links.some((link) => !/\b(nofollow|ugc|sponsored)\b/.test(String(link.rel || '').toLowerCase())) ? 'Yes' : 'No';
}

function internalProductCandidates(html, baseUrl, host, kit = getKitConfig()) {
  const productSlug = kit.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || domainOf(kit.website);
  return unique(anchors(html, baseUrl)
    .filter((a) => domainOf(a.href) === host && a.href.toLowerCase().includes(productSlug))
    .map((a) => a.href))
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

function scoreCandidate(url) {
  let score = 0;
  if (!/[?&#]/.test(url)) score += 3;
  if (/\/(tool|tools|project|product|startup|item|profile|software)\//i.test(url)) score += 2;
  if (/search|query|q=|s=/.test(url)) score -= 2;
  if (/#$/.test(url)) score -= 3;
  return score;
}

async function fetchText(url, { circuitPath = CIRCUIT_FILE, blockedDomains } = {}) {
  const initialBlock = blockedDomainResult(url, blockedDomains);
  if (initialBlock) return initialBlock;
  let currentUrl;
  try {
    currentUrl = await assertPublicHttpUrl(url);
  } catch (error) {
    return { ok: false, status: 0, finalUrl: url, text: '', error: String(error?.message || error), blocked: true };
  }
  const requestDomains = [];
  for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
    const domainBlock = blockedDomainResult(currentUrl, blockedDomains);
    if (domainBlock) return { ...domainBlock, requestDomains };
    const circuitState = await readCircuit(circuitPath);
    if (circuitState.open) {
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        text: '',
        error: `Submission circuit is open for today: ${circuitState.reason}`,
        blocked: true,
        circuitStopReason: circuitState.reason || 'global_circuit_open',
        requestDomains,
      };
    }
    const persistent403Block = blockedDomainResult(currentUrl, circuit403Domains(circuitState));
    if (persistent403Block) {
      return {
        ...persistent403Block,
        error: `Skipped request to persistent 403-blocked domain ${persistent403Block.batchBlockedDomain}.`,
        requestDomains,
      };
    }
    requestDomains.push(domainOf(currentUrl));
    const result = await fetchOnce(currentUrl);
    const location = result.headers?.get('location');
    if (![301, 302, 303, 307, 308].includes(result.status) || !location) return { ...result, requestDomains };
    const redirectUrl = new URL(location, currentUrl).href;
    const redirectBlock = blockedDomainResult(redirectUrl, blockedDomains);
    if (redirectBlock) return { ...redirectBlock, requestDomains };
    try {
      currentUrl = await assertPublicHttpUrl(redirectUrl);
    } catch (error) {
      return { ok: false, status: result.status, finalUrl: currentUrl, text: '', error: String(error?.message || error), blocked: true };
    }
  }
  return { ok: false, status: 0, finalUrl: currentUrl, text: '', error: 'Too many redirects', blocked: true };
}

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 18000);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, status: 0, finalUrl: url, text: '', error: String(error?.message || error) };
  }

  try {
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, text: (await res.text()).slice(0, 2_500_000), headers: res.headers };
  } catch (error) {
    return {
      ok: false,
      status: res.status,
      finalUrl: res.url || url,
      text: '',
      error: String(error?.message || error),
      headers: res.headers,
    };
  } finally {
    clearTimeout(timer);
  }
}

function privateOrQueueUrl(url) {
  return /\/(dashboard|account|admin|login|signin|sign-in|submit|my-products|preview|draft|queue)\b/i.test(url);
}

function noteUrls(record) {
  return unique([...(record.myurl?.match(urlRe) || []), ...(record.notes?.match(urlRe) || [])]);
}

function searchUrls(homeHtml, site, kit = getKitConfig()) {
  const urls = [];
  for (const formMatch of homeHtml.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    const form = formMatch[0];
    const action = attr(form, 'action') || site;
    const input = [...form.matchAll(/<(input|textarea)\b[^>]*>/gi)]
      .map((m) => m[0])
      .find((tag) => /\b(q|s|search|query|keyword)\b|search/i.test(`${attr(tag, 'name')} ${attr(tag, 'type')} ${attr(tag, 'placeholder')}`));
    if (!input) continue;
    try {
      const url = new URL(action, site);
      url.searchParams.set(attr(input, 'name') || 'q', kit.name);
      urls.push(url.href);
    } catch {}
  }
  const origin = originOf(site);
  const query = encodeURIComponent(kit.name);
  urls.push(`${origin}/search?q=${query}`, `${origin}/search?query=${query}`, `${origin}/?s=${query}`, `${origin}/?q=${query}`, `${origin}/tools?search=${query}`, `${origin}/tools?q=${query}`, `${origin}/projects?search=${query}`, `${origin}/projects?q=${query}`);
  return unique(urls);
}

async function inspectPage(url, { circuitPath = CIRCUIT_FILE, blockedDomains } = {}) {
  await sleep(750);
  const res = await fetchText(url, { circuitPath, blockedDomains });
  const links = res.text ? targetLinks(res.text, res.finalUrl || url) : [];
  // Cloudflare documents this header for all Challenge Pages; normal pages may also load JSD assets.
  // https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
  const cloudflareChallengeHeader = String(res.headers?.get?.('cf-mitigated') || '').trim().toLowerCase() === 'challenge';
  const challengeType = cloudflareChallengeHeader ? 'cloudflare' : classifySecurityChallenge(res.text || '');
  const blockType = res.status === 429
    ? 'rate_limit_429'
    : (challengeType || (res.status === 403 ? 'forbidden_403' : null));
  if (blockType && !res.circuitStopReason && !res.batchBlockedDomain && blockedDomains) {
    for (const domain of [domainOf(url), ...(res.requestDomains || []), domainOf(res.finalUrl)]) {
      if (domain) blockedDomains.add(domain);
    }
  }
  return {
    url,
    status: res.status,
    finalUrl: res.finalUrl || url,
    text: res.text,
    error: res.error,
    blocked: Boolean(res.error) || res.blocked || Boolean(challengeType) || [401, 403, 429].includes(res.status),
    blockType,
    circuitStopReason: res.circuitStopReason || null,
    batchBlockedDomain: res.batchBlockedDomain || null,
    requestDomains: res.requestDomains || [],
    links,
    dofollow: dofollowForLinks(links),
  };
}

export function detectSecurityChallenge(html) {
  return Boolean(classifySecurityChallenge(html));
}

export function classifySecurityChallenge(html) {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (element) => element.slice(0, element.indexOf('>') + 1));
  const cloudflareAsset = /<(?:script|iframe|link|form)\b[^>]*\b(?:src|href|action)\s*=\s*(?:"[^"]*\/cdn-cgi\/challenge-platform(?:\/[^\"]*)?"|'[^']*\/cdn-cgi\/challenge-platform(?:\/[^']*)?'|[^\s>"']*\/cdn-cgi\/challenge-platform(?:\/[^\s>"']*)?)/i.test(markup);
  const cloudflarePageMarker = /<title[^>]*>\s*just a moment\b/i.test(markup)
    || /<(?:h1|h2)\b[^>]*>\s*verify you are human\b[^<]*<\/(?:h1|h2)>/i.test(markup);
  const cloudflareActiveChallenge = /<(?:script|iframe|form)\b[^>]*\b(?:src|action)\s*=\s*(?:"[^"]*\/cdn-cgi\/challenge-platform\/h\/[a-z0-9]+\/orchestrate\/(?:chl_page|managed)\/v\d+(?:[?#][^"]*)?"|'[^']*\/cdn-cgi\/challenge-platform\/h\/[a-z0-9]+\/orchestrate\/(?:chl_page|managed)\/v\d+(?:[?#][^']*)?'|[^\s>"']*\/cdn-cgi\/challenge-platform\/h\/[a-z0-9]+\/orchestrate\/(?:chl_page|managed)\/v\d+(?:[?#][^\s>"']*)?)/i.test(markup);
  if (cloudflareAsset && cloudflarePageMarker && cloudflareActiveChallenge) return 'cloudflare';

  const captchaPrompt = /<(?:h1|h2)\b[^>]*>\s*(?:complete (?:the )?captcha|verify you are human)\b[^<]*<\/(?:h1|h2)>/i.test(markup);
  const captchaWidget = /<(?:iframe|div|script)\b[^>]*\b(?:src|id|class)\s*=\s*(?:"[^"]*(?:recaptcha|hcaptcha|captcha|cf-turnstile)[^"]*"|'[^']*(?:recaptcha|hcaptcha|captcha|cf-turnstile)[^']*')/i.test(markup);
  if (captchaPrompt && captchaWidget) return 'captcha';
  return null;
}

function cleanNotes(notes, myurl) {
  if (!notes) return null;
  const target = myurl.replace(/\/$/, '');
  const cleaned = notes
    .replace(/\[([^\]]*)]\((https?:\/\/[^)]+)\)/g, (all, label, url) => (url.replace(/\/$/, '') === target ? label.trim() : all))
    .replace(urlRe, (url) => (url.replace(/\/$/, '') === target ? '' : url))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s*[;；,，]\s*$/g, '')
    .trim();
  return cleaned || null;
}

function compact(check) {
  return {
    url: check.url,
    status: check.status,
    finalUrl: check.finalUrl,
    error: check.error,
    blocked: check.blocked,
    blockType: check.blockType,
    ...(check.circuitStopReason ? { circuitStopReason: check.circuitStopReason } : {}),
    ...(check.batchBlockedDomain ? { batchBlockedDomain: check.batchBlockedDomain } : {}),
    linkCount: check.links?.length || 0,
  };
}

function confirmed(record, check, checks) {
  return { category: 'confirmed', record, myurl: check.finalUrl, dofollow: check.dofollow, links: check.links, notes: cleanNotes(record.notes, check.finalUrl), checks: checks.map(compact) };
}

export function canConfirm(check) {
  try {
    assertPublicHttpUrlBasic(check.finalUrl);
  } catch {
    return false;
  }
  return check.status >= 200 && check.status < 400 && check.links.length > 0 && !check.blocked && !privateOrQueueUrl(check.finalUrl);
}

export async function recordPersistentCircuitEvent(event, {
  circuitPath = CIRCUIT_FILE,
  lockPath = BASE_WRITE_LOCK_FILE,
  now = new Date(),
} = {}) {
  return withFileLock(lockPath, async () => {
    const current = await readCircuit(circuitPath, now);
    const next = updateCircuit(current, event, now);
    await writeCircuit(circuitPath, next);
    return next;
  });
}

async function verifyRecord(record, kit = getKitConfig(), { circuitPath = CIRCUIT_FILE, blockedDomains } = {}) {
  const checks = [];
  const ambiguous = [];
  const needsAttention = (reason) => ({ category: 'needs_attention', record, reason, checks: checks.map(compact) });

  for (const url of noteUrls(record)
    .filter((u) => sameSiteDomain(record.website, u) && !privateOrQueueUrl(u))
    .slice(0, 2)) {
    const check = await inspectPage(url, { circuitPath, blockedDomains });
    checks.push(check);
    if (check.blocked) return needsAttention('Public verification hit a security or network block; stopped probing this domain.');
    if (canConfirm(check)) return confirmed(record, check, checks);
    if (String(check.text || '').toLowerCase().includes(kit.name.toLowerCase()) && check.status >= 200 && check.status < 400) {
      ambiguous.push({ url: check.finalUrl, reason: `Candidate page mentions ${kit.name} but no link to ${new URL(kit.website).hostname} was found.` });
    }
  }

  const site = record.website;
  const host = domainOf(site);
  const home = await inspectPage(site, { circuitPath, blockedDomains });
  checks.push(home);
  if (home.blocked) return needsAttention('Homepage verification hit a security or network block; stopped probing this domain.');
  if (canConfirm(home)) return confirmed(record, home, checks);
  const pageCandidates = [];
  for (const searchUrl of searchUrls(home.text || '', site, kit).slice(0, 2)) {
    const check = await inspectPage(searchUrl, { circuitPath, blockedDomains });
    checks.push(check);
    if (check.blocked) return needsAttention('Site search hit a security or network block; stopped probing this domain.');
    if (canConfirm(check) && scoreCandidate(check.finalUrl) > 0) return confirmed(record, check, checks);
    if (check.links.length) {
      ambiguous.push({ url: check.finalUrl, reason: `Site-search page contains a ${kit.name} link, but no stable detail page was confirmed.` });
    }
    pageCandidates.push(...internalProductCandidates(check.text || '', searchUrl, host, kit));
  }

  for (const url of unique(pageCandidates).slice(0, 2)) {
    if (privateOrQueueUrl(url)) continue;
    const check = await inspectPage(url, { circuitPath, blockedDomains });
    checks.push(check);
    if (check.blocked) return needsAttention('Candidate listing hit a security or network block; stopped probing this domain.');
    if (canConfirm(check)) return confirmed(record, check, checks);
    if (String(check.text || '').toLowerCase().includes(kit.name.toLowerCase()) && check.status >= 200 && check.status < 400) {
      ambiguous.push({ url: check.finalUrl, reason: `Discovered page mentions ${kit.name} but no link to ${new URL(kit.website).hostname} was found.` });
    }
  }

  if (ambiguous.length) {
    return {
      category: 'ambiguous',
      record,
      reason: ambiguous[0].reason,
      evidence: ambiguous,
      checks: checks.map(compact),
    };
  }

  const blocked = checks.some((check) => check.blocked || check.error);
  return {
    category: blocked ? 'needs_attention' : 'pending',
    record,
    reason: blocked ? 'Public automated verification was blocked or errored.' : `No public ${kit.name} listing with a link to ${new URL(kit.website).hostname} was found.`,
    checks: checks.map(compact),
  };
}

export async function verifyRecords(records, kit = getKitConfig(), {
  circuitPath = CIRCUIT_FILE,
  lockPath = BASE_WRITE_LOCK_FILE,
} = {}) {
  const results = [];
  const blockedDomains = new Set();
  let persistentCircuit = { open: false, reason: null };
  let circuit = { stopReason: null };
  for (const record of records) {
    persistentCircuit = await readCircuit(circuitPath);
    if (persistentCircuit.open) circuit.stopReason = persistentCircuit.reason;
    if (circuit.stopReason) {
      results.push({
        category: 'needs_attention',
        record,
        reason: `Audit stopped before navigation by global safety circuit: ${circuit.stopReason}.`,
        checks: [],
      });
      continue;
    }
    for (const domain of circuit403Domains(persistentCircuit)) blockedDomains.add(domain);
    const candidateDomain = domainOf(record.website);
    if (isCircuit403Blocked(persistentCircuit, { domain: candidateDomain, recordId: record.record_id })) {
      results.push({
        category: 'needs_attention',
        record,
        reason: `Audit stopped before navigation for ${candidateDomain || record.record_id} after a real non-verification 403 today.`,
        checks: [],
      });
      continue;
    }
    if (candidateDomain && blockedDomains.has(candidateDomain)) {
      results.push({
        category: 'needs_attention',
        record,
        reason: `Audit stopped before navigation for ${candidateDomain} after a security block this run.`,
        checks: [],
      });
      continue;
    }
    const result = await verifyRecord(record, kit, { circuitPath, blockedDomains });
    results.push(result);
    const securityBlockedChecks = (result.checks || []).filter((check) => (
      check.blockType && !check.circuitStopReason && !check.batchBlockedDomain
    ));
    const blockType = securityBlockedChecks[0]?.blockType;
    if (securityBlockedChecks.length) {
      for (const domain of [candidateDomain, ...securityBlockedChecks.flatMap((check) => [domainOf(check.url), domainOf(check.finalUrl)])]) {
        if (domain) blockedDomains.add(domain);
      }
    }
    if (blockType) {
      const blockedCheck = securityBlockedChecks.find((check) => check.blockType === blockType) || securityBlockedChecks[0];
      const responseDomain = domainOf(blockedCheck?.finalUrl || blockedCheck?.url);
      const eventDomain = blockType === 'forbidden_403' ? (responseDomain || candidateDomain) : candidateDomain;
      const event = {
        type: blockType,
        record_id: record.record_id,
        domain: eventDomain,
      };
      if (blockType === 'forbidden_403') {
        event.website_domain = candidateDomain || eventDomain;
        event.domains = [...new Set([candidateDomain, responseDomain].filter(Boolean))];
      }
      persistentCircuit = await recordPersistentCircuitEvent(
        event,
        { circuitPath, lockPath },
      );
      if (persistentCircuit.open) circuit.stopReason = persistentCircuit.reason;
    }
    const circuitStop = result.checks?.find((check) => check.circuitStopReason)?.circuitStopReason;
    if (circuitStop) {
      persistentCircuit = await readCircuit(circuitPath);
      circuit.stopReason = persistentCircuit.open ? persistentCircuit.reason : circuitStop;
    }
  }
  return { results, circuit, persistentCircuit };
}

function section(title, rows, render) {
  return [`## ${title}`, '', ...(rows.length ? rows.map(render) : ['None']), ''].join('\n');
}

export function renderScreeningReport({kit, results, stopReason = null, date = auditDate}) {
  const by = category => results.filter(row => row.category === category);
  return [
    `# ${kit.name} HTTP Backlink Screening ${date}`, '',
    '> PRIVATE: contains project routing, candidate URLs and business records. Do not publish this report.',
    '> SCREENING ONLY: HTTP matches are leads, not verified public listings. Every result requires Chrome DOM review; this report cannot be applied to Base.', '',
    `- Project: ${kit.id}`,
    `- Website: ${kit.website}`,
    `- Base: ${kit.base.wikiUrl} (table ${kit.base.tableId}, view ${kit.base.viewId || 'none'})`, '',
    `- Link candidates requiring Chrome review: ${by('confirmed').length}`,
    `- No match in HTTP checks: ${by('pending').length}`,
    `- Blocked checks: ${by('needs_attention').length}`,
    `- Ambiguous checks: ${by('ambiguous').length}`,
    `- Global safety stop: ${stopReason || 'No'}`, '',
    section('Link candidates — unverified', by('confirmed'), row => `- ${row.record.website} -> ${row.myurl} (HTTP link hint: ${row.dofollow ?? 'unknown'})`),
    section('No match in HTTP checks', by('pending'), row => `- ${row.record.website}: ${row.reason}`),
    section('Blocked checks', by('needs_attention'), row => `- ${row.record.website}: ${row.reason}`),
    section('Ambiguous checks', by('ambiguous'), row => `- ${row.record.website}: ${row.reason}`),
  ].join('\n');
}

async function main() {
  assertNoTargetOverrides();
  const kit = getKitConfig();
  const paths = runtimePaths(kit);
  const input = process.argv[2] || paths.candidatesFile;
  const outJson = join(paths.projectDir, `backlink-submitted-audit-${runStamp}.json`);
  const outMd = join(paths.projectDir, `backlink-submitted-audit-${runStamp}.md`);
  const inputData = JSON.parse(await readFile(input, 'utf8'));
  assertArtifactIdentity(inputData, kit);
  const { results, circuit } = await verifyRecords(inputData.records, kit);
  for (const [index, result] of results.entries()) {
    console.error(`${index + 1}/${inputData.records.length} ${result.record.website} ${result.category}`);
  }

  const confirmedRows = results.filter((r) => r.category === 'confirmed');
  const pendingRows = results.filter((r) => r.category === 'pending');
  const attentionRows = results.filter((r) => r.category === 'needs_attention');
  const ambiguousRows = results.filter((r) => r.category === 'ambiguous');

  await mkdir(dirname(outJson), { recursive: true });
  const identity = targetIdentity(kit);
  await writeFile(outJson, JSON.stringify({ generatedAt: new Date().toISOString(), method: 'http-verifier', screening_only:true, artifact_sensitivity:'private', ...identity, target: inputData.target, source: input, globalStopReason: circuit.stopReason, confirmed: confirmedRows, pending: pendingRows, needsAttention: attentionRows, ambiguous: ambiguousRows }, null, 2));
  await writeFile(outMd, renderScreeningReport({kit,results,stopReason:circuit.stopReason}));

  console.log(JSON.stringify({ json: outJson, markdown: outMd, method:'http-verifier', screening_only:true, globalStopReason: circuit.stopReason, linkCandidates: confirmedRows.length, pending: pendingRows.length, needsAttention: attentionRows.length, ambiguous: ambiguousRows.length }, null, 2));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
