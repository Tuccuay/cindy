import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'RemoteSection.tsx'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('RemoteSection add form order', () => {
  it('keeps the add form before every existing host', () => {
    const cardStart = source.indexOf("className={cn('flex flex-col rounded-xl'");
    const addForm = source.indexOf('{adding && (', cardStart);
    const hostList = source.indexOf('{hosts.map(', cardStart);

    expect(cardStart).toBeGreaterThanOrEqual(0);
    expect(addForm).toBeGreaterThan(cardStart);
    expect(hostList).toBeGreaterThan(addForm);
    expect(source).toContain('idx > 0 || adding');
  });

  it('keeps external connection fields read-only while showing display name and alias', () => {
    expect(source).toContain('snap.config.displayName?.trim() || snap.config.id');
    expect(source).toContain('displayName !== snap.config.id');
    expect(source).toContain('!snap.config.managedByCindy');
    expect(source).toContain('connectionFieldsReadOnly={!snap.config.managedByCindy}');
    expect(source).toContain('{snap.config.managedByCindy && (');
  });

  it('rejects character-class aliases that discovery intentionally excludes', () => {
    expect(source).toContain("/\\s|[*?!\\[]/.test(form.id)");
  });

  it('surfaces non-fatal SSH config discovery warnings', () => {
    expect(source).toContain('setConfigWarnings(res.warnings ?? [])');
    expect(source).toContain("t('settings.remote.configWarning')");
  });

  it('surfaces fatal diagnostics and retries committed mutations only once', () => {
    expect(source).toContain('setConfigDiagnostic(res.diagnostic?.kind ?? null)');
    expect(source).toContain('settings.remote.configDiagnostic.${configDiagnostic}');
    expect(source).toContain('const reloadCommittedMutationOnce = useCallback');
    expect(source.match(/await reloadCommittedMutationOnce\(\)/g)).toHaveLength(3);
    expect(source).not.toContain('while (extractIpcError');
  });
});
