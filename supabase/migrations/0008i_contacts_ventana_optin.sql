-- 0008i_contacts_ventana_optin.sql · WhatsApp real (docs/plan_maestro_trabajo/asignaciones/back-whatsapp-real.md, B2).
-- wa_last_inbound_at: última vez que ese teléfono escribió a VanGUARD (E31 la pone con cualquier entrante, en todas las
-- orgs: la ventana es por usuario y número de VanGUARD). Fuera de la ventana de 24 h solo sale una plantilla aprobada
-- (131047): E27 y el despachador la miran antes de enviar.
-- optin_at: evidencia del consentimiento (E31 la pone con el «VERIFICAR <código>» del enlace wa.me de E26, cuyo texto
-- dice qué se acepta y nombra al negocio).
-- vg_replace_contacts (0005) no cambia: su upsert solo toca name, whatsapp, voice y priority, así que conserva las dos
-- columnas igual que verified_at; un teléfono nuevo es otra fila y empieza sin ellas (supabase/tests/contacts-ventana.sql).
-- Sin grants: 0008h dejó a anon y authenticated sin nada en public, y el DML de tabla de service_role (0008c) ya cubre
-- las columnas nuevas.
alter table public.contacts add column if not exists wa_last_inbound_at timestamptz;
alter table public.contacts add column if not exists optin_at timestamptz;
comment on column public.contacts.wa_last_inbound_at is 'Último mensaje entrante de este teléfono (ventana de 24 h de WhatsApp)';
comment on column public.contacts.optin_at is 'Consentimiento por WhatsApp (VERIFICAR <código>)';
-- E31 busca por teléfono en todas las orgs (VERIFICAR, BAJA y la última entrada): el unique (org_id, phone_e164) no sirve.
create index if not exists contacts_phone_idx on public.contacts (phone_e164);
