import { sharedResourceMatches } from './base-store.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

import { appendAutomationLog, BASE_WRITE_LOCK_FILE, reviewedBaseNote, waitForReadback, withFileLock, getRecord, updateRecord } from './run-state.mjs';
import { isAuditEligible } from './collect-submitted.mjs';
import { dofollowForLinks, sameSiteDomain } from './verify-submitted.mjs';
import { assertArtifactIdentity, assertNoTargetOverrides, getKitConfig } from './kit-config.mjs';

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

const input = process.argv[2];
const applyConfirmed = process.argv.includes('--confirmed');
const appendPending = process.argv.includes('--append-pending-notes');

function firstUrl(value) {
  const text = String(value || '');
  const markdown = text.match(/\[[^\]]*]\((https?:\/\/[^)]+)\)/);
  if (markdown) return markdown[1];
  return text.match(/https?:\/\/[^\s)\]]+/)?.[0] || text;
}

function resolveTarget(kit) {
  return { baseToken: kit.base.baseToken, tableId: kit.base.tableId };
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function normalizedCandidateDomain(url) {
  return domainOf(firstUrl(url));
}

function isTargetHost(host, kit = getKitConfig()) {
  const target = new URL(kit.website).hostname.toLowerCase().replace(/^www\./, '');
  const normalized = host.toLowerCase().replace(/^www\./, '');
  return normalized === target || normalized.endsWith(`.${target}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function auditRunId(audit) {
  return `public-audit-${sha256(stableJson(audit))}`;
}

export function auditEvent(recordId) {
  return `public-audit:${sha256(String(recordId)).slice(0, 20)}`;
}

function auditLinks(item) {
  const redirectUrls = (item.links || []).flatMap((link) => link?.redirect_evidence
    ? [link.href, link.redirect_evidence.destination?.url]
    : []);
  const values = [
    ...redirectUrls,
    item.myurl,
    ...(item.links || []).flatMap((link) => link ? [link.href, link.redirect_evidence?.destination?.url] : []),
    ...(item.checks || []).flatMap((check) => [check.finalUrl, check.url]),
    ...(item.evidence || []).map((evidence) => evidence.url),
    item.record?.website,
  ];
  return [...new Set(values.filter((value) => typeof value === 'string' && /^https?:\/\//i.test(value)))]
    .slice(0, Math.max(5, redirectUrls.length));
}

function jsonForAutomationLog(value) {
  const json = JSON.stringify(value);
  let inString = false;
  let escaped = false;
  let output = '';
  for (const char of json) {
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }
    output += /\s/u.test(char) ? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}` : char;
  }
  return output;
}

export function auditLogDetail(item, category, audit, kit = getKitConfig()) {
  const checks = Array.isArray(item.checks) ? item.checks : [];
  const reportAt = typeof audit.generatedAt === 'string' && Number.isFinite(Date.parse(audit.generatedAt))
    ? audit.generatedAt
    : null;
  const evidenceLink = category === 'confirmed'
    ? (item.links || []).find((link) => isTargetHost(domainOf(link.href), kit)
      || isTargetHost(domainOf(link.redirect_evidence?.destination?.url), kit))
    : null;
  const relEvidence = evidenceLink
    ? (typeof evidenceLink.rel === 'string' ? (evidenceLink.rel || 'none') : 'unknown')
    : null;
  const browserEvidence = audit.method === 'browser-fallback' ? item.browser_evidence : null;
  const linkEvidence = (item.links || []).filter((link) => link && typeof link === 'object').map((link) => ({
    href: link.href,
    rel: typeof link.rel === 'string' ? link.rel : null,
    ...(link.redirect_evidence ? { redirect_evidence: link.redirect_evidence } : {}),
  }));
  const siteAccess = browserEvidence
    ? 'browser_confirmed'
    : Array.isArray(item.checks) ? (checks.length ? 'attempted' : 'not_attempted') : 'unknown';
  const reasons = [
    item.reason,
    browserEvidence ? `browser_tab=${browserEvidence.tab_id} browser_url=${browserEvidence.url} observed_at=${browserEvidence.observed_at}` : null,
    evidenceLink ? `confirmed_href=${evidenceLink.href}` : null,
    evidenceLink ? `rel=${relEvidence}` : null,
    evidenceLink ? `dofollow=${item.dofollow || 'unknown'}` : null,
  ]
    .filter(Boolean)
    .join('; ');
  const checkSummary = checks.slice(0, 5).map((check) => {
    const url = check.finalUrl || check.url || 'unknown-url';
    const result = check.blockType || check.error || check.status || 'unknown-result';
    return `${url}(${result})`;
  }).join(';');
  return [
    `result=${category}`,
    reportAt ? `report_at=${reportAt}` : null,
    `site_access=${siteAccess}`,
    `checks=${browserEvidence ? 'browser-evidence' : Array.isArray(item.checks) ? checks.length : 'unknown'}`,
    checkSummary ? `check_evidence=${checkSummary}` : null,
    `links=${auditLinks(item).join(',') || 'none'}`,
    linkEvidence.length ? `link_evidence=${jsonForAutomationLog(linkEvidence)}` : null,
    reasons ? `reason=${reasons}` : null,
  ].filter(Boolean).join(' ');
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
    || a === 0
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
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

function publicHttpUrlBasic(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    const decodedPathname = decodeURIComponent(parsed.pathname);
    if (/\b(dashboard|account|admin|auth|login|signin|sign-in|sso|oauth|authorize|authentication|submit|my-products|preview|draft|queue)\b/i.test(decodedPathname)) return false;
    if (/^(auth|account|accounts|login|signin|sso)([.-]|$)/i.test(parsed.hostname)) return false;
    const host = normalizeIpHost(parsed.hostname);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (isPrivateIpAddress(host)) return false;
    return true;
  } catch {
    return false;
  }
}

async function publicHttpUrl(url) {
  try {
    if (!publicHttpUrlBasic(url)) return false;
    const parsed = new URL(url);
    const host = normalizeIpHost(parsed.hostname);
    if (isIP(host)) return true;
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.some((entry) => isPrivateIpAddress(entry.address))) return false;
    return true;
  } catch {
    return false;
  }
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function sameUrl(left, right) {
  try { return new URL(left).href === new URL(right).href; } catch { return false; }
}

function validBrowserEvidence(evidence) {
  return Boolean(
    evidence && evidence.provider === 'chrome'
    && typeof evidence.tab_id === 'string' && evidence.tab_id.trim()
    && publicHttpUrlBasic(evidence.url)
    && validIsoTimestamp(evidence.observed_at),
  );
}

function resolveAnchorHref(href, myurl) {
  try { return new URL(href, myurl).href; } catch { return ''; }
}

function validateRedirectEvidence(link, item, kit) {
  const evidence = link.redirect_evidence;
  const source = evidence?.source;
  const destination = evidence?.destination;
  const browserEvidence = item.browser_evidence;
  if (!source || !destination) return 'redirect evidence must include source and destination';
  if (source.href !== link.href) return 'redirect source href does not match the original anchor href';
  if (source.myurl !== item.myurl) return 'redirect source myurl does not match the audited myurl';
  if (source.tab_id !== browserEvidence.tab_id || source.observed_at !== browserEvidence.observed_at) {
    return 'redirect source tab and observed_at must match the audited Chrome evidence';
  }
  if (typeof link.href !== 'string' || !link.href.trim()) return 'redirect source href is missing';
  const sourceUrl = resolveAnchorHref(link.href, item.myurl);
  if (!sourceUrl || !publicHttpUrlBasic(sourceUrl)) return 'redirect source href is not a public HTTP URL';
  const sourceWithoutFragment = new URL(sourceUrl);
  const listingWithoutFragment = new URL(item.myurl);
  sourceWithoutFragment.hash = '';
  listingWithoutFragment.hash = '';
  if (sourceWithoutFragment.href === listingWithoutFragment.href) {
    return 'redirect source href only changes the audited page fragment';
  }
  if (destination.provider !== 'chrome' || typeof destination.tab_id !== 'string' || !destination.tab_id.trim()) {
    return 'redirect destination must be observed in a Chrome tab';
  }
  if (destination.tab_id !== source.tab_id) {
    const openedFrom = destination.opened_from;
    if (!openedFrom
        || openedFrom.href !== source.href
        || openedFrom.myurl !== source.myurl
        || openedFrom.tab_id !== source.tab_id
        || openedFrom.observed_at !== source.observed_at) {
      return 'new-tab redirect destination must bind to the source href, myurl, tab, and observed_at';
    }
  }
  if (!validIsoTimestamp(destination.observed_at)
      || Date.parse(destination.observed_at) < Date.parse(source.observed_at)) {
    return 'redirect destination requires a valid observed_at at or after the source observation';
  }
  if (!publicHttpUrlBasic(destination.url)) return 'redirect destination is not a public non-login HTTP URL';
  if (!isTargetHost(domainOf(destination.url), kit)) return `redirect destination does not match ${new URL(kit.website).hostname}`;
  return null;
}

export function candidateSiteMismatch(item, current) {
  const reportDomain = normalizedCandidateDomain(item?.record?.website);
  const currentDomain = normalizedCandidateDomain(current?.website);
  if (!reportDomain) return 'report candidate website is missing or invalid';
  if (!currentDomain) return 'current Base website is missing or invalid';
  if (!sameUrl(firstUrl(item.record.website), firstUrl(current.website))) return 'report candidate URL does not match the current Base candidate';
  if (reportDomain !== currentDomain) return `report candidate domain ${reportDomain} does not match current Base domain ${currentDomain}`;
  return null;
}

export function reviewedAuditNote(item, current) {
  const note = reviewedBaseNote(item.base_note);
  if (!item.record || !Object.hasOwn(item.record, 'notes')
    || !(item.record.notes === null || typeof item.record.notes === 'string')) {
    throw new Error('record.notes must contain the notes snapshot used for review (null if empty).');
  }
  if ((item.record.notes ?? '') !== (current.notes ?? '')) {
    throw new Error('Base notes changed since review; read and review them again before replacing.');
  }
  if (!Array.isArray(item.record.status) || !item.record.status.every(value => typeof value === 'string')) throw new Error('record.status must contain the reviewed status snapshot.');
  if (JSON.stringify(item.record.status) !== JSON.stringify(current.status)) throw new Error('Base status changed since review; read and review the record again.');
  if (!Object.hasOwn(item.record,'link_type') || !Object.hasOwn(item.record,'myurl')) throw new Error('record.link_type and record.myurl snapshots are required.');
  if ((item.record.link_type ?? null) !== (current.link_type ?? null)) throw new Error('Base link_type changed since review.');
  const oldUrl = item.record.myurl ? firstUrl(item.record.myurl) : null;
  const currentUrl = current.myurl ? firstUrl(current.myurl) : null;
  if (oldUrl !== currentUrl) throw new Error('Base myurl changed since review.');
  return note;
}

export function getCurrent(target, recordId) {
  return getRecord(target, recordId);
}

export function assertConfirmedReadback(current, expected) {
  if (!current.status.some((value) => ['已验证：dofollow', '已验证：nofollow', '已验证：nolink'].includes(value))) throw new Error('confirmed writeback status mismatch');
  if (current.myurl !== expected.myurl) throw new Error('confirmed writeback myurl mismatch');
  const expectedType = expected.link_type || ({Yes:'dofollow', No:'nofollow'})[expected.dofollow];
  if (current.link_type !== expectedType || !current.status.includes(`已验证：${expectedType}`)) throw new Error('confirmed writeback link_type/status mismatch');
  if (current.notes !== expected.notes) throw new Error('confirmed writeback notes mismatch');
  if (current.date !== expected.date) throw new Error('confirmed writeback date mismatch');
  if (expected.automation_state && current.automation_state !== expected.automation_state) throw new Error('confirmed writeback automation_state mismatch');
  if (Object.hasOwn(expected, 'blocker_type') && current.blocker_type !== expected.blocker_type) throw new Error('confirmed writeback blocker_type mismatch');
  if (current.automation_log !== expected.automation_log) throw new Error('confirmed writeback automation_log mismatch');
}

export function assertPendingReadback(current, expected) {
  if (current.notes !== expected.notes) throw new Error('pending note writeback mismatch');
  if (current.date !== expected.date) throw new Error('pending date writeback mismatch');
  if (current.automation_log !== expected.automation_log) throw new Error('pending automation_log writeback mismatch');
  if (expected.status && !current.status.includes(expected.status)) throw new Error('pending status writeback mismatch');
}

export function manualReviewCompletionPatch(current) {
  return current.automation_state === 'manual_review'
    && current.blocker_type === 'submit_unknown'
    && ['submit_click_started', 'submit_result_recorded'].includes(current.checkpoint)
    ? { automation_state: 'submitted', blocker_type: null }
    : {};
}

export async function validateConfirmed(item, { browserFallback = false, kit = getKitConfig() } = {}) {
  if (!item.record || typeof item.record.record_id !== 'string' || !item.record.record_id) return 'missing record_id';
  if (!normalizedCandidateDomain(item.record.website)) return 'missing or invalid candidate website';
  if (item.category !== 'confirmed') return 'category is not confirmed';
  if (browserFallback) {
    const evidence = item.browser_evidence;
    if (
      !validBrowserEvidence(evidence)
      || !sameUrl(evidence.url, item.myurl)
    ) return 'browser confirmation requires Chrome tab, matching URL, and ISO observed_at evidence';
  }
  if (!sharedResourceMatches(item.record.website, item.myurl)) return 'Chrome listing does not belong to the candidate resource';
  const links = Array.isArray(item.links) ? item.links : [];
  if (!browserFallback && links.some((link) => link?.redirect_evidence)) return 'redirect evidence requires browser-fallback';
  const validMyurl = browserFallback ? publicHttpUrlBasic(item.myurl) : await publicHttpUrl(item.myurl);
  if (!validMyurl) return 'myurl is not a public HTTP listing URL';
  if (item.link_type === 'nolink') {
    if (item.dofollow !== undefined && item.dofollow !== null && item.dofollow !== '') return 'nolink contradicts dofollow';
    const product = item.product_evidence;
    if (!browserFallback || product?.name !== kit.name || typeof product.visible_text !== 'string'
      || !product.visible_text.toLowerCase().includes(kit.name.toLowerCase()) || product.outbound_links_checked !== true) {
      return 'nolink requires matching public product text and an explicit outbound-link check';
    }
    if (links.some(link => isTargetHost(domainOf(link.href), kit) || link.redirect_evidence)) return 'nolink contradicts target link evidence';
    return null;
  }
  const dofollow = item.dofollow ?? ({dofollow:'Yes', nofollow:'No'})[item.link_type];
  if (!['Yes', 'No'].includes(dofollow)) return 'dofollow must be Yes or No';
  if (item.link_type && item.link_type !== (dofollow === 'Yes' ? 'dofollow' : 'nofollow')) return 'link_type contradicts dofollow';
  const targetLinks = [];
  for (const link of links) {
    if (!link || typeof link.href !== 'string') continue;
    if (link.redirect_evidence) {
      const redirectError = validateRedirectEvidence(link, item, kit);
      if (redirectError) return redirectError;
      targetLinks.push(link);
      continue;
    }
    const validLink = browserFallback ? publicHttpUrlBasic(link.href) : await publicHttpUrl(link.href);
    if (validLink && isTargetHost(domainOf(link.href), kit)) targetLinks.push(link);
  }
  if (!targetLinks.length) return `missing real ${new URL(kit.website).hostname} evidence link`;
  if (targetLinks.some((link) => typeof link.rel !== 'string')) return 'target-domain link evidence is missing explicit rel values';
  if (dofollowForLinks(targetLinks) !== dofollow) {
    return 'dofollow does not match the recorded link rel evidence';
  }
  return null;
}

export function validatePending(item, { browserFallback = false } = {}) {
  if (!item.record || typeof item.record.record_id !== 'string' || !item.record.record_id) return 'missing record_id';
  if (!['pending', 'needs_attention', 'ambiguous'].includes(item.category || 'pending')) return 'category is not an auditable check result';
  const candidateDomain = normalizedCandidateDomain(item.record.website);
  if (!candidateDomain) return 'missing or invalid candidate website';
  const evidence = item.browser_evidence;
  if (!browserFallback || !validBrowserEvidence(evidence)) return 'Chrome tab, URL, and ISO observed_at evidence are required';
  if (!sharedResourceMatches(item.record.website, evidence.url)) return 'browser evidence URL does not match the candidate resource';
  if (normalizedCandidateDomain(evidence.url) !== candidateDomain) return 'browser evidence URL does not match the report candidate domain';
  return null;
}

function assertUniqueAuditRecords(audit) {
  const seen = new Set();
  const items = [
    ...(audit.confirmed || []),
    ...(audit.pending || []),
    ...(audit.needsAttention || []),
    ...(audit.ambiguous || []),
  ];
  for (const item of items) {
    const recordId = item?.record?.record_id;
    if (!recordId) continue;
    if (seen.has(recordId)) throw new Error(`Audit report contains duplicate record_id: ${recordId}`);
    seen.add(recordId);
  }
}

function runUpdate(target, recordId, patch, expected) {
  return updateRecord(target, recordId, patch, 'Audit', expected);
}

async function applyAudit(audit, kit) {
  const target = resolveTarget(kit);
  const browserFallback = audit.method === 'browser-fallback';
  const runId = auditRunId(audit);
  let updated = 0;

  if (applyConfirmed) {
    for (const item of audit.confirmed || []) {
      if (!browserFallback) {
        console.log(`skip-browser-evidence ${item.record?.record_id || 'unknown'} browser DOM confirmation is required before marking success`);
        continue;
      }
      const validationError = await validateConfirmed(item, { browserFallback, kit });
      if (validationError) {
        console.log(`skip-invalid ${item.record?.record_id || 'unknown'} ${validationError}`);
        continue;
      }
      const current = getCurrent(target, item.record.record_id);
      const siteMismatch = candidateSiteMismatch(item, current);
      if (siteMismatch) {
        console.log(`skip-site-mismatch ${item.record.record_id} ${siteMismatch}`);
        continue;
      }
      if (!sameSiteDomain(current.website, item.myurl) || !sharedResourceMatches(current.website, item.myurl)) {
        console.log(`skip-site-mismatch ${item.record.record_id} ${current.website} ${item.myurl}`);
        continue;
      }
      if (!isAuditEligible(current)) {
        console.log(`skip-current-status ${item.record.record_id} ${current.status.join(',')}`);
        continue;
      }
      const now = new Date();
      const patch = {
        status: 'succeed',
        myurl: item.myurl,
        link_type: item.link_type || (item.dofollow === 'Yes' ? 'dofollow' : 'nofollow'),
        automation_log: appendAutomationLog(current.automation_log, {
          runId,
          event: auditEvent(item.record.record_id),
          detail: auditLogDetail(item, 'confirmed', audit, kit),
          now,
        }),
      };
      if (patch.automation_log === current.automation_log) {
        console.log(`skip-duplicate ${item.record.record_id} confirmed`);
        continue;
      }
      try {
        patch.notes = reviewedAuditNote(item, current);
      } catch (error) {
        console.log(`skip-invalid-note ${item.record.record_id} ${error.message}`);
        continue;
      }
      Object.assign(patch, manualReviewCompletionPatch(current));
      const readback = runUpdate(target, item.record.record_id, patch, current);
      assertConfirmedReadback(readback, { ...patch, date: current.date });
      updated += 1;
      console.log(`confirmed ${item.record.record_id}`);
    }
  }

  if (appendPending) {
    const checks = [
      ...(audit.pending || []),
      ...(audit.needsAttention || []).map((item) => ({ ...item, category: 'needs_attention' })),
      ...(audit.ambiguous || []).map((item) => ({ ...item, category: 'ambiguous' })),
    ];
    for (const item of checks) {
      const validationError = validatePending(item, { browserFallback });
      if (validationError) {
        console.log(`skip-invalid ${item.record?.record_id || 'unknown'} ${validationError}`);
        continue;
      }
      const current = getCurrent(target, item.record.record_id);
      const siteMismatch = candidateSiteMismatch(item, current);
      if (siteMismatch) {
        console.log(`skip-site-mismatch ${item.record.record_id} ${siteMismatch}`);
        continue;
      }
      if (!isAuditEligible(current)) {
        console.log(`skip-current-status ${item.record.record_id} ${current.status.join(',')}`);
        continue;
      }
      const category = item.category || 'pending';
      const now = new Date();
      const nextPatch = {
        ...(category === 'pending' ? { status: '已验证：未找到记录' } : {}),
        automation_log: appendAutomationLog(current.automation_log, {
          runId,
          event: auditEvent(item.record.record_id),
          detail: auditLogDetail(item, category, audit, kit),
          now,
        }),
      };
      if (nextPatch.automation_log === current.automation_log) {
        console.log(`skip-duplicate ${item.record.record_id} ${category}`);
        continue;
      }
      try {
        nextPatch.notes = reviewedAuditNote(item, current);
      } catch (error) {
        console.log(`skip-invalid-note ${item.record.record_id} ${error.message}`);
        continue;
      }
      const readback = runUpdate(target, item.record.record_id, nextPatch, current);
      assertPendingReadback(readback, { ...nextPatch, date: current.date });
      updated += 1;
      console.log(`audit-note ${item.record.record_id} ${category}`);
    }
  }

  console.log(JSON.stringify({ updated }, null, 2));
}

async function main() {
  assertNoTargetOverrides();
  const kit = getKitConfig();
  const audit = JSON.parse(await readFile(input, 'utf8'));
  assertUniqueAuditRecords(audit);
  assertArtifactIdentity(audit, kit);
  if (audit.method !== 'browser-fallback') {
    throw new Error('HTTP verifier reports are screening only; Chrome DOM evidence is required for every Base writeback.');
  }
  await withFileLock(BASE_WRITE_LOCK_FILE, () => applyAudit(audit, kit));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  if (!input || (!applyConfirmed && !appendPending)) {
    console.error('Usage: node apply-submitted-updates.mjs <audit.json> [--confirmed] [--append-pending-notes]');
    process.exitCode = 2;
  } else {
    main().catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
  }
}
