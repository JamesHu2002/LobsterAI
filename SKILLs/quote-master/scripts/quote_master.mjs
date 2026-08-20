#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = process.env.QUOTE_MASTER_BASE_URL || 'http://127.0.0.1:8000/api';
const STATE_DIR = process.env.QUOTE_MASTER_STATE_DIR || path.join(os.tmpdir(), 'lobsterai-quote-master');
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');

const OPTIONS = {
  'base-url': { type: 'string' },
  username: { type: 'string' },
  password: { type: 'string' },
  'project-name': { type: 'string' },
  'raw-text': { type: 'string' },
  'input-channel': { type: 'string' },
  'intake-id': { type: 'string' },
  file: { type: 'string' },
  category: { type: 'string' },
  'source-doc-id': { type: 'string', multiple: true },
  'input-mode': { type: 'string' },
  'quote-id': { type: 'string' },
  'quote-line-id': { type: 'string' },
  'unit-price': { type: 'string' },
  quantity: { type: 'string' },
  'cycle-days': { type: 'string' },
  'line-status': { type: 'string' },
  'pricing-basis': { type: 'string' },
  'customer-id': { type: 'string' },
  'customer-name-snapshot': { type: 'string' },
  'selection-mode': { type: 'string' },
  out: { type: 'string' },
  timeout: { type: 'string' },
  interval: { type: 'string' },
  'target-status': { type: 'string' },
  keyword: { type: 'string' },
  status: { type: 'string' },
  page: { type: 'string' },
  'page-size': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `Quote Master CLI

Usage:
  node quote_master.mjs <command> [options]

Commands:
  login                   Log in and cache the access token.
  health                  Check the Quote Master API.
  intakes                 List quote intakes.
  intake-create           Create a quote intake.
  upload                  Upload or register a document.
  classification-review   List documents waiting for classification.
  confirm-category        Confirm a document category.
  progress                Get intake progress.
  wait                    Poll intake progress until it settles or times out.
  extract                 Trigger test-item extraction.
  extractions             List persisted extractions.
  test-items              List extracted test items.
  nonstandard-items       List non-standard or review-required items.
  draft                   Create a quote draft from an intake.
  quote                   Get a quote header.
  lines                   List quote lines.
  patch-line              Patch one quote line.
  select-customer         Select or create a customer snapshot.
  confirm-pricing         Mark the quote as internally confirmed.
  generate                Generate a formal quote.
  export                  Download pricing-sheet.xlsx.

Environment:
  QUOTE_MASTER_BASE_URL   Default ${DEFAULT_BASE_URL}
  QUOTE_MASTER_STATE_DIR  Default ${STATE_DIR}
`;

function die(message, code = 1) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(code);
}

function print(data) {
  console.log(JSON.stringify(data, null, 2));
}

function outputOk(data) {
  print({ ok: true, data });
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function requireToken() {
  const state = await readState();
  if (!state?.access_token) {
    die('Not logged in. Run `quote_master.mjs login` first.');
  }
  if (state.expires_at && Date.now() > state.expires_at) {
    die('Quote Master token expired. Run `quote_master.mjs login` again.');
  }
  return state.access_token;
}

async function apiRequest(baseUrl, token, method, route, options = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.json);
  } else if (options.form) {
    options.body = options.form;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: options.body,
    });
  } catch (error) {
    die(`Cannot reach Quote Master API: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options.binary) {
    if (!response.ok) {
      const text = await response.text();
      die(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || payload?.detail || `HTTP ${response.status}`;
    die(String(detail));
  }

  if (payload && payload.success === false) {
    const detail = payload.error?.message || payload.message || 'Quote Master returned an error.';
    die(String(detail));
  }

  if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

function require(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    die(`Missing required option: --${name}`);
  }
  return String(value);
}

function optional(value) {
  return value === undefined || value === null || String(value).trim() === '' ? undefined : String(value);
}

function numeric(value) {
  const text = optional(value);
  if (text === undefined) return undefined;
  const number = Number(text);
  if (!Number.isFinite(number)) die(`Expected a number, got: ${text}`);
  return number;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help') {
    console.log(HELP);
    return;
  }

  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: false });
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  const o = parsed.values;
  if (o.help) {
    console.log(HELP);
    return;
  }

  const baseUrl = (o['base-url'] || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let token;

  if (command === 'login') {
    const payload = await apiRequest(baseUrl, null, 'POST', '/auth/login', {
      json: {
        username: require(o.username, 'username'),
        password: require(o.password, 'password'),
      },
    });
    const expiresIn = Number(payload.expires_in_seconds || 0);
    await writeState({
      access_token: payload.access_token,
      expires_at: expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    });
    outputOk({
      username: payload.username,
      display_name: payload.display_name,
      roles: payload.roles,
    });
    return;
  }

  if (command === 'health') {
    outputOk(await apiRequest(baseUrl, null, 'GET', '/health'));
    return;
  }

  token = await requireToken();

  switch (command) {
    case 'intakes': {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({
        keyword: o.keyword,
        status: o.status,
        page: o.page,
        page_size: o['page-size'],
      })) {
        if (value !== undefined && value !== '') query.set(key, value);
      }
      outputOk(await apiRequest(baseUrl, token, 'GET', `/quote-intakes?${query.toString()}`));
      break;
    }
    case 'intake-create': {
      outputOk(
        await apiRequest(baseUrl, token, 'POST', '/quote-intakes', {
          json: {
            project_name: require(o['project-name'], 'project-name'),
            input_channel: o['input-channel'] || 'UPLOAD',
            raw_input_text: o['raw-text'] || null,
          },
        })
      );
      break;
    }
    case 'upload': {
      const intakeId = require(o['intake-id'], 'intake-id');
      const file = require(o.file, 'file');
      const form = new FormData();
      form.append('file', new Blob([await fs.readFile(file)]), path.basename(file));
      if (o.category) form.append('document_category', o.category);
      outputOk(
        await apiRequest(baseUrl, token, 'POST', `/quote-intakes/${intakeId}/documents`, { form })
      );
      break;
    }
    case 'classification-review': {
      const intakeId = require(o['intake-id'], 'intake-id');
      outputOk(await apiRequest(baseUrl, token, 'GET', `/quote-intakes/${intakeId}/classification-review`));
      break;
    }
    case 'confirm-category': {
      const intakeId = require(o['intake-id'], 'intake-id');
      const sourceDocId = require(o['source-doc-id']?.[0], 'source-doc-id');
      const category = require(o.category, 'category');
      outputOk(
        await apiRequest(
          baseUrl,
          token,
          'POST',
          `/quote-intakes/${intakeId}/documents/${sourceDocId}/confirm-category`,
          { json: { document_category: category } }
        )
      );
      break;
    }
    case 'progress':
    case 'wait': {
      const intakeId = require(o['intake-id'], 'intake-id');
      const progress = async () =>
        apiRequest(baseUrl, token, 'GET', `/quote-intakes/${intakeId}/progress`);
      if (command === 'progress') {
        outputOk(await progress());
        break;
      }
      const timeout = numeric(o.timeout) ?? 600;
      const interval = numeric(o.interval) ?? 5;
      const target = optional(o['target-status']);
      const started = Date.now();
      let last;
      for (;;) {
        last = await progress();
        if (last.error_code || last.error_message) {
          outputOk({ ...last, timed_out: false });
          return;
        }
        if (target ? last.current_status === target : !['UNINPUT', 'INPUT_RECEIVED', 'EXTRACTING', 'RAG_RETRIEVING'].includes(last.current_status)) {
          outputOk({ ...last, timed_out: false });
          return;
        }
        if (Date.now() - started >= timeout * 1000) {
          outputOk({ ...last, timed_out: true });
          return;
        }
        // Keep long-running OpenClaw process polls alive with observable progress.
        process.stderr.write(
          `[quote-master] waiting status=${last.current_status} elapsed=${Math.floor((Date.now() - started) / 1000)}s\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      }
    }
    case 'extract': {
      const intakeId = require(o['intake-id'], 'intake-id');
      const started = Date.now();
      const heartbeat = setInterval(() => {
        process.stderr.write(
          `[quote-master] extraction request running elapsed=${Math.floor((Date.now() - started) / 1000)}s\n`,
        );
      }, 15000);
      try {
        outputOk(
          await apiRequest(baseUrl, token, 'POST', `/quote-intakes/${intakeId}/extract`, {
            json: {
              source_doc_ids: o['source-doc-id']?.length ? o['source-doc-id'] : null,
              input_mode: o['input-mode'] || 'MIXED',
              persist: true,
            },
          })
        );
      } finally {
        clearInterval(heartbeat);
      }
      break;
    }
    case 'extractions': {
      const intakeId = require(o['intake-id'], 'intake-id');
      outputOk(await apiRequest(baseUrl, token, 'GET', `/quote-intakes/${intakeId}/extractions`));
      break;
    }
    case 'test-items': {
      const intakeId = require(o['intake-id'], 'intake-id');
      outputOk(await apiRequest(baseUrl, token, 'GET', `/quote-intakes/${intakeId}/test-items`));
      break;
    }
    case 'nonstandard-items': {
      const intakeId = require(o['intake-id'], 'intake-id');
      outputOk(await apiRequest(baseUrl, token, 'GET', `/quote-intakes/${intakeId}/nonstandard-items`));
      break;
    }
    case 'draft': {
      const intakeId = require(o['intake-id'], 'intake-id');
      outputOk(await apiRequest(baseUrl, token, 'POST', `/quote-intakes/${intakeId}/draft-quotes`));
      break;
    }
    case 'quote': {
      const quoteId = require(o['quote-id'], 'quote-id');
      outputOk(await apiRequest(baseUrl, token, 'GET', `/quotes/${quoteId}`));
      break;
    }
    case 'lines': {
      const quoteId = require(o['quote-id'], 'quote-id');
      outputOk(await apiRequest(baseUrl, token, 'GET', `/quotes/${quoteId}/lines`));
      break;
    }
    case 'patch-line': {
      const lineId = require(o['quote-line-id'], 'quote-line-id');
      const body = {};
      for (const [optionName, fieldName] of [
        ['quantity', 'quantity'],
        ['unit-price', 'unit_price'],
        ['cycle-days', 'cycle_days'],
        ['line-status', 'line_status'],
        ['pricing-basis', 'pricing_basis'],
      ]) {
        const value = optionName === 'cycle-days' ? numeric(o[optionName]) : optional(o[optionName]);
        if (value !== undefined) body[fieldName] = value;
      }
      outputOk(await apiRequest(baseUrl, token, 'PATCH', `/quote-lines/${lineId}`, { json: body }));
      break;
    }
    case 'select-customer': {
      const quoteId = require(o['quote-id'], 'quote-id');
      outputOk(
        await apiRequest(baseUrl, token, 'POST', `/quotes/${quoteId}/select-customer`, {
          json: {
            customer_selection_mode: require(o['selection-mode'], 'selection-mode'),
            customer_id: optional(o['customer-id']),
            customer_name_snapshot: optional(o['customer-name-snapshot']),
          },
        })
      );
      break;
    }
    case 'confirm-pricing': {
      const quoteId = require(o['quote-id'], 'quote-id');
      outputOk(await apiRequest(baseUrl, token, 'POST', `/quotes/${quoteId}/confirm-pricing`));
      break;
    }
    case 'generate': {
      const quoteId = require(o['quote-id'], 'quote-id');
      outputOk(await apiRequest(baseUrl, token, 'POST', `/quotes/${quoteId}/generate`));
      break;
    }
    case 'export': {
      const quoteId = require(o['quote-id'], 'quote-id');
      const out = require(o.out, 'out');
      const bytes = await apiRequest(baseUrl, token, 'GET', `/quotes/${quoteId}/pricing-sheet.xlsx`, { binary: true });
      await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
      await fs.writeFile(out, bytes);
      outputOk({ file: path.resolve(out), bytes: bytes.length });
      break;
    }
    default:
      die(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error));
});
