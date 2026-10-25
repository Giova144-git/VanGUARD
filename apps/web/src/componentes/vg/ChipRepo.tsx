import { GitBranch } from 'lucide-react';
import { sinBidi } from '@/lib/bidi';
import { TINTE } from '@/lib/severidad';
import { cn } from '@/lib/utils';

// Chip con el repo de un hallazgo cuando la org tiene 2 o más (varias-codebases §6.4, F4a): sin él, el mismo `.env` o
// `npm:lodash@4.17.15` en dos repos se verían iguales. No se recorta (parte en dos líneas) ni va en mayúsculas: es un
// nombre técnico, en <bdi dir="ltr"> y con los controles bidi a la vista. `repo` sale de useRepoDeConexion.
export function ChipRepo({ repo, className }: { repo: string | null; className?: string }) {
  if (!repo) return null;
  return (
    <span className={cn('inline-flex min-h-6 max-w-full items-center gap-1 rounded-lg border px-2 py-0.5 font-mono text-[12.5px] font-medium', TINTE.neutra, className)}>
      <GitBranch className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">Repo: </span><bdi dir="ltr" className="break-all">{sinBidi(repo)}</bdi>
    </span>
  );
}
