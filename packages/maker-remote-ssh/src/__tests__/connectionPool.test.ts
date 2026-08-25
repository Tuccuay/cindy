import { describe, expect, it, vi } from 'vitest';

import { ConnectionPool } from '../ConnectionPool.js';
import type { HostConfig } from '../types.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function host(id: string, hostname = '192.0.2.1'): HostConfig {
  return {
    id,
    hostname,
    port: 22,
    user: 'developer',
    authMethod: 'agent',
    source: 'ssh-config',
    managedByCindy: false,
  };
}

describe('ConnectionPool.hydrate', () => {
  it('validates duplicate ids before mutating the existing pool', async () => {
    const pool = new ConnectionPool({ logger });
    const existing = pool.add(host('keep'));
    const disconnect = vi.spyOn(existing, 'disconnect').mockResolvedValue();

    await expect(pool.hydrate([host('duplicate'), host('duplicate')]))
      .rejects.toThrow('duplicate host id');

    expect(pool.get('keep')).toBe(existing);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('disconnects an alias before publishing changed connection fields', async () => {
    const pool = new ConnectionPool({ logger });
    const existing = pool.add(host('lab'));
    const disconnect = vi.spyOn(existing, 'disconnect').mockResolvedValue();

    await pool.hydrate([host('lab', '192.0.2.99')]);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(pool.get('lab')?.config.hostname).toBe('192.0.2.99');
  });
});
