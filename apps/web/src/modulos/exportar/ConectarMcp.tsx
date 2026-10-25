// Bloques 3 y 4 de «Llevar a tu IA» (S13 §13.10): tokens vgk_ (E29/E29b), guías por cliente y «Resolver con un botón».
// El token solo existe en el estado de este panel mientras se muestra (una vez); «Ya lo guardé» lo borra.
import { useState } from 'react';
import { KeyRound, Wand2 } from 'lucide-react';
import type { McpTokenCreated, McpTokenPublic } from '@vanguard/contracts';
import { Input } from '@/componentes/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/componentes/ui/tabs';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { ConfirmarEnSitio } from '@/componentes/vg/ConfirmarEnSitio';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { sinBidi } from '@/lib/bidi';
import { useTokensMcp } from '@/lib/consultas';
import { mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { comandoClaudeCode, guiasMcp, origenApp, pedidoResolverTodo, urlMcp } from '@/lib/mcp';
import { useCrearTokenMcp, useRevocarTokenMcp } from '@/lib/mutaciones';

const SELECTOR = 'h-12 rounded-lg border border-input bg-card px-3 text-[15px] outline-none focus-visible:border-info focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60';
const DIAS = [7, 30, 90] as const;

function Fragmento({ valor }: { valor: string }) {
  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-64 overflow-auto rounded-lg border bg-background p-3 font-mono text-[13px] whitespace-pre-wrap break-all">{sinBidi(valor)}</pre>
      <BotonCopiar valor={valor} />
    </div>
  );
}

export function GuiasMcp({ token }: { token?: string }) {
  const guias = guiasMcp(urlMcp(origenApp()), token);
  return (
    <Tabs defaultValue="claude_code">
      <TabsList className="h-auto flex-wrap">
        {guias.map((g) => <TabsTrigger key={g.id} value={g.id} className="h-10">{g.nombre}</TabsTrigger>)}
      </TabsList>
      {guias.map((g) => (
        <TabsContent key={g.id} value={g.id} className="flex flex-col gap-3">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-[15px]">{g.pasos.map((p) => <li key={p}>{p}</li>)}</ol>
          <Fragmento valor={g.fragmento} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function TokenNuevo({ r, alCerrar }: { r: McpTokenCreated; alCerrar: () => void }) {
  const [guardado, setGuardado] = useState(false);
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-mal-borde bg-card p-4">
      <p className="text-sm font-semibold text-mal">Solo lo verás ahora. Si lo pierdes, revócalo y crea otro.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 font-mono text-[13px] break-all">{r.token}</code>
        <BotonCopiar valor={r.token} texto="Copiar token" />
      </div>
      <GuiasMcp token={r.token} />
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input type="checkbox" className="size-5" checked={guardado} onChange={(e) => setGuardado(e.target.checked)} />Ya lo guardé
      </label>
      <div><BotonAccion variante="principal" disabled={!guardado} ayuda="Marca «Ya lo guardé» para cerrar" onClick={alCerrar}>Cerrar</BotonAccion></div>
    </div>
  );
}

function FilaToken({ org, t }: { org: string; t: McpTokenPublic }) {
  const revocar = useRevocarTokenMcp(org);
  const vencido = !!t.expires_at && Date.parse(t.expires_at) <= Date.now();
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t py-3 first:border-t-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          <bdi>{sinBidi(t.name)}</bdi>
          {t.last4 ? <span className="font-mono text-[13px] text-muted-foreground">••••<bdi dir="ltr">{sinBidi(t.last4)}</bdi></span> : null}
          {t.revoked_at ? <Etiqueta texto="Revocado" /> : vencido ? <Etiqueta texto="Vencido" rol="aviso" /> : null}
        </span>
        <span className="text-[12.5px] text-texto-3">
          Creado {cuando(t.created_at)} · {t.last_used_at ? `último uso ${cuando(t.last_used_at)}` : 'sin usar'}
          {t.expires_at && !t.revoked_at ? ` · ${vencido ? 'venció' : 'caduca'} ${cuando(t.expires_at)}` : ''}
        </span>
      </div>
      {t.revoked_at ? null : <ConfirmarEnSitio verbo="Revocar" aviso="Tu IA dejará de poder consultar VanGUARD con este token."
        onConfirmar={async () => { await revocar.mutateAsync(t.id); }} />}
    </li>
  );
}

function Tokens({ org }: { org: string }) {
  const q = useTokensMcp(org, true);
  const crear = useCrearTokenMcp(org);
  const [nombre, setNombre] = useState('');
  const [dias, setDias] = useState<(typeof DIAS)[number]>(30);
  const [estado, setEstado] = useState<{ ocupado?: boolean; error?: string }>({});
  const [nuevo, setNuevo] = useState<McpTokenCreated | null>(null);
  const nombreOk = nombre.trim().length >= 2 && nombre.trim().length <= 60;

  if (nuevo) return <TokenNuevo r={nuevo} alCerrar={() => setNuevo(null)} />;
  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (!nombreOk || estado.ocupado) return;
        setEstado({ ocupado: true });
        try { setNuevo(await crear({ name: nombre.trim(), expires_in_days: dias })); setNombre(''); setEstado({}); }
        catch (err) { setEstado({ error: mensajeDe(err) }); }
      }}>
        <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-[12.5px] font-medium text-texto-3">Nombre
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={60} placeholder="Claude Code de Ana" />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-medium text-texto-3">Caduca en
          <select className={SELECTOR} value={dias} onChange={(e) => setDias(Number(e.target.value) as (typeof DIAS)[number])}>
            {DIAS.map((d) => <option key={d} value={d}>{d} días</option>)}
          </select>
        </label>
        <BotonAccion type="submit" variante="principal" icono={KeyRound} ocupado={estado.ocupado} disabled={!nombreOk}
          ayuda="Ponle un nombre de 2 a 60 caracteres">Crear token</BotonAccion>
      </form>
      {estado.error ? <p role="alert" className="text-sm text-mal">{estado.error}</p> : null}
      {q.isError ? <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />
        : q.data?.length ? <ul aria-label="Tokens MCP">{q.data.map((t) => <FilaToken key={t.id} org={org} t={t} />)}</ul>
        : q.data ? <p className="text-sm text-muted-foreground">Aún no hay tokens. Crea uno por cada IA o persona que vaya a conectarse.</p>
        : null}
    </div>
  );
}

export function ConectarMcp({ org, puedeEscribir }: { org: string; puedeEscribir: boolean }) {
  return (
    <>
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-label="Conectar por MCP">
        <div className="flex items-center gap-2"><KeyRound className="size-5 text-muted-foreground" /><h3 className="flex-1 text-[17px] font-semibold">Conecta tu IA por MCP</h3><Etiqueta texto="Solo lectura" /></div>
        <p className="text-sm text-muted-foreground">
          Con el MCP de VanGUARD tu IA consulta el estado de tu repo, tus vulnerabilidades y los prompts de corrección, sin copiar y pegar.
          Nunca escribe en VanGUARD ni gasta tu presupuesto de IA.
        </p>
        {puedeEscribir ? <Tokens org={org} /> : <p className="text-sm text-muted-foreground">Pide a un administrador que cree un token.</p>}
        <details className="group">
          <summary className="cursor-pointer text-[15px] font-medium">Cómo conectarla en cada IA</summary>
          <div className="pt-3"><GuiasMcp /></div>
        </details>
      </section>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-label="Resolver con un botón">
        <div className="flex items-center gap-2"><Wand2 className="size-5 text-muted-foreground" /><h3 className="flex-1 text-[17px] font-semibold">Resuelve tus vulnerabilidades con un botón</h3></div>
        <p className="text-sm text-muted-foreground">
          Con el MCP conectado, copia el comando y pégalo en tu IA abierta en el repo: trae cada corrección de VanGUARD y la aplica
          una por una, mostrándote el diff antes. En cada hallazgo tienes además «Resolver con mi IA».
        </p>
        <div className="flex flex-wrap gap-3">
          <BotonCopiar valor={comandoClaudeCode('resolver_criticos')} texto="Resolver lo más grave · Claude Code" variante="principal" tam="grande" />
          <BotonCopiar valor={pedidoResolverTodo()} texto="Resolver lo más grave · otra IA" tam="grande" />
        </div>
      </section>
    </>
  );
}
