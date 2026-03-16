/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type {Context} from '../tools/ToolDefinition.js';

export function getFastContext(): Context {
  return {
    isRunningPerformanceTrace: () => false,
    setIsRunningPerformanceTrace: () => {
      /* no-op */
    },
    recordedTraces: () => [],
    storeTraceRecording: () => {
      /* no-op */
    },
    getSelectedPage: () => {
      throw new Error('Fast context: no page');
    },
    getPages: () => [],
    createPagesSnapshot: async () => [],
    getDialog: () => undefined,
    clearDialog: () => {
      /* no-op */
    },
    getPageByIdx: () => {
      throw new Error('Fast context: no pages');
    },
    newPage: async () => {
      throw new Error('Fast context: newPage not supported');
    },
    closePage: async () => {
      throw new Error('Fast context: closePage not supported');
    },
    setSelectedPageIdx: () => {
      /* no-op */
    },
    getElementByUid: async () => {
      throw new Error('Fast context: getElementByUid not supported');
    },
    setNetworkConditions: () => {
      /* no-op */
    },
    setCpuThrottlingRate: () => {
      /* no-op */
    },
    saveTemporaryFile: async () => {
      throw new Error('Fast context: saveTemporaryFile not supported');
    },
    waitForEventsAfterAction: async () => {
      /* no-op */
    },
  };
}
