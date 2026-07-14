-- OFCE-409: optimistic concurrency for page edits. A monotonically-increasing version per
-- route lets a save reject a stale write (last-write-wins was silently clobbering edits now
-- that humans and the AI assistant edit the same store concurrently).
ALTER TABLE routes ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
