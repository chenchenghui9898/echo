-- Correlates optimistic client messages with their durable server row and
-- makes retries idempotent per authenticated user.
alter table public.chat_messages
  add column client_request_id uuid;

alter table public.chat_messages
  add constraint chat_messages_client_request_human_only check (
    sender_type = 'human' or client_request_id is null
  );

create unique index chat_messages_user_client_request_idx
  on public.chat_messages (user_id, client_request_id)
  where user_id is not null and client_request_id is not null;

grant insert (client_request_id) on table public.chat_messages to authenticated;

comment on column public.chat_messages.client_request_id
is 'Client-generated UUID for optimistic UI reconciliation and idempotent human-message retries.';
