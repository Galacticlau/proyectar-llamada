CREATE TABLE IF NOT EXISTS media (
  id uuid PRIMARY KEY,
  mime text NOT NULL,
  bytes bytea NOT NULL,
  digest text UNIQUE NOT NULL
);
ALTER TABLE media ADD COLUMN IF NOT EXISTS object_key text;

CREATE TABLE IF NOT EXISTS tracks (
  id uuid PRIMARY KEY,
  media_id uuid UNIQUE NOT NULL REFERENCES media(id),
  name text NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  played_at timestamptz,
  played_attempt uuid
);

CREATE TABLE IF NOT EXISTS room (
  id integer PRIMARY KEY,
  track_id uuid REFERENCES tracks(id),
  attempt uuid,
  phase text NOT NULL DEFAULT 'waiting' CHECK (phase IN ('waiting','ringing','playing','snoozed','rejected','interrupted')),
  deadline timestamptz,
  wallpaper uuid REFERENCES media(id)
);
ALTER TABLE room ADD COLUMN IF NOT EXISTS prepared_media uuid REFERENCES media(id);
ALTER TABLE room ADD COLUMN IF NOT EXISTS prepared_until timestamptz;
ALTER TABLE room DROP CONSTRAINT IF EXISTS room_id_check;
INSERT INTO room (id) VALUES (1), (2), (3), (4) ON CONFLICT DO NOTHING;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS room_id integer NOT NULL DEFAULT 1 REFERENCES room(id);
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_position_key;
CREATE UNIQUE INDEX IF NOT EXISTS tracks_room_position ON tracks (room_id, position);

CREATE TABLE IF NOT EXISTS projection_pairing (
  id uuid PRIMARY KEY,
  code text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  approved boolean NOT NULL DEFAULT false
);
ALTER TABLE projection_pairing ADD COLUMN IF NOT EXISTS room_id integer NOT NULL DEFAULT 2 REFERENCES room(id);
