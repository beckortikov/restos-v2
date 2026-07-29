package service

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"gorm.io/gorm"
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

// Ingest применяет батч UP-пушей на центральном узле — upsert по PK (центр
// зеркалит авторитетные данные филиала). Идемпотентно.
func (s *SyncService) Ingest(ctx context.Context, in IngestInput) (*IngestResult, error) {
	return s.apply(ctx, in, true, "")
}

// ApplyPulled применяет DOWN-pull на филиале — insert-if-absent (НЕ перезаписывает).
// Критично: получатель — авторитет по статусу received своих входящих перемещений;
// pull не должен откатить локальный received обратно в sent (гонка до up-sync).
//
// branchRestaurantID — id этого филиала (для сетевого меню: мастер → menu_items
// с merge, наследуемое из мастера, локальные цена/стоп сохраняются).
func (s *SyncService) ApplyPulled(ctx context.Context, in IngestInput, branchRestaurantID string) (*IngestResult, error) {
	return s.apply(ctx, in, false, branchRestaurantID)
}

func (s *SyncService) apply(ctx context.Context, in IngestInput, updateAll bool, branchID string) (*IngestResult, error) {
	res := &IngestResult{}
	for _, e := range in.Entries {
		switch e.Entity {
		case "stock_transfers":
			if err := s.applyTransfer(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "financial_operations":
			if err := s.applyFinancialOp(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "orders":
			if err := s.applyOrder(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "network_menu_items":
			if branchID == "" {
				res.Skipped++ // мастер-меню применяется только при down-pull на филиале
				continue
			}
			if err := s.applyNetworkMenu(ctx, e, branchID); err != nil {
				return nil, err
			}
			res.Applied++
		default:
			res.Skipped++ // неизвестная сущность — не роняем весь батч
		}
	}
	return res, nil
}

// applyNetworkMenu — распространение мастер-блюда сети в меню филиала (ADR-004).
// Наследуемые поля (name/category/station/unit) берём из мастера; локальные
// (price/is_available/emoji) НЕ трогаем. Нет локального блюда с этим master_id →
// создаём (цена = base_price, доступно). Есть → обновляем только наследуемое.
func (s *SyncService) applyNetworkMenu(ctx context.Context, e SyncEntry, branchID string) error {
	var m models.NetworkMenuItem
	if err := json.Unmarshal(e.Payload, &m); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid network_menu_items payload", err)
	}
	if m.ID == "" {
		return apperrors.Wrap("VALIDATION", "network_menu_items payload missing id", nil)
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		var existing models.MenuItem
		err := tx.Where("restaurant_id = ? AND master_id = ?", branchID, m.ID).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			avail := true
			item := &models.MenuItem{
				ID: uuid.NewString(), MasterID: &m.ID, RestaurantID: &branchID,
				Name: &m.Name, Category: m.Category, Price: m.BasePrice,
				Station: m.Station, Unit: m.Unit, Emoji: m.Emoji, IsAvailable: &avail,
			}
			return tx.Create(item).Error
		}
		if err != nil {
			return err
		}
		// Обновляем ТОЛЬКО наследуемые поля — цену/доступность/оформление филиала
		// не трогаем.
		return tx.Model(&models.MenuItem{}).Where("id = ?", existing.ID).
			Updates(map[string]any{
				"name": m.Name, "category": m.Category, "station": m.Station, "unit": m.Unit,
			}).Error
	})
}

// onConflict — UpdateAll (upsert) или DoNothing (insert-if-absent) по id.
func onConflict(updateAll bool) clause.OnConflict {
	c := clause.OnConflict{Columns: []clause.Column{{Name: "id"}}}
	if updateAll {
		c.UpdateAll = true
	} else {
		c.DoNothing = true
	}
	return c
}

// applyTransfer — upsert перемещения + его строк из payload. На центральном
// узле это лишь запись документа (для сводки/доставки получателю); движения
// остатка НЕ выполняются — их сделает получатель при Receive у себя.
func (s *SyncService) applyTransfer(ctx context.Context, e SyncEntry, updateAll bool) error {
	var t models.StockTransfer
	if err := json.Unmarshal(e.Payload, &t); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_transfers payload", err)
	}
	if t.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_transfers payload missing id", nil)
	}
	lines := t.Lines
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		// SkipHooks: реплицированные данные не аудируем и не рекордим повторно.
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		// upsert/insert самого перемещения (без ассоциаций).
		if err := tx.Omit("Lines").Clauses(conflict).Create(&t).Error; err != nil {
			return err
		}
		// строки.
		for i := range lines {
			l := lines[i]
			if err := tx.Clauses(conflict).Create(&l).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyOrder — upsert заказа + его позиций из payload (ADR-003 Фаза 5).
// Central получает точную копию терминального снимка заказа филиала
// (closed/cancelled/refunded); это голый upsert двух таблиц, а не вызов
// OrdersService — списание склада и создание financial_operations здесь
// НЕ выполняются повторно (у Order/OrderItem нет GORM-хуков, только
// императивный код внутри Close()/Cancel()/Refund() на филиале).
func (s *SyncService) applyOrder(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p orderSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid orders payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "orders payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.Order).Error; err != nil {
			return err
		}
		for i := range p.Items {
			if err := tx.Clauses(conflict).Create(&p.Items[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// PullFor — сторона ЦЕНТРАЛЬНОГО узла: дельты, адресованные филиалу
// restaurantID (down-sync, ADR-003 Фаза 2). Пока — входящие перемещения в
// статусе sent (получатель ещё не принял). Возвращаем в формате ingest, чтобы
// филиал применил их своим же Ingest (upsert). Идемпотентно и без курсора:
// после приёма статус станет received и перестанет попадать в выборку.
func (s *SyncService) PullFor(ctx context.Context, restaurantID string) (*IngestInput, error) {
	if restaurantID == "" {
		return nil, apperrors.Wrap("VALIDATION", "restaurant_id is required", nil)
	}
	var transfers []models.StockTransfer
	if err := s.r.Raw().WithContext(ctx).
		Preload("Lines").
		Where("to_restaurant_id = ? AND status = ?", restaurantID, "sent").
		Order("created_at ASC").
		Find(&transfers).Error; err != nil {
		return nil, err
	}
	out := &IngestInput{Entries: make([]SyncEntry, 0, len(transfers))}
	for i := range transfers {
		payload, err := json.Marshal(transfers[i])
		if err != nil {
			return nil, err
		}
		out.Entries = append(out.Entries, SyncEntry{
			Entity: "stock_transfers", RowID: transfers[i].ID, Op: "insert", Payload: payload,
		})
	}

	// Мастер-меню сети (ADR-004) — филиал наследует его целиком.
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Select("account_id").Where("id = ?", restaurantID).First(&rest).Error; err == nil &&
		rest.AccountID != nil && *rest.AccountID != "" {
		var master []models.NetworkMenuItem
		if err := s.r.Raw().WithContext(ctx).Where("account_id = ?", *rest.AccountID).Find(&master).Error; err != nil {
			return nil, err
		}
		for i := range master {
			payload, err := json.Marshal(master[i])
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "network_menu_items", RowID: master[i].ID, Op: "upsert", Payload: payload,
			})
		}
	}
	return out, nil
}

// applyFinancialOp — upsert денежной операции из payload (для сводки владельцу).
// Только запись строки; балансы счетов на центральном узле НЕ трогаем (они —
// производные операций филиала, сводку считаем из financial_operations).
func (s *SyncService) applyFinancialOp(ctx context.Context, e SyncEntry, updateAll bool) error {
	var op models.FinancialOperation
	if err := json.Unmarshal(e.Payload, &op); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid financial_operations payload", err)
	}
	if op.ID == "" {
		return apperrors.Wrap("VALIDATION", "financial_operations payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&op).Error
	})
}
