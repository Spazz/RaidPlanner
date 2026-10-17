-- Raidsmith: the idea box on the Future enhancements page. Any signed-in person suggests an idea; the orchestrator triages the rows
-- with tools/roadmap-ideas.js. App-wide (no guild). submitted_by goes NULL when the person deletes their data: the idea stays, unlinked.
-- area is the same list as AREAS in js/guild/pages-roadmap.js and worker/routes/roadmap.js (guild-roadmap-worker-tests.js keeps the three equal).
-- roadmap_id is the id of the js/guild/roadmap-data.js item an idea became.

CREATE TABLE roadmap_ideas (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  details       TEXT CHECK (details IS NULL OR length(details) <= 2000),
  area          TEXT NOT NULL CHECK (area IN ('loot', 'roster', 'raids', 'attendance', 'signups', 'planner', 'discord', 'battlenet', 'platform', 'guilds', 'other')),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'added', 'declined', 'done')),
  roadmap_id    TEXT CHECK (roadmap_id IS NULL OR length(roadmap_id) BETWEEN 1 AND 80),
  triage_note   TEXT CHECK (triage_note IS NULL OR length(triage_note) <= 300),
  submitted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_roadmap_ideas_created ON roadmap_ideas(created_at);
CREATE INDEX idx_roadmap_ideas_user ON roadmap_ideas(submitted_by);
