/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {parseArgs} from 'node:util';

import {
  collectContext,
  MAX_ANSWER_BYTES,
  MAX_PROMPT_BYTES,
  readTextFile,
} from './context.ts';
import {verifyPullRequest} from './github.ts';
import {browserPlan as makeBrowserPlan} from './plan.ts';
import {preparePrompt} from './prompts.ts';
import {StateStore} from './store.ts';
import type {Provider, Repository, Run, Visibility} from './types.ts';
import {WorkflowError} from './types.ts';
import {canonicalRepositoryUrl} from './urls.ts';
import {Workflow} from './workflow.ts';

const {version: VERSION} = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {version: string};

export const HELP = `chrome-ai-bridge v3 — native browser-use workflow for Claude Code and Codex

The calling agent performs browser actions with its own authenticated browser tools.
Preparing a task does not send it. CAB never drives a browser itself.

  cab prepare <chatgpt|gemini|both> "task" --project NAME --repo URL --visibility public|private
  cab prepare <provider> --prompt-file FILE --project NAME --repo URL --visibility public|private
    [--context PATH[:START:END]]... [--root DIR] [--base BRANCH]
    [--request-id KEY] [--new-chat]
  cab ready RUN --url OBSERVED_URL --mode OBSERVED_MODE_LABEL [--tab HANDLE] [--new-page]
  cab begin-send RUN
  cab sent RUN --url CANONICAL_CHAT_URL
  cab complete RUN --answer-file FILE [--pr GITHUB_PR_URL]
  cab fail RUN --answer-file FILE --reason TEXT
  cab block RUN --reason TEXT
  cab reconcile-not-sent RUN --url OBSERVED_URL --reason EVIDENCE
  cab cancel RUN                  Cancel a request only before submission starts
  cab resume RUN                  Inspect durable state; never automatically resend
  cab prompt RUN                  Print the exact prepared prompt as UTF-8
  cab status [RUN] [--project NAME]
  cab import-session <provider> --project NAME --repo URL --visibility public|private --url CHAT_URL
  cab doctor                      Check local workflow setup (does not probe browser login)

Aliases: cab <provider> ... and cab ask <provider> ... both prepare browser work.
Use --prompt-file - or --answer-file - for stdin. Files preserve code formatting.
ChatGPT: selected Pro, connected GitHub URL, real same-repository branch + PR.
Gemini: selected Thinking, public URL or explicit private code, final chat answer.
State: CAB_STATE_DIR, or $XDG_STATE_HOME/chrome-ai-bridge, or ~/.local/state/chrome-ai-bridge.
Private PR verification: authenticated gh, GH_TOKEN or GITHUB_TOKEN (read access).
`;

interface Option {
  type: 'string' | 'boolean';
  multiple?: boolean;
}
const prepareOptions = {
  project: {type: 'string'},
  repo: {type: 'string'},
  visibility: {type: 'string'},
  'prompt-file': {type: 'string'},
  context: {type: 'string', multiple: true},
  root: {type: 'string'},
  base: {type: 'string'},
  'request-id': {type: 'string'},
  'new-chat': {type: 'boolean'},
} satisfies Record<string, Option>;

function parse(argv: string[], options: Record<string, Option>) {
  return parseArgs({args: argv, options, allowPositionals: true, strict: true});
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowError(
      'MISSING_ARGUMENT',
      `Missing ${label}. See cab --help.`,
    );
  }
  return value;
}

function assertPositionals(positionals: string[], count: number): void {
  if (positionals.length !== count) {
    throw new WorkflowError(
      'INVALID_ARGUMENTS',
      'Unexpected or missing positional arguments. Quote the task or use --prompt-file. See cab --help.',
    );
  }
}

function provider(value: string): Provider {
  if (value !== 'chatgpt' && value !== 'gemini') {
    throw new WorkflowError(
      'INVALID_PROVIDER',
      'Provider must be chatgpt or gemini.',
    );
  }
  return value;
}

function repository(values: Record<string, unknown>): Repository {
  const url = required(values.repo, '--repo URL');
  const visibility = required(values.visibility, '--visibility public|private');
  if (!['public', 'private'].includes(visibility)) {
    throw new WorkflowError(
      'INVALID_VISIBILITY',
      'Repository visibility must be explicitly public or private.',
    );
  }
  const baseBranch =
    values.base === undefined
      ? undefined
      : required(values.base, '--base BRANCH');
  if (baseBranch && /[\r\n\0]/.test(baseBranch)) {
    throw new WorkflowError(
      'INVALID_BRANCH',
      'Base branch cannot contain control characters.',
    );
  }
  return {
    ...canonicalRepositoryUrl(url),
    visibility: visibility as Visibility,
    baseBranch,
  };
}

function localRevision(root: string): string | undefined {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function browserPlan(run: Run, sendAuthorized = false) {
  const entrypoint = process.argv[1]
    ? fs.realpathSync(process.argv[1])
    : undefined;
  return makeBrowserPlan(
    run,
    sendAuthorized,
    entrypoint ? [process.execPath, entrypoint] : ['cab'],
  );
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  let [command, ...rest] = argv;
  if (['chatgpt', 'gemini', 'both'].includes(command)) {
    rest = [command, ...rest];
    command = 'prepare';
  }
  if (command === 'ask') command = 'prepare';
  const store = new StateStore();
  const workflow = new Workflow(store);

  if (command === 'prepare') {
    const {positionals, values} = parse(rest, prepareOptions);
    const target = required(positionals[0], 'provider');
    const providers: Provider[] =
      target === 'both' ? ['chatgpt', 'gemini'] : [provider(target)];
    assertPositionals(positionals, values['prompt-file'] ? 1 : 2);
    const question =
      typeof values['prompt-file'] === 'string'
        ? readTextFile(values['prompt-file'], MAX_PROMPT_BYTES)
        : required(positionals[1], 'task or --prompt-file');
    const repo = repository(values);
    const project = required(values.project, '--project NAME');
    const specs = (values.context as string[] | undefined) ?? [];
    if (specs.length && !providers.includes('gemini')) {
      throw new WorkflowError(
        'UNUSED_CONTEXT',
        'ChatGPT uses its connected repository URL. --context is for Gemini; no source files were read.',
      );
    }
    const root = typeof values.root === 'string' ? values.root : process.cwd();
    const context = specs.length ? collectContext(root, specs) : [];
    const revision = context.length ? localRevision(root) : undefined;
    const inputs = providers.map(p =>
      preparePrompt({
        project,
        provider: p,
        repository: repo,
        question,
        context,
        revision,
        requestId:
          typeof values['request-id'] === 'string'
            ? values['request-id']
            : undefined,
        newChat: values['new-chat'] === true,
      }),
    );
    const runs = await workflow.prepareMany(inputs);
    json(
      runs.length === 1
        ? browserPlan(runs[0])
        : {
            protocol: 'cab.browser-use.v1',
            tasks: runs.map(r => browserPlan(r)),
          },
    );
    return;
  }

  if (command === 'doctor' || command === 'health') {
    assertPositionals(rest, 0);
    await store.read();
    json({
      version: VERSION,
      transport: 'caller-owned-browser',
      daemonRequired: false,
      stateDirectory: store.directory,
      stateReadable: true,
      node: process.version,
      browserStatus:
        'not-probed: use the calling agent’s native browser or configured browser MCP',
      requiredCapabilities: [
        'open/reuse signed-in tabs',
        'inspect current page and model selection',
        'fill and submit text',
        'read final answer and URL',
      ],
      githubVerification:
        'gh api, or GitHub REST with GH_TOKEN/GITHUB_TOKEN; anonymous REST for public repos only',
    });
    return;
  }

  if (command === 'import-session') {
    const {positionals, values} = parse(rest, {
      project: {type: 'string'},
      repo: {type: 'string'},
      visibility: {type: 'string'},
      base: {type: 'string'},
      url: {type: 'string'},
    });
    assertPositionals(positionals, 1);
    json(
      await workflow.importSession({
        provider: provider(positionals[0]),
        project: required(values.project, '--project'),
        repository: repository(values),
        url: required(values.url, '--url'),
      }),
    );
    return;
  }

  if (command === 'status' || command === 'list') {
    const {positionals, values} = parse(rest, {project: {type: 'string'}});
    if (positionals.length > 1) assertPositionals(positionals, 1);
    if (positionals.length === 1) {
      if (values.project)
        throw new WorkflowError(
          'INVALID_ARGUMENTS',
          'Use a run ID or --project, not both.',
        );
      json(browserPlan(await workflow.get(positionals[0])));
    } else {
      const state = await workflow.status(
        typeof values.project === 'string' ? values.project : undefined,
      );
      json({
        ...state,
        runs: state.runs.map(r => ({
          id: r.id,
          project: r.project,
          provider: r.provider,
          phase: r.phase,
          blocked: r.blocked,
          conversationUrl: r.conversationUrl,
          updatedAt: r.updatedAt,
          pullRequest: r.result?.pullRequest,
        })),
      });
    }
    return;
  }

  const options: Record<string, Record<string, Option>> = {
    ready: {
      url: {type: 'string'},
      mode: {type: 'string'},
      tab: {type: 'string'},
      'new-page': {type: 'boolean'},
    },
    'begin-send': {},
    sent: {url: {type: 'string'}},
    complete: {'answer-file': {type: 'string'}, pr: {type: 'string'}},
    fail: {'answer-file': {type: 'string'}, reason: {type: 'string'}},
    'reconcile-not-sent': {url: {type: 'string'}, reason: {type: 'string'}},
    block: {reason: {type: 'string'}},
    cancel: {},
    resume: {},
    prompt: {},
  };
  if (!Object.hasOwn(options, command)) {
    throw new WorkflowError(
      'UNKNOWN_COMMAND',
      `Unknown command ${JSON.stringify(command)}. See cab --help.`,
    );
  }
  const {positionals, values} = parse(rest, options[command]);
  assertPositionals(positionals, 1);
  const id = required(positionals[0], 'RUN');
  if (command === 'prompt') {
    const run = await workflow.get(id);
    process.stdout.write(run.prompt);
    return;
  }
  if (command === 'ready') {
    json(
      browserPlan(
        await workflow.ready(id, {
          url: required(values.url, '--url'),
          modeLabel: required(values.mode, '--mode'),
          tabId: typeof values.tab === 'string' ? values.tab : undefined,
          newPage: values['new-page'] === true,
        }),
      ),
    );
  } else if (command === 'begin-send') {
    json(browserPlan(await workflow.beginSend(id), true));
  } else if (command === 'sent') {
    json(
      browserPlan(
        await workflow.sent(id, {url: required(values.url, '--url')}),
      ),
    );
  } else if (command === 'complete') {
    const run = await workflow.get(id);
    if (run.phase !== 'submitted') {
      throw new WorkflowError(
        'INVALID_PHASE',
        'Only a submitted operation can be completed; record its chat URL first.',
      );
    }
    const answer = readTextFile(
      required(values['answer-file'], '--answer-file'),
      MAX_ANSWER_BYTES,
    );
    if (!answer.trim())
      throw new WorkflowError('EMPTY_ANSWER', 'The final answer is empty.');
    if (run.provider === 'gemini' && values.pr !== undefined) {
      throw new WorkflowError(
        'INVALID_OUTPUT',
        'Gemini returns a chat answer, not a PR.',
      );
    }
    const pullRequest =
      run.provider === 'chatgpt'
        ? await verifyPullRequest(
            run.repository,
            required(values.pr, '--pr URL'),
          )
        : undefined;
    json(browserPlan(await workflow.complete(id, {answer, pullRequest})));
  } else if (command === 'block') {
    json(
      browserPlan(
        await workflow.block(id, required(values.reason, '--reason')),
      ),
    );
  } else if (command === 'fail') {
    const answer = readTextFile(
      required(values['answer-file'], '--answer-file'),
      MAX_ANSWER_BYTES,
    );
    json(
      browserPlan(
        await workflow.fail(id, {
          answer,
          reason: required(values.reason, '--reason'),
        }),
      ),
    );
  } else if (command === 'reconcile-not-sent') {
    json(
      browserPlan(
        await workflow.reconcileNotSent(id, {
          url: required(values.url, '--url'),
          reason: required(values.reason, '--reason'),
        }),
      ),
    );
  } else if (command === 'cancel') {
    json(browserPlan(await workflow.cancel(id)));
  } else {
    json(browserPlan(await workflow.resume(id)));
  }
}

export function cliError(error: unknown): void {
  const code = error instanceof WorkflowError ? error.code : 'CLI_ERROR';
  let message = error instanceof Error ? error.message : 'Unknown error';
  // File errors need the filename, never the contents. Subprocess verification errors
  // are separately sanitized by github.ts.
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    message =
      'File or directory not found. Check the supplied path and build the package with npm run build.';
  }
  process.stderr.write(`${JSON.stringify({error: {code, message}})}\n`);
  process.exitCode = 1;
}
