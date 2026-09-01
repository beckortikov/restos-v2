-- +goose Up
-- +goose StatementBegin
--
-- 103_attendance_photos — селфи при отметке прихода/ухода.
--
-- PIN доказывает только то, что кто-то знал четыре цифры. Их передают
-- друг другу — это и есть главный способ обмануть табель («отметь меня, я
-- опаздываю»). Фото не мешает передать PIN, но делает обман видимым: владелец
-- листает ленту снимков и сразу видит, что в 08:55 отметился не тот человек.
-- Это доказательство постфактум, а не биометрия.
--
-- ОТДЕЛЬНАЯ таблица, а не колонки в time_entries — сознательно:
-- GET /time-entries отдаёт табель за месяц (до 1000 строк), и превью в каждой
-- строке раздуло бы обычный ответ на мегабайты. Фото тянут по требованию.
--
-- Два слоя хранения, потому что у них разная судьба в мультифилиальной сети:
--   path  — ОРИГИНАЛ (~640px, 30-50 КБ) лежит файлом на диске филиала
--           (<data-dir>/attendance/ГГГГ-ММ/<id>.jpg). В Postgres его класть
--           нельзя: ежедневный pg_dump с ротацией 7+4+12 умножил бы эти
--           мегабайты на два десятка копий.
--   thumb  — превью 160px (~8 КБ) в BYTEA. Едет в центр обычным синком: с
--           филиала это ~10 МБ/мес вместо ~50 МБ за оригиналы, а владельцу
--           «глазом убедиться, что это он» превью хватает. Оригинал остаётся
--           на филиале и подтягивается по клику, пока касса включена.
--
-- kind — снимок привязан к КОНКРЕТНОМУ событию, а не к смене целиком: приход
-- и уход это два разных момента и два разных фото.
--
CREATE TABLE IF NOT EXISTS attendance_photos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,
  entry_id      UUID NOT NULL,
  user_id       UUID,
  kind          TEXT NOT NULL,
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  path          TEXT,
  thumb         BYTEA,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id, kind)
);

ALTER TABLE attendance_photos DROP CONSTRAINT IF EXISTS attendance_photos_kind_check;
ALTER TABLE attendance_photos ADD CONSTRAINT attendance_photos_kind_check
  CHECK (kind IN ('in','out'));

CREATE INDEX IF NOT EXISTS idx_attendance_photos_lookup
  ON attendance_photos (restaurant_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_photos_user
  ON attendance_photos (restaurant_id, user_id, taken_at DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS attendance_photos;
-- +goose StatementEnd
