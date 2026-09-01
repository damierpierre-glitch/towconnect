-- TowConnect — Phase 5 follow-up. AdminDashboard.tsx subscribes to
-- postgres_changes on driver_documents (added in the same phase) so a new
-- upload shows up in the admin's queue without a manual refresh — but every
-- other table that gets subscribed this way in this codebase (requests,
-- driver_profiles, dispatch_offers, messages, payments — see 0001, 0006,
-- 0008, 0013) is explicitly added to the supabase_realtime publication
-- first, and this one was missed. Without this, the subscription is silent:
-- no error, it just never fires, and the admin only sees a new document
-- after some other subscribed table happens to change.
alter publication supabase_realtime add table driver_documents;
