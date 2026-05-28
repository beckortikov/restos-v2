package service

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/repo"
)

// PrintJobsService — admin-вью на очередь печати.
// Менеджер видит pending/failed, может перезапустить failed → pending.
type PrintJobsService struct {
	r *repo.Repo
}

func NewPrintJobsService(r *repo.Repo) *PrintJobsService { return &PrintJobsService{r: r} }

// PrintJobsFilter — фильтры GET /api/v1/print/jobs.
type PrintJobsFilter struct {
	Status string // pending|running|done|failed
	Type   string // receipt|runner|cancel_runner
	Page   cursor.Page
}

// List — пагинированный список jobs ресторана.
func (s *PrintJobsService) List(ctx context.Context, f PrintJobsFilter) ([]models.PrintJob, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	if f.Type != "" {
		q = q.Where("type = ?", f.Type)
	}
	q = cursor.Apply(q, "print_jobs", f.Page)
	var rows []models.PrintJob
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.PrintJob) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// Retry — failed/done → pending, attempts=0. Воркер подберёт.
// Из pending/running ничего не делаем (409).
func (s *PrintJobsService) Retry(ctx context.Context, id string) (*models.PrintJob, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var job models.PrintJob
	if err := scoped.Where("id = ?", id).First(&job).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if job.Status == "pending" || job.Status == "running" {
		return nil, apperrors.Wrap("CONFLICT", "job is already pending/running", nil)
	}

	now := time.Now().UTC()
	job.Status = "pending"
	job.Attempts = 0
	job.LastError = nil
	job.UpdatedAt = now.Add(-time.Hour) // чтобы воркер на следующем тике взял без backoff
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Save(&job).Error; err != nil {
		return nil, err
	}
	return &job, nil
}
