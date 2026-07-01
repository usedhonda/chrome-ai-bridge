/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Gemini Driver
 *
 * Handles Gemini-specific DOM interactions for sending prompts
 * and extracting responses. Gemini uses Shadow DOM extensively.
 */

import {BaseDriver} from '../../core/base-driver.js';
import type {
  DriverSelectors,
  SendResult,
  ExtractResult,
  DriverOptions,
} from '../types.js';

import {GEMINI_SELECTORS} from './selectors.js';

/**
 * Gemini Site Driver
 */
export class GeminiDriver extends BaseDriver {
  readonly name = 'gemini';
  readonly selectors: DriverSelectors = GEMINI_SELECTORS;

  /**
   * Send a prompt to Gemini
   */
  async sendPrompt(text: string): Promise<SendResult> {
    const sanitized = JSON.stringify(text);

    // Input the text using Shadow DOM traversal
    const inputResult = await this.evaluateWithUtils<{
      ok: boolean;
      error?: string;
    }>(`
      const text = ${sanitized};
      const textbox = __collectDeep(['[role="textbox"]', 'div[contenteditable="true"]', 'textarea']).nodes[0];

      if (!textbox) {
        return {ok: false, error: 'Textbox not found'};
      }

      textbox.focus();

      if (textbox.isContentEditable) {
        textbox.innerText = '';
        textbox.innerText = text;
        textbox.dispatchEvent(new Event('input', {bubbles: true}));
        textbox.dispatchEvent(new Event('change', {bubbles: true}));
        return {ok: true};
      }

      if ('value' in textbox) {
        textbox.value = text;
        textbox.dispatchEvent(new Event('input', {bubbles: true}));
        textbox.dispatchEvent(new Event('change', {bubbles: true}));
        return {ok: true};
      }

      return {ok: false, error: 'Unknown textbox type'};
    `);

    if (!inputResult.ok) {
      return {
        success: false,
        error: inputResult.error || 'Failed to input text',
      };
    }

    // Wait for input to be processed
    await this.sleep(200);

    // Find and click send button
    const clickResult = await this.evaluateWithUtils<{
      clicked: boolean;
      error?: string;
    }>(`
      const buttons = __collectDeep(['button', '[role="button"]']).nodes
        .filter(__isVisible)
        .filter(el => !__isDisabled(el));

      // Try to find send button
      let sendButton = buttons.find(b =>
        (b.textContent || '').includes('プロンプトを送信') ||
        (b.textContent || '').includes('送信') ||
        (b.getAttribute('aria-label') || '').includes('送信') ||
        (b.getAttribute('aria-label') || '').includes('Send')
      );

      if (!sendButton) {
        sendButton = buttons.find(b =>
          b.querySelector('mat-icon[data-mat-icon-name="send"]') ||
          b.querySelector('[data-icon="send"]')
        );
      }

      if (!sendButton) {
        return {clicked: false, error: 'Send button not found'};
      }

      // Click the button
      sendButton.click();
      return {clicked: true};
    `);

    if (!clickResult.clicked) {
      return {
        success: false,
        error: clickResult.error || 'Failed to click send button',
      };
    }

    this.log('Prompt sent');
    return {success: true};
  }

  /**
   * Check if Gemini is currently processing
   */
  async isProcessing(): Promise<boolean> {
    return this.evaluateWithUtils<boolean>(`
      const buttons = __collectDeep(['button', '[role="button"]']).nodes.filter(__isVisible);

      // Check for stop button by aria-label
      const hasStopByLabel = buttons.some(b => {
        const label = (b.getAttribute('aria-label') || '').trim();
        return label.includes('回答を停止') || label.includes('Stop generating') ||
               label.includes('Stop streaming') || label === 'Stop';
      });
      if (hasStopByLabel) return true;

      // Check for stop icon
      const stopIcons = __collectDeep(['mat-icon[data-mat-icon-name="stop"]']).nodes;
      for (const stopIcon of stopIcons) {
        const btn = stopIcon.closest('button');
        if (btn && __isVisible(btn)) return true;
      }

      // Check for stop img
      const stopImgs = __collectDeep(['img[alt="stop"]']).nodes;
      for (const stopImg of stopImgs) {
        const btn = stopImg.closest('button');
        if (btn && __isVisible(btn)) return true;
      }

      return false;
    `);
  }

  /**
   * Extended wait that also checks for feedback buttons
   */
  override async waitForResponse(options?: DriverOptions): Promise<void> {
    const maxWaitMs = options?.maxWaitMs ?? 480000;
    const pollIntervalMs = 500;
    const startTime = Date.now();
    const initialModelResponseCount =
      (options as {initialModelResponseCount?: number} | undefined)
        ?.initialModelResponseCount ?? 0;

    let sawStopButton = false;
    let lastTextLength = 0;
    let textStableCount = 0;
    let lastState:
      | {
          hasStopButton: boolean;
          hasMicButton: boolean;
          hasFeedbackButtons: boolean;
          sendButtonEnabled: boolean;
          modelResponseCount: number;
          lastResponseTextLength: number;
          inputBoxEmpty: boolean;
        }
      | undefined;

    while (Date.now() - startTime < maxWaitMs) {
      const state = await this.evaluateWithUtils<{
        hasStopButton: boolean;
        hasMicButton: boolean;
        hasFeedbackButtons: boolean;
        sendButtonEnabled: boolean;
        modelResponseCount: number;
        lastResponseTextLength: number;
        inputBoxEmpty: boolean;
      }>(`
        const buttons = __collectDeep(['button', '[role="button"]']).nodes.filter(__isVisible);

        // Stop button check
        const hasStopButton = (() => {
          const stopByLabel = buttons.some(b => {
            const label = (b.getAttribute('aria-label') || '').trim();
            return label.includes('回答を停止') || label.includes('Stop generating') ||
                   label.includes('Stop streaming') || label === 'Stop';
          });
          if (stopByLabel) return true;

          const stopIcons = __collectDeep(['mat-icon[data-mat-icon-name="stop"]']).nodes;
          for (const stopIcon of stopIcons) {
            const btn = stopIcon.closest('button');
            if (btn && __isVisible(btn)) return true;
          }
          return false;
        })();

        const micButton = (() => {
          const micImgs = __collectDeep(['img[alt="mic"]']).nodes;
          for (const micImg of micImgs) {
            const btn = micImg.closest('button');
            if (btn && __isVisible(btn)) return btn;
          }
          return buttons.find(b => {
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            return label.includes('マイク') ||
                   label.includes('mic') ||
                   label.includes('microphone') ||
                   label.includes('voice');
          });
        })();

        const sendBtn = buttons.find(b =>
          (b.textContent || '').includes('プロンプトを送信') ||
          (b.textContent || '').includes('送信') ||
          (b.getAttribute('aria-label') || '').includes('送信') ||
          (b.getAttribute('aria-label') || '').includes('Send') ||
          b.querySelector('mat-icon[data-mat-icon-name="send"]') ||
          b.querySelector('[data-icon="send"]')
        );

        // Feedback buttons (indicate completion)
        const feedbackImgs = __collectDeep(['img[alt="thumb_up"]', 'img[alt="thumb_down"]']).nodes;
        const hasFeedbackButtons = feedbackImgs.length > 0 ||
          buttons.some(b => {
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            return label.includes('良い回答') || label.includes('悪い回答') ||
                   label.includes('good') || label.includes('bad');
          });

        // Response text length
        const allResponses = __collectDeep(['model-response', '[data-test-id*="response"]', '.response', '.model-response']).nodes;
        const lastResponse = allResponses[allResponses.length - 1];
        const lastResponseTextLength = lastResponse ? (lastResponse.innerText || lastResponse.textContent || '').length : 0;

        const inputSelectors = ['rich-textarea textarea', '.ql-editor', '[contenteditable="true"]', 'textarea'];
        let inputBoxEmpty = true;
        for (const sel of inputSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const text = el.tagName === 'TEXTAREA' ? el.value : (el.textContent || '');
            if (text.trim().length > 0) {
              inputBoxEmpty = false;
              break;
            }
          }
        }

        return {
          hasStopButton,
          hasMicButton: Boolean(micButton && __isVisible(micButton)),
          hasFeedbackButtons,
          sendButtonEnabled: Boolean(sendBtn && !__isDisabled(sendBtn)),
          modelResponseCount: allResponses.length,
          lastResponseTextLength,
          inputBoxEmpty,
        };
      `);
      lastState = state;

      if (state.hasStopButton) {
        sawStopButton = true;
      }

      // Check for completion conditions
      if (
        sawStopButton &&
        !state.hasStopButton &&
        state.hasFeedbackButtons &&
        state.modelResponseCount > initialModelResponseCount
      ) {
        this.log(
          'Response complete (stop button disappeared, feedback visible)',
        );
        return;
      }

      if (
        sawStopButton &&
        !state.hasStopButton &&
        state.hasMicButton &&
        state.modelResponseCount > initialModelResponseCount
      ) {
        this.log('Response complete (stop button disappeared, mic visible)');
        return;
      }

      if (
        sawStopButton &&
        !state.hasStopButton &&
        state.sendButtonEnabled &&
        state.inputBoxEmpty &&
        state.modelResponseCount > initialModelResponseCount
      ) {
        this.log('Response complete (stop button disappeared, send enabled)');
        return;
      }

      // Text stability check
      if (
        state.lastResponseTextLength === lastTextLength &&
        lastTextLength > 0
      ) {
        textStableCount++;
        if (
          textStableCount >= 10 &&
          state.modelResponseCount > initialModelResponseCount &&
          !state.hasStopButton
        ) {
          this.log('Response complete (text stable)');
          return;
        }
      } else {
        textStableCount = 0;
        lastTextLength = state.lastResponseTextLength;
      }

      await this.sleep(pollIntervalMs);
    }

    if (lastState?.hasStopButton) {
      throw new Error(
        'GEMINI_STUCK_STOP_BUTTON: Previous response appears stuck. Session cleared, please retry.',
      );
    }

    throw new Error(`Gemini: Timed out waiting for response (${maxWaitMs}ms)`);
  }

  /**
   * Extract the latest response from Gemini
   */
  async extractResponse(_options?: DriverOptions): Promise<ExtractResult> {
    const result = await this.evaluateWithUtils<{
      text: string;
      evidence: string;
    }>(`
      // Method 1: Find response via feedback button location
      const feedbackImgs = __collectDeep(['img[alt="thumb_up"]', 'img[alt="thumb_down"]']).nodes;
      const thumbUpImg = feedbackImgs.find(img => img.alt === 'thumb_up') || feedbackImgs[0];

      if (thumbUpImg) {
        let container = thumbUpImg.closest('button')?.parentElement;
        if (container) {
          const parent = container.parentElement;
          if (parent) {
            const textElements = parent.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, code');
            const texts = Array.from(textElements)
              .map(el => (el.innerText || el.textContent || '').trim())
              .filter(t => t.length > 0);

            if (texts.length > 0) {
              return {text: texts.join('\\n\\n'), evidence: 'thumb_up-parent'};
            }

            // Fallback: clone and clean
            const clone = parent.cloneNode(true);
            clone.querySelectorAll('button, img').forEach(el => el.remove());
            const text = (clone.innerText || clone.textContent || '').trim();
            if (text.length > 0) {
              return {text, evidence: 'thumb_up-parent-cleaned'};
            }
          }
        }
      }

      // Method 2: Traditional selector-based approach
      const allResponses = __collectDeep(['model-response', '[data-test-id*="response"]', '.response', '.model-response']).nodes;

      if (allResponses.length === 0) {
        // Method 3: aria-live polite region
        const live = document.querySelector('[aria-live="polite"]');
        return live
          ? {text: (live.innerText || live.textContent || '').trim(), evidence: 'aria-live'}
          : {text: '', evidence: 'no-response-found'};
      }

      const lastMsg = allResponses[allResponses.length - 1];
      const content = lastMsg.querySelector?.('.markdown') || lastMsg;
      const text = (content.innerText || content.textContent || '').trim();

      return {text, evidence: 'model-response'};
    `);

    return {
      text: result.text,
      confidence: result.text.length > 0 ? 0.8 : 0.0,
      evidence: result.evidence,
    };
  }

  /**
   * Check if login is required
   */
  async needsLogin(): Promise<boolean> {
    return this.evaluateWithUtils<boolean>(`
      const url = location.href;
      if (url.includes('accounts.google.com')) return true;

      const textbox = __collectDeep(['[role="textbox"]', 'div[contenteditable="true"]', 'textarea']).nodes
        .find(__isVisible);
      if (textbox) return false;

      // Check for Google login redirect
      const hasLoginLink = !!document.querySelector('a[href*="accounts.google.com"]');

      // Check for sign-in text
      const bodyText = document.body?.innerText || '';
      const hasSignInText = bodyText.includes('Sign in') && bodyText.includes('Google');

      return hasLoginLink || hasSignInText;
    `);
  }
}

/**
 * Driver metadata for registration
 */
export const GEMINI_DRIVER_META = {
  name: 'gemini',
  urlPatterns: ['https://gemini.google.com/*'],
  description: 'Gemini by Google',
};

/**
 * Factory function for creating Gemini driver instances
 */
export function createGeminiDriver(): GeminiDriver {
  return new GeminiDriver();
}
