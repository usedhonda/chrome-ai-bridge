/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cpSync, mkdirSync} from 'node:fs';

// Keep the explicit legacy package usable. Building never opens or reloads Chrome.
mkdirSync(new URL('../build/', import.meta.url), {recursive: true});
cpSync(
  new URL('../src/extension/', import.meta.url),
  new URL('../build/extension/', import.meta.url),
  {recursive: true},
);
