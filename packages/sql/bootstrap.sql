-- Cluster-level hardening, run once as supabase_admin after the image init.
-- The default "postgres" database is not used by apps: nobody but its owner and
-- the explicitly granted internal roles may connect to it.
revoke connect, temporary on database postgres from public;
revoke connect, temporary on database template1 from public;
