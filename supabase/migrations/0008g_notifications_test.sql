-- 0008g_notifications_test.sql · E27 (POST /api/orgs/:org/notifications/test, §15.4) deja su fila en notifications.
-- En 0005 incident_id es NOT NULL y la prueba no cuelga de ningún incidente: cada insert daba 23502 y no quedaba ni la
-- fila failed/unverified (§06.9), ni la queued→sent con provider_id que casa E31, ni el conteo de los topes por hora.
-- El unique (incident_id, channel, recipient_masked, template) no cambia: con incident_id nulo los null son distintos
-- entre sí y cada prueba es su propia fila. Por eso el check deja sin incidente SOLO la plantilla de prueba: el
-- despachador (§15.9) siempre lleva incident_id, o perdería el 23505 de «ya avisado».
alter table public.notifications alter column incident_id drop not null;
alter table public.notifications drop constraint if exists notifications_incidente_o_prueba;
alter table public.notifications add constraint notifications_incidente_o_prueba
  check (incident_id is not null or template = 'test_v1');
