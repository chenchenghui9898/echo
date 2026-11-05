-- Echo phase 2: lossless archive and AI-lab data structures used by the
-- one-time JSON migration. These tables do not replace the application's
-- current JSON repository yet.

create type public.lab_generation_status as enum ('running', 'completed', 'failed');
create type public.lab_comment_trigger as enum ('initial', 'agreement', 'user_reply');
create type public.lab_task_status as enum ('pending', 'running', 'completed', 'failed', 'cancelled');
create type public.feedback_sentiment as enum ('like', 'dislike');
create type public.chat_report_status as enum ('pending', 'reviewed', 'dismissed', 'actioned');

create table public.legacy_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_checksum text not null unique,
  source_schema_version integer not null,
  source_counts jsonb not null,
  raw_document jsonb not null,
  imported_at timestamptz not null default timezone('utc', now()),
  constraint legacy_import_batches_checksum_format check (source_checksum ~ '^[0-9a-f]{64}$'),
  constraint legacy_import_batches_counts_object check (jsonb_typeof(source_counts) = 'object'),
  constraint legacy_import_batches_document_object check (jsonb_typeof(raw_document) = 'object')
);

create table public.lab_prompt_versions (
  id uuid primary key,
  scope text not null,
  version integer not null,
  name text not null,
  body text not null,
  notes text not null default '',
  created_at timestamptz not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_prompt_versions_scope_length check (char_length(scope) between 1 and 80),
  constraint lab_prompt_versions_positive_version check (version > 0),
  constraint lab_prompt_versions_name_length check (char_length(name) between 1 and 120),
  constraint lab_prompt_versions_unique_scope_version unique (scope, version)
);

create table public.lab_inputs (
  id uuid primary key,
  content text not null,
  character_count integer not null,
  created_at timestamptz not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_inputs_character_count_nonnegative check (character_count >= 0)
);

comment on column public.lab_inputs.character_count is
  'Original JavaScript UTF-16 length. It can differ from PostgreSQL char_length for non-BMP characters.';

create table public.lab_generation_runs (
  id uuid primary key,
  input_id uuid not null references public.lab_inputs(id) on delete restrict,
  prompt_version_id uuid not null references public.lab_prompt_versions(id) on delete restrict,
  prompt_snapshot jsonb not null,
  system_prompt_snapshot text not null,
  model_config_snapshot jsonb not null,
  status public.lab_generation_status not null,
  error_message text,
  token_usage jsonb,
  created_at timestamptz not null,
  completed_at timestamptz,
  content_analysis_id uuid,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_generation_runs_prompt_snapshot_object check (jsonb_typeof(prompt_snapshot) = 'object'),
  constraint lab_generation_runs_model_config_object check (jsonb_typeof(model_config_snapshot) = 'object'),
  constraint lab_generation_runs_usage_object check (token_usage is null or jsonb_typeof(token_usage) = 'object')
);

create index lab_generation_runs_input_idx on public.lab_generation_runs (input_id, created_at desc);
create index lab_generation_runs_status_idx on public.lab_generation_runs (status, created_at desc);

create table public.legacy_posts (
  id uuid primary key,
  input_id uuid not null references public.lab_inputs(id) on delete restrict,
  run_id uuid not null references public.lab_generation_runs(id) on delete restrict,
  legacy_type text not null,
  title text,
  author_snapshot text not null,
  published_at timestamptz not null,
  deleted_at timestamptz,
  planned_comment_count integer not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint legacy_posts_type_length check (char_length(legacy_type) between 1 and 40),
  constraint legacy_posts_title_length check (title is null or char_length(title) <= 120),
  constraint legacy_posts_author_length check (char_length(author_snapshot) between 1 and 80),
  constraint legacy_posts_comment_count_nonnegative check (planned_comment_count >= 0)
);

create index legacy_posts_published_idx on public.legacy_posts (published_at desc);

create table public.lab_content_analyses (
  id uuid primary key,
  input_id uuid not null references public.lab_inputs(id) on delete restrict,
  legacy_post_id uuid not null references public.legacy_posts(id) on delete restrict,
  analysis jsonb not null,
  prompt_version_id uuid not null references public.lab_prompt_versions(id) on delete restrict,
  prompt_snapshot jsonb not null,
  model_config_snapshot jsonb not null,
  token_usage jsonb,
  source text not null,
  error_message text,
  created_at timestamptz not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_content_analyses_analysis_object check (jsonb_typeof(analysis) = 'object'),
  constraint lab_content_analyses_prompt_snapshot_object check (jsonb_typeof(prompt_snapshot) = 'object'),
  constraint lab_content_analyses_model_config_object check (jsonb_typeof(model_config_snapshot) = 'object'),
  constraint lab_content_analyses_usage_object check (token_usage is null or jsonb_typeof(token_usage) = 'object'),
  constraint lab_content_analyses_source check (source in ('model', 'fallback'))
);

alter table public.lab_generation_runs
  add constraint lab_generation_runs_content_analysis_fk
  foreign key (content_analysis_id) references public.lab_content_analyses(id) on delete set null;

create table public.lab_comment_tasks (
  id uuid primary key,
  legacy_post_id uuid not null references public.legacy_posts(id) on delete restrict,
  persona_id text not null,
  scheduled_at timestamptz not null,
  status public.lab_task_status not null,
  generated_at timestamptz,
  comment_id uuid,
  retry_count integer not null,
  created_at timestamptz not null,
  started_at timestamptz,
  execution_token uuid,
  last_error text,
  content_analysis_id uuid references public.lab_content_analyses(id) on delete set null,
  strategy_prompt_snapshot jsonb,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_comment_tasks_retry_nonnegative check (retry_count >= 0),
  constraint lab_comment_tasks_strategy_object check (
    strategy_prompt_snapshot is null or jsonb_typeof(strategy_prompt_snapshot) = 'object'
  )
);

create index lab_comment_tasks_due_idx
  on public.lab_comment_tasks (scheduled_at, id)
  where status = 'pending';
create index lab_comment_tasks_post_idx on public.lab_comment_tasks (legacy_post_id, created_at);

create table public.lab_comments (
  id uuid primary key,
  run_id uuid not null references public.lab_generation_runs(id) on delete restrict,
  position integer not null,
  content text not null,
  persona_snapshot jsonb not null,
  trigger public.lab_comment_trigger not null,
  parent_comment_id uuid references public.lab_comments(id) on delete restrict,
  trigger_feedback_id uuid,
  scheduled_task_id uuid references public.lab_comment_tasks(id) on delete set null,
  content_analysis_id uuid references public.lab_content_analyses(id) on delete set null,
  strategy_prompt_snapshot jsonb,
  token_usage jsonb,
  created_at timestamptz not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_comments_position_nonnegative check (position >= 0),
  constraint lab_comments_persona_object check (jsonb_typeof(persona_snapshot) = 'object'),
  constraint lab_comments_strategy_object check (
    strategy_prompt_snapshot is null or jsonb_typeof(strategy_prompt_snapshot) = 'object'
  ),
  constraint lab_comments_usage_object check (token_usage is null or jsonb_typeof(token_usage) = 'object'),
  constraint lab_comments_run_position_unique unique (run_id, position),
  constraint lab_comments_scheduled_task_unique unique (scheduled_task_id)
);

alter table public.lab_comment_tasks
  add constraint lab_comment_tasks_comment_fk
  foreign key (comment_id) references public.lab_comments(id) on delete set null;

create index lab_comments_run_idx on public.lab_comments (run_id, position);
create index lab_comments_parent_idx on public.lab_comments (parent_comment_id) where parent_comment_id is not null;

create table public.lab_comment_evaluations (
  id uuid primary key,
  comment_id uuid not null unique references public.lab_comments(id) on delete cascade,
  human_likeness text,
  value_rating text,
  notes text not null default '',
  updated_at timestamptz not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_comment_evaluations_human_likeness check (
    human_likeness is null or human_likeness in ('human', 'not_human')
  ),
  constraint lab_comment_evaluations_value check (
    value_rating is null or value_rating in ('valuable', 'not_valuable')
  )
);

create table public.lab_content_feedback (
  id uuid primary key,
  input_id uuid not null references public.lab_inputs(id) on delete restrict,
  comment_id uuid not null references public.lab_comments(id) on delete cascade,
  persona_id text not null,
  feedback_type text not null,
  reply_text text,
  active boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_content_feedback_type check (feedback_type in ('agree', 'disagree', 'reply')),
  constraint lab_content_feedback_reply_text check (
    (feedback_type = 'reply' and reply_text is not null and char_length(reply_text) > 0)
    or (feedback_type <> 'reply' and reply_text is null)
  )
);

create index lab_content_feedback_comment_idx on public.lab_content_feedback (comment_id, created_at);

create table public.lab_style_feedback (
  id uuid primary key,
  input_id uuid not null references public.lab_inputs(id) on delete restrict,
  comment_id uuid not null unique references public.lab_comments(id) on delete cascade,
  persona_id text not null,
  feedback_type public.feedback_sentiment not null,
  reasons text[] not null default '{}',
  note text not null default '',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete restrict,
  constraint lab_style_feedback_like_reasons check (
    feedback_type = 'dislike' or cardinality(reasons) = 0
  )
);

create type public.chat_report_reason as enum ('spam', 'sexual', 'attack', 'harassment', 'illegal', 'other');

create table public.chat_message_reports (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.chat_rooms(id) on delete restrict,
  message_id uuid not null references public.chat_messages(id) on delete restrict,
  reporter_user_id uuid references public.profiles(id) on delete cascade,
  reporter_legacy_id text,
  reported_user_id uuid references public.profiles(id) on delete set null,
  reported_persona_id text references public.ai_personas(id) on delete set null,
  reported_legacy_id text,
  reason public.chat_report_reason not null,
  note text not null default '',
  status public.chat_report_status not null default 'pending',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint chat_message_reports_one_reporter check (
    (reporter_user_id is not null)::integer + (reporter_legacy_id is not null)::integer = 1
  ),
  constraint chat_message_reports_one_reported_identity check (
    (reported_user_id is not null)::integer
    + (reported_persona_id is not null)::integer
    + (reported_legacy_id is not null)::integer = 1
  ),
  constraint chat_message_reports_note_length check (char_length(note) <= 1000)
);

create unique index chat_message_reports_user_unique_idx
  on public.chat_message_reports (message_id, reporter_user_id)
  where reporter_user_id is not null;
create unique index chat_message_reports_legacy_unique_idx
  on public.chat_message_reports (message_id, reporter_legacy_id)
  where reporter_legacy_id is not null;

create trigger chat_message_reports_set_updated_at
before update on public.chat_message_reports
for each row execute function public.set_updated_at();

create table public.chat_user_blocks (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.chat_rooms(id) on delete restrict,
  blocker_user_id uuid references public.profiles(id) on delete cascade,
  blocker_legacy_id text,
  blocked_user_id uuid references public.profiles(id) on delete cascade,
  blocked_legacy_id text,
  created_at timestamptz not null default timezone('utc', now()),
  constraint chat_user_blocks_one_blocker check (
    (blocker_user_id is not null)::integer + (blocker_legacy_id is not null)::integer = 1
  ),
  constraint chat_user_blocks_one_blocked check (
    (blocked_user_id is not null)::integer + (blocked_legacy_id is not null)::integer = 1
  ),
  constraint chat_user_blocks_not_self check (
    blocker_user_id is null or blocked_user_id is null or blocker_user_id <> blocked_user_id
  )
);

create unique index chat_user_blocks_user_unique_idx
  on public.chat_user_blocks (room_id, blocker_user_id, blocked_user_id)
  where blocker_user_id is not null and blocked_user_id is not null;
create unique index chat_user_blocks_legacy_unique_idx
  on public.chat_user_blocks (room_id, blocker_legacy_id, blocked_legacy_id)
  where blocker_legacy_id is not null and blocked_legacy_id is not null;

create table public.chat_ai_style_feedback (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.chat_rooms(id) on delete restrict,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  persona_id text not null references public.ai_personas(id) on delete restrict,
  model text not null,
  prompt_version text not null,
  user_id uuid references public.profiles(id) on delete cascade,
  legacy_user_id text,
  feedback_type public.feedback_sentiment not null,
  reasons text[] not null default '{}',
  note text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint chat_ai_style_feedback_one_user check (
    (user_id is not null)::integer + (legacy_user_id is not null)::integer = 1
  ),
  constraint chat_ai_style_feedback_like_reasons check (
    feedback_type = 'dislike' or cardinality(reasons) = 0
  )
);

create unique index chat_ai_style_feedback_user_unique_idx
  on public.chat_ai_style_feedback (message_id, user_id)
  where user_id is not null;
create unique index chat_ai_style_feedback_legacy_unique_idx
  on public.chat_ai_style_feedback (message_id, legacy_user_id)
  where legacy_user_id is not null;

create trigger chat_ai_style_feedback_set_updated_at
before update on public.chat_ai_style_feedback
for each row execute function public.set_updated_at();

-- Archive and lab data are admin-only. Trusted server roles bypass RLS.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'legacy_import_batches',
    'lab_prompt_versions',
    'lab_inputs',
    'lab_generation_runs',
    'legacy_posts',
    'lab_content_analyses',
    'lab_comment_tasks',
    'lab_comments',
    'lab_comment_evaluations',
    'lab_content_feedback',
    'lab_style_feedback'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      table_name || '_admin_all',
      table_name
    );
  end loop;
end;
$$;

alter table public.chat_message_reports enable row level security;
alter table public.chat_user_blocks enable row level security;
alter table public.chat_ai_style_feedback enable row level security;

revoke all on table public.chat_message_reports from anon, authenticated;
revoke all on table public.chat_user_blocks from anon, authenticated;
revoke all on table public.chat_ai_style_feedback from anon, authenticated;

grant select, insert, update on table public.chat_message_reports to authenticated;
grant select, insert, delete on table public.chat_user_blocks to authenticated;
grant select, insert, update on table public.chat_ai_style_feedback to authenticated;

create policy chat_message_reports_owner_select
on public.chat_message_reports for select to authenticated
using (reporter_user_id = auth.uid() or public.is_admin());

create policy chat_message_reports_owner_insert
on public.chat_message_reports for insert to authenticated
with check (reporter_user_id = auth.uid() and reporter_legacy_id is null);

create policy chat_message_reports_owner_update
on public.chat_message_reports for update to authenticated
using (reporter_user_id = auth.uid() or public.is_admin())
with check (reporter_user_id = auth.uid() or public.is_admin());

create policy chat_user_blocks_owner_select
on public.chat_user_blocks for select to authenticated
using (blocker_user_id = auth.uid() or public.is_admin());

create policy chat_user_blocks_owner_insert
on public.chat_user_blocks for insert to authenticated
with check (blocker_user_id = auth.uid() and blocker_legacy_id is null);

create policy chat_user_blocks_owner_delete
on public.chat_user_blocks for delete to authenticated
using (blocker_user_id = auth.uid() or public.is_admin());

create policy chat_ai_style_feedback_owner_select
on public.chat_ai_style_feedback for select to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy chat_ai_style_feedback_owner_insert
on public.chat_ai_style_feedback for insert to authenticated
with check (user_id = auth.uid() and legacy_user_id is null);

create policy chat_ai_style_feedback_owner_update
on public.chat_ai_style_feedback for update to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

comment on table public.legacy_import_batches is 'Immutable source snapshots and checksums for audited legacy imports.';
comment on table public.legacy_posts is 'Archived prototype posts; never included in the production posts feed.';
comment on table public.lab_generation_runs is 'AI lab and prototype generation history with immutable prompt/model snapshots.';
