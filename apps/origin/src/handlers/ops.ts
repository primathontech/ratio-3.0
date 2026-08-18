import { type Context } from 'hono';
import { pool } from '@ratio/data-db';
import { type Vars } from './helpers';

export type Stats = { renders: number };

export function handleHealth(c: Context<Vars>): Response {
  return c.json({ status: 'ok' });
}

export async function handleReady(c: Context<Vars>): Promise<Response> {
  try {
    await pool.query('SELECT 1');
    return c.json({ ready: true });
  } catch {
    return c.json({ ready: false }, 503);
  }
}

export function handleStats(c: Context<Vars>, stats: Stats): Response {
  return c.json({ renders: stats.renders });
}
