CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  username      citext NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  suspended_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens rotativos: se guarda solo el hash. Reutilizar uno ya rotado revoca toda la familia.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family ON refresh_tokens(family_id);

CREATE TABLE matches (
  id           uuid PRIMARY KEY,
  visibility   text NOT NULL CHECK (visibility IN ('public', 'private')),
  invite_code  text UNIQUE,
  status       text NOT NULL CHECK (status IN ('lobby', 'active', 'finished', 'aborted')),
  state        jsonb NOT NULL,
  version      integer NOT NULL DEFAULT 0,
  deadline     timestamptz,
  result       jsonb,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX matches_open ON matches(status, visibility, created_at DESC) WHERE status = 'lobby';
CREATE INDEX matches_deadline ON matches(deadline) WHERE status IN ('lobby', 'active');

CREATE TABLE match_players (
  match_id  uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX match_players_user ON match_players(user_id, joined_at DESC);

-- Garantiza que un jugador nunca esté asignado a dos partidas a la vez.
CREATE TABLE active_membership (
  user_id  uuid PRIMARY KEY REFERENCES users(id),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE
);

-- Bitácora inmutable de eventos: permite reproducir la partida jugada por jugada.
CREATE TABLE match_events (
  match_id   uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  type       text NOT NULL,
  recipient  text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq)
);

-- Idempotencia: el id generado por el cliente identifica cada jugada.
CREATE TABLE match_actions (
  match_id       uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id),
  client_move_id uuid NOT NULL,
  round          integer NOT NULL,
  action         jsonb NOT NULL,
  seq            integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id, client_move_id)
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid NOT NULL REFERENCES users(id),
  action     text NOT NULL,
  target     text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Resultado inmutable: una partida terminada no se puede modificar.
CREATE FUNCTION forbid_finished_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('finished', 'aborted') THEN
    RAISE EXCEPTION 'La partida % ya terminó y su resultado es inmutable', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER matches_immutable BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION forbid_finished_update();

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Tabla de solo inserción: %', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER match_events_append_only BEFORE UPDATE OR DELETE ON match_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
