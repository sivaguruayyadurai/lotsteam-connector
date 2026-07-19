#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const CONNECTOR_VERSION = PACKAGE_JSON.version || 'unknown';
const CONFIG_DIR = path.join(os.homedir(), '.lotsteam-connector');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_POLL_INTERVAL_MS = 10000;
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TRANSCRIPT_LIMIT_BYTES = 256 * 1024;

const COMMON_BIN_PATHS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.nvm', 'current', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  process.env.PATH || '',
].filter(Boolean).join(':');

function printHelp() {
  console.log(`
LotsTeam Connector

Usage:
  lotsteam-connector create    Connect this machine interactively
  lotsteam-connector start     Keep this machine online and process assigned tasks
  lotsteam-connector once      Process one queued task, then stop
  lotsteam-connector status    Show saved connection and CLI availability
  lotsteam-connector help      Show this help

Environment overrides:
  LOTSTEAM_BASE_URL            Example: https://team.example.com
  LOTSTEAM_RUNNER_TOKEN        Token generated from LotsTeam
  LOTSTEAM_REPO_MAP            JSON map: {"lots.team":"/Users/me/Projects/lots.team"}
  LOTSTEAM_POLL_INTERVAL_MS    Default: 10000
  LOTSTEAM_AGENT_TIMEOUT_MS    Default: 1800000
  LOTSTEAM_TRANSCRIPT_LIMIT_BYTES Default: 262144
  LOTSTEAM_CODEX_SANDBOX       Default: danger-full-access
  LOTSTEAM_CODEX_APPROVALS     Default: never
  LOTSTEAM_CODEX_BYPASS_SANDBOX Set to 0 with LOTSTEAM_CODEX_SANDBOX to keep sandboxing
  LOTSTEAM_CLAUDE_PERMISSION_MODE Default: bypassPermissions
  LOTSTEAM_CLAUDE_BYPASS_PERMISSIONS Set to 0 to use acceptEdits unless mode is set
  LOTSTEAM_CONNECTOR_VERBOSE   Set to 1 to print/store agent transcript chunks
`);
}

function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function readConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

function parseRepoMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('Repo map must be JSON, for example {"lots.team":"/Users/me/Projects/lots.team"}');
  }
}

function expandHomePath(repoPath) {
  if (!repoPath) return repoPath;
  if (repoPath === '~') return os.homedir();
  if (repoPath.startsWith('~/')) return path.join(os.homedir(), repoPath.slice(2));
  return repoPath;
}

function getRuntimeConfig() {
  const saved = readConfig();
  return {
    baseUrl: process.env.LOTSTEAM_BASE_URL || saved.baseUrl || 'http://localhost:3000',
    token: process.env.LOTSTEAM_RUNNER_TOKEN || saved.token || '',
    repoMap: parseRepoMap(process.env.LOTSTEAM_REPO_MAP || saved.repoMap || {}),
    pollIntervalMs: Number(process.env.LOTSTEAM_POLL_INTERVAL_MS || saved.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS),
    agentTimeoutMs: Number(process.env.LOTSTEAM_AGENT_TIMEOUT_MS || saved.agentTimeoutMs || DEFAULT_AGENT_TIMEOUT_MS),
    transcriptLimitBytes: Number(process.env.LOTSTEAM_TRANSCRIPT_LIMIT_BYTES || saved.transcriptLimitBytes || DEFAULT_TRANSCRIPT_LIMIT_BYTES),
  };
}

function appendBounded(current, next, limitBytes) {
  const combined = `${current}${next}`;
  if (!limitBytes || limitBytes < 1) return combined;
  const buffer = Buffer.from(combined);
  if (buffer.byteLength <= limitBytes) return combined;
  return buffer.subarray(buffer.byteLength - limitBytes).toString('utf8');
}

function isQuietDiagnostic(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 1200) return false;

  const firstLine = trimmed.split('\n').find(Boolean) || '';
  return [
    /^error[:\s]/i,
    /^warning[:\s]/i,
    /^fatal[:\s]/i,
    /^blocked[:\s]/i,
    /command not found/i,
    /permission denied/i,
    /operation not permitted/i,
    /timed out after/i,
    /was not found in PATH/i,
    /missing .*environment variable/i,
  ].some((pattern) => pattern.test(firstLine));
}

async function createConfig() {
  const rl = readline.createInterface({ input, output });
  const current = readConfig();

  try {
    console.log('Connect this machine to LotsTeam.');
    console.log('Create a machine command/token from LotsTeam, then paste it here.\n');

    const baseUrl = await ask(rl, 'LotsTeam site URL', current.baseUrl || 'http://localhost:3000');
    const token = await ask(rl, 'Machine token', current.token || '');
    const repoName = await ask(rl, 'Repo name in LotsTeam', Object.keys(current.repoMap || {})[0] || path.basename(process.cwd()));
    const repoPath = path.resolve(expandHomePath(await ask(rl, 'Local repo folder path', Object.values(current.repoMap || {})[0] || process.cwd())));

    if (!token.startsWith('ltcr_')) {
      throw new Error('Machine token should start with ltcr_. Create it from LotsTeam > Coding Agents.');
    }
    if (!existsSync(repoPath)) {
      throw new Error(`Repo folder does not exist: ${repoPath}`);
    }

    const config = {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      token,
      repoMap: {
        ...(current.repoMap || {}),
        [repoName]: repoPath,
      },
      pollIntervalMs: current.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
    };

    writeConfig(config);
    console.log(`\nSaved connection to ${CONFIG_FILE}`);
    console.log('\nNext, keep this machine connected:');
    console.log('  lotsteam-connector start\n');
  } finally {
    rl.close();
  }
}

async function ask(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || defaultValue;
}

async function api(pathname, options = {}) {
  const config = getRuntimeConfig();
  if (!config.token) {
    throw new Error('No machine token configured. Run: lotsteam-connector create');
  }

  const response = await fetch(`${config.baseUrl}${pathname}`, {
    method: options.method || 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function claim() {
  return api('/api/coding/runs/claim', {
    body: connectorIdentityPayload(),
  });
}

async function heartbeat() {
  return api('/api/coding/runner/heartbeat', {
    body: connectorIdentityPayload(),
  }).catch((error) => {
    console.error(`[heartbeat] ${error.message}`);
  });
}

function connectorIdentityPayload() {
  return {
    connector_version: CONNECTOR_VERSION,
    machine: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      username: os.userInfo().username,
      homedir: os.homedir(),
    },
  };
}

async function event(runId, event_type, message, metadata = {}, post_to_task = false) {
  return api(`/api/coding/runs/${runId}/events`, {
    body: { event_type, message, metadata, post_to_task },
  }).catch((error) => {
    console.error(`[event:${event_type}] ${error.message}`);
  });
}

async function complete(runId, body) {
  return api(`/api/coding/runs/${runId}/complete`, { body });
}

function runCommand(command, args, cwd, onOutput) {
  return new Promise((resolve) => {
    const config = getRuntimeConfig();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: COMMON_BIN_PATHS },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const startedAt = Date.now();
    const heartbeat = onOutput
      ? setInterval(() => {
          const seconds = Math.round((Date.now() - startedAt) / 1000);
          onOutput('status', `Still running ${command} after ${seconds}s...`);
        }, 30000)
      : null;
    const timeout = config.agentTimeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          const seconds = Math.round(config.agentTimeoutMs / 1000);
          stderr = appendBounded(stderr, `\n${command} timed out after ${seconds}s.`, config.transcriptLimitBytes);
          onOutput?.('stderr', `${command} timed out after ${seconds}s.`);
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
          }, 5000);
        }, config.agentTimeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = appendBounded(stdout, text, config.transcriptLimitBytes);
      onOutput?.('stdout', text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = appendBounded(stderr, text, config.transcriptLimitBytes);
      onOutput?.('stderr', text);
    });

    child.on('error', (error) => {
      stderr = appendBounded(stderr, error.message, config.transcriptLimitBytes);
      if (error.code === 'ENOENT') {
        stderr = appendBounded(
          stderr,
          `\n${command} was not found in PATH. PATH used by LotsTeam Connector:\n${COMMON_BIN_PATHS}`,
          config.transcriptLimitBytes
        );
      }
    });

    child.on('close', (code) => {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr });
    });
  });
}

async function git(cwd, args) {
  return runCommand('git', args, cwd);
}

function resolveRepoPath(run) {
  const config = getRuntimeConfig();
  const repository = run.repository || {};
  const keys = [repository.id, repository.repo_full_name, repository.repo_url].filter(Boolean);

  for (const key of keys) {
    if (config.repoMap[key]) return path.resolve(expandHomePath(config.repoMap[key]));
  }

  if (repository.provider === 'local' && repository.metadata?.local_path) {
    return path.resolve(expandHomePath(repository.metadata.local_path));
  }

  if (config.repoMap.default) {
    return path.resolve(expandHomePath(config.repoMap.default));
  }

  return null;
}

function buildPrompt(run) {
  const task = run.task || {};
  const repository = run.repository || {};
  return [
    'You are working as a LotsTeam coding teammate.',
    '',
    `Task: ${task.title || run.task_id}`,
    task.description ? `Description:\n${task.description}` : null,
    run.prompt ? `Additional instructions:\n${run.prompt}` : null,
    '',
    `Repository: ${repository.repo_full_name || repository.repo_url || run.repository_id || 'machine default folder'}`,
    `Base branch: ${run.base_branch}`,
    `Working branch: ${run.branch_name}`,
    '',
    'Work in this local checkout. Make requested changes only when the task asks for changes.',
    'If the task asks for analysis or summary, do not edit files; answer clearly.',
    'Do not merge, deploy, or touch production secrets.',
  ].filter(Boolean).join('\n');
}

function codexSandboxMode() {
  if (process.env.LOTSTEAM_CODEX_BYPASS_SANDBOX === '0') {
    return process.env.LOTSTEAM_CODEX_SANDBOX || 'workspace-write';
  }
  return process.env.LOTSTEAM_CODEX_SANDBOX || 'danger-full-access';
}

function codexFreshAutomationArgs() {
  const sandbox = codexSandboxMode();
  const bypassSandbox = sandbox === 'danger-full-access';
  if (bypassSandbox) return ['--dangerously-bypass-approvals-and-sandbox'];
  return [
    '--sandbox',
    sandbox,
    '-c',
    `approval_policy="${process.env.LOTSTEAM_CODEX_APPROVALS || 'never'}"`,
  ];
}

function codexResumeAutomationArgs() {
  const sandbox = codexSandboxMode();
  const bypassSandbox = sandbox === 'danger-full-access';
  if (bypassSandbox) return ['--dangerously-bypass-approvals-and-sandbox'];
  return [
    '-c',
    `sandbox_mode="${sandbox}"`,
    '-c',
    `approval_policy="${process.env.LOTSTEAM_CODEX_APPROVALS || 'never'}"`,
  ];
}

function claudeAutomationArgs() {
  const permissionMode = process.env.LOTSTEAM_CLAUDE_PERMISSION_MODE || (
    process.env.LOTSTEAM_CLAUDE_BYPASS_PERMISSIONS === '0' ? 'acceptEdits' : 'bypassPermissions'
  );

  if (permissionMode === 'bypassPermissions') {
    return ['--permission-mode', 'bypassPermissions'];
  }

  return ['--permission-mode', permissionMode];
}

function commandForProvider(run, prompt) {
  if (process.env.LOTSTEAM_AGENT_COMMAND) {
    return {
      command: process.env.LOTSTEAM_AGENT_COMMAND,
      args: process.env.LOTSTEAM_AGENT_ARGS ? JSON.parse(process.env.LOTSTEAM_AGENT_ARGS) : [prompt],
    };
  }

  if (run.provider === 'claude_code') {
    const resumeSessionId = run.metadata?.resume_session_id || run.external_session_id;
    const args = resumeSessionId
      ? ['-p', '--resume', String(resumeSessionId), ...claudeAutomationArgs(), '--output-format', 'json', prompt]
      : ['-p', '--session-id', run.id, ...claudeAutomationArgs(), '--output-format', 'json', prompt];
    return { command: 'claude', args };
  }

  const resumeSessionId = run.metadata?.resume_session_id || run.external_session_id;
  const args = resumeSessionId
    ? ['exec', 'resume', ...codexResumeAutomationArgs(), String(resumeSessionId), prompt]
    : ['exec', ...codexFreshAutomationArgs(), '--color', 'never', prompt];

  return {
    command: 'codex',
    args,
  };
}

async function prepareBranch(repoPath, run) {
  const branchName = run.branch_name || `lotsteam/${run.id.slice(0, 8)}`;
  if (run.metadata?.follow_up_run) {
    await git(repoPath, ['fetch', '--all', '--prune']);
    const localBranch = await git(repoPath, ['rev-parse', '--verify', branchName]);
    if (localBranch.code === 0) {
      const checkout = await git(repoPath, ['checkout', branchName]);
      if (checkout.code !== 0) throw new Error(checkout.stderr || `Failed to checkout ${branchName}`);
      return branchName;
    }

    const remoteBranch = await git(repoPath, ['rev-parse', '--verify', `origin/${branchName}`]);
    if (remoteBranch.code === 0) {
      const checkout = await git(repoPath, ['checkout', '-B', branchName, `origin/${branchName}`]);
      if (checkout.code !== 0) throw new Error(checkout.stderr || `Failed to checkout ${branchName}`);
      return branchName;
    }
  }

  await git(repoPath, ['fetch', '--all', '--prune']);
  await git(repoPath, ['checkout', run.base_branch || 'main']);
  await git(repoPath, ['pull', '--ff-only']);
  const checkout = await git(repoPath, ['checkout', '-B', branchName]);
  if (checkout.code !== 0) throw new Error(checkout.stderr || `Failed to checkout ${branchName}`);
  return branchName;
}

async function summarizeRepo(repoPath) {
  const status = await git(repoPath, ['status', '--short']);
  const diffNames = await git(repoPath, ['diff', '--name-only']);
  const head = await git(repoPath, ['rev-parse', 'HEAD']);
  return {
    status: status.stdout.trim(),
    changed_files: diffNames.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
    commit_sha: head.stdout.trim() || null,
  };
}

function extractCodexSessionId(text) {
  const match = text.match(/session id:\s*([0-9a-fA-F-]{32,36})/);
  return match?.[1] || null;
}

function parseClaudeResult(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return {
      text: typeof parsed.result === 'string' ? parsed.result : trimmed,
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    };
  } catch {
    return { text: trimmed, sessionId: null };
  }
}

async function handleRun(run) {
  const repoPath = resolveRepoPath(run);
  if (!repoPath || !existsSync(repoPath)) {
    await complete(run.id, {
      status: 'blocked',
      error: `Repository folder is not configured on ${os.hostname()}.`,
      final_summary: 'I could not start because this machine does not know where the repository lives.',
    });
    return;
  }

  const absoluteRepoPath = path.resolve(repoPath);
  console.log(`Starting run ${run.id} in ${absoluteRepoPath}`);
  await event(run.id, 'started', `Starting in ${absoluteRepoPath}.`, { repo_path: absoluteRepoPath }, false);

  let branchName = run.branch_name;
  try {
    branchName = await prepareBranch(absoluteRepoPath, run);
  } catch (error) {
    await complete(run.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      final_summary: 'Failed while preparing the git branch.',
    });
    return;
  }

  const prompt = buildPrompt(run);
  const { command, args } = commandForProvider(run, prompt);
  console.log(`Invoking ${command} for run ${run.id}`);
  await event(run.id, 'progress', `Invoking ${command}.`, { command, args_preview: args.slice(0, 2) }, false);
  await event(
    run.id,
    'progress',
    [
      'Coding agent started.',
      `Branch: \`${branchName}\`.`,
      `Machine: ${run.runner?.display_name || 'connected machine'}.`,
      `Provider: ${run.provider === 'claude_code' ? 'Claude Code' : run.provider === 'codex' ? 'Codex' : run.provider}.`,
      `Folder: \`${absoluteRepoPath}\`.`,
    ].join('\n'),
    {
      branch_name: branchName,
      repo_path: absoluteRepoPath,
      command,
      provider: run.provider,
      runner_id: run.runner_id || null,
    },
    true
  );

  const verbose = process.env.LOTSTEAM_CONNECTOR_VERBOSE === '1';
  let lastOutputEvent = 0;
  const result = await runCommand(command, args, absoluteRepoPath, (stream, text) => {
    const trimmed = text.trim();
    if (stream === 'status' && trimmed) {
      console.log(`[${run.id}] ${trimmed}`);
      heartbeat();
    } else if (verbose && trimmed) {
      console.log(`[${run.id}] ${stream}: ${trimmed.slice(-2000)}`);
    } else if (stream === 'stderr' && isQuietDiagnostic(trimmed)) {
      console.log(`[${run.id}] ${stream}: ${trimmed.slice(-1000)}`);
    }

    const now = Date.now();
    if (verbose && now - lastOutputEvent > 5000) {
      lastOutputEvent = now;
      event(run.id, stream, text.slice(-4000), {}, false);
    }
  });

  const repoSummary = await summarizeRepo(absoluteRepoPath);
  const claudeResult = run.provider === 'claude_code' ? parseClaudeResult(result.stdout) : {};
  const externalSessionId = run.external_session_id || claudeResult.sessionId || extractCodexSessionId(`${result.stderr}\n${result.stdout}`);
  console.log(`Finished run ${run.id} with exit code ${result.code}`);
  const agentAnswer = ((claudeResult.text || result.stdout.trim()) || result.stderr.trim()).slice(-12000);
  const connectorSummary = [
    result.code === 0 ? 'Connector check:' : `Connector check: coding agent exited with code ${result.code}.`,
    repoSummary.changed_files.length ? `Changed files:\n${repoSummary.changed_files.map((file) => `- ${file}`).join('\n')}` : 'No changed files detected.',
    repoSummary.status ? `\nGit status:\n${repoSummary.status}` : null,
  ].filter(Boolean).join('\n');
  const finalSummary = agentAnswer ? `${agentAnswer.slice(-12000)}\n\n${connectorSummary}` : connectorSummary;

  await complete(run.id, {
    status: result.code === 0 ? 'ready_for_review' : 'failed',
    branch_name: branchName,
    final_summary: finalSummary,
    error: result.code === 0 ? null : result.stderr.slice(-8000),
    external_session_id: externalSessionId,
    metadata: {
      exit_code: result.code,
      stdout_tail: result.stdout.slice(-8000),
      stderr_tail: result.stderr.slice(-8000),
      changed_files: repoSummary.changed_files,
      external_session_id: externalSessionId,
    },
    pull_request: {
      provider: 'local',
      branch_name: branchName,
      commit_sha: repoSummary.commit_sha,
      status: 'unknown',
      metadata: { git_status: repoSummary.status },
    },
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start({ once = false } = {}) {
  const config = getRuntimeConfig();
  console.log(`LotsTeam Connector ${CONNECTOR_VERSION} connected to ${config.baseUrl}`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log('Keep this process running while you want coding agents online.\n');

  while (true) {
    try {
      const response = await claim();
      const run = response.data;
      if (run) {
        console.log(`Claimed run ${run.id}`);
        await handleRun(run);
      } else if (once) {
        console.log('No queued run found.');
        break;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      if (once) process.exitCode = 1;
    }

    if (once) break;
    await sleep(config.pollIntervalMs);
  }
}

function showStatus() {
  const config = getRuntimeConfig();
  console.log(`Config file: ${CONFIG_FILE}`);
  console.log(`LotsTeam site: ${config.baseUrl}`);
  console.log(`Machine token: ${config.token ? 'configured' : 'missing'}`);
  console.log(`Repos: ${Object.keys(config.repoMap).length ? JSON.stringify(config.repoMap, null, 2) : 'none'}`);

  for (const command of ['codex', 'claude', 'git']) {
    runCommand(command, ['--version'], process.cwd()).then((result) => {
      const output = (result.stdout || result.stderr).trim();
      console.log(`${command}: ${result.code === 0 ? output : 'not found'}`);
    });
  }
}

async function main() {
  const command = process.argv[2] || 'help';
  if (['help', '--help', '-h'].includes(command)) return printHelp();
  if (['create', 'login', 'init'].includes(command)) return createConfig();
  if (command === 'start') return start({ once: false });
  if (['once', 'run-once'].includes(command)) return start({ once: true });
  if (command === 'status') return showStatus();

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

main();
