/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {cliOptions} from '../build/src/cli.js';
import {ToolCategories} from '../build/src/tools/categories.js';

const SERVER_PATH = 'build/src/index.js';
const OUTPUT_PATH = './docs/tool-reference.md';
const README_PATH = './README.md';

// Tool type matching the server's tool definition schema
interface ToolWithAnnotations {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    category?: ToolCategories;
  };
}

function escapeHtmlTags(text: string): string {
  return text
    .replace(/&(?![a-zA-Z]+;)/g, '&amp;')
    .replace(/<([a-zA-Z][^>]*)>/g, '&lt;$1&gt;');
}

function addCrossLinks(text: string, tools: ToolWithAnnotations[]): string {
  let result = text;

  // Create a set of all tool names for efficient lookup
  const toolNames = new Set(tools.map(tool => tool.name));

  // Sort tool names by length (descending) to match longer names first
  const sortedToolNames = Array.from(toolNames).sort(
    (a, b) => b.length - a.length,
  );

  for (const toolName of sortedToolNames) {
    // Create regex to match tool name (case insensitive, word boundaries)
    const regex = new RegExp(`\\b${toolName.replace(/_/g, '_')}\\b`, 'gi');

    result = result.replace(regex, match => {
      // Only create link if the match isn't already inside a link
      if (result.indexOf(`[${match}]`) !== -1) {
        return match; // Already linked
      }
      const anchorLink = toolName.toLowerCase();
      return `[\`${match}\`](#${anchorLink})`;
    });
  }

  return result;
}

function generateToolsTOC(
  categories: Record<string, ToolWithAnnotations[]>,
  sortedCategories: string[],
): string {
  let toc = '';

  for (const category of sortedCategories) {
    const categoryTools = categories[category];
    const categoryName = category;
    toc += `- **${categoryName}** (${categoryTools.length} tools)\n`;

    // Sort tools within category for TOC
    categoryTools.sort((a: ToolWithAnnotations, b: ToolWithAnnotations) =>
      a.name.localeCompare(b.name),
    );
    for (const tool of categoryTools) {
      const anchorLink = tool.name.toLowerCase();
      toc += `  - [\`${tool.name}\`](docs/tool-reference.md#${anchorLink})\n`;
    }
  }

  return toc;
}

function updateReadmeWithToolsTOC(toolsTOC: string): void {
  const readmeContent = fs.readFileSync(README_PATH, 'utf8');

  const beginMarker = '<!-- BEGIN AUTO GENERATED TOOLS -->';
  const endMarker = '<!-- END AUTO GENERATED TOOLS -->';

  const beginIndex = readmeContent.indexOf(beginMarker);
  const endIndex = readmeContent.indexOf(endMarker);

  if (beginIndex === -1 || endIndex === -1) {
    console.warn('Could not find auto-generated tools markers in README.md');
    return;
  }

  const before = readmeContent.substring(0, beginIndex + beginMarker.length);
  const after = readmeContent.substring(endIndex);

  const updatedContent = before + '\n\n' + toolsTOC + '\n' + after;

  fs.writeFileSync(README_PATH, updatedContent);
  console.log('Updated README.md with tools table of contents');
}

function generateConfigOptionsMarkdown(): string {
  let markdown = '';

  for (const [optionName, optionConfig] of Object.entries(cliOptions)) {
    // Skip hidden options
    if (optionConfig.hidden) {
      continue;
    }

    const aliasText = optionConfig.alias ? `, \`-${optionConfig.alias}\`` : '';
    const description = optionConfig.description || optionConfig.describe || '';

    // Start with option name and description
    markdown += `- **\`--${optionName}\`${aliasText}**\n`;
    markdown += `  ${description}\n`;

    // Add type information
    markdown += `  - **Type:** ${optionConfig.type}\n`;

    // Add choices if available
    if (optionConfig.choices) {
      markdown += `  - **Choices:** ${optionConfig.choices.map(c => `\`${c}\``).join(', ')}\n`;
    }

    // Add default if available
    if (optionConfig.default !== undefined) {
      markdown += `  - **Default:** \`${optionConfig.default}\`\n`;
    }

    markdown += '\n';
  }

  return markdown.trim();
}

function updateReadmeWithOptionsMarkdown(optionsMarkdown: string): void {
  const readmeContent = fs.readFileSync(README_PATH, 'utf8');

  const beginMarker = '<!-- BEGIN AUTO GENERATED OPTIONS -->';
  const endMarker = '<!-- END AUTO GENERATED OPTIONS -->';

  const beginIndex = readmeContent.indexOf(beginMarker);
  const endIndex = readmeContent.indexOf(endMarker);

  if (beginIndex === -1 || endIndex === -1) {
    console.warn('Could not find auto-generated options markers in README.md');
    return;
  }

  const before = readmeContent.substring(0, beginIndex + beginMarker.length);
  const after = readmeContent.substring(endIndex);

  const updatedContent = before + '\n\n' + optionsMarkdown + '\n\n' + after;

  fs.writeFileSync(README_PATH, updatedContent);
  console.log('Updated README.md with options markdown');
}

/**
 * Spawn the server and exchange JSON-RPC messages over stdio to list tools.
 * This replaces the previous MCP SDK client dependency.
 */
async function queryToolsViaJsonRpc(): Promise<ToolWithAnnotations[]> {
  const {spawn} = await import('node:child_process');

  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_PATH, '--channel', 'canary'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let buffer = '';
    let msgId = 0;

    function send(method: string, params: Record<string, unknown> = {}) {
      const id = ++msgId;
      const msg = JSON.stringify({jsonrpc: '2.0', id, method, params});
      child.stdin!.write(
        `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`,
      );
      return id;
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Parse JSON-RPC responses from the Content-Length framed stream
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) break;

        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + contentLength) break;

        const body = buffer.slice(bodyStart, bodyStart + contentLength);
        buffer = buffer.slice(bodyStart + contentLength);

        try {
          const msg = JSON.parse(body);
          if (msg.result?.tools) {
            child.kill('SIGTERM');
            resolve(msg.result.tools as ToolWithAnnotations[]);
          }
        } catch {
          // skip malformed messages
        }
      }
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code !== null && code !== 0) {
        reject(new Error(`Server exited with code ${code}`));
      }
    });

    // Send initialize, then list tools
    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {name: 'docs-generator', version: '1.0.0'},
    });

    // Small delay to let initialization complete before listing tools
    setTimeout(() => {
      send('notifications/initialized');
      send('tools/list');
    }, 500);

    // Timeout after 30s
    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Timed out waiting for tools/list response'));
    }, 30_000);
  });
}

async function generateToolDocumentation(): Promise<void> {
  console.log('Starting server to query tool definitions...');

  try {
    let tools: ToolWithAnnotations[];
    try {
      tools = await queryToolsViaJsonRpc();
    } catch (rpcError) {
      // In CI or environments without Chrome, server cannot list tools.
      // Skip tool doc generation and only update config options / README.
      console.warn(
        `Warning: Could not query tools from server (${rpcError instanceof Error ? rpcError.message : String(rpcError)}). Skipping tool reference generation.`,
      );
      const optionsMarkdown = generateConfigOptionsMarkdown();
      updateReadmeWithOptionsMarkdown(optionsMarkdown);
      process.exit(0);
    }
    const toolsWithAnnotations = tools;
    console.log(`Found ${tools.length} tools`);

    // Generate markdown documentation
    let markdown = `<!-- AUTO GENERATED DO NOT EDIT - run 'npm run docs' to update-->

# Chrome AI Bridge Tool Reference

`;

    // Group tools by category (based on annotations)
    const categories: Record<string, ToolWithAnnotations[]> = {};
    toolsWithAnnotations.forEach((tool: ToolWithAnnotations) => {
      const category = tool.annotations?.category || 'Uncategorized';
      if (!categories[category]) {
        categories[category] = [];
      }
      categories[category].push(tool);
    });

    // Sort categories using the enum order
    const categoryOrder = Object.values(ToolCategories);
    const sortedCategories = Object.keys(categories).sort((a, b) => {
      const aIndex = categoryOrder.indexOf(a);
      const bIndex = categoryOrder.indexOf(b);
      // Put known categories first, unknown categories last
      if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });

    // Generate table of contents
    for (const category of sortedCategories) {
      const categoryTools = categories[category];
      const categoryName = category;
      const anchorName = category.toLowerCase().replace(/\s+/g, '-');
      markdown += `- **[${categoryName}](#${anchorName})** (${categoryTools.length} tools)\n`;

      // Sort tools within category for TOC
      categoryTools.sort((a: ToolWithAnnotations, b: ToolWithAnnotations) =>
        a.name.localeCompare(b.name),
      );
      for (const tool of categoryTools) {
        // Generate proper markdown anchor link: backticks are removed, keep underscores, lowercase
        const anchorLink = tool.name.toLowerCase();
        markdown += `  - [\`${tool.name}\`](#${anchorLink})\n`;
      }
    }
    markdown += '\n';

    for (const category of sortedCategories) {
      const categoryTools = categories[category];

      markdown += `## ${category}\n\n`;

      // Sort tools within category
      categoryTools.sort((a: ToolWithAnnotations, b: ToolWithAnnotations) =>
        a.name.localeCompare(b.name),
      );

      for (const tool of categoryTools) {
        markdown += `### \`${tool.name}\`\n\n`;

        if (tool.description) {
          // Escape HTML tags but preserve JS function syntax
          let escapedDescription = escapeHtmlTags(tool.description);

          // Add cross-links to mentioned tools
          escapedDescription = addCrossLinks(
            escapedDescription,
            toolsWithAnnotations,
          );
          markdown += `**Description:** ${escapedDescription}\n\n`;
        }

        // Handle input schema
        if (
          tool.inputSchema &&
          tool.inputSchema.properties &&
          Object.keys(tool.inputSchema.properties).length > 0
        ) {
          const properties = tool.inputSchema.properties;
          const required = tool.inputSchema.required || [];

          markdown += '**Parameters:**\n\n';

          const propertyNames = Object.keys(properties).sort();
          for (const propName of propertyNames) {
            const prop = properties[propName] as string;
            const isRequired = required.includes(propName);
            const requiredText = isRequired
              ? ' **(required)**'
              : ' _(optional)_';

            let typeInfo = prop.type || 'unknown';
            if (prop.enum) {
              typeInfo = `enum: ${prop.enum.map(v => `"${v}"`).join(', ')}`;
            }

            markdown += `- **${propName}** (${typeInfo})${requiredText}`;
            if (prop.description) {
              let escapedParamDesc = escapeHtmlTags(prop.description);

              // Add cross-links to mentioned tools
              escapedParamDesc = addCrossLinks(
                escapedParamDesc,
                toolsWithAnnotations,
              );
              markdown += `: ${escapedParamDesc}`;
            }
            markdown += '\n';
          }
          markdown += '\n';
        } else {
          markdown += '**Parameters:** None\n\n';
        }

        markdown += '---\n\n';
      }
    }

    // Write the documentation to file (create directory if needed)
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, {recursive: true});
    }
    fs.writeFileSync(OUTPUT_PATH, markdown.trim() + '\n');

    console.log(
      `Generated documentation for ${toolsWithAnnotations.length} tools in ${OUTPUT_PATH}`,
    );

    // Generate tools TOC and update README
    const toolsTOC = generateToolsTOC(categories, sortedCategories);
    updateReadmeWithToolsTOC(toolsTOC);

    // Generate and update configuration options
    const optionsMarkdown = generateConfigOptionsMarkdown();
    updateReadmeWithOptionsMarkdown(optionsMarkdown);

    process.exit(0);
  } catch (error) {
    console.error('Error generating documentation:', error);
    process.exit(1);
  }
}

// Run the documentation generator
generateToolDocumentation().catch(console.error);
