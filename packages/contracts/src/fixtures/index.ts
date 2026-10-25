// Fixtures del FRONT en modo sin BACK (S14 §14.19). Claves exactas que valida contracts.test.ts.
// Nunca importar de '../index.ts' (sería circular): cada archivo importa sus tipos de api.ts/estado.ts/comun.ts.
import { aiUsage, contacts } from './ajustes.ts';
import { scanDone, scanDoneDosRepos, scanRunning } from './auditoria.ts';
import { underAttackOffer, underAttackOfferSinPermiso, underAttackOfferUnaIp, underAttackProposal } from './bajo-ataque.ts';
import { fixRequests } from './correcciones.ts';
import { conexionGithub2, connections, permChecks } from './conexiones.ts';
import { auditDelta, deltasRevision, evolution, hallazgosCorregidos } from './evolucion.ts';
import { exportMd, mcpTokens } from './exportar.ts';
import { findings, fixPrompt } from './hallazgos.ts';
import { fechasFallas, fotosFallas, hallazgosHistoricos, historialFallas, lineaTiempoFalla } from './historial.ts';
import { actionProposal, incidentDetail, incidents, traffic } from './incidentes.ts';
import { moduleState } from './modulos.ts';
import { perfRuns } from './rendimiento.ts';
import { overview, overviewVacio } from './resumen.ts';
import {
  alertPrefs, codeReviewSaved, codeReviewState, codeReviewStateBloqueo, codeReviewStateRepo2, hallazgoRevision, mergeGateSaved,
} from './revision.ts';
import { me, meViewer } from './sesion.ts';
import { wikiDoc, wikiEstimate, wikiRunDone, wikiRunRunning, wikiRuns } from './wiki.ts';

export const fixtures = {
  me, meViewer, overview, overviewVacio, moduleState, connections, permChecks, scanRunning, scanDone,
  findings, fixPrompt, incidents, incidentDetail, traffic, actionProposal, contacts, aiUsage, perfRuns,
  exportMd, mcpTokens, wikiEstimate, wikiRunRunning, wikiRunDone, wikiRuns, wikiDoc,
  codeReviewState, codeReviewSaved, alertPrefs, hallazgoRevision,
  conexionGithub2, scanDoneDosRepos, codeReviewStateRepo2,
  codeReviewStateBloqueo, mergeGateSaved,
  auditDelta, evolution, hallazgosCorregidos, deltasRevision,
  underAttackOffer, underAttackOfferUnaIp, underAttackOfferSinPermiso, underAttackProposal,
  fixRequests,
  historialFallas, lineaTiempoFalla, hallazgosHistoricos, fechasFallas, fotosFallas,
};
