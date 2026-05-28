package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ShadowService — приём drift-репортов от фронта (Phase 8) и агрегация
// статистики для Owner Dashboard.
type ShadowService struct {
	r *repo.Repo
}

func NewShadowService(r *repo.Repo) *ShadowService { return &ShadowService{r: r} }

// ShadowReportInput — body POST /api/v1/admin/shadow/reports.
//
// Фронт шлёт массивом (batch) — у активного кассира десятки операций в минуту,
// шлём раз в N секунд пакетом.
type ShadowReportInput struct {
	AppVersion string             `json:"app_version,omitempty"`
	Items      []ShadowReportItem `json:"items"`
}

// ShadowReportItem — одна shadow-операция (фронт измерил).
type ShadowReportItem struct {
	Operation     string `json:"operation"` // "menu.items.list" и т.п.
	Matched       bool   `json:"matched"`
	V1Status      *int   `json:"v1_status,omitempty"`
	V4Status      *int   `json:"v4_status,omitempty"`
	V1LatencyMs   *int   `json:"v1_latency_ms,omitempty"`
	V4LatencyMs   *int   `json:"v4_latency_ms,omitempty"`
	DiffSizeBytes *int   `json:"diff_size_bytes,omitempty"`
	DiffSample    string `json:"diff_sample,omitempty"`
}

// Ingest сохраняет batch отчётов. Возвращает количество принятых.
func (s *ShadowService) Ingest(ctx context.Context, in ShadowReportInput) (int, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return 0, err
	}
	if len(in.Items) == 0 {
		return 0, nil
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()

	rows := make([]models.ShadowDrift, 0, len(in.Items))
	for _, it := range in.Items {
		if it.Operation == "" {
			continue
		}
		row := models.ShadowDrift{
			ID:            uuid.NewString(),
			RestaurantID:  rid,
			Operation:     it.Operation,
			Matched:       it.Matched,
			V1Status:      it.V1Status,
			V4Status:      it.V4Status,
			V1LatencyMs:   it.V1LatencyMs,
			V4LatencyMs:   it.V4LatencyMs,
			DiffSizeBytes: it.DiffSizeBytes,
			CreatedAt:     now,
		}
		if it.DiffSample != "" {
			// Truncate до 2KB.
			sample := it.DiffSample
			if len(sample) > 2048 {
				sample = sample[:2048]
			}
			row.DiffSample = &sample
		}
		if actor.UserID != "" {
			uid := actor.UserID
			row.UserID = &uid
		}
		if in.AppVersion != "" {
			v := in.AppVersion
			row.AppVersion = &v
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return 0, nil
	}

	scoped, _ := s.r.ForTenant(ctx)
	// SkipHooks — shadow-drifts не пишем в audit_log (это metrics, не доменные данные).
	if err := scoped.Session(skipHooks()).CreateInBatches(rows, 100).Error; err != nil {
		return 0, err
	}
	return len(rows), nil
}

// ShadowStats — агрегаты для GET /api/v1/admin/shadow/stats.
type ShadowStats struct {
	From      time.Time         `json:"from"`
	To        time.Time         `json:"to"`
	Total     int               `json:"total"`
	Matched   int               `json:"matched"`
	MatchRate float64           `json:"match_rate"` // 0..1
	ByOpRows  []ShadowStatsByOp `json:"by_operation"`
}

// ShadowStatsByOp — разрезка по operation.
type ShadowStatsByOp struct {
	Operation      string  `json:"operation" gorm:"column:operation"`
	Total          int     `json:"total" gorm:"column:total"`
	Matched        int     `json:"matched" gorm:"column:matched"`
	MatchRate      float64 `json:"match_rate" gorm:"-"`
	AvgV1LatencyMs float64 `json:"avg_v1_latency_ms,omitempty" gorm:"column:avg_v1_latency_ms"`
	AvgV4LatencyMs float64 `json:"avg_v4_latency_ms,omitempty" gorm:"column:avg_v4_latency_ms"`
}

// Stats возвращает агрегаты за период. Если from/to nil → последние 24 часа.
func (s *ShadowService) Stats(ctx context.Context, f PeriodFilter) (*ShadowStats, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	to := now
	from := now.Add(-24 * time.Hour)
	if f.From != nil {
		from = *f.From
	}
	if f.To != nil {
		to = *f.To
	}

	out := &ShadowStats{From: from, To: to}

	// 1. Total + matched (one query).
	type sumRow struct {
		Total   int `gorm:"column:total"`
		Matched int `gorm:"column:matched"`
	}
	var sum sumRow
	if err := s.r.DB().Session(skipHooks()).WithContext(ctx).
		Table("shadow_drifts").
		Select("COUNT(*) AS total, SUM(CASE WHEN matched THEN 1 ELSE 0 END) AS matched").
		Where("restaurant_id = ? AND created_at >= ? AND created_at < ?", rid, from, to).
		Scan(&sum).Error; err != nil {
		return nil, err
	}
	out.Total = sum.Total
	out.Matched = sum.Matched
	if sum.Total > 0 {
		out.MatchRate = float64(sum.Matched) / float64(sum.Total)
	}

	// 2. By operation.
	var byOp []ShadowStatsByOp
	if err := s.r.DB().Session(skipHooks()).WithContext(ctx).
		Table("shadow_drifts").
		Select(`operation,
			COUNT(*) AS total,
			SUM(CASE WHEN matched THEN 1 ELSE 0 END) AS matched,
			AVG(NULLIF(v1_latency_ms, 0)) AS avg_v1_latency_ms,
			AVG(NULLIF(v4_latency_ms, 0)) AS avg_v4_latency_ms`).
		Where("restaurant_id = ? AND created_at >= ? AND created_at < ?", rid, from, to).
		Group("operation").
		Order("total DESC").
		Scan(&byOp).Error; err != nil {
		return nil, err
	}
	for i := range byOp {
		if byOp[i].Total > 0 {
			byOp[i].MatchRate = float64(byOp[i].Matched) / float64(byOp[i].Total)
		}
	}
	out.ByOpRows = byOp
	return out, nil
}

// RecentDrifts — последние N drift'ов с расхождением (для дебага).
func (s *ShadowService) RecentDrifts(ctx context.Context, limit int) ([]models.ShadowDrift, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.ShadowDrift
	if err := scoped.Where("matched = false").
		Order("created_at DESC").
		Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// skipHooks — переиспользуемая сессия без audit-хуков.
// shadow_drifts — это метрики, не доменные данные.
func skipHooks() *gorm.Session { return &gorm.Session{SkipHooks: true} }
