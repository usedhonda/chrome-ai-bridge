/**
 * @license
 * Copyright 2026 usedhonda
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Run} from './types.ts';

export function browserPlan(
  run: Run,
  sendAuthorized = false,
  commandPrefix = ['cab'],
) {
  const mode =
    run.provider === 'chatgpt'
      ? 'Pro'
      : 'the Carbon model with 思考レベル 高 (Thinking level: High)';
  const command = `cab`;
  const steps: string[] = [];
  if (run.blocked) {
    steps.push(`Resolve the observed blocker first: ${run.blocked.reason}`);
  }
  switch (run.phase) {
    case 'prepared':
      steps.push(
        run.requiresNewPage
          ? `Open a NEW page at ${run.openUrl} in the caller's signed-in browser. Do not reuse another project's conversation.`
          : `Find the saved conversation ${run.openUrl}, or open that exact URL if its tab is gone. Do not create a replacement conversation unless the provider states that this conversation reached its length limit.`,
        `Inspect the live page and explicitly select ${mode}. Verify the selected control, not the subscription badge. Never silently downgrade.`,
        `Record readiness: ${command} ready ${run.id} --url OBSERVED_URL --mode OBSERVED_MODE_LABEL${run.requiresNewPage ? ' --new-page' : ''} [--tab TAB_HANDLE].`,
      );
      break;
    case 'ready':
      steps.push(
        `Continue the recorded browser page${run.tabId ? ` (tab hint ${run.tabId})` : ''} at ${run.readyUrl}. Do not open another new page. Verify its mode is still ${mode} before sending.`,
        `Obtain the exact prompt with ${command} prompt ${run.id}. Fill the composer using your available browser tools and preserve all newlines.`,
        `Immediately before clicking Send, run ${command} begin-send ${run.id}. Only a successful response with sendAuthorized=true permits the single Send action.`,
        `After the browser accepts the message, immediately record its canonical chat URL with ${command} sent ${run.id} --url CHAT_URL, even while generation continues.`,
      );
      break;
    case 'sending':
      if (sendAuthorized) {
        steps.push(
          'The durable sending marker was just created. Click Send ONCE in the already prepared browser page.',
          `As soon as the message is accepted and its chat URL appears, run ${command} sent ${run.id} --url CHAT_URL.`,
        );
      } else {
        steps.push(
          'Submission may already have happened. Inspect the recorded tab or saved URL and locate this exact user turn. Do not send again or open a new chat.',
          `If the accepted user turn is visible, record ${command} sent ${run.id} --url CHAT_URL. Otherwise record a blocker; preserve this operation for reconciliation.`,
          `Only if browser evidence positively proves no submission occurred may you run ${command} reconcile-not-sent ${run.id} --url OBSERVED_URL --reason EVIDENCE. A timeout or missing tab is not such evidence. This returns to readiness without authorizing a send.`,
        );
      }
      break;
    case 'submitted':
      steps.push(
        `Inspect the existing conversation at ${run.conversationUrl}. Wait for the actual final response using the caller's browser tools; do not resubmit the task.`,
        'Capture only this turn’s completed answer, preserving Markdown and code. Do not take an earlier reply, thinking text, or a streaming fragment as the result.',
      );
      break;
    case 'completed':
      steps.push(
        'This operation is complete. Return the saved result. Prepare a new request with the same project to continue in its saved conversation.',
      );
      break;
    case 'canceled':
      steps.push(
        'This operation was canceled before submission. No browser send is authorized.',
      );
      break;
    case 'failed':
      steps.push(
        'This operation ended with the provider’s final blocker/failure, not a successful deliverable. Return the recorded failure. Prepare a corrective follow-up with the same project to keep the saved conversation. If it failed because the conversation reached its length limit, prepare a self-contained follow-up with --new-chat instead.',
      );
      break;
  }
  if (!['completed', 'canceled', 'failed'].includes(run.phase)) {
    steps.push(
      run.provider === 'chatgpt'
        ? `Require the actual branch and PR in the target repository. Save the final answer and run ${command} complete ${run.id} --answer-file PATH --pr PR_URL. The CLI checks GitHub metadata before marking completion.`
        : `Save the final chat response and run ${command} complete ${run.id} --answer-file PATH. Gemini's output is chat/code, not a remote PR.`,
      `If login, mode, access, or result is blocked, use ${command} block ${run.id} --reason REASON. Resume this operation; do not silently switch conversations or downgrade modes.`,
      `If the provider has finished with a final blocker instead of the requested deliverable, record ${command} fail ${run.id} --answer-file PATH --reason REASON. This records failure and preserves the conversation for a corrective follow-up.`,
      `If the provider states that this conversation reached its length limit, do not keep using it. Close this operation (cancel before a send; after an accepted send, fail with the visible text as the answer), check the branch and PR on GitHub, and prepare the same work again with --new-chat. The new prompt must stand on its own: the goal, scope and constraints, and the progress confirmed on GitHub, in --prompt-file or --handoff-file.`,
    );
  }
  return {
    protocol: 'cab.browser-use.v1',
    transport: 'caller-owned-browser',
    commandPrefix,
    commandNote:
      'Execute every displayed cab command with this commandPrefix argv. Keep the same entrypoint; do not switch to a different global cab installation.',
    runId: run.id,
    project: run.project,
    provider: run.provider,
    repository: run.repository,
    phase: run.phase,
    blocked: run.blocked,
    failure: run.failure,
    completed: run.phase === 'completed',
    // Never infer browser execution from a prepared prompt or a zero CLI exit code.
    sendAuthorized,
    requiredMode: mode,
    modeLabel: run.modeLabel,
    navigation: {
      url: run.conversationUrl ?? run.readyUrl ?? run.openUrl,
      newPage: run.requiresNewPage && run.phase === 'prepared',
      tabHint: run.tabId,
    },
    conversationUrl: run.conversationUrl,
    contextFiles: run.contextFiles,
    steps,
    result: run.result,
  };
}
