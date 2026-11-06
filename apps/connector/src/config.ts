import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { openSync, closeSync, fsyncSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

import { PRODUCT, type DeviceRecord, type PairingRecord } from '@dashup/protocol';
import type { SessionResult } from '@dashup/protocol/session';
import type { NotificationPolicy } from '@dashup/protocol/attention';

import type { QueueRequest } from './harness/queue';
import type { StoredAttention } from './attention';

interface LocalPair {
  key      : string;
  sequence : number;
  attention? : NotificationPolicy;
}

export interface ConnectorConfig {
  api          : string;
  // This computer signs in with its own secret; the phone that paired it recorded the hash.
  secret       : string;
  device?      : DeviceRecord;
  pairs        : Record<string, LocalPair>;
  localSecret  : string;
  queued?      : Record<string, QueueRequest>;
  receipts? : Record<
    string,
    {
      pairing: string;
      project: string;
      at: number;
      message?: {
        thread: string;
        before?: string;
        hash: string;
        id?: string;
        originalLength?: number;
      };
      result?: Pick<SessionResult, 'ok' | 'error' | 'queue' | 'started'>;
    }
  >;
  attentionPending? : StoredAttention[];
  usageResetReceipts? : Record<string, number>;
}

export const configPath = () =>
  resolve(process.env.DASHUP_CONFIG ?? join(homedir(), '.dashup', 'connector.json'));

export const connectorPort = (): number =>
  16384 + (createHash('sha256').update(configPath()).digest().readUInt16BE(0) % 49152);

export function loadConfig(): ConnectorConfig {
  const path = configPath();
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as ConnectorConfig)
    : {
        api: PRODUCT.api,
        secret: '',
        pairs: {},
        localSecret: '',
      };
}

export function saveConfig(config: ConnectorConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = openSync(path + '.tmp', 'w', 0o600);
  try {
    writeFileSync(file, JSON.stringify(config, null, 2));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(path + '.tmp', path);
  if (process.platform === 'linux') {
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

// Bytes go as they are; anything else as JSON.
export async function api<T>(
  config: ConnectorConfig,
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
): Promise<T> {
  const bytes    = body instanceof Uint8Array;
  const response = await fetch(`${config.api}/v1${path}`, {
    method,
    headers : {
      'Content-Type' : bytes ? 'application/octet-stream' : 'application/json',
      Authorization  : `Bearer ${config.secret}`,
    },
    body    : bytes ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined,
  });
  const value = (await response.json()) as { success: boolean; result: T; error?: string };
  if (!response.ok || !value.success)
    throw new Error(value.error ?? `Dashup request failed (${response.status})`);
  return value.result;
}

export function activePair(config: ConnectorConfig, pair: PairingRecord): boolean {
  return Boolean(!pair.revokedAt && config.pairs[pair.id] && pair.device === config.device?.id);
}
