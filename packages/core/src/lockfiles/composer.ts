// composer.lock → dependencias Packagist para OSV (S09 09.6 literal): `packages` y `packages-dev`, versión sin `v`
// inicial, sin ramas `dev-*`; directas = `require` del composer.json hermano.
import type { Dep } from './npm.ts';

export function fromComposerLock(txt: string, manifest: string, composerJson?: string): Dep[] {
  const j = JSON.parse(txt) as { packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] };
  const req = composerJson ? Object.keys(JSON.parse(composerJson).require ?? {}) : [];
  const m = (a: { name: string; version: string }[] = [], dev: boolean) => a.filter((p) => p.name && p.version && !p.version.startsWith('dev-'))
    .map((p) => ({ ecosystem: 'Packagist' as const, name: p.name, version: p.version.replace(/^v/, ''), dev, direct: req.includes(p.name), manifest }));
  return [...m(j.packages, false), ...m(j['packages-dev'], true)];
}
