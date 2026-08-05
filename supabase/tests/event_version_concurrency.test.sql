-- ============================================================
-- Test Suite: event_version_concurrency.test.sql
-- Description: Verifies events table version column for optimistic concurrency control.
-- ============================================================

BEGIN;

-- Enable pgTAP extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pgtap;

-- Plan the tests
SELECT plan(4);

-- Test 1: Check events table exists
SELECT has_table('public', 'events', 'Table events should exist');

-- Test 2: Check version column on events table
SELECT has_column('public', 'events', 'version', 'Column version should exist on events');

-- Test 3: Check version_vector column on events table
SELECT has_column('public', 'events', 'version_vector', 'Column version_vector should exist on events');

-- Test 4: Verify OCC update behaves correctly on version mismatch
-- Setup test profile for creator (auto-created by handle_new_user trigger)
INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
VALUES ('90000000-0000-0000-0000-000000000003', 'eventocctest@test.com', 'authenticated', 'authenticated', '{"full_name": "Event OCC Test Creator"}')
ON CONFLICT (id) DO NOTHING;

-- Insert event with initial version = 1
INSERT INTO public.events (id, title, description, created_by, version, start_date, end_date)
VALUES (
    '90000000-0000-0000-0000-000000000004',
    'OCC Test Event',
    'Original Description',
    '90000000-0000-0000-0000-000000000003',
    1,
    NOW(),
    NOW()
);

-- Try to update with stale version = 0 (should update 0 rows)
UPDATE public.events
SET description = 'Stale Update', version = 2
WHERE id = '90000000-0000-0000-0000-000000000004' AND version = 0;

SELECT is(
    (SELECT description FROM public.events WHERE id = '90000000-0000-0000-0000-000000000004'),
    'Original Description',
    'Update fails and does not modify description on version mismatch'
);

SELECT * FROM finish();
ROLLBACK;
