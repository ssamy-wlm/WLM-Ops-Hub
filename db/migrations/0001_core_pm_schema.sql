-- Migration 0001: core PM data model (Postgres)
-- Purely additive: every statement is CREATE — nothing here ever touches the
-- existing Vercel Blob data store or any row in it. Safe to run multiple
-- times (IF NOT EXISTS everywhere) so re-running after a partial failure
-- never errors out or duplicates anything.

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  legacy_id       TEXT UNIQUE,        -- the old string id from wl_users_db (e.g. 'assmaa'), for traceability back to the Blob/backup
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id              SERIAL PRIMARY KEY,
  legacy_id       TEXT UNIQUE,        -- the old string id from wl_clients_db, for traceability
  name            TEXT NOT NULL,
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id              SERIAL PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  client_id       INTEGER NOT NULL REFERENCES clients(id),
  name            TEXT NOT NULL,       -- e.g. "SEO Audit", "Monthly Retainer"
  category        TEXT,
  frequency       TEXT,                -- e.g. one-time / monthly / yearly
  status          TEXT NOT NULL DEFAULT 'active',
  started_at      DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_client_id ON services(client_id);

-- Configurable status list — admins can add/rename/reorder via the UI later
-- with no code change, instead of a hardcoded enum.
CREATE TABLE IF NOT EXISTS task_statuses (
  id              SERIAL PRIMARY KEY,
  label           TEXT NOT NULL UNIQUE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  is_terminal     BOOLEAN NOT NULL DEFAULT false,  -- marks "done"-like states for reporting
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO task_statuses (label, sort_order, is_default, is_terminal) VALUES
  ('Not Started', 0, true,  false),
  ('In Progress', 1, false, false),
  ('Review',      2, false, false),
  ('Done',        3, false, true)
ON CONFLICT (label) DO NOTHING;

CREATE TABLE IF NOT EXISTS projects (
  id                  SERIAL PRIMARY KEY,
  legacy_id           TEXT UNIQUE,
  client_id           INTEGER NOT NULL REFERENCES clients(id),
  service_id          INTEGER NOT NULL REFERENCES services(id),
  title               TEXT NOT NULL,
  description         TEXT,
  owner_user_id       INTEGER REFERENCES users(id),
  start_date          DATE,
  due_date            DATE,
  status_id           INTEGER NOT NULL REFERENCES task_statuses(id),
  created_from        TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'transcript_extraction' | future sources
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_service_id ON projects(service_id);
CREATE INDEX IF NOT EXISTS idx_projects_status_id ON projects(status_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                  SERIAL PRIMARY KEY,
  legacy_id           TEXT UNIQUE,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  title               TEXT NOT NULL,
  description         TEXT,
  assignee_user_id    INTEGER REFERENCES users(id),
  start_date          DATE,
  due_date            DATE,
  status_id           INTEGER NOT NULL REFERENCES task_statuses(id),
  created_from        TEXT NOT NULL DEFAULT 'manual',
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_user_id ON tasks(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_id ON tasks(status_id);
