/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * ChatGPT Driver
 *
 * Handles ChatGPT-specific DOM interactions for sending prompts
 * and extracting responses.
 */

import {BaseDriver} from '../../core/base-driver.js';
import type {
  DriverSelectors,
  SendResult,
  ExtractResult,
  DriverOptions,
} from '../types.js';

import {CHATGPT_SELECTORS} from './selectors.js';

interface ChatGPTResponseBaseline {
  assistantCount: number;
  lastTextLength: number;
}

/**
 * ChatGPT Site Driver
 */
export class ChatGPTDriver extends BaseDriver {
  readonly name = 'chatgpt';
  readonly selectors: DriverSelectors = CHATGPT_SELECTORS;

  private responseBaseline: ChatGPTResponseBaseline | null = null;
  private streamingText = '';

  /**
   * Send a prompt to ChatGPT
   */
  async sendPrompt(text: string): Promise<SendResult> {
    const _client = this.getClient();
    const sanitized = JSON.stringify(text);

    // Input the text
    const inputResult = await this.evaluateWithUtils<boolean>(`
      const text = ${sanitized};

      // Try preferred selectors first
      const preferredEditable = document.querySelector('.ProseMirror[contenteditable="true"]');
      if (preferredEditable) {
        preferredEditable.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = text;
        preferredEditable.appendChild(p);
        preferredEditable.dispatchEvent(new Event('input', {bubbles: true}));
        return true;
      }

      const preferredTextarea =
        document.querySelector('textarea#prompt-textarea') ||
        document.querySelector('textarea[data-testid="prompt-textarea"]');

      if (preferredTextarea) {
        preferredTextarea.focus();
        preferredTextarea.value = text;
        const inputEvent = typeof InputEvent !== 'undefined'
          ? new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text})
          : new Event('input', {bubbles: true});
        preferredTextarea.dispatchEvent(inputEvent);
        preferredTextarea.dispatchEvent(new Event('change', {bubbles: true}));
        return true;
      }

      // Fallback to largest visible input
      const candidates = [
        ...Array.from(document.querySelectorAll('textarea')),
        ...Array.from(document.querySelectorAll('div[contenteditable="true"]')),
      ].filter(__isVisible);

      const pick = candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })[0] || null;

      if (!pick) return false;

      pick.focus();
      if (pick.tagName === 'TEXTAREA') {
        pick.value = text;
        const inputEvent = typeof InputEvent !== 'undefined'
          ? new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text})
          : new Event('input', {bubbles: true});
        pick.dispatchEvent(inputEvent);
        pick.dispatchEvent(new Event('change', {bubbles: true}));
        return true;
      }

      if (pick.isContentEditable) {
        pick.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = text;
        pick.appendChild(p);
        pick.dispatchEvent(new Event('input', {bubbles: true}));
        return true;
      }

      return false;
    `);

    if (!inputResult) {
      return {success: false, error: 'Failed to input text'};
    }

    this.responseBaseline = await this.captureResponseBaseline();
    this.streamingText = '';

    // Wait for input to be processed
    await this.sleep(100);

    // Click send button
    const clickResult = await this.evaluateWithUtils<{
      clicked: boolean;
      selector: string | null;
    }>(`
      const selectors = [
        'button[data-testid="send-button"]',
        '#composer-submit-button',
        'button[aria-label*="送信"]',
        'button[aria-label*="Send"]'
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
          btn.click();
          return {clicked: true, selector: sel};
        }
      }
      return {clicked: false, selector: null};
    `);

    if (!clickResult.clicked) {
      return {success: false, error: 'Failed to click send button'};
    }

    this.log('Prompt sent', {selector: clickResult.selector});
    return {success: true};
  }

  /**
   * Check if ChatGPT is currently processing
   */
  async isProcessing(): Promise<boolean> {
    return this.evaluateWithUtils<boolean>(`
      const buttons = __collectDeep(['button', '[role="button"]']).nodes
        .filter(__isVisible)
        .filter(el => !__isDisabled(el));

      // Check for stop button
      const hasStopButton = buttons.some(b => {
        const text = (b.textContent || '').trim();
        const label = (b.getAttribute('aria-label') || '').trim();
        return text.includes('Stop generating') || label.includes('Stop generating') ||
               text.includes('生成を停止') || label.includes('生成を停止') ||
               label.includes('Stop streaming') || label === 'Stop';
      });
      if (hasStopButton) return true;

      // Check for streaming indicator
      const streaming = document.querySelector('.result-streaming');
      if (streaming) return true;

      // Check for "generating" text
      const bodyText = document.body?.innerText || '';
      const hasGeneratingText = bodyText.includes('回答を生成しています') ||
                               bodyText.includes('is still generating') ||
                               bodyText.includes('generating a response');
      const hasThinkingComplete = /思考時間[：:]\\s*\\d+s?/.test(bodyText) ||
                                  /Thinking.*\\d+s?/.test(bodyText);
      const hasSkipThinkingButton = bodyText.includes('今すぐ回答') ||
                                    bodyText.includes('Skip thinking');

      return (hasGeneratingText && !hasThinkingComplete) || hasSkipThinkingButton;
    `);
  }

  override async waitForResponse(options?: DriverOptions): Promise<void> {
    const maxWaitMs = options?.maxWaitMs ?? 480000;
    const pollIntervalMs = 1000;
    const idleTimeoutMs = 60000;
    const startWait = Date.now();
    let lastActivityAt = Date.now();
    let lastLoggedState = '';
    let sawStopButton = false;
    let textStableCount = 0;
    let lastTextLength = -1;
    let stopButtonGoneCount = 0;
    let textGrowingCount = 0;
    const baseline =
      this.responseBaseline ?? (await this.captureResponseBaseline());

    while (
      Date.now() - lastActivityAt < idleTimeoutMs &&
      (sawStopButton || Date.now() - startWait < maxWaitMs)
    ) {
      const state = await this.readResponseState();

      if (state.hasStopButton) {
        sawStopButton = true;
        lastActivityAt = Date.now();
      }
      if (state.hasStreamingIndicator) {
        lastActivityAt = Date.now();
      }

      const currentState = JSON.stringify(state);
      if (currentState !== lastLoggedState) {
        const elapsed = Math.round((Date.now() - startWait) / 1000);
        this.log(
          `State @${elapsed}s: stop=${state.hasStopButton}, send=${state.sendButtonFound}(disabled=${state.sendButtonDisabled}), assistant=${state.assistantMsgCount}, inputHasText=${state.inputBoxHasText}, sawStop=${sawStopButton}, generating=${state.isStillGenerating}, streaming=${state.hasStreamingIndicator}, skipThink=${state.hasSkipThinkingButton}, hasText=${state.hasResponseText}, textGrow=${textGrowingCount}`,
        );
        lastLoggedState = currentState;
      }

      const currentTextLen = state.debug_lastAssistantInnerTextLen;
      if (currentTextLen === lastTextLength && currentTextLen > 0) {
        textStableCount++;
        textGrowingCount = 0;
      } else if (currentTextLen > lastTextLength) {
        textStableCount = 0;
        textGrowingCount++;
        lastTextLength = currentTextLen;
        lastActivityAt = Date.now();
      } else {
        textStableCount = 0;
        textGrowingCount = 0;
        lastTextLength = currentTextLen;
      }

      if (sawStopButton && !state.hasStopButton) {
        stopButtonGoneCount++;
      } else {
        stopButtonGoneCount = 0;
      }

      const hasNewAssistant = state.assistantMsgCount > baseline.assistantCount;
      const hasGrownText =
        state.debug_lastAssistantInnerTextLen > baseline.lastTextLength + 10;
      const hasResponseChange = hasNewAssistant || hasGrownText;

      if (
        sawStopButton &&
        stopButtonGoneCount >= 3 &&
        !state.inputBoxHasText &&
        hasResponseChange
      ) {
        if (textStableCount >= 2) {
          this.log(
            `Response complete - stop gone for ${stopButtonGoneCount} polls, text stable for ${textStableCount} polls (len=${currentTextLen})`,
          );
          this.streamingText = await this.captureStreamingText();
          return;
        }
        this.log(
          `Stop button gone (${stopButtonGoneCount} polls) but text not stable yet (len=${currentTextLen}, stableCount=${textStableCount})`,
        );
        await this.sleep(pollIntervalMs);
        continue;
      }

      const elapsed = Date.now() - startWait;
      if (
        elapsed > 5000 &&
        !state.hasStopButton &&
        !state.inputBoxHasText &&
        hasResponseChange &&
        !state.isStillGenerating &&
        textGrowingCount === 0
      ) {
        if (textStableCount >= 2) {
          this.log(
            `Response complete - fallback after 5s, text stable (len=${currentTextLen}, stableCount=${textStableCount})`,
          );
          return;
        }
        this.log(
          `Fallback conditions met but text not stable yet (len=${currentTextLen}, stableCount=${textStableCount})`,
        );
      }

      if (
        elapsed > 10000 &&
        !state.isStillGenerating &&
        !state.hasSkipThinkingButton &&
        hasResponseChange &&
        !state.inputBoxHasText
      ) {
        if (textStableCount >= 2) {
          this.log(
            `Response complete - Thinking mode fallback after 10s, text stable (len=${currentTextLen}, stableCount=${textStableCount})`,
          );
          return;
        }
        this.log(
          `Thinking fallback conditions met but text not stable yet (len=${currentTextLen}, stableCount=${textStableCount})`,
        );
      }

      await this.sleep(pollIntervalMs);
    }

    const loopElapsed = Date.now() - startWait;
    const loopIdle = Date.now() - lastActivityAt;
    const finalState = await this.readTimeoutState();
    const reason =
      loopIdle >= idleTimeoutMs
        ? `idle for ${Math.round(loopIdle / 1000)}s (no stop button or text growth)`
        : `absolute ceiling ${maxWaitMs}ms reached`;
    throw new Error(
      `chatgpt: Timed out waiting for response (${Math.round(loopElapsed / 1000)}s, ${reason}). DO NOT RESEND: the question was already submitted to ChatGPT. Final state: ${JSON.stringify(finalState)}`,
    );
  }

  /**
   * Extract the latest response from ChatGPT
   */
  async extractResponse(_options?: DriverOptions): Promise<ExtractResult> {
    await this.expandCollapsedThinking();
    await this.waitForFinalText();

    const debugInfo = await this.readExtractDebug();
    this.log('Extract debug', {
      lastArticleDebug: debugInfo.lastArticleDebug,
    });

    let answer = '';
    let evidence = 'empty';
    const extractMaxRetries = 2;
    const extractBaseIntervalMs = 500;

    for (let retry = 0; retry < extractMaxRetries; retry++) {
      if (retry > 0) {
        const waitMs = extractBaseIntervalMs + (retry - 1) * 250;
        this.log(`Waiting ${waitMs}ms before retry ${retry}`);
        await this.sleep(waitMs);
      }

      const result = await this.extractFromAssistantArticle();
      answer = result.text;
      evidence = result.evidence;
      if (answer && answer.length > 0 && !answer.startsWith('ChatGPT:')) {
        if (retry > 0) {
          this.log(`Got response on retry ${retry}`);
        }
        break;
      }

      if (retry < extractMaxRetries - 1) {
        this.log(
          `Response empty, will retry (${retry + 1}/${extractMaxRetries})`,
        );
      }
    }

    if (!answer || answer.length === 0) {
      const mainResult = await this.extractFromMain();
      answer = mainResult.text;
      evidence = mainResult.evidence;
      if (answer && answer.length > 0) {
        this.log('Got response from main element fallback');
      }
    }

    if (!answer || answer.length === 0) {
      const bodyResult = await this.extractFromBody();
      answer = bodyResult.text;
      evidence = bodyResult.evidence;
      if (answer && answer.length > 0) {
        this.log('Got response from body.innerText fallback');
      }
    }

    const finalAnswer =
      answer && answer.length > 0 && !answer.startsWith('ChatGPT:')
        ? answer
        : this.streamingText || answer;

    this.log('Response extracted', {
      length: finalAnswer.length,
      evidence,
      usedStreamingText: finalAnswer === this.streamingText,
    });

    return {
      text: finalAnswer,
      confidence: finalAnswer.length > 0 ? 0.8 : 0.0,
      evidence:
        finalAnswer === this.streamingText ? 'streaming-text' : evidence,
    };
  }

  private async captureResponseBaseline(): Promise<ChatGPTResponseBaseline> {
    return this.evaluateWithUtils<ChatGPTResponseBaseline>(`
      const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const chatgptArticles = [];
      for (const article of document.querySelectorAll('article')) {
        const heading = article.querySelector('h6, h5, [role="heading"]');
        if (heading && (heading.textContent || '').includes('ChatGPT')) {
          chatgptArticles.push(article);
        }
      }
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1] ||
        chatgptArticles[chatgptArticles.length - 1];
      return {
        assistantCount: Math.max(assistantMsgs.length, chatgptArticles.length),
        lastTextLength: lastAssistant ? ((lastAssistant.innerText || lastAssistant.textContent || '').trim()).length : 0,
      };
    `);
  }

  private async readResponseState(): Promise<{
    hasStopButton: boolean;
    sendButtonFound: boolean;
    sendButtonDisabled: boolean | null;
    assistantMsgCount: number;
    inputBoxHasText: boolean;
    isStillGenerating: boolean;
    hasResponseText: boolean;
    hasSkipThinkingButton: boolean;
    hasStreamingIndicator: boolean;
    debug_lastAssistantInnerTextLen: number;
  }> {
    return this.evaluateWithUtils(`
      const stopBtn = document.querySelector('button[data-testid="stop-button"]') ||
                      document.querySelector('button[aria-label="ストリーミングの停止"]') ||
                      document.querySelector('button[aria-label="Stop streaming"]') ||
                      document.querySelector('button[aria-label*="停止"]') ||
                      document.querySelector('button[aria-label*="Stop"]') ||
                      [...document.querySelectorAll('button')].find(b =>
                        b.querySelector('rect') && (b.textContent || '').trim() === ''
                      );
      const buttons = __collectDeep(['button', '[role="button"]']).nodes;
      const sendBtn = buttons.find(b =>
        b.getAttribute('data-testid') === 'send-button' ||
        b.getAttribute('aria-label')?.includes('送信') ||
        b.getAttribute('aria-label')?.includes('Send')
      );
      const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const chatgptArticles = [];
      for (const article of document.querySelectorAll('article')) {
        const heading = article.querySelector('h6, h5, [role="heading"]');
        if (heading && (heading.textContent || '').includes('ChatGPT')) {
          chatgptArticles.push(article);
        }
      }
      const inputBox = document.querySelector('.ProseMirror[contenteditable="true"]') ||
                      document.querySelector('textarea#prompt-textarea');
      const inputText = inputBox ?
        (inputBox.tagName === 'TEXTAREA' ? inputBox.value : inputBox.textContent) || '' : '';
      const bodyText = document.body?.innerText || '';
      const hasGeneratingText = bodyText.includes('回答を生成しています') ||
                               bodyText.includes('is still generating') ||
                               bodyText.includes('generating a response');
      const hasThinkingComplete = /思考時間[：:]\\s*\\d+s?/.test(bodyText) ||
                                  /Thinking.*\\d+s?/.test(bodyText);
      const hasSkipThinkingButton = bodyText.includes('今すぐ回答') ||
                                    bodyText.includes('Skip thinking');
      const isStillGenerating = Boolean(stopBtn) ||
        (hasGeneratingText && !hasThinkingComplete) || hasSkipThinkingButton;
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1] ||
        chatgptArticles[chatgptArticles.length - 1];
      let hasResponseText = false;
      if (lastAssistant) {
        const markdowns = lastAssistant.querySelectorAll('.markdown');
        for (const md of markdowns) {
          if (md.classList.contains('result-thinking')) continue;
          const text = (md.innerText || md.textContent || '').trim();
          if (text.length > 0) {
            hasResponseText = true;
            break;
          }
        }
        if (!hasResponseText) {
          const rt = lastAssistant.querySelector('.result-thinking');
          if (rt) {
            const text = (rt.innerText || rt.textContent || '').trim();
            hasResponseText = text.length > 0;
          }
        }
        if (!hasResponseText) {
          const paragraphs = lastAssistant.querySelectorAll('p');
          for (const p of paragraphs) {
            if (p.closest('button')) continue;
            const text = (p.innerText || p.textContent || '').trim();
            if (text.length > 0) {
              hasResponseText = true;
              break;
            }
          }
        }
      }
      if (!hasResponseText) {
        const mainEl = document.querySelector('main');
        if (mainEl) {
          const mainText = mainEl.innerText || '';
          const idx = mainText.lastIndexOf('ChatGPT:');
          if (idx >= 0) {
            let afterChatGPT = mainText.slice(idx + 8).trim();
            const endMarkers = ['あなた:', 'You:', '思考の拡張', 'ChatGPT の回答'];
            for (const m of endMarkers) {
              const endIdx = afterChatGPT.indexOf(m);
              if (endIdx > 0) afterChatGPT = afterChatGPT.slice(0, endIdx).trim();
            }
            if (afterChatGPT.length > 5 &&
                !afterChatGPT.startsWith('思考の拡張') &&
                !afterChatGPT.includes('cookie の設定')) {
              hasResponseText = true;
            }
          }
        }
      }
      const hasStreamingIndicator = Boolean(
        lastAssistant?.querySelector('.result-streaming') ||
        lastAssistant?.querySelector('.streaming-animation') ||
        lastAssistant?.querySelector('.markdown.streaming-animation')
      );
      const assistantCount = Math.max(assistantMsgs.length, chatgptArticles.length);
      const lastAssistantText = lastAssistant ?
        (lastAssistant.innerText || lastAssistant.textContent || '').trim() : '';
      if (lastAssistant) {
        try { lastAssistant.scrollIntoView({block: 'center'}); } catch {}
      }
      return {
        hasStopButton: Boolean(stopBtn),
        sendButtonFound: Boolean(sendBtn),
        sendButtonDisabled: sendBtn ? (
          sendBtn.disabled ||
          sendBtn.getAttribute('aria-disabled') === 'true' ||
          sendBtn.getAttribute('disabled') === 'true'
        ) : null,
        assistantMsgCount: assistantCount,
        inputBoxHasText: inputText.trim().length > 0,
        isStillGenerating,
        hasResponseText,
        hasSkipThinkingButton,
        hasStreamingIndicator,
        debug_lastAssistantInnerTextLen: lastAssistantText.length,
      };
    `);
  }

  private async readTimeoutState(): Promise<Record<string, unknown>> {
    return this.evaluateWithUtils<Record<string, unknown>>(`
      const stopBtn = document.querySelector('button[data-testid="stop-button"]') ||
                      document.querySelector('button[aria-label*="停止"]') ||
                      document.querySelector('button[aria-label*="Stop"]');
      const allButtons = Array.from(document.querySelectorAll('button'));
      const sendBtn = allButtons.find(b =>
        b.getAttribute('data-testid') === 'send-button' ||
        b.getAttribute('aria-label')?.includes('送信') ||
        b.getAttribute('aria-label')?.includes('Send')
      );
      const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const inputBox = document.querySelector('.ProseMirror[contenteditable="true"]') ||
                      document.querySelector('textarea#prompt-textarea');
      const inputText = inputBox ?
        (inputBox.tagName === 'TEXTAREA' ? inputBox.value : inputBox.textContent) || '' : '';
      return {
        hasStopButton: Boolean(stopBtn),
        sendButtonFound: Boolean(sendBtn),
        sendButtonDisabled: sendBtn ? sendBtn.disabled : null,
        sendButtonAriaDisabled: sendBtn ? sendBtn.getAttribute('aria-disabled') : null,
        assistantMsgCount: assistantMsgs.length,
        inputBoxHasText: inputText.trim().length > 0,
        url: location.href,
      };
    `);
  }

  private async captureStreamingText(): Promise<string> {
    return this.evaluateWithUtils<string>(`
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const chatgptArticles = [];
      for (const article of document.querySelectorAll('article')) {
        const heading = article.querySelector('h6, h5, [role="heading"]');
        if (heading && (heading.textContent || '').includes('ChatGPT')) {
          chatgptArticles.push(article);
        }
      }
      const last = msgs[msgs.length - 1] || chatgptArticles[chatgptArticles.length - 1];
      if (!last) return '';
      const md = last.querySelector('.markdown');
      if (md) {
        const t = (md.innerText || md.textContent || '').trim();
        if (t.length > 0) return t;
      }
      const rt = last.querySelector('.result-thinking');
      if (rt) {
        const t = (rt.innerText || rt.textContent || '').trim();
        if (t.length > 0) return t;
      }
      return (last.innerText || last.textContent || '').trim();
    `);
  }

  private async expandCollapsedThinking(): Promise<void> {
    const clickedExpand = await this.evaluateWithUtils<boolean>(`
      const articles = document.querySelectorAll('article');
      for (const article of articles) {
        const heading = article.querySelector('h6, h5, [role="heading"]');
        if (heading && (heading.textContent || '').includes('ChatGPT')) {
          const buttons = article.querySelectorAll('button');
          for (const btn of buttons) {
            const text = (btn.innerText || '').toLowerCase();
            if ((text.includes('思考時間') || text.includes('second') || text.includes('秒')) &&
                btn.getAttribute('aria-expanded') === 'false') {
              btn.click();
              return true;
            }
          }
        }
      }
      return false;
    `);
    if (clickedExpand) {
      await this.sleep(1000);
      this.log('Expanded thinking content');
    }
  }

  private async waitForFinalText(): Promise<void> {
    const client = this.getClient();
    const maxWaitForText = 15000;
    const pollInterval = 200;
    const waitStart = Date.now();
    let hasResponseText = false;

    try {
      await client.send('Page.enable');
      await client.send('Page.bringToFront');
      await this.sleep(500);
    } catch {
      this.log('Page.bringToFront failed, continuing anyway');
    }

    while (Date.now() - waitStart < maxWaitForText) {
      await this.evaluateWithUtils<void>(`
        const articles = document.querySelectorAll('article');
        for (let i = articles.length - 1; i >= 0; i--) {
          const heading = articles[i].querySelector('h6, h5, [role="heading"]');
          if (heading && (heading.textContent || '').includes('ChatGPT')) {
            articles[i].scrollIntoView({block: 'center', behavior: 'instant'});
            break;
          }
        }
      `);
      await this.sleep(100);
      const checkResult = await this.evaluateWithUtils<{
        hasText: boolean;
        textLength: number;
        articleIndex: number;
        markdownClass: string;
        hasSkipButton: boolean;
        isStreaming: boolean;
        debug?: string;
      }>(`
        const articles = document.querySelectorAll('article');
        let lastChatGPTArticle = null;
        let lastChatGPTWithText = null;
        let lastIndex = -1;
        let lastIndexWithText = -1;
        for (let i = 0; i < articles.length; i++) {
          const heading = articles[i].querySelector('h6, h5, [role="heading"]');
          if (heading && (heading.textContent || '').includes('ChatGPT')) {
            lastChatGPTArticle = articles[i];
            lastIndex = i;
            const md = articles[i].querySelector('.markdown:not(.result-thinking)');
            if (md && (md.innerText || '').trim().length > 0) {
              lastChatGPTWithText = articles[i];
              lastIndexWithText = i;
            }
          }
        }
        if (lastChatGPTWithText) {
          lastChatGPTArticle = lastChatGPTWithText;
          lastIndex = lastIndexWithText;
        }
        const bodyText = document.body?.innerText || '';
        const hasSkipButton = bodyText.includes('今すぐ回答') || bodyText.includes('Skip thinking');
        if (!lastChatGPTArticle) return {hasText: false, textLength: 0, articleIndex: -1, markdownClass: '', hasSkipButton, isStreaming: false, debug: 'no article'};
        const markdowns = lastChatGPTArticle.querySelectorAll('.markdown');
        const debugMd = Array.from(markdowns).map(md => ({
          cls: md.className.slice(0, 50),
          rt: md.classList.contains('result-thinking'),
          itLen: (md.innerText || '').length,
          tcLen: (md.textContent || '').length,
          html: (md.innerHTML || '').slice(0, 100),
        }));
        for (const md of markdowns) {
          if (md.classList.contains('result-thinking')) continue;
          const isStreaming = md.classList.contains('streaming-animation');
          const text = (md.innerText || md.textContent || '').trim();
          if (text.length > 0) return {hasText: true, textLength: text.length, articleIndex: lastIndex, markdownClass: md.className, hasSkipButton, isStreaming, debug: JSON.stringify(debugMd)};
        }
        for (const md of markdowns) {
          const text = (md.innerText || md.textContent || '').trim();
          if (text.length > 0) return {hasText: true, textLength: text.length, articleIndex: lastIndex, markdownClass: md.className, hasSkipButton, isStreaming: false, debug: JSON.stringify(debugMd)};
        }
        const paragraphs = lastChatGPTArticle.querySelectorAll('p');
        for (const p of paragraphs) {
          if (p.closest('button')) continue;
          const text = (p.innerText || p.textContent || '').trim();
          if (text.length > 0) return {hasText: true, textLength: text.length, articleIndex: lastIndex, markdownClass: 'p-element', hasSkipButton, isStreaming: false};
        }
        const articleText = (lastChatGPTArticle.innerText || '').trim();
        const cleanedText = articleText
          .replace(/^ChatGPT:?\\s*/i, '')
          .replace(/思考時間[：:]\\s*\\d+s?/g, '')
          .replace(/今すぐ回答/g, '')
          .replace(/Skip thinking/g, '')
          .trim();
        if (cleanedText.length > 10) {
          return {hasText: true, textLength: cleanedText.length, articleIndex: lastIndex, markdownClass: 'article-fallback', hasSkipButton, isStreaming: false, debug: JSON.stringify(debugMd)};
        }
        return {hasText: false, textLength: 0, articleIndex: lastIndex, markdownClass: '', hasSkipButton, isStreaming: false, debug: JSON.stringify(debugMd)};
      `);

      if (checkResult.hasSkipButton) {
        await this.sleep(pollInterval);
        continue;
      }
      if (checkResult.hasText) {
        if (checkResult.isStreaming) {
          await this.sleep(pollInterval);
          continue;
        }
        hasResponseText = true;
        this.log(
          `Response text ready (${checkResult.textLength} chars) in article[${checkResult.articleIndex}] (${checkResult.markdownClass}) after ${Date.now() - waitStart}ms`,
        );
        break;
      }
      const elapsed = Date.now() - waitStart;
      if (elapsed > 0 && elapsed % 2000 < pollInterval) {
        this.log(
          `Still waiting for response text (${elapsed}ms, articleIndex=${checkResult.articleIndex}, debug=${checkResult.debug || 'none'})`,
        );
      }
      await this.sleep(pollInterval);
    }

    if (!hasResponseText) {
      this.log(
        `Warning: Response text not detected after ${maxWaitForText}ms, proceeding with extraction`,
      );
    }
  }

  private async readExtractDebug(): Promise<{
    lastArticleDebug: unknown;
  }> {
    return this.evaluateWithUtils(`
      const articles = Array.from(document.querySelectorAll('article'));
      let chatgptCount = 0;
      let lastChatGPT = null;
      let lastIndex = -1;
      for (let i = 0; i < articles.length; i++) {
        const heading = articles[i].querySelector('h6, h5, [role="heading"]');
        if (heading && (heading.textContent || '').includes('ChatGPT')) {
          chatgptCount++;
          lastChatGPT = articles[i];
          lastIndex = i;
        }
      }
      if (!lastChatGPT) return {lastArticleDebug: null};
      const markdowns = lastChatGPT.querySelectorAll('.markdown');
      const mdInfos = [];
      for (const md of markdowns) {
        mdInfos.push({
          className: md.className,
          innerTextLength: (md.innerText || '').length,
          isResultThinking: md.classList.contains('result-thinking'),
        });
      }
      return {
        lastArticleDebug: {
          index: lastIndex,
          markdownCount: markdowns.length,
          markdowns: mdInfos,
          paragraphCount: lastChatGPT.querySelectorAll('p').length,
          articleInnerTextLength: (lastChatGPT.innerText || '').length,
          articleInnerTextPreview: (lastChatGPT.innerText || '').substring(0, 100),
          chatgptArticles: chatgptCount,
        },
      };
    `);
  }

  private async extractFromAssistantArticle(): Promise<{
    text: string;
    evidence: string;
  }> {
    return this.evaluateWithUtils(`
      const articles = document.querySelectorAll('article');
      let lastAssistantArticle = null;
      let lastAssistantWithText = null;
      for (const article of articles) {
        const heading = article.querySelector('h6, h5, [role="heading"]');
        if (heading && (heading.textContent || '').includes('ChatGPT')) {
          lastAssistantArticle = article;
          const md = article.querySelector('.markdown:not(.result-thinking)');
          if (md && (md.innerText || '').trim().length > 0) {
            lastAssistantWithText = article;
          }
        }
      }
      lastAssistantArticle = lastAssistantWithText || lastAssistantArticle;
      if (!lastAssistantArticle) {
        const old = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (old.length > 0) lastAssistantArticle = old[old.length - 1];
      }
      if (!lastAssistantArticle) return {text: '', evidence: 'no-assistant-message'};
      const allMarkdowns = lastAssistantArticle.querySelectorAll('.markdown');
      for (const md of allMarkdowns) {
        if (md.classList.contains('result-thinking')) continue;
        const text = (md.innerText || md.textContent || '').trim();
        if (text.length > 0) return {text, evidence: '.markdown:not(.result-thinking)'};
      }
      const thinking = lastAssistantArticle.querySelector('.result-thinking.markdown, .result-thinking');
      if (thinking) {
        const text = (thinking.innerText || thinking.textContent || '').trim();
        if (text.length > 0) return {text, evidence: '.result-thinking'};
      }
      const fallbackSelectors = [
        '.prose:not(.result-thinking)',
        '[class*="markdown"]:not(.result-thinking)',
        '.whitespace-pre-wrap',
      ];
      for (const sel of fallbackSelectors) {
        const elem = lastAssistantArticle.querySelector(sel);
        if (elem) {
          const text = (elem.innerText || elem.textContent || '').trim();
          if (text.length > 0) return {text, evidence: sel};
        }
      }
      const contentDivs = lastAssistantArticle.querySelectorAll(':scope > div > div');
      for (const div of contentDivs) {
        if (div.tagName === 'BUTTON') continue;
        const paragraphs = div.querySelectorAll('p');
        if (paragraphs.length > 0) {
          const text = Array.from(paragraphs)
            .map(p => (p.innerText || p.textContent || '').trim())
            .filter(t => t.length > 0)
            .join('\\n\\n');
          if (text.length > 0) return {text, evidence: 'content-div-p'};
        }
      }
      const paragraphs = lastAssistantArticle.querySelectorAll('p');
      if (paragraphs.length > 0) {
        const text = Array.from(paragraphs)
          .filter(p => !p.closest('button'))
          .map(p => (p.innerText || p.textContent || '').trim())
          .filter(t => t.length > 0)
          .join('\\n\\n');
        if (text.length > 0) return {text, evidence: 'p-elements'};
      }
      const fullText = (lastAssistantArticle.innerText || lastAssistantArticle.textContent || '').trim();
      const cleaned = fullText
        .replace(/^ChatGPT:\\s*/i, '')
        .split('\\n')
        .filter(line => {
          const trimmed = line.trim();
          if (/^思考時間:\\s*\\d+s?$/.test(trimmed)) return false;
          if (trimmed === '思考中') return false;
          if (trimmed === '今すぐ回答') return false;
          if (trimmed === 'Skip thinking') return false;
          return true;
        })
        .join('\\n')
        .trim();
      return {text: cleaned, evidence: 'article-fallback'};
    `);
  }

  private async extractFromMain(): Promise<{text: string; evidence: string}> {
    return this.evaluateWithUtils(`
      const mainEl = document.querySelector('main');
      if (!mainEl) return {text: '', evidence: 'no-main'};
      const mainText = mainEl.innerText || '';
      const parts = mainText.split('ChatGPT:');
      if (parts.length < 2) return {text: '', evidence: 'main-no-chatgpt-marker'};
      const lastPart = parts[parts.length - 1];
      const endMarkers = ['あなた:', 'You:', 'cookie', 'ChatGPT の回答は必ずしも'];
      const invalidStartMarkers = ['思考の拡張', '質問してみましょう', 'ChatGPT の回答'];
      let endIndex = lastPart.length;
      for (const marker of endMarkers) {
        const idx = lastPart.indexOf(marker);
        if (idx > 10 && idx < endIndex) endIndex = idx;
      }
      const result = lastPart.slice(0, endIndex).trim();
      for (const invalid of invalidStartMarkers) {
        if (result.startsWith(invalid)) return {text: '', evidence: 'main-invalid-start'};
      }
      if (!result || result === '\\n' || result.length < 2) return {text: '', evidence: 'main-empty'};
      return {text: result, evidence: 'main-fallback'};
    `);
  }

  private async extractFromBody(): Promise<{text: string; evidence: string}> {
    return this.evaluateWithUtils(`
      const bodyText = document.body.innerText || '';
      const parts = bodyText.split('ChatGPT:');
      if (parts.length < 2) return {text: '', evidence: 'body-no-chatgpt-marker'};
      const lastPart = parts[parts.length - 1];
      const endMarkers = ['あなた:', 'You:', 'cookie', 'ChatGPT は間違えることがあります'];
      const invalidStartMarkers = ['思考の拡張', '質問してみましょう', 'ChatGPT の回答'];
      let endIndex = lastPart.length;
      for (const marker of endMarkers) {
        const idx = lastPart.indexOf(marker);
        if (idx > 10 && idx < endIndex) endIndex = idx;
      }
      const result = lastPart.slice(0, endIndex).trim();
      for (const invalid of invalidStartMarkers) {
        if (result.startsWith(invalid)) return {text: '', evidence: 'body-invalid-start'};
      }
      return {text: result, evidence: 'body-fallback'};
    `);
  }

  /**
   * Check if login is required
   */
  async needsLogin(): Promise<boolean> {
    return this.evaluateWithUtils<boolean>(`
      const url = location.href;
      if (url.includes('auth0.openai.com') || url.includes('/auth/login')) {
        return true;
      }

      const bodyText = document.body?.innerText || '';
      return bodyText.includes('Log in') && bodyText.includes('Sign up') &&
             !document.querySelector('[data-message-author-role]');
    `);
  }
}

/**
 * Driver metadata for registration
 */
export const CHATGPT_DRIVER_META = {
  name: 'chatgpt',
  urlPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  description: 'ChatGPT by OpenAI',
};

/**
 * Factory function for creating ChatGPT driver instances
 */
export function createChatGPTDriver(): ChatGPTDriver {
  return new ChatGPTDriver();
}
