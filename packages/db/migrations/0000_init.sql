CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"linked_email" text,
	"email_verified_by_provider" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"user_id" text NOT NULL,
	"transport" text NOT NULL,
	"client_name" text,
	"declared_model" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"halt_reason" text,
	"premise_id" text,
	"output_commit_sha" text,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"fetches" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"seq" integer NOT NULL,
	"tool" text NOT NULL,
	"args_hash" text NOT NULL,
	"args_redacted" jsonb,
	"result_hash" text,
	"result_ref" text,
	"status" text NOT NULL,
	"reject_reason" text,
	"duration_ms" integer,
	"called_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"selector" text NOT NULL,
	"verifier" text NOT NULL,
	"scopes" text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_selector_unique" UNIQUE("selector")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" text,
	"repo_id" text,
	"action" text NOT NULL,
	"target" text,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authoring_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"paths" text[] DEFAULT '{}' NOT NULL,
	"words_added" integer DEFAULT 0 NOT NULL,
	"words_removed" integer DEFAULT 0 NOT NULL,
	"keystrokes" integer DEFAULT 0 NOT NULL,
	"iki_histogram" integer[] DEFAULT '{}' NOT NULL,
	"median_wpm" real,
	"burst_count" integer,
	"mode_words" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client" text NOT NULL,
	"commit_shas" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"repo_id" text NOT NULL,
	"name" text NOT NULL,
	"head_sha" text NOT NULL,
	"kind" text DEFAULT 'draft' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_repo_id_name_pk" PRIMARY KEY("repo_id","name")
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"repo_id" text NOT NULL,
	"sha" text NOT NULL,
	"parents" text[] DEFAULT '{}' NOT NULL,
	"author_id" text,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"message" text NOT NULL,
	"provenance" text NOT NULL,
	"agent_session_id" text,
	"declared_model" text,
	"spans_digest" text,
	"config_version" text,
	"words_added" integer DEFAULT 0 NOT NULL,
	"words_removed" integer DEFAULT 0 NOT NULL,
	"files_changed" integer DEFAULT 0 NOT NULL,
	"evidence" text[] DEFAULT '{}' NOT NULL,
	"phase" text,
	CONSTRAINT "commits_repo_id_sha_pk" PRIMARY KEY("repo_id","sha")
);
--> statement-breakpoint
CREATE TABLE "derivations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"beat_id" text,
	"path" text NOT NULL,
	"para_index" integer NOT NULL,
	"relation" text NOT NULL,
	"similarity" double precision,
	"method" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diff_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"mode" text NOT NULL,
	"algo_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"chapter_no" integer,
	"title" text,
	"order_index" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"ai_word_share" real DEFAULT 0 NOT NULL,
	"head_sha" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "input_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"path" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"input_mode" text NOT NULL,
	"char_count" integer NOT NULL,
	"word_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"is_trusted" boolean DEFAULT true NOT NULL,
	"matched_session_id" text,
	"author_note" text,
	"author_noted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"selector" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_links_selector_unique" UNIQUE("selector")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"repo_id" text,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "novelty_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"premise_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"corpus_similarity" real,
	"concept_overlap" real,
	"market_density" integer,
	"corpora" text[] NOT NULL,
	"searched_at" timestamp with time zone NOT NULL,
	"nearest_works" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"author_response" text,
	"author_responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"selector" text NOT NULL,
	"verifier" text NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"return_to" text DEFAULT '/' NOT NULL,
	"link_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_selector_unique" UNIQUE("selector")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'publisher' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "premises" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"themes" text[],
	"entities" jsonb,
	"embedding" real[],
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prior_works" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"authors" text[],
	"published_year" integer,
	"isbn" text,
	"synopsis" text,
	"subjects" text[],
	"embedding" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provenance_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"prev_receipt_hash" text,
	"spans_digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"anchored_at" timestamp with time zone,
	"anchor_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provenance_spans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"path" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"origin" text NOT NULL,
	"agent_session_id" text,
	"declared_model" text,
	"retained" real,
	"beat_id" text,
	"author_id" text,
	"evidence" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"owner_org_id" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"form" text NOT NULL,
	"genre" text[],
	"visibility" text DEFAULT 'private' NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"storage_path" text NOT NULL,
	"target_words" integer,
	"current_words" integer DEFAULT 0 NOT NULL,
	"phase" text DEFAULT 'premise' NOT NULL,
	"signing_key_id" text,
	"halt_on_derivative" boolean DEFAULT true NOT NULL,
	"gallery_opt_in" boolean DEFAULT false NOT NULL,
	"delisted_at" timestamp with time zone,
	"delisted_reason" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_one_owner" CHECK (("repositories"."owner_user_id" is null) <> ("repositories"."owner_org_id" is null))
);
--> statement-breakpoint
CREATE TABLE "repository_collaborators" (
	"repo_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_collaborators_repo_id_user_id_pk" PRIMARY KEY("repo_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "research_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"ledger_ref" text NOT NULL,
	"discovered_via" text NOT NULL,
	"query" text,
	"source_type" text NOT NULL,
	"url" text,
	"title" text,
	"authors" text[],
	"publisher" text,
	"published_at" timestamp with time zone,
	"identifier" text,
	"retrieved_at" timestamp with time zone NOT NULL,
	"fetch_status" text NOT NULL,
	"content_hash" text,
	"excerpt" text,
	"excerpt_ref" text,
	"domain" text,
	"used_in_beats" text[],
	"embedding" real[]
);
--> statement-breakpoint
CREATE TABLE "review_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"path" text,
	"commit_sha" text,
	"start_offset" integer,
	"end_offset" integer,
	"anchor_text" text,
	"resolved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"selector" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_selector_unique" UNIQUE("selector")
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text,
	"algo" text DEFAULT 'ed25519' NOT NULL,
	"public_key" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"phase" text,
	"commit_sha" text,
	"agent_session_id" text,
	"actor_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"display_name" text,
	"pen_name" text,
	"bio" text,
	"avatar_url" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_links" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text NOT NULL,
	"ref" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_sessions" ADD CONSTRAINT "authoring_sessions_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_sessions" ADD CONSTRAINT "authoring_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derivations" ADD CONSTRAINT "derivations_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diff_cache" ADD CONSTRAINT "diff_cache_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_events" ADD CONSTRAINT "input_events_session_id_authoring_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."authoring_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_events" ADD CONSTRAINT "input_events_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "novelty_reports" ADD CONSTRAINT "novelty_reports_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "novelty_reports" ADD CONSTRAINT "novelty_reports_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_link_user_id_users_id_fk" FOREIGN KEY ("link_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "premises" ADD CONSTRAINT "premises_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_receipts" ADD CONSTRAINT "provenance_receipts_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_receipts" ADD CONSTRAINT "provenance_receipts_signing_key_id_signing_keys_id_fk" FOREIGN KEY ("signing_key_id") REFERENCES "public"."signing_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_spans" ADD CONSTRAINT "provenance_spans_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_spans" ADD CONSTRAINT "provenance_spans_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_owner_org_id_organizations_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_collaborators" ADD CONSTRAINT "repository_collaborators_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_collaborators" ADD CONSTRAINT "repository_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_collaborators" ADD CONSTRAINT "repository_collaborators_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_thread_id_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."review_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_keys" ADD CONSTRAINT "signing_keys_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_links" ADD CONSTRAINT "verification_links_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_links" ADD CONSTRAINT "verification_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_uq" ON "accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "accounts_user" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_repo" ON "agent_sessions" USING btree ("repo_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_session_seq" ON "agent_tool_calls" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "sessions_repo" ON "authoring_sessions" USING btree ("repo_id","started_at");--> statement-breakpoint
CREATE INDEX "commits_repo_time" ON "commits" USING btree ("repo_id","committed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "derivations_uq" ON "derivations" USING btree ("repo_id","head_sha","path","para_index","beat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_repo_path" ON "documents" USING btree ("repo_id","path");--> statement-breakpoint
CREATE INDEX "input_events_repo" ON "input_events" USING btree ("repo_id","occurred_at");--> statement-breakpoint
CREATE INDEX "magic_links_email" ON "magic_links" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "premises_repo_version" ON "premises" USING btree ("repo_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "prior_works_source_ext" ON "prior_works" USING btree ("source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_repo_commit" ON "provenance_receipts" USING btree ("repo_id","commit_sha");--> statement-breakpoint
CREATE INDEX "spans_lookup" ON "provenance_spans" USING btree ("repo_id","path","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_owner_slug" ON "repositories" USING btree (coalesce("owner_user_id", "owner_org_id"),"slug");--> statement-breakpoint
CREATE INDEX "sources_repo" ON "research_sources" USING btree ("repo_id","domain");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "timeline_scan" ON "timeline_events" USING btree ("repo_id","occurred_at");