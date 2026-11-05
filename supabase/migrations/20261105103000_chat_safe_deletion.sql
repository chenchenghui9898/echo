-- Keep deleted chat content private while preserving public reply relationships.

create table public.chat_message_deletion_audits (
  message_id uuid primary key references public.chat_messages(id) on delete cascade,
  room_id text not null references public.chat_rooms(id) on delete restrict,
  original_content text not null,
  deleted_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz not null,
  archived_at timestamptz not null default timezone('utc', now())
);

alter table public.chat_message_deletion_audits enable row level security;
revoke all on table public.chat_message_deletion_audits from anon, authenticated;

-- The raw legacy import batch still preserves the original prototype snapshot.
insert into public.chat_message_deletion_audits (
  message_id, room_id, original_content, deleted_by, deleted_at
)
select id, room_id, content, user_id, coalesce(deleted_at, updated_at)
from public.chat_messages
where status = 'deleted'
on conflict (message_id) do nothing;

update public.chat_messages
set content = '该消息已删除'
where status = 'deleted';

drop policy chat_messages_public_read_normal on public.chat_messages;

create policy chat_messages_public_read_sanitized
on public.chat_messages for select
to anon, authenticated
using (true);

create or replace function public.delete_own_chat_message(
  p_room_id text,
  p_message_id uuid
)
returns public.chat_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.chat_messages;
  deleted_at_value timestamptz := timezone('utc', now());
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'CHAT_AUTH_REQUIRED';
  end if;

  select * into target
  from public.chat_messages
  where id = p_message_id and room_id = p_room_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'CHAT_MESSAGE_NOT_FOUND';
  end if;

  if target.sender_type <> 'human' or target.user_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'CHAT_MESSAGE_DELETE_FORBIDDEN';
  end if;

  if target.status = 'deleted' then
    return target;
  end if;

  insert into public.chat_message_deletion_audits (
    message_id, room_id, original_content, deleted_by, deleted_at
  ) values (
    target.id, target.room_id, target.content, auth.uid(), deleted_at_value
  ) on conflict (message_id) do nothing;

  update public.chat_messages
  set
    content = '该消息已删除',
    status = 'deleted',
    deleted_at = deleted_at_value,
    updated_at = deleted_at_value
  where id = target.id
  returning * into target;

  update public.chat_ai_tasks
  set
    status = 'cancelled',
    execution_token = null,
    started_at = null,
    last_error = '触发消息已被用户删除。'
  where trigger_message_id = target.id
    and status in ('pending', 'processing');

  return target;
end;
$$;

revoke all on function public.delete_own_chat_message(text, uuid) from public;
grant execute on function public.delete_own_chat_message(text, uuid) to authenticated;

comment on table public.chat_message_deletion_audits is
  'Private original content for soft-deleted chat messages. Client roles have no access.';
comment on function public.delete_own_chat_message(text, uuid) is
  'Atomically archives and sanitizes a human user own chat message and cancels pending AI tasks.';
