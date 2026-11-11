CREATE TABLE IF NOT EXISTS media (
  id uuid PRIMARY KEY,
  mime text NOT NULL,
  bytes bytea NOT NULL,
  digest text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id uuid PRIMARY KEY,
  media_id uuid UNIQUE NOT NULL REFERENCES media(id),
  name text NOT NULL,
  position integer UNIQUE NOT NULL CHECK (position > 0),
  played_at timestamptz,
  played_attempt uuid
);

CREATE TABLE IF NOT EXISTS room (
  id integer PRIMARY KEY CHECK (id = 1),
  track_id uuid REFERENCES tracks(id),
  attempt uuid,
  phase text NOT NULL DEFAULT 'waiting' CHECK (phase IN ('waiting','ringing','playing','snoozed','rejected','interrupted')),
  deadline timestamptz,
  wallpaper uuid REFERENCES media(id)
);
INSERT INTO room (id) VALUES (1) ON CONFLICT DO NOTHING;
