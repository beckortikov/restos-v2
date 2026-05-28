package service

import (
	"context"
	"time"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/repo"
)

// AuditReadsService — admin-вью на audit_log.
type AuditReadsService struct{ r *repo.Repo }

func NewAuditReadsService(r *repo.Repo) *AuditReadsService { return &AuditReadsService{r: r} }

// AuditFilter — фильтры GET /api/v1/audit-log.
type AuditFilter struct {
	EntityType string
	Action     string
	UserID     string
	From       *time.Time
	To         *time.Time
	Limit      int
	Offset     int
}

// AuditListResult — что возвращаем.
type AuditListResult struct {
	Data   []models.AuditLog `json:"data"`
	Total  int64             `json:"total"`
	Limit  int               `json:"limit"`
	Offset int               `json:"offset"`
}

const (
	auditMaxLimit     = 500
	auditDefaultLimit = 50
)

// List — GET /api/v1/audit-log с фильтрами и offset-пагинацией.
// Используем offset (не cursor), т.к. UI Admin'а покажет таблицу с pagination links.
func (s *AuditReadsService) List(ctx context.Context, f AuditFilter) (*AuditListResult, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	limit := f.Limit
	if limit <= 0 {
		limit = auditDefaultLimit
	}
	if limit > auditMaxLimit {
		return nil, apperrors.Wrap("VALIDATION", "limit too large", nil)
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}
	q := scoped
	if f.EntityType != "" {
		q = q.Where("entity_type = ?", f.EntityType)
	}
	if f.Action != "" {
		q = q.Where("action = ?", f.Action)
	}
	if f.UserID != "" {
		q = q.Where("user_id = ?", f.UserID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}

	var total int64
	if err := q.Model(&models.AuditLog{}).Count(&total).Error; err != nil {
		return nil, err
	}
	var rows []models.AuditLog
	if err := q.Order("created_at DESC").Limit(limit).Offset(offset).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return &AuditListResult{
		Data:   rows,
		Total:  total,
		Limit:  limit,
		Offset: offset,
	}, nil
}
