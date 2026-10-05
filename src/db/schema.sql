-- design-report database схемасы (PostgreSQL). Қайта іске қосуға қауіпсіз (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS people (
  id           SERIAL PRIMARY KEY,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'designer', 'viewer')),
  name         TEXT NOT NULL,
  yougile_id   TEXT UNIQUE,            -- тек дизайнерлер
  yougile_name TEXT,
  excel_name   TEXT,
  telegram_id  BIGINT UNIQUE,
  link_code    TEXT UNIQUE,
  link_code_at TIMESTAMPTZ,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- YouGile тапсырмасының raw көшірмесі
CREATE TABLE IF NOT EXISTS tasks (
  yougile_id     TEXT PRIMARY KEY,
  code           TEXT NOT NULL,
  title          TEXT NOT NULL,
  project        TEXT,
  board          TEXT,
  column_name    TEXT,
  assigned       TEXT[] NOT NULL DEFAULT '{}',
  completed      BOOLEAN NOT NULL,
  completed_at   TIMESTAMPTZ,
  raw            JSONB NOT NULL,
  content_hash   TEXT NOT NULL,
  messages_read_at TIMESTAMPTZ,
  reopened_count INT NOT NULL DEFAULT 0,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_files (
  task_id     TEXT NOT NULL REFERENCES tasks(yougile_id),
  uuid        TEXT NOT NULL,
  name        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  message_id  BIGINT NOT NULL,
  uploaded_by TEXT NOT NULL,
  status      TEXT NOT NULL,   -- counted / ask / excluded
  reason      TEXT,
  PRIMARY KEY (task_id, uuid)
);

CREATE TABLE IF NOT EXISTS weeks (
  monday  DATE PRIMARY KEY,
  label   TEXT NOT NULL,
  status  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent')),
  sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS calculations (
  id            SERIAL PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(yougile_id),
  designer_yid  TEXT NOT NULL,
  week          DATE NOT NULL REFERENCES weeks(monday),
  is_supplement BOOLEAN NOT NULL DEFAULT FALSE,
  file_count    INT NOT NULL,
  ask_count     INT NOT NULL DEFAULT 0,
  rule_code     TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'needs_review', 'ask_designer', 'no_files', 'corrected', 'skipped')),
  reasons       TEXT[] NOT NULL DEFAULT '{}',
  warnings      TEXT[] NOT NULL DEFAULT '{}',
  items         JSONB NOT NULL DEFAULT '{}',
  trace         JSONB NOT NULL DEFAULT '{}',
  manual        BOOLEAN NOT NULL DEFAULT FALSE,   -- дизайнер санды өзі енгізді
  asked_at      TIMESTAMPTZ,                      -- бот сұрақ жіберген уақыт
  answer        TEXT,                             -- correction / extra / manual:N / uploaded
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, designer_yid, week, is_supplement)
);

CREATE TABLE IF NOT EXISTS corrections (
  id          SERIAL PRIMARY KEY,
  calc_id     INT NOT NULL REFERENCES calculations(id),
  old_items   JSONB NOT NULL,
  new_items   JSONB NOT NULL,
  old_status  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  made_by     TEXT NOT NULL,
  made_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_by TEXT,
  reverted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS weekly_reports (
  week         DATE NOT NULL REFERENCES weeks(monday),
  designer_yid TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'sent', -- sent / confirmed / disputed
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  PRIMARY KEY (week, designer_yid)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  requests    INT NOT NULL DEFAULT 0,
  tasks_new   INT NOT NULL DEFAULT 0,
  tasks_changed INT NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id     SERIAL PRIMARY KEY,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  data   JSONB,
  at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calc_week_idx ON calculations (week, designer_yid);
CREATE INDEX IF NOT EXISTS tasks_completed_idx ON tasks (completed_at);

-- v2: бір адам әрі дизайнер, әрі админ бола алады
ALTER TABLE people ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- v3: қазір ашық (✓ болмаған) тапсырмалар — AI «бүгін кімде не бар» сұрағы үшін. Әр sync-те толық жаңартылады
CREATE TABLE IF NOT EXISTS open_tasks (
  yougile_id  TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  title       TEXT NOT NULL,
  project     TEXT,
  board       TEXT,
  column_name TEXT,
  assigned    TEXT[] NOT NULL DEFAULT '{}',
  deadline_at TIMESTAMPTZ,
  created_at_yg TIMESTAMPTZ,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v4: Telegram username бойынша автоматты тіркелу
ALTER TABLE people ADD COLUMN IF NOT EXISTS tg_username TEXT;

-- v5: толық емес ТЗ туралы ескертілген тапсырмалар (бір рет қана ескерту үшін)
CREATE TABLE IF NOT EXISTS tz_warnings (
  task_id   TEXT PRIMARY KEY,
  reasons   TEXT[] NOT NULL,
  warned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v6: Marketing-тегі «обложка» тапсырмаларын дизайнерден растау (рилс па, пост па) — бір рет
CREATE TABLE IF NOT EXISTS cover_checks (
  calc_id   INTEGER PRIMARY KEY,
  asked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  answer    TEXT
);
