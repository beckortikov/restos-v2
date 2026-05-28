// Package models — GORM-модели для restos-server.
//
// Принципы:
//   - Каждая модель строго соответствует таблице из миграции 001_init.sql.
//   - Имена полей в БД — snake_case (по умолчанию GORM-naming), Go — CamelCase.
//   - UUID PK — *string (БД хранит UUID; gorm генерирует через gen_random_uuid()).
//   - restaurant_id — *string (в миграции 001 это TEXT без NOT NULL, чтобы 1:1
//     соответствовать legacy-схеме; ужесточение типа — отдельная миграция позже).
//   - Денежные поля — decimal.Decimal (NUMERIC(14,4) в БД).
//   - Time — time.Time или *time.Time, JSONB — datatypes.JSON.
//   - Никаких relations здесь; их объявляем точечно в сервисном слое через Preload,
//     чтобы не плодить N+1 и циклические зависимости в моделях.
package models
