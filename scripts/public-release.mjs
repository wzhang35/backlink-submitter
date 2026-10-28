#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_REPOSITORY_URL = 'https://github.com/wzhang35/backlink-submitter';
const repositoryWrappers = new Map([['"','"'], ["'","'"], ['`','`'], ['(',')'], ['[',']'], ['{','}'], ['<','>'], ['（','）'], ['【','】']]);

function withoutPublicRepositoryReferences(content) {
  return content.replaceAll(PUBLIC_REPOSITORY_URL, (url, offset) => {
    const linePrefix = content.slice(content.lastIndexOf('\n', offset - 1) + 1, offset)
      .replaceAll(PUBLIC_REPOSITORY_URL, '');
    // Keep URI-valued text conservative, including whitespace inside opaque URIs.
    if (/\b[a-z][a-z\d+.-]*:|[/\\]{2}[^\s/\\]/i.test(linePrefix)) return url;
    let start = offset;
    while (start > 0 && !/\s/.test(content[start - 1])) start--;
    const prefix = content.slice(start, offset), opener = prefix.at(-1);
    // A reference nested in another URL or path is not the public repository.
    if (/[:/\\?#%@]/.test(prefix)) return url;
    const closer = repositoryWrappers.get(opener);
    if (prefix && !closer && opener !== '：') return url;
    let suffix = content.slice(offset + url.length);
    if (closer) {
      if (!suffix.startsWith(closer)) return url;
      suffix = suffix.slice(1);
    }
    const sentenceEnd = /^(?:$|\s|[.,;!?。，；！？、](?=$|\s))/.test(suffix);
    // Chinese prose may directly follow a closed reference: （URL），请查看。
    const proseAfterWrapper = closer && /^[，。；！？、][^\s/\\?#%@]*?(?:\s|$)/.test(suffix);
    return sentenceEnd || proseAfterWrapper ? '' : url;
  });
}
function git(args, cwd = root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|TEMPLATE_DIR|CONFIG.*)$/.test(key)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform === 'win32' ? 'NUL' : '/dev/null'});
  const result = spawnSync('git', ['-C', cwd, ...args], {encoding:'utf8',maxBuffer:32*1024*1024,env});
  if (result.status !== 0) throw new Error(result.stderr || 'Git command failed');
  return result.stdout;
}

export function privatePath(path) {
  return /^(?:tmp|output|dist|coverage|\.local|node_modules)\//.test(path)
    || /^projects\/(?!example\/kit\.json$)/.test(path)
    || /(?:^|\/)(?:\.env(?:\..*)?|credentials[^/]*|[^/]+\.(?:pem|key|p12))$/.test(path) && !path.endsWith('.env.example');
}

export function contentFindings(content, signals = []) {
  const result = [];
  try {
    const data = JSON.parse(content);
    if (data?.artifact_sensitivity === 'private' || ['http-verifier','browser-fallback'].includes(data?.method) || (data?.integrity_sha256 && data?.records)) result.push('private runtime or audit artifact');
  } catch { /* Source text is not necessarily JSON. */ }
  if (/\/(?:Users|home)\/[a-zA-Z0-9._-]+\//.test(content)) result.push('personal absolute path');
  if (/https?:\/\/[a-z0-9.-]+\.(?:feishu\.cn|larksuite\.com)\/(?:wiki|base|docx)\/[a-z0-9]+/i.test(content)) result.push('private document or Base URL');
  if (/https?:\/\/github\.com\/(?!example(?:[-/])|sample(?:[-/]))[^/\s]+\/[^/\s]+\/(?:pull|issues)\/\d+/i.test(content)) result.push('nonfictional PR or issue reference');
  if (/(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(content)) result.push('credential-like content');
  const emails = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  if (emails.some(email => !/@(?:[^@]*\.)?(?:example|invalid|test)$|@example\.(?:com|org|net)$|@localhost$/i.test(email))) result.push('nonfictional email');
  // The exact public repository URL is safe; project identity elsewhere is not.
  const lower = withoutPublicRepositoryReferences(content).toLowerCase();
  if (signals.some(signal => lower.includes(signal.toLowerCase()))) result.push('local project identity');
  return result;
}

function localSignals() {
  const signals = [];
  for (const entry of readdirSync(join(root,'projects'), {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.name === 'example') continue;
    let kit;
    try { kit = JSON.parse(readFileSync(join(root,'projects',entry.name,'kit.json'),'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('Cannot inspect local routing config; publication check stopped.'); }
    if (typeof kit.website === 'string' && /^https?:\/\/(?:[^/]+\.)?example(?:\.(?:com|org|net))?(?:\/|$)/i.test(kit.website)) continue;
    const values = [kit.id,kit.name,kit.website,kit.submissionKitUrl,kit.sourceProjectRoot,kit.profile,kit.defaultSubmitter,...Object.values(kit.base || {})];
    signals.push(...values.filter(value => typeof value === 'string' && value.length >= 4));
  }
  return [...new Set(signals)];
}

function workingFiles() {
  return [...new Set(git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean))].sort();
}

function assertNoSymlinkAncestors(path) {
  const parts = relative(root,path).split(sep);
  let current = root;
  for (const part of parts) {
    current = join(current,part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink paths are not allowed in publication inputs or destinations.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function inspectPublication({history = true} = {}) {
  const signals = localSignals(), findings = [], files = workingFiles();
  for (const path of files) {
    const location = `working tree:${path}`;
    if (privatePath(path)) { findings.push({location,reason:'private artifact path'}); continue; }
    try { assertNoSymlinkAncestors(join(root,path)); }
    catch { findings.push({location,reason:'symlink path requires review'}); continue; }
    let stat;
    try { stat = lstatSync(join(root,path)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) { findings.push({location,reason:'symlink or non-file requires review'}); continue; }
    const buffer = readFileSync(join(root,path));
    if (buffer.includes(0)) { findings.push({location,reason:'binary artifact requires review'}); continue; }
    for (const reason of contentFindings(buffer.toString('utf8'),signals)) findings.push({location,reason});
  }
  // A clean working copy does not imply the staged version is safe to commit.
  for (const line of git(['ls-files','--stage','-z']).split('\0').filter(Boolean)) {
    const [metadata,path] = line.split('\t'), [mode,id,stage] = metadata.split(' ');
    const location = `index:${path}`;
    if (privatePath(path)) { findings.push({location,reason:'private artifact path'}); continue; }
    if (stage !== '0' || !['100644','100755'].includes(mode)) { findings.push({location,reason:'unmerged or non-file index entry'}); continue; }
    const content = git(['cat-file','blob',id]);
    if (content.includes('\0')) { findings.push({location,reason:'binary artifact requires review'}); continue; }
    for (const reason of contentFindings(content,signals)) findings.push({location,reason});
  }
  if (history) {
    const seen = new Set();
    for (const commit of git(['rev-list','--all']).trim().split('\n').filter(Boolean)) {
      for (const line of git(['ls-tree','-rz','--full-tree',commit]).split('\0').filter(Boolean)) {
        const [metadata,path] = line.split('\t'), [mode,type,id] = metadata.split(' ');
        if (seen.has(`${id}:${path}`)) continue;
        seen.add(`${id}:${path}`);
        const location = `history:${commit.slice(0,8)}:${path}`;
        if (privatePath(path)) { findings.push({location,reason:'private artifact path'}); continue; }
        if (type !== 'blob' || mode === '120000') { findings.push({location,reason:'non-file historical entry requires review'}); continue; }
        for (const reason of contentFindings(git(['cat-file','blob',id]),signals)) findings.push({location,reason});
      }
      for (const reason of contentFindings(git(['show','-s','--format=%B',commit]),signals)) findings.push({location:`commit:${commit.slice(0,8)}`,reason});
    }
    const tags = git(['for-each-ref','--format=%(objecttype) %(objectname)','refs/tags']).trim().split('\n').filter(Boolean);
    const seenTags = new Set();
    for (const line of tags) {
      const [type,id] = line.split(' ');
      if (type !== 'tag' || seenTags.has(id)) continue;
      seenTags.add(id);
      const tag = git(['cat-file','tag',id]);
      const message = tag.slice(tag.indexOf('\n\n') + 2);
      for (const reason of contentFindings(message,signals)) findings.push({location:`tag:${id.slice(0,8)}`,reason});
      if (/^type tag$/m.test(tag)) tags.push(`tag ${tag.match(/^object (\w+)$/m)[1]}`);
    }
  }
  return {ok:findings.length === 0, history_checked:history, findings, files};
}

function exportPublic(destination) {
  if (!destination) throw new Error('Usage: npm run export:public -- tmp/public-release');
  const target = resolve(root,destination), path = relative(root,target);
  if (!path.startsWith(`tmp${sep}`) && !path.startsWith(`dist${sep}`)) throw new Error('Export destination must be a new directory under tmp/ or dist/.');
  assertNoSymlinkAncestors(target);
  const result = inspectPublication({history:false});
  if (!result.ok) throw new Error(JSON.stringify({ok:false,findings:result.findings},null,2));
  mkdirSync(dirname(target), {recursive:true});
  mkdirSync(target, {recursive:false}); // Never overwrite an existing release or its Git repository.
  for (const file of result.files) {
    let stat;
    try { stat = lstatSync(join(root,file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    mkdirSync(dirname(join(target,file)), {recursive:true});
    copyFileSync(join(root,file),join(target,file));
    chmodSync(join(target,file),stat.mode & 0o777);
  }
  git(['init','--template=','--initial-branch=main',target]);
  if (git(['remote'],target).trim() || git(['for-each-ref','--format=%(refname)'],target).trim()) throw new Error('Export has unexpected remotes or refs; do not publish it.');
  console.log(JSON.stringify({exported:target,files:result.files.length,history_copied:false,remotes_copied:false,committed:false},null,2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command,...args] = process.argv.slice(2);
    if (command === 'export' && args.length === 1) exportPublic(args[0]);
    else if ((!command || command === 'check') && !args.length) {
      const {files,...result} = inspectPublication();
      console.log(JSON.stringify({...result,files_checked:files.length},null,2));
      if (!result.ok) process.exitCode = 1;
    } else throw new Error('Usage: public-release.mjs check | export <new tmp/directory>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
