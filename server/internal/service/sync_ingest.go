package service

import (
	"context"
	"encoding/json"

	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/repo"
)

// SyncService — приём дельт на ЦЕНТРАЛЬНОМ узле (Фаза 2 multi-branch, ADR-003).
// Филиалы пушат сюда неотправленные строки sync_log; центральный узел делает
// upsert по row_id (идемпотентно) в свою БД — она становится сводной по сети.
//
// ВАЖНО: ingest НЕ скоупится по ресторану центрального узла — он хранит данные
// ВСЕХ филиалов сети (в payload уже есть restaurant_id/account_id). Поэтому
// используем Raw + явный upsert (легитимный сетевой агрегатор, не утечка).
//
// Режим «только нужное»: применяем известные сущности (перемещения), остальные
// пропускаем (forward-compat: новый филиал может прислать то, что старый центр
// ещё не умеет).
type SyncService struct {
	r *repo.Repo
}

func NewSyncService(r *repo.Repo) *SyncService {
	return &SyncService{r: r}
}

// SyncEntry — одна дельта в батче ingest.
type SyncEntry struct {
	Entity  string          `json:"entity"`
	RowID   string          `json:"row_id"`
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}

// IngestInput — body POST /api/v1/sync/ingest.
type IngestInput struct {
	Entries []SyncEntry `json:"entries"`
}

// IngestResult — сколько дельт применено/пропущено.
type IngestResult struct {
	Applied int `json:"applied"`
	Skipped int `json:"skipped"`
}

// Ingest применяет батч дельт. Идемпотентно (upsert по PK).
func (s *SyncService) Ingest(ctx context.Context, in IngestInput) (*IngestResult, error) {
	res := &IngestResult{}
	for _, e := range in.Entries {
		switch e.Entity {
		case "stock_transfers":
			if err := s.applyTransfer(ctx, e); err != nil {
				return nil, err
			}
			res.Applied++
		default:
			res.Skipped++ // неизвестная сущность — не роняем весь батч
		}
	}
	return res, nil
}

// applyTransfer — upsert перемещения + его строк из payload. На центральном
// узле это лишь запись документа (для сводки/доставки получателю); движения
// остатка НЕ выполняются — их сделает получатель при Receive у себя.
func (s *SyncService) applyTransfer(ctx context.Context, e SyncEntry) error {
	var t models.StockTransfer
	if err := json.Unmarshal(e.Payload, &t); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_transfers payload", err)
	}
	if t.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_transfers payload missing id", nil)
	}
	lines := t.Lines
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// upsert самого перемещения (без ассоциаций).
		if err := tx.Omit("Lines").Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "id"}},
			UpdateAll: true,
		}).Create(&t).Error; err != nil {
			return err
		}
		// upsert строк.
		for i := range lines {
			l := lines[i]
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "id"}},
				UpdateAll: true,
			}).Create(&l).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
