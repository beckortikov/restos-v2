package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// PrintersService — CRUD по физическим принтерам.
type PrintersService struct {
	r *repo.Repo
}

func NewPrintersService(r *repo.Repo) *PrintersService { return &PrintersService{r: r} }

// PrinterInput — body POST/PATCH /api/v1/printers.
// На PATCH nil-поля не меняются.
type PrinterInput struct {
	Name      *string `json:"name,omitempty"`
	Kind      *string `json:"kind,omitempty"`    // receipt | station
	Station   *string `json:"station,omitempty"` // для kind=station
	Driver    *string `json:"driver,omitempty"`  // tcp|usb|virtual|mock
	Target    *string `json:"target,omitempty"`
	Cols      *int    `json:"cols,omitempty"`
	IsDefault *bool   `json:"is_default,omitempty"`
	Enabled   *bool   `json:"enabled,omitempty"`
}

// List — все принтеры ресторана.
func (s *PrintersService) List(ctx context.Context) ([]models.Printer, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.Printer
	if err := scoped.Order("kind ASC, name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// Get — один принтер по id.
func (s *PrintersService) Get(ctx context.Context, id string) (*models.Printer, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var p models.Printer
	if err := scoped.Where("id = ?", id).First(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &p, nil
}

// Create. Валидация: kind ∈ {receipt,station}, driver ∈ {tcp,usb,virtual,mock},
// для kind=station требуется station.
func (s *PrintersService) Create(ctx context.Context, in PrinterInput) (*models.Printer, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	if in.Kind == nil || (*in.Kind != "receipt" && *in.Kind != "station") {
		return nil, apperrors.Wrap("VALIDATION", "kind must be receipt|station", nil)
	}
	if *in.Kind == "station" && (in.Station == nil || *in.Station == "") {
		return nil, apperrors.Wrap("VALIDATION", "station is required for kind=station", nil)
	}
	if in.Driver == nil || !validDriver(*in.Driver) {
		return nil, apperrors.Wrap("VALIDATION", "driver must be tcp|usb|virtual|mock", nil)
	}

	now := time.Now().UTC()
	p := &models.Printer{
		ID:           uuid.NewString(),
		RestaurantID: rid,
		Name:         *in.Name,
		Kind:         *in.Kind,
		Station:      in.Station,
		Driver:       *in.Driver,
		Cols:         48,
		Enabled:      true,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if in.Target != nil {
		p.Target = *in.Target
	}
	if in.Cols != nil {
		p.Cols = *in.Cols
	}
	if in.IsDefault != nil {
		p.IsDefault = *in.IsDefault
	}
	if in.Enabled != nil {
		p.Enabled = *in.Enabled
	}

	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(p).Error; err != nil {
		// unique-index `default+receipt` или `station per restaurant` поднимут 23505.
		return nil, mapPGConflict(err)
	}
	return p, nil
}

// Patch — частичное обновление.
func (s *PrintersService) Patch(ctx context.Context, id string, in PrinterInput) (*models.Printer, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Printer
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Kind != nil {
		if *in.Kind != "receipt" && *in.Kind != "station" {
			return nil, apperrors.Wrap("VALIDATION", "bad kind", nil)
		}
		updates["kind"] = *in.Kind
	}
	if in.Station != nil {
		updates["station"] = *in.Station
	}
	if in.Driver != nil {
		if !validDriver(*in.Driver) {
			return nil, apperrors.Wrap("VALIDATION", "bad driver", nil)
		}
		updates["driver"] = *in.Driver
	}
	if in.Target != nil {
		updates["target"] = *in.Target
	}
	if in.Cols != nil {
		updates["cols"] = *in.Cols
	}
	if in.IsDefault != nil {
		updates["is_default"] = *in.IsDefault
	}
	if in.Enabled != nil {
		updates["enabled"] = *in.Enabled
	}

	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, mapPGConflict(err)
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var updated models.Printer
	if err := scoped3.Where("id = ?", id).First(&updated).Error; err != nil {
		return nil, err
	}
	return &updated, nil
}

// Delete — hard delete.
func (s *PrintersService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.Printer{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

func validDriver(d string) bool {
	switch d {
	case "tcp", "usb", "virtual", "mock":
		return true
	}
	return false
}

// mapPGConflict — превращает Postgres-unique-violation в наш CONFLICT.
func mapPGConflict(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if containsAny(msg, []string{"duplicate key value", "SQLSTATE 23505"}) {
		return apperrors.Wrap("CONFLICT", "duplicate printer (default receipt / station already exists)", err)
	}
	return err
}

func containsAny(s string, subs []string) bool {
	for _, sub := range subs {
		if indexOf(s, sub) >= 0 {
			return true
		}
	}
	return false
}

// indexOf — без импорта strings (минимизация import surface).
func indexOf(s, sub string) int {
	n, m := len(s), len(sub)
	if m == 0 || m > n {
		return -1
	}
	for i := 0; i <= n-m; i++ {
		if s[i:i+m] == sub {
			return i
		}
	}
	return -1
}

// Test — POST /api/v1/printers/{id}/test.
//
// Создаёт print_job типа "test" с готовым ESC/POS-эталоном (TestPageLayout) и
// привязкой printer_id=<this>. Воркер на следующем тике отправит. Если принтер
// неисправен — job попадёт в failed, видно в /print/jobs?status=failed.
func (s *PrintersService) Test(ctx context.Context, id string) (*models.PrintJob, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	scoped, _ := s.r.ForTenant(ctx)
	var p models.Printer
	if err := scoped.Where("id = ?", id).First(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if !p.Enabled {
		return nil, apperrors.Wrap("CONFLICT", "printer is disabled", nil)
	}

	station := ""
	if p.Station != nil {
		station = *p.Station
	}
	payload := escpos.TestPageLayout(escpos.TestPageInput{
		PrinterName: p.Name,
		Station:     station,
		Cols:        p.Cols,
		Now:         time.Now().UTC(),
	})

	now := time.Now().UTC()
	pid := p.ID
	job := &models.PrintJob{
		ID:           uuid.NewString(),
		Type:         "test",
		PrinterID:    &pid,
		Payload:      payload,
		Status:       "pending",
		RestaurantID: &rid,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Session(&gorm.Session{SkipHooks: true}).Create(job).Error; err != nil {
		return nil, err
	}
	return job, nil
}
