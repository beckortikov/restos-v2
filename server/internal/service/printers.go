package service

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/printer"
	"github.com/restos/restos-v4/server/internal/repo"
)

// normalizePrinterTarget — для tcp-драйвера дополняет адрес дефолтным портом
// :9100 если кассир ввёл только IP. Хранится уже нормализованным, чтобы
// db_router и worker получали готовый host:port.
func normalizePrinterTarget(driver, target string) string {
	t := strings.TrimSpace(target)
	if driver != "tcp" || t == "" {
		return t
	}
	if _, _, err := net.SplitHostPort(t); err == nil {
		return t
	}
	return net.JoinHostPort(t, "9100")
}

// PrintersService — CRUD по физическим принтерам.
type PrintersService struct {
	r *repo.Repo
}

func NewPrintersService(r *repo.Repo) *PrintersService { return &PrintersService{r: r} }

// PrinterInput — body POST/PATCH /api/v1/printers.
// На PATCH nil-поля не меняются.
type PrinterInput struct {
	Name *string `json:"name,omitempty"`
	Kind *string `json:"kind,omitempty"` // receipt | station
	// Station — legacy-поле «один цех» (до 053). Принимается как список из
	// одного элемента, если Stations не передан.
	Station *string `json:"station,omitempty"`
	// Stations — цехи станционного принтера (053): всё, что попало в заказ по
	// этим цехам, печатается одним бегунком. Полная замена списка на PATCH.
	Stations *[]string `json:"stations,omitempty"`
	Driver   *string   `json:"driver,omitempty"` // tcp|usb|virtual|mock
	Target   *string   `json:"target,omitempty"`
	Cols     *int      `json:"cols,omitempty"`
	// Codepage — таблица символов принтера (ESC t n), 055. 17 = PC866.
	Codepage  *int  `json:"codepage,omitempty"`
	IsDefault *bool `json:"is_default,omitempty"`
	Enabled   *bool `json:"enabled,omitempty"`
	// Content flags (миграция 015).
	PrintLogo       *bool `json:"print_logo,omitempty"`
	PrintDiscount   *bool `json:"print_discount,omitempty"`
	PrintService    *bool `json:"print_service,omitempty"`
	PrintTip        *bool `json:"print_tip,omitempty"`
	PrintQRFeedback *bool `json:"print_qr_feedback,omitempty"`
}

// stationsFromInput — итоговый список цехов из input: приоритет у Stations,
// legacy Station (старые клиенты) трактуется как список из одного. Второй
// результат — передавал ли клиент цехи вообще (для PATCH: nil = не менять).
func stationsFromInput(in PrinterInput) ([]string, bool) {
	if in.Stations != nil {
		seen := map[string]bool{}
		out := []string{}
		for _, st := range *in.Stations {
			st = strings.TrimSpace(st)
			if st == "" || seen[st] {
				continue
			}
			seen[st] = true
			out = append(out, st)
		}
		return out, true
	}
	if in.Station != nil && strings.TrimSpace(*in.Station) != "" {
		return []string{strings.TrimSpace(*in.Station)}, true
	}
	return nil, false
}

// loadPrinterStations — цехи принтеров ресторана одним запросом (map по id).
func (s *PrintersService) loadPrinterStations(ctx context.Context, printerIDs []string) (map[string][]string, error) {
	out := make(map[string][]string, len(printerIDs))
	if len(printerIDs) == 0 {
		return out, nil
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.PrinterStation
	if err := scoped.Where("printer_id IN ?", printerIDs).
		Order("created_at ASC, station ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.PrinterID] = append(out[row.PrinterID], row.Station)
	}
	return out, nil
}

// replacePrinterStations — полная замена цехов принтера (внутри транзакции).
func replacePrinterStations(tx *gorm.DB, rid, printerID string, stations []string, now time.Time) error {
	if err := tx.Where("restaurant_id = ? AND printer_id = ?", rid, printerID).
		Delete(&models.PrinterStation{}).Error; err != nil {
		return err
	}
	for _, st := range stations {
		row := &models.PrinterStation{
			PrinterID:    printerID,
			Station:      st,
			RestaurantID: rid,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(row).Error; err != nil {
			return mapPGConflict(err)
		}
	}
	return nil
}

// SystemQueues — очереди печати, зарегистрированные в ОС кассы. Нужны, чтобы
// в настройках driver=system кассир выбирал принтер из списка, а не вбивал
// имя очереди руками (опечатка = принтер, который молча не печатает).
//
// Сознательно не tenant-scoped: это железо конкретной машины, а не данные
// ресторана. Список всегда снимается с машины, где крутится Go-бэк, — при
// заходе через LAN Web Access с ноутбука это по-прежнему принтеры кассы.
func (s *PrintersService) SystemQueues(ctx context.Context) ([]printer.SystemQueue, error) {
	return printer.ListSystemQueues(ctx)
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
	ids := make([]string, 0, len(rows))
	for _, p := range rows {
		ids = append(ids, p.ID)
	}
	stationsByID, err := s.loadPrinterStations(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range rows {
		rows[i].Stations = stationsWithLegacy(&rows[i], stationsByID[rows[i].ID])
	}
	return rows, nil
}

// stationsWithLegacy — список цехов принтера; для строк, созданных до 053 и
// не прошедших backfill (теоретический случай), падаем на legacy-поле.
func stationsWithLegacy(p *models.Printer, stations []string) []string {
	if len(stations) > 0 {
		return stations
	}
	if p.Kind == "station" && p.Station != nil && *p.Station != "" {
		return []string{*p.Station}
	}
	return []string{}
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
	stationsByID, err := s.loadPrinterStations(ctx, []string{p.ID})
	if err != nil {
		return nil, err
	}
	p.Stations = stationsWithLegacy(&p, stationsByID[p.ID])
	return &p, nil
}

// Create. Валидация: kind ∈ {receipt,station}, driver ∈ {tcp,usb,virtual,mock},
// для kind=station требуется station.
//
// Swap-default: если is_default=true и kind=receipt — в той же транзакции
// очищаем флаг is_default у предыдущего default-receipt-принтера. Никаких
// 409 «duplicate default»: UX лучше, чем требовать от кассира сначала
// «снять галочку».
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
	stations, _ := stationsFromInput(in)
	if *in.Kind == "station" && len(stations) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "stations (хотя бы один цех) is required for kind=station", nil)
	}
	if in.Driver == nil || !validDriver(*in.Driver) {
		return nil, apperrors.Wrap("VALIDATION", "driver must be tcp|usb|system|virtual|mock", nil)
	}

	now := time.Now().UTC()
	// Legacy-колонка printers.station хранит первый цех списка (для старых
	// читателей); маршрутизация читает только printer_stations.
	var legacyStation *string
	if *in.Kind == "station" {
		st := stations[0]
		legacyStation = &st
	}
	p := &models.Printer{
		ID:              uuid.NewString(),
		RestaurantID:    rid,
		Name:            *in.Name,
		Kind:            *in.Kind,
		Station:         legacyStation,
		Driver:          *in.Driver,
		Cols:            48,
		Enabled:         true,
		PrintLogo:       true,
		PrintDiscount:   true,
		PrintService:    true,
		PrintTip:        false,
		PrintQRFeedback: false,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if in.Target != nil {
		p.Target = normalizePrinterTarget(p.Driver, *in.Target)
	}
	if err := validateSystemTarget(p.Driver, p.Target); err != nil {
		return nil, err
	}
	if in.Cols != nil {
		p.Cols = *in.Cols
	}
	if in.Codepage != nil {
		if *in.Codepage < 0 || *in.Codepage > 255 {
			return nil, apperrors.Wrap("VALIDATION", "codepage must be 0..255", nil)
		}
		p.Codepage = *in.Codepage
	}
	if in.IsDefault != nil {
		p.IsDefault = *in.IsDefault
	}
	if in.Enabled != nil {
		p.Enabled = *in.Enabled
	}
	if in.PrintLogo != nil {
		p.PrintLogo = *in.PrintLogo
	}
	if in.PrintDiscount != nil {
		p.PrintDiscount = *in.PrintDiscount
	}
	if in.PrintService != nil {
		p.PrintService = *in.PrintService
	}
	if in.PrintTip != nil {
		p.PrintTip = *in.PrintTip
	}
	if in.PrintQRFeedback != nil {
		p.PrintQRFeedback = *in.PrintQRFeedback
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if p.IsDefault && p.Kind == "receipt" {
			if err := tx.Model(&models.Printer{}).
				Where("restaurant_id = ? AND kind = ? AND is_default = TRUE",
					rid, "receipt").
				Updates(map[string]any{"is_default": false, "updated_at": now}).
				Error; err != nil {
				return err
			}
		}
		if err := tx.Create(p).Error; err != nil {
			return mapPGConflict(err)
		}
		if p.Kind == "station" {
			if err := replacePrinterStations(tx, rid, p.ID, stations, now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	p.Stations = stationsWithLegacy(p, stations)
	return p, nil
}

// Patch — частичное обновление.
func (s *PrintersService) Patch(ctx context.Context, id string, in PrinterInput) (*models.Printer, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Printer
	scopedRead, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	if err := scopedRead.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	now := time.Now().UTC()
	updates := map[string]any{"updated_at": now}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Kind != nil {
		if *in.Kind != "receipt" && *in.Kind != "station" {
			return nil, apperrors.Wrap("VALIDATION", "bad kind", nil)
		}
		updates["kind"] = *in.Kind
	}
	// Цехи (053): передан station/stations → полная замена привязок (в tx ниже).
	stations, hasStations := stationsFromInput(in)
	kindAfter := existing.Kind
	if in.Kind != nil {
		kindAfter = *in.Kind
	}
	if hasStations {
		if kindAfter != "station" {
			return nil, apperrors.Wrap("VALIDATION", "stations применимы только к kind=station", nil)
		}
		if len(stations) == 0 {
			return nil, apperrors.Wrap("VALIDATION", "stations: нужен хотя бы один цех", nil)
		}
		updates["station"] = stations[0] // legacy-колонка = первый цех
	}
	// station→receipt: цеховые привязки снимаются.
	dropStations := in.Kind != nil && *in.Kind == "receipt" && existing.Kind == "station"
	if dropStations {
		updates["station"] = nil
	}
	driverForTarget := existing.Driver
	if in.Driver != nil {
		if !validDriver(*in.Driver) {
			return nil, apperrors.Wrap("VALIDATION", "bad driver", nil)
		}
		updates["driver"] = *in.Driver
		driverForTarget = *in.Driver
	}
	effectiveTarget := existing.Target
	if in.Target != nil {
		effectiveTarget = normalizePrinterTarget(driverForTarget, *in.Target)
		updates["target"] = effectiveTarget
	}
	// Ловит и «создали system без очереди», и «переключили tcp→system, а
	// target остался старым host:port» — во втором случае target непустой,
	// но очередью с таким именем он не станет, поэтому проверяем на смене
	// драйвера отдельно ниже.
	if err := validateSystemTarget(driverForTarget, effectiveTarget); err != nil {
		return nil, err
	}
	if in.Driver != nil && *in.Driver != existing.Driver && *in.Driver == "system" && in.Target == nil {
		return nil, apperrors.Wrap("VALIDATION",
			"при переключении на driver=system нужно указать target (имя очереди печати)", nil)
	}
	if in.Cols != nil {
		updates["cols"] = *in.Cols
	}
	if in.Codepage != nil {
		if *in.Codepage < 0 || *in.Codepage > 255 {
			return nil, apperrors.Wrap("VALIDATION", "codepage must be 0..255", nil)
		}
		updates["codepage"] = *in.Codepage
	}
	if in.IsDefault != nil {
		updates["is_default"] = *in.IsDefault
	}
	if in.Enabled != nil {
		updates["enabled"] = *in.Enabled
	}
	if in.PrintLogo != nil {
		updates["print_logo"] = *in.PrintLogo
	}
	if in.PrintDiscount != nil {
		updates["print_discount"] = *in.PrintDiscount
	}
	if in.PrintService != nil {
		updates["print_service"] = *in.PrintService
	}
	if in.PrintTip != nil {
		updates["print_tip"] = *in.PrintTip
	}
	if in.PrintQRFeedback != nil {
		updates["print_qr_feedback"] = *in.PrintQRFeedback
	}

	// Эффективные значения для swap-логики.
	effectiveKind := existing.Kind
	if in.Kind != nil {
		effectiveKind = *in.Kind
	}
	effectiveDefault := existing.IsDefault
	if in.IsDefault != nil {
		effectiveDefault = *in.IsDefault
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Swap: если выставляем default=true для receipt — снимаем флаг с других.
		if effectiveDefault && effectiveKind == "receipt" {
			if err := tx.Model(&models.Printer{}).
				Where("restaurant_id = ? AND kind = ? AND is_default = TRUE AND id <> ?",
					rid, "receipt", id).
				Updates(map[string]any{"is_default": false, "updated_at": now}).
				Error; err != nil {
				return err
			}
		}
		if err := tx.Model(&models.Printer{}).
			Where("restaurant_id = ? AND id = ?", rid, id).
			Updates(updates).Error; err != nil {
			return mapPGConflict(err)
		}
		if hasStations {
			if err := replacePrinterStations(tx, rid, id, stations, now); err != nil {
				return err
			}
		}
		if dropStations {
			if err := tx.Where("restaurant_id = ? AND printer_id = ?", rid, id).
				Delete(&models.PrinterStation{}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var updated models.Printer
	if err := scoped3.Where("id = ?", id).First(&updated).Error; err != nil {
		return nil, err
	}
	stationsByID, err := s.loadPrinterStations(ctx, []string{updated.ID})
	if err != nil {
		return nil, err
	}
	updated.Stations = stationsWithLegacy(&updated, stationsByID[updated.ID])
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
	case "tcp", "usb", "system", "virtual", "mock":
		return true
	}
	return false
}

// validateSystemTarget — для driver=system target обязателен: это имя очереди
// печати в ОС. Пустое имя даёт принтер, который молча не печатает (job уходит
// в failed на резолве драйвера), поэтому ловим на входе.
//
// Для tcp такой проверки сознательно нет: исторически принтер можно создать
// без адреса и дозаполнить его позже, ломать этот сценарий не хочется.
func validateSystemTarget(driver, target string) error {
	if driver == "system" && strings.TrimSpace(target) == "" {
		return apperrors.Wrap("VALIDATION", "target (имя очереди печати) is required for driver=system", nil)
	}
	return nil
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
// CodepageProbe — печать пробы кодовых страниц (055).
//
// Печатает одну и ту же русскую строку несколькими таблицами подряд с
// подписью номера. Нужна, когда принтер печатает вместо кириллицы мусор:
// единой нумерации в ESC/POS нет, а самотест со списком таблиц печатают не
// все модели. Кассир смотрит, какая строка читается, и вбивает её номер в
// настройку принтера.
func (s *PrintersService) CodepageProbe(ctx context.Context, id string) (*models.PrintJob, error) {
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

	payload := escpos.CodepageProbeLayout(escpos.CodepageProbeInput{
		PrinterName: p.Name,
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
	if stationsByID, err := s.loadPrinterStations(ctx, []string{p.ID}); err == nil {
		station = strings.Join(stationsWithLegacy(&p, stationsByID[p.ID]), ", ")
	} else if p.Station != nil {
		station = *p.Station
	}
	payload := escpos.TestPageLayout(escpos.TestPageInput{
		PrinterName: p.Name,
		Station:     station,
		Cols:        p.Cols,
		Codepage:    byte(p.Codepage),
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
