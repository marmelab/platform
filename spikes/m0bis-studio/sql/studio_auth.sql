set client_min_messages = warning;
reassign owned by supabase_auth_admin to studio_auth_admin;
drop owned by supabase_auth_admin;
drop owned by supabase_storage_admin;
grant usage, create on schema auth to studio_auth_admin;
