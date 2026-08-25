import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostConfig, ReadSshConfigResult } from '@cindy/maker-remote-ssh';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<unknown> | unknown>(),
  readSshConfigDetailed: vi.fn(),
  addManagedHostWithInclude: vi.fn(),
  updateManagedHostFields: vi.fn(),
  removeManagedHost: vi.fn(),
  patchPref: vi.fn(),
  removePref: vi.fn(),
  clearAgentProxy: vi.fn(),
  removeMcpPref: vi.fn(),
  invalidateMcpEndpoint: vi.fn(),
}));

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>();
  return {
    ...actual,
    ipcMain: {
      ...actual.ipcMain,
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
        mocks.handlers.set(channel, handler);
      }),
    },
    BrowserWindow: class {
      static getAllWindows(): never[] { return []; }
    },
  };
});

vi.mock('@cindy/maker-remote-ssh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/maker-remote-ssh')>();
  return {
    ...actual,
    defaultSshConfigPath: () => '/virtual/.ssh/config',
    defaultManagedSshConfigPath: () => '/virtual/.ssh/cindy.conf',
    readSshConfigDetailed: mocks.readSshConfigDetailed,
    addManagedHostWithInclude: mocks.addManagedHostWithInclude,
    updateManagedHostFields: mocks.updateManagedHostFields,
    removeManagedHost: mocks.removeManagedHost,
  };
});

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [] }),
        }),
      }),
    },
  }),
}));

vi.mock('../ssh-host-prefs-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ssh-host-prefs-store.js')>();
  return {
    ...actual,
    getSshHostAgentProxy: () => null,
    getSshHostAutoConnect: () => false,
    getSshHostDisplayName: (hostId: string) => hostId,
    hasAnyAutoConnectHost: () => false,
    readSshHostPrefs: () => ({}),
    patchSshHostPref: mocks.patchPref,
    removeSshHostPref: mocks.removePref,
    setSshHostAutoConnect: vi.fn(),
  };
});

vi.mock('../agent-proxy.js', () => ({
  applyAgentProxyForHost: vi.fn(async () => undefined),
  clearAgentProxyTunnelState: mocks.clearAgentProxy,
  clearAgentProxyTunnelStateAndWait: vi.fn(async () => undefined),
  disposeAllTunnels: vi.fn(async () => undefined),
  getAgentProxyTunnelState: () => null,
  getRemoteAgentProxyEnvUppercase: () => ({}),
  handleAgentProxyMainHostDown: vi.fn(),
  initAgentProxy: vi.fn(),
  killRemoteCodexDaemon: vi.fn(async () => undefined),
  reconcileCodexAgentProxyEnv: vi.fn(async () => undefined),
  teardownAgentProxyOnUserDisconnect: vi.fn(async () => undefined),
}));

vi.mock('../cc-manager-install.js', () => ({
  clearCcManagerInstallCache: vi.fn(),
  runCcMgrUpgrade: vi.fn(),
  listPendingCcMgrUpgrades: vi.fn(() => []),
  dismissPendingCcMgrUpgrade: vi.fn(),
  ensureCcManagerInstalledOrInstall: vi.fn(),
}));

vi.mock('../codex-remote-mcp.js', () => ({
  invalidateRemoteCodexMcpEndpointState: mocks.invalidateMcpEndpoint,
  removeRemoteMcpForwardPref: mocks.removeMcpPref,
}));

vi.mock('../../maker-host/index.js', () => ({
  getMakerIfReady: () => null,
  softCloseCcSessionsForHost: vi.fn(async () => undefined),
}));

import {
  getRemoteSshPool,
  registerRemoteSshIpc,
  REMOTE_SSH_INVOKE,
} from '../index.js';

function host(id: string, overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id,
    hostname: `192.0.2.${id.length}`,
    port: 22,
    user: 'developer',
    authMethod: 'agent',
    source: 'ssh-config',
    managedByCindy: true,
    ...overrides,
  };
}

function successfulRead(hosts: HostConfig[]): ReadSshConfigResult {
  return { hosts, diagnostic: null, warnings: [] };
}

function failedRead(): ReadSshConfigResult {
  return {
    hosts: [],
    diagnostic: {
      path: '/virtual/.ssh/config',
      kind: 'syntax',
      message: 'fixture parse failure',
      recoveryHint: 'fix fixture',
    },
    warnings: [],
  };
}

function handler(channel: string): (...args: any[]) => Promise<any> {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`handler not registered: ${channel}`);
  return async (...args: any[]) => registered(...args);
}

let initialListResult: {
  hosts: unknown[];
  warnings: string[];
  diagnostic: { kind: string } | null;
};

beforeAll(async () => {
  mocks.readSshConfigDetailed.mockResolvedValue(failedRead());
  registerRemoteSshIpc();
  initialListResult = await handler(REMOTE_SSH_INVOKE.LIST)({});
  mocks.readSshConfigDetailed.mockResolvedValue(successfulRead([]));
  await handler(REMOTE_SSH_INVOKE.RELOAD_CONFIG)({});
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.readSshConfigDetailed.mockReset();
  mocks.addManagedHostWithInclude.mockResolvedValue(undefined);
  mocks.updateManagedHostFields.mockResolvedValue(undefined);
  mocks.removeManagedHost.mockResolvedValue(undefined);
  mocks.invalidateMcpEndpoint.mockReset();
  await getRemoteSshPool().hydrate([]);
  mocks.readSshConfigDetailed.mockImplementation(async () => successfulRead(
    getRemoteSshPool().list().map((snapshot) => snapshot.config),
  ));
});

describe('remote SSH mutation runtime semantics', () => {
  it('returns a cold-start diagnostic instead of making the host list look valid and empty', () => {
    expect(initialListResult).toMatchObject({
      hosts: [],
      warnings: [],
      diagnostic: { kind: 'syntax' },
    });
  });

  it('keeps a live endpoint connected when UPDATE cannot write', async () => {
    const current = host('managed');
    await getRemoteSshPool().hydrate([current]);
    const live = getRemoteSshPool().get(current.id)!;
    const disconnect = vi.spyOn(live, 'disconnect').mockResolvedValue();
    mocks.updateManagedHostFields.mockRejectedValueOnce(new Error('disk full'));

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...current,
      hostname: '192.0.2.99',
      displayName: current.id,
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_IO_FAILED' });

    expect(disconnect).not.toHaveBeenCalled();
    expect(live.config.hostname).toBe(current.hostname);
  });

  it('keeps existing aliases connected when ADD writes but refresh fails', async () => {
    const existing = host('existing');
    await getRemoteSshPool().hydrate([existing]);
    const live = getRemoteSshPool().get(existing.id)!;
    const disconnect = vi.spyOn(live, 'disconnect').mockResolvedValue();
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([existing]))
      .mockResolvedValueOnce(failedRead());

    await expect(handler(REMOTE_SSH_INVOKE.ADD)({}, {
      id: 'new-host',
      hostname: '192.0.2.77',
      user: 'developer',
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_RELOAD_REQUIRED' });

    expect(disconnect).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(existing.id)).toBe(live);
    expect(getRemoteSshPool().get('new-host')).toBeUndefined();
    expect(mocks.patchPref).toHaveBeenCalledWith('new-host', {
      displayName: 'new-host',
    });
  });

  it('disconnects only the target when UPDATE writes but refresh fails', async () => {
    const target = host('target');
    const other = host('other');
    await getRemoteSshPool().hydrate([target, other]);
    const targetLive = getRemoteSshPool().get(target.id)!;
    const otherLive = getRemoteSshPool().get(other.id)!;
    const targetDisconnect = vi.spyOn(targetLive, 'disconnect').mockResolvedValue();
    const otherDisconnect = vi.spyOn(otherLive, 'disconnect').mockResolvedValue();
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([target, other]))
      .mockResolvedValueOnce(failedRead());

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...target,
      hostname: '192.0.2.88',
      displayName: target.id,
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_RELOAD_REQUIRED' });

    expect(targetDisconnect).toHaveBeenCalledTimes(1);
    expect(otherDisconnect).not.toHaveBeenCalled();
    expect(targetLive.config.hostname).toBe(target.hostname);
    expect(mocks.patchPref).toHaveBeenCalledWith(target.id, {
      displayName: target.id,
    });
  });

  it('disconnects only the target when REMOVE writes but refresh fails', async () => {
    const target = host('remove-me');
    const other = host('keep-me');
    await getRemoteSshPool().hydrate([target, other]);
    const targetLive = getRemoteSshPool().get(target.id)!;
    const otherLive = getRemoteSshPool().get(other.id)!;
    const targetDisconnect = vi.spyOn(targetLive, 'disconnect').mockResolvedValue();
    const otherDisconnect = vi.spyOn(otherLive, 'disconnect').mockResolvedValue();
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([target, other]))
      .mockResolvedValueOnce(failedRead());

    await expect(handler(REMOTE_SSH_INVOKE.REMOVE)({}, { id: target.id }))
      .rejects.toMatchObject({ code: 'SSH_CONFIG_RELOAD_REQUIRED' });

    expect(targetDisconnect).toHaveBeenCalledTimes(1);
    expect(otherDisconnect).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(target.id)).toBe(targetLive);
    expect(mocks.removePref).toHaveBeenCalledWith(target.id);
    expect(mocks.clearAgentProxy).toHaveBeenCalledWith(target.id);
    expect(mocks.removeMcpPref).toHaveBeenCalledWith(target.id);
  });

  it('still disconnects the target when endpoint cleanup fails after UPDATE writes', async () => {
    const target = host('cleanup-failure');
    await getRemoteSshPool().hydrate([target]);
    const targetLive = getRemoteSshPool().get(target.id)!;
    const disconnect = vi.spyOn(targetLive, 'disconnect').mockResolvedValue();
    mocks.invalidateMcpEndpoint.mockImplementationOnce(() => {
      throw new Error('prefs disk unavailable');
    });

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...target,
      hostname: '192.0.2.89',
      displayName: target.id,
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_RELOAD_REQUIRED' });

    expect(mocks.updateManagedHostFields).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(getRemoteSshPool().get(target.id)).toBe(targetLive);
    expect(targetLive.config.hostname).toBe(target.hostname);
  });

  it('rejects external connection edits but allows local preference edits', async () => {
    const external = host('external', { managedByCindy: false });
    await getRemoteSshPool().hydrate([external]);

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...external,
      hostname: '192.0.2.111',
      displayName: 'Renamed',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...external,
      displayName: 'Renamed',
      agentProxy: null,
    })).resolves.toMatchObject({
      host: { config: { id: external.id } },
    });
    expect(mocks.patchPref).toHaveBeenCalledWith(external.id, {
      displayName: 'Renamed',
      agentProxy: null,
    });
    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
  });

  it('refuses UPDATE when the latest disk graph no longer uniquely owns the alias', async () => {
    const managed = host('duplicate-update');
    await getRemoteSshPool().hydrate([managed]);
    mocks.readSshConfigDetailed.mockResolvedValueOnce(successfulRead([
      { ...managed, managedByCindy: false },
    ]));

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...managed,
      hostname: '192.0.2.200',
      displayName: managed.id,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
  });

  it('refuses REMOVE when the latest disk graph no longer uniquely owns the alias', async () => {
    const managed = host('duplicate-remove');
    await getRemoteSshPool().hydrate([managed]);
    mocks.readSshConfigDetailed.mockResolvedValueOnce(successfulRead([
      { ...managed, managedByCindy: false },
    ]));

    await expect(handler(REMOTE_SSH_INVOKE.REMOVE)({}, { id: managed.id }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mocks.removeManagedHost).not.toHaveBeenCalled();
    expect(mocks.removePref).not.toHaveBeenCalled();
  });
});
