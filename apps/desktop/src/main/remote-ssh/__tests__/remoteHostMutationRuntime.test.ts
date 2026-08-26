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
  warningCount: number;
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
      warningCount: 0,
      diagnostic: { kind: 'syntax' },
    });
  });

  it('does not expose main-only SSH authentication metadata or warning paths over LIST IPC', async () => {
    const visible = host('visible', {
      identityFile: '/Users/example/.ssh/private.key',
      sshAuthentication: {
        identitiesOnly: true,
        identityAgent: '/private/tmp/agent.sock',
        configuredIdentityFiles: ['/Users/example/.ssh/private.key'],
        identityFileDirectiveSeen: true,
        identityFileNoneSeen: false,
        allowedAgentFingerprints: ['SHA256:secret-fingerprint'],
      },
    });
    mocks.readSshConfigDetailed.mockResolvedValueOnce({
      hosts: [visible],
      diagnostic: null,
      warnings: ['/Users/example/.ssh/config:12: unsupported conditional Include'],
    });

    const result = await handler(REMOTE_SSH_INVOKE.RELOAD_CONFIG)({});
    expect(result.warningCount).toBe(1);
    expect(result).not.toHaveProperty('warnings');
    expect(result.hosts[0].config).not.toHaveProperty('sshAuthentication');
    expect(result.hosts[0].config).not.toHaveProperty('identityFile');
    expect(result.hosts[0].config).toMatchObject({
      identityFileConfigured: true,
      identityFileName: 'private.key',
    });
    expect(JSON.stringify(result)).not.toContain('secret-fingerprint');
    expect(JSON.stringify(result)).not.toContain('/Users/example/.ssh/private.key');
    expect(JSON.stringify(result)).not.toContain('/Users/example/.ssh/config');
  });

  it('preserves an existing main-only identity path when Renderer edits other fields', async () => {
    const current = host('preserve-key', {
      authMethod: 'key',
      identityFile: '/Users/example/.ssh/preserve.key',
    });
    await getRemoteSshPool().hydrate([current]);
    const onDisk = { ...getRemoteSshPool().get(current.id)!.config };
    const updated = { ...onDisk, hostname: '192.0.2.210' };
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([onDisk]))
      .mockResolvedValueOnce(successfulRead([onDisk]))
      .mockResolvedValueOnce(successfulRead([updated]));

    const result = await handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      id: current.id,
      displayName: current.id,
      hostname: updated.hostname,
      port: current.port,
      user: current.user,
      authMethod: current.authMethod,
      identityFileUnchanged: true,
    });

    expect(mocks.updateManagedHostFields).toHaveBeenCalledWith(expect.objectContaining({
      identityFile: current.identityFile,
    }), expect.any(String));
    expect(result.host.config).toMatchObject({
      identityFileConfigured: true,
      identityFileName: 'preserve.key',
    });
    expect(JSON.stringify(result)).not.toContain('/Users/example/.ssh/preserve.key');
  });

  it('keeps a live endpoint connected when UPDATE cannot write', async () => {
    const current = host('managed');
    await getRemoteSshPool().hydrate([current]);
    const live = getRemoteSshPool().get(current.id)!;
    const disconnect = vi.spyOn(live, 'disconnect').mockResolvedValue();
    mocks.updateManagedHostFields.mockRejectedValueOnce(
      new Error('EACCES: cannot write /Users/example/.ssh/cindy.conf'),
    );

    const error = await handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...current,
      hostname: '192.0.2.99',
      displayName: current.id,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'SSH_CONFIG_IO_FAILED' });
    expect(error.message).not.toContain('/Users/example/.ssh/cindy.conf');

    expect(disconnect).not.toHaveBeenCalled();
    expect(live.config.hostname).toBe(current.hostname);
  });

  it.each([
    ['a thrown filesystem error', () => {
      mocks.readSshConfigDetailed.mockRejectedValueOnce(
        new Error('EACCES: cannot read /Users/example/.ssh/config'),
      );
    }],
    ['a returned diagnostic', () => {
      mocks.readSshConfigDetailed.mockResolvedValueOnce({
        hosts: [],
        diagnostic: {
          path: '/Users/example/.ssh/included.conf',
          kind: 'io',
          message: 'EACCES: cannot read /Users/example/.ssh/included.conf',
          recoveryHint: 'fix permissions',
        },
        warnings: [],
      });
    }],
  ])('does not expose local paths when config preflight returns %s', async (_label, failRead) => {
    const current = host('private-path');
    await getRemoteSshPool().hydrate([current]);
    failRead();

    const error = await handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...current,
      hostname: '192.0.2.199',
      displayName: current.id,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'SSH_CONFIG_IO_FAILED' });
    expect(error.message).not.toContain('/Users/example');
    expect(error.message).not.toContain('EACCES');
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

  it('reports a stable partial-success code when ADD commits but local prefs cannot be written', async () => {
    const added = host('prefs-failed');
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([]))
      .mockResolvedValueOnce(successfulRead([added]));
    mocks.patchPref.mockImplementationOnce(() => {
      throw new Error('userData is read-only');
    });

    await expect(handler(REMOTE_SSH_INVOKE.ADD)({}, {
      id: added.id,
      hostname: added.hostname,
      user: added.user,
      displayName: 'Friendly name',
    })).rejects.toMatchObject({ code: 'SSH_HOST_PREFS_WRITE_FAILED' });

    expect(mocks.addManagedHostWithInclude).toHaveBeenCalledOnce();
    expect(getRemoteSshPool().get(added.id)?.config.id).toBe(added.id);
  });

  it('reports a stable local-prefs error instead of a raw filesystem failure on UPDATE', async () => {
    const external = host('prefs-only', { managedByCindy: false });
    await getRemoteSshPool().hydrate([external]);
    mocks.patchPref.mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...external,
      displayName: 'Unsaved name',
    })).rejects.toMatchObject({ code: 'SSH_HOST_PREFS_WRITE_FAILED' });

    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(external.id)).toBeTruthy();
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
