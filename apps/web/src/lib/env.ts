// Modo fixtures (S14 §14.19): `vite --mode fixtures` o VITE_USE_FIXTURES=1. Sin archivo .env versionado.
export const USA_FIXTURES = import.meta.env.MODE === 'fixtures' || import.meta.env.VITE_USE_FIXTURES === '1';
export const COMMIT = __VG_COMMIT__;
export const REPO_JUECES = 'https://github.com/platanus-hack/platanus-hack-26-ve-team-22';
