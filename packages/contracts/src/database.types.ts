// GENERADO con generate_typescript_types (MCP de Supabase) sobre accshmgmfrqrxubpuxcl tras la migración 0013.
// No editar a mano: regenerar tras cada migración (tarea T6 del ORQUESTADOR).
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      actions: {
        Row: {
          approval_id: string | null
          created_at: string
          expires_at: string | null
          id: string
          incident_id: string | null
          kind: string
          org_id: string
          previous: Json | null
          provider_ref: string | null
          requested_by: string | null
          status: string
          target: string
          undone_at: string | null
        }
        Insert: {
          approval_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          incident_id?: string | null
          kind: string
          org_id: string
          previous?: Json | null
          provider_ref?: string | null
          requested_by?: string | null
          status?: string
          target: string
          undone_at?: string | null
        }
        Update: {
          approval_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          incident_id?: string | null
          kind?: string
          org_id?: string
          previous?: Json | null
          provider_ref?: string | null
          requested_by?: string | null
          status?: string
          target?: string
          undone_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "actions_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: true
            referencedRelation: "approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actions_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage: {
        Row: {
          cache_read: number
          cache_write: number
          cost_usd: number
          created_at: string
          id: string
          input_tokens: number
          model: string
          org_id: string | null
          output_tokens: number
          refusal_category: string | null
          request_id: string | null
          route: string
          stop_reason: string | null
        }
        Insert: {
          cache_read?: number
          cache_write?: number
          cost_usd: number
          created_at?: string
          id?: string
          input_tokens?: number
          model: string
          org_id?: string | null
          output_tokens?: number
          refusal_category?: string | null
          request_id?: string | null
          route: string
          stop_reason?: string | null
        }
        Update: {
          cache_read?: number
          cache_write?: number
          cost_usd?: number
          created_at?: string
          id?: string
          input_tokens?: number
          model?: string
          org_id?: string | null
          output_tokens?: number
          refusal_category?: string | null
          request_id?: string | null
          route?: string
          stop_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_prefs: {
        Row: {
          org_id: string
          review_voice_min: string
          review_whatsapp_min: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          org_id: string
          review_voice_min?: string
          review_whatsapp_min?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          org_id?: string
          review_voice_min?: string
          review_whatsapp_min?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "alert_prefs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      app_config: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      approvals: {
        Row: {
          action_kind: string
          attempts: number
          channel: string
          created_at: string
          expires_at: string
          id: string
          incident_id: string | null
          nonce_hash: string
          org_id: string
          params: Json
          recipient: string
          result: Json | null
          used_at: string | null
        }
        Insert: {
          action_kind: string
          attempts?: number
          channel: string
          created_at?: string
          expires_at?: string
          id?: string
          incident_id?: string | null
          nonce_hash: string
          org_id: string
          params?: Json
          recipient: string
          result?: Json | null
          used_at?: string | null
        }
        Update: {
          action_kind?: string
          attempts?: number
          channel?: string
          created_at?: string
          expires_at?: string
          id?: string
          incident_id?: string | null
          nonce_hash?: string
          org_id?: string
          params?: Json
          recipient?: string
          result?: Json | null
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approvals_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      code_review_configs: {
        Row: {
          branch: string
          connection_id: string
          created_at: string
          created_by: string | null
          enabled: boolean
          hook_events: string[]
          id: string
          last_error: string | null
          last_error_at: string | null
          last_event_at: string | null
          last_ping_at: string | null
          org_id: string
          secret_kid: string
          secret_last4: string | null
          secret_sealed: Json
          updated_at: string
        }
        Insert: {
          branch: string
          connection_id: string
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          hook_events?: string[]
          id: string
          last_error?: string | null
          last_error_at?: string | null
          last_event_at?: string | null
          last_ping_at?: string | null
          org_id: string
          secret_kid: string
          secret_last4?: string | null
          secret_sealed: Json
          updated_at?: string
        }
        Update: {
          branch?: string
          connection_id?: string
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          hook_events?: string[]
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          last_event_at?: string | null
          last_ping_at?: string | null
          org_id?: string
          secret_kid?: string
          secret_last4?: string | null
          secret_sealed?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_review_configs_connection_id_org_id_fkey"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "code_review_configs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      code_reviews: {
        Row: {
          alert_reason: string | null
          alert_state: string
          base_sha: string
          branch: string
          config_id: string
          counts: Json
          created_at: string
          delivery_id: string | null
          error_code: string | null
          event: string
          files_changed: number
          finished_at: string | null
          head_sha: string
          id: string
          lines_added: number
          max_severity: string | null
          new_findings: Json
          notified_at: string | null
          org_id: string
          partial: boolean
          pr_number: number | null
          push_commits: string[]
          reported_keys: string[]
          started_at: string | null
          status: string
          voice_pending: boolean
        }
        Insert: {
          alert_reason?: string | null
          alert_state?: string
          base_sha: string
          branch: string
          config_id: string
          counts?: Json
          created_at?: string
          delivery_id?: string | null
          error_code?: string | null
          event: string
          files_changed?: number
          finished_at?: string | null
          head_sha: string
          id?: string
          lines_added?: number
          max_severity?: string | null
          new_findings?: Json
          notified_at?: string | null
          org_id: string
          partial?: boolean
          pr_number?: number | null
          push_commits?: string[]
          reported_keys?: string[]
          started_at?: string | null
          status?: string
          voice_pending?: boolean
        }
        Update: {
          alert_reason?: string | null
          alert_state?: string
          base_sha?: string
          branch?: string
          config_id?: string
          counts?: Json
          created_at?: string
          delivery_id?: string | null
          error_code?: string | null
          event?: string
          files_changed?: number
          finished_at?: string | null
          head_sha?: string
          id?: string
          lines_added?: number
          max_severity?: string | null
          new_findings?: Json
          notified_at?: string | null
          org_id?: string
          partial?: boolean
          pr_number?: number | null
          push_commits?: string[]
          reported_keys?: string[]
          started_at?: string | null
          status?: string
          voice_pending?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "code_reviews_config_id_org_id_fkey"
            columns: ["config_id", "org_id"]
            isOneToOne: false
            referencedRelation: "code_review_configs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "code_reviews_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_secrets: {
        Row: {
          connection_id: string
          created_at: string
          fingerprint: string
          kid: string
          org_id: string
          rotated_at: string | null
          sealed: Json
        }
        Insert: {
          connection_id: string
          created_at?: string
          fingerprint: string
          kid: string
          org_id: string
          rotated_at?: string | null
          sealed: Json
        }
        Update: {
          connection_id?: string
          created_at?: string
          fingerprint?: string
          kid?: string
          org_id?: string
          rotated_at?: string | null
          sealed?: Json
        }
        Relationships: [
          {
            foreignKeyName: "connection_secrets_connection_id_org_id_fkey"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      connections: {
        Row: {
          capabilities: Json
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          kind: string
          label: string
          last_checked_at: string | null
          last_error: string | null
          last4: string | null
          meta: Json
          org_id: string
          provider: string
          scopes: string[]
          status: string
        }
        Insert: {
          capabilities?: Json
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id: string
          kind?: string
          label: string
          last_checked_at?: string | null
          last_error?: string | null
          last4?: string | null
          meta?: Json
          org_id: string
          provider: string
          scopes?: string[]
          status?: string
        }
        Update: {
          capabilities?: Json
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          kind?: string
          label?: string
          last_checked_at?: string | null
          last_error?: string | null
          last4?: string | null
          meta?: Json
          org_id?: string
          provider?: string
          scopes?: string[]
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          created_at: string
          id: string
          name: string
          optin_at: string | null
          org_id: string
          phone_e164: string
          priority: number
          verified_at: string | null
          voice: boolean
          wa_last_inbound_at: string | null
          whatsapp: boolean
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          optin_at?: string | null
          org_id: string
          phone_e164: string
          priority?: number
          verified_at?: string | null
          voice?: boolean
          wa_last_inbound_at?: string | null
          whatsapp?: boolean
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          optin_at?: string | null
          org_id?: string
          phone_e164?: string
          priority?: number
          verified_at?: string | null
          voice?: boolean
          wa_last_inbound_at?: string | null
          whatsapp?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "contacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      edge_eval_state: {
        Row: {
          last_eval_at: string
          org_id: string
        }
        Insert: {
          last_eval_at: string
          org_id: string
        }
        Update: {
          last_eval_at?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "edge_eval_state_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      edge_hits: {
        Row: {
          auth: boolean
          connection_id: string
          id: number
          ip: unknown
          latency_ms: number
          method: string
          org_id: string
          path: string
          status: number
          ts: string
          ua: string
        }
        Insert: {
          auth?: boolean
          connection_id: string
          id?: never
          ip: unknown
          latency_ms: number
          method: string
          org_id: string
          path: string
          status: number
          ts: string
          ua?: string
        }
        Update: {
          auth?: boolean
          connection_id?: string
          id?: never
          ip?: unknown
          latency_ms?: number
          method?: string
          org_id?: string
          path?: string
          status?: number
          ts?: string
          ua?: string
        }
        Relationships: [
          {
            foreignKeyName: "edge_hits_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edge_hits_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      findings: {
        Row: {
          confirmed: boolean
          connection_id: string | null
          dedupe_key: string
          evidence: Json
          first_seen_at: string
          fix_model: string | null
          fix_prompt: string | null
          id: string
          last_seen_at: string
          module: string
          org_id: string
          origin: string
          resource: string
          rule_id: string
          scan_run_id: string | null
          severity: string
          severity_rank: number | null
          status: string
          status_reason: string | null
          suspected_injection: boolean
          title: string
          verified_at: string | null
        }
        Insert: {
          confirmed?: boolean
          connection_id?: string | null
          dedupe_key: string
          evidence?: Json
          first_seen_at?: string
          fix_model?: string | null
          fix_prompt?: string | null
          id?: string
          last_seen_at?: string
          module: string
          org_id: string
          origin?: string
          resource: string
          rule_id: string
          scan_run_id?: string | null
          severity: string
          severity_rank?: number | null
          status?: string
          status_reason?: string | null
          suspected_injection?: boolean
          title: string
          verified_at?: string | null
        }
        Update: {
          confirmed?: boolean
          connection_id?: string | null
          dedupe_key?: string
          evidence?: Json
          first_seen_at?: string
          fix_model?: string | null
          fix_prompt?: string | null
          id?: string
          last_seen_at?: string
          module?: string
          org_id?: string
          origin?: string
          resource?: string
          rule_id?: string
          scan_run_id?: string | null
          severity?: string
          severity_rank?: number | null
          status?: string
          status_reason?: string | null
          suspected_injection?: boolean
          title?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "findings_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "findings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "findings_scan_run_id_fkey"
            columns: ["scan_run_id"]
            isOneToOne: false
            referencedRelation: "scan_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          acked_at: string | null
          acked_via: string | null
          code: string
          connection_id: string | null
          dedupe_key: string
          details: Json
          event_count: number
          id: string
          last_event_at: string
          mitigated_at: string | null
          muted_until: string | null
          notified_at: string | null
          org_id: string
          resolved_at: string | null
          resource: string
          rule_ids: string[]
          severity: string
          severity_rank: number | null
          started_at: string
          status: string
          suspected_injection: boolean
          title: string
        }
        Insert: {
          acked_at?: string | null
          acked_via?: string | null
          code?: string
          connection_id?: string | null
          dedupe_key: string
          details?: Json
          event_count?: number
          id?: string
          last_event_at?: string
          mitigated_at?: string | null
          muted_until?: string | null
          notified_at?: string | null
          org_id: string
          resolved_at?: string | null
          resource: string
          rule_ids: string[]
          severity: string
          severity_rank?: number | null
          started_at?: string
          status?: string
          suspected_injection?: boolean
          title: string
        }
        Update: {
          acked_at?: string | null
          acked_via?: string | null
          code?: string
          connection_id?: string | null
          dedupe_key?: string
          details?: Json
          event_count?: number
          id?: string
          last_event_at?: string
          mitigated_at?: string | null
          muted_until?: string | null
          notified_at?: string | null
          org_id?: string
          resolved_at?: string | null
          resource?: string
          rule_ids?: string[]
          severity?: string
          severity_rank?: number | null
          started_at?: string
          status?: string
          suspected_injection?: boolean
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "incidents_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_samples: {
        Row: {
          connection_id: string
          id: number
          labels: Json
          metric: string
          org_id: string
          ts: string
          value: number
        }
        Insert: {
          connection_id: string
          id?: never
          labels?: Json
          metric: string
          org_id: string
          ts: string
          value: number
        }
        Update: {
          connection_id?: string
          id?: never
          labels?: Json
          metric?: string
          org_id?: string
          ts?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "metric_samples_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_samples_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          channel: string
          code_review_id: string | null
          created_at: string
          delivered_at: string | null
          error: string | null
          id: string
          incident_id: string | null
          org_id: string
          provider_id: string | null
          read_at: string | null
          recipient_masked: string
          sent_at: string | null
          status: string
          template: string
        }
        Insert: {
          channel: string
          code_review_id?: string | null
          created_at?: string
          delivered_at?: string | null
          error?: string | null
          id?: string
          incident_id?: string | null
          org_id: string
          provider_id?: string | null
          read_at?: string | null
          recipient_masked: string
          sent_at?: string | null
          status?: string
          template: string
        }
        Update: {
          channel?: string
          code_review_id?: string | null
          created_at?: string
          delivered_at?: string | null
          error?: string | null
          id?: string
          incident_id?: string | null
          org_id?: string
          provider_id?: string | null
          read_at?: string | null
          recipient_masked?: string
          sent_at?: string | null
          status?: string
          template?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_code_review_id_fkey"
            columns: ["code_review_id"]
            isOneToOne: false
            referencedRelation: "code_reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          created_at: string
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          org_id: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          ai_daily_cap_usd: number
          created_at: string
          daily_audit: boolean
          id: string
          is_demo: boolean
          name: string
          slug: string
        }
        Insert: {
          ai_daily_cap_usd?: number
          created_at?: string
          daily_audit?: boolean
          id?: string
          is_demo?: boolean
          name: string
          slug: string
        }
        Update: {
          ai_daily_cap_usd?: number
          created_at?: string
          daily_audit?: boolean
          id?: string
          is_demo?: boolean
          name?: string
          slug?: string
        }
        Relationships: []
      }
      perf_runs: {
        Row: {
          commit_sha: string | null
          created_at: string
          diagnosis: Json | null
          field: Json | null
          final_url: string | null
          id: string
          is_representative: boolean
          lighthouse_version: string | null
          metrics: Json
          org_id: string
          rep: number
          run_group: string
          runtime_error: string | null
          scan_run_id: string | null
          scores: Json
          source: string
          strategy: string
          trigger: string
          url: string
          version_label: string | null
        }
        Insert: {
          commit_sha?: string | null
          created_at?: string
          diagnosis?: Json | null
          field?: Json | null
          final_url?: string | null
          id?: string
          is_representative?: boolean
          lighthouse_version?: string | null
          metrics?: Json
          org_id: string
          rep?: number
          run_group?: string
          runtime_error?: string | null
          scan_run_id?: string | null
          scores?: Json
          source?: string
          strategy: string
          trigger?: string
          url: string
          version_label?: string | null
        }
        Update: {
          commit_sha?: string | null
          created_at?: string
          diagnosis?: Json | null
          field?: Json | null
          final_url?: string | null
          id?: string
          is_representative?: boolean
          lighthouse_version?: string | null
          metrics?: Json
          org_id?: string
          rep?: number
          run_group?: string
          runtime_error?: string | null
          scan_run_id?: string | null
          scores?: Json
          source?: string
          strategy?: string
          trigger?: string
          url?: string
          version_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "perf_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "perf_runs_scan_run_id_fkey"
            columns: ["scan_run_id"]
            isOneToOne: false
            referencedRelation: "scan_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      scan_runs: {
        Row: {
          coverage: Json | null
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          kind: string
          org_id: string
          params: Json
          progress: number
          requested_by: string | null
          score: number | null
          started_at: string | null
          status: string
          step: string | null
          steps: Json
          summary: Json | null
        }
        Insert: {
          coverage?: Json | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          kind: string
          org_id: string
          params?: Json
          progress?: number
          requested_by?: string | null
          score?: number | null
          started_at?: string | null
          status?: string
          step?: string | null
          steps?: Json
          summary?: Json | null
        }
        Update: {
          coverage?: Json | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          org_id?: string
          params?: Json
          progress?: number
          requested_by?: string | null
          score?: number | null
          started_at?: string | null
          status?: string
          step?: string | null
          steps?: Json
          summary?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "scan_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_events: {
        Row: {
          external_id: string
          id: number
          payload_redacted: Json
          provider: string
          received_at: string
        }
        Insert: {
          external_id: string
          id?: never
          payload_redacted?: Json
          provider: string
          received_at?: string
        }
        Update: {
          external_id?: string
          id?: never
          payload_redacted?: Json
          provider?: string
          received_at?: string
        }
        Relationships: []
      }
      wiki_runs: {
        Row: {
          branch: string | null
          cached: boolean
          commit_sha: string | null
          connection_id: string | null
          cost_usd: number
          created_at: string
          doc: Json | null
          error: string | null
          est_usd: number | null
          finished_at: string | null
          huella: string | null
          id: string
          max_usd: number
          models: Json
          org_id: string
          progress: number
          repo_full_name: string
          requested_by: string | null
          started_at: string | null
          state: Json | null
          status: string
          steps: Json
          updated_at: string
        }
        Insert: {
          branch?: string | null
          cached?: boolean
          commit_sha?: string | null
          connection_id?: string | null
          cost_usd?: number
          created_at?: string
          doc?: Json | null
          error?: string | null
          est_usd?: number | null
          finished_at?: string | null
          huella?: string | null
          id?: string
          max_usd?: number
          models?: Json
          org_id: string
          progress?: number
          repo_full_name: string
          requested_by?: string | null
          started_at?: string | null
          state?: Json | null
          status?: string
          steps?: Json
          updated_at?: string
        }
        Update: {
          branch?: string | null
          cached?: boolean
          commit_sha?: string | null
          connection_id?: string | null
          cost_usd?: number
          created_at?: string
          doc?: Json | null
          error?: string | null
          est_usd?: number | null
          finished_at?: string | null
          huella?: string | null
          id?: string
          max_usd?: number
          models?: Json
          org_id?: string
          progress?: number
          repo_full_name?: string
          requested_by?: string | null
          started_at?: string | null
          state?: Json | null
          status?: string
          steps?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wiki_runs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wiki_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      perf_points: {
        Row: {
          at: string | null
          cls: number | null
          commit_sha: string | null
          fcp_ms: number | null
          lcp_ms: number | null
          lighthouse_version: string | null
          n: number | null
          org_id: string | null
          perf_score: number | null
          run_group: string | null
          script_bytes: number | null
          si_ms: number | null
          strategy: string | null
          tbt_ms: number | null
          trigger: string | null
          ttfb_ms: number | null
          url: string | null
          version_label: string | null
        }
        Relationships: [
          {
            foreignKeyName: "perf_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      join_demo_org: { Args: never; Returns: string }
      vg_ai_reserve: {
        Args: {
          p_model: string
          p_org: string
          p_route: string
          p_worst_usd: number
        }
        Returns: Json
      }
      vg_ai_settle: {
        Args: {
          p_cache_read: number
          p_cache_write: number
          p_cost: number
          p_id: string
          p_input: number
          p_output: number
          p_refusal: string
          p_request_id: string
          p_stop: string
        }
        Returns: undefined
      }
      vg_ai_status: { Args: { p_org: string }; Returns: Json }
      vg_claim_step: {
        Args: { p_paso: string; p_retomar: boolean; p_scan: string }
        Returns: boolean
      }
      vg_create_connection: {
        Args: { p_conn: Json; p_secret: Json }
        Returns: undefined
      }
      vg_create_org: {
        Args: { p_name: string; p_owner: string; p_slug: string }
        Returns: string
      }
      vg_crypto_material: {
        Args: { p_version: number }
        Returns: {
          fp_pepper_b64: string
          kek_b64: string
        }[]
      }
      vg_edge_window: {
        Args: { p_org: string; p_seconds?: number }
        Returns: {
          admin_ok: number
          ip: unknown
          n: number
          n5xx: number
          p95_ms: number
          paths_4xx: number
          probe_hits: number
          total: number
          ua_top: string
        }[]
      }
      vg_ip_first_seen: {
        Args: { p_ip: unknown; p_org: string; p_seconds?: number }
        Returns: string
      }
      vg_mark_step: {
        Args: {
          p_paso: string
          p_patch: Json
          p_progress: number
          p_scan: string
        }
        Returns: boolean
      }
      vg_redeem_approval: {
        Args: { p_approval: string; p_nonce_hash: string; p_recipient: string }
        Returns: {
          action_kind: string
          attempts: number
          channel: string
          created_at: string
          expires_at: string
          id: string
          incident_id: string | null
          nonce_hash: string
          org_id: string
          params: Json
          recipient: string
          result: Json | null
          used_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "approvals"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      vg_replace_contacts: {
        Args: { p_org: string; p_rows: Json }
        Returns: {
          created_at: string
          id: string
          name: string
          optin_at: string | null
          org_id: string
          phone_e164: string
          priority: number
          verified_at: string | null
          voice: boolean
          wa_last_inbound_at: string | null
          whatsapp: boolean
        }[]
        SetofOptions: {
          from: "*"
          to: "contacts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      vg_resolve_idle_incidents: {
        Args: { p_idle_seconds?: number; p_limit?: number }
        Returns: {
          id: string
          org_id: string
        }[]
      }
      vg_review_findings: {
        Args: {
          p_meta: Json
          p_org: string
          p_review: string
          p_rows: Json
          p_write: boolean
        }
        Returns: Json
      }
      vg_rotate_secret: {
        Args: {
          p_capabilities: Json
          p_conn: string
          p_expires_at: string
          p_last4: string
          p_org: string
          p_scopes: string[]
          p_secret: Json
        }
        Returns: undefined
      }
      vg_traffic: { Args: { p_org: string; p_seconds?: number }; Returns: Json }
      vg_try_eval: { Args: { p_org: string }; Returns: boolean }
      vg_upsert_findings: {
        Args: {
          p_complete: boolean
          p_conn: string
          p_module: string
          p_org: string
          p_rows: Json
          p_rule?: string
          p_scan: string
        }
        Returns: number
      }
      vg_upsert_incident: {
        Args: {
          p_conn: string
          p_dedupe: string
          p_details: Json
          p_ip: unknown
          p_org: string
          p_resource: string
          p_rules: string[]
          p_severity: string
          p_started: string
          p_title: string
        }
        Returns: {
          code: string
          id: string
          is_new: boolean
          muted_until: string
          prev_severity: string
          reopened: boolean
          severity: string
          status: string
        }[]
      }
      vg_vigilar_corridas: {
        Args: {
          p_limit?: number
          p_scan_seconds?: number
          p_wiki_seconds?: number
        }
        Returns: {
          id: string
          org_id: string
          tabla: string
        }[]
      }
      vg_wiki_avanzar: {
        Args: {
          p_n: number
          p_org: string
          p_patch: Json
          p_run: string
          p_state: Json
        }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
