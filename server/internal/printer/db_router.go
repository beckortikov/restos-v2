package printer

import (
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// DBRouter — резолвит Printer по job, используя таблицу `printers`.
//
// Логика:
//  1. Если job.PrinterID != nil → ищем именно этот принтер (любого ресторана —
//     tenant-проверка уже на write-side в enqueue).
//  2. Иначе и job.Type == "receipt"/"pre_bill"/*_report → включённый чековый
//     принтер ресторана: дефолтный, иначе единственный (is_default DESC).
//  3. Иначе и job.Type == "runner" → принтер ресторана с kind=station
//     и station=<station из payload meta>. Если в job нет hint — используем
//     первый station-printer ресторана.
//
// Драйверы кэшируются по printer.id+updated_at, чтобы не пересоздавать TCP-сокеты
// (хотя TCP-driver сам open-on-demand, кэш экономит парсинг target). На UPDATE
// строки кэш инвалидируется по mismatch updated_at.
//
// Fallback (DefaultPrinter) используется, когда БД пуста (только что setup'нули
// ресторан, ещё не настроили принтер). Чтобы close_order не падал.
type DBRouter struct {
	db       *gorm.DB
	fallback Printer
	mu       sync.Mutex
	cache    map[string]cachedDriver
	cacheTTL time.Duration
}

type cachedDriver struct {
	driver    Printer
	updatedAt time.Time
	cachedAt  time.Time
}

// NewDBRouter создаёт router. fallback опционален (nil → если нет принтера →
// job помечается failed).
func NewDBRouter(db *gorm.DB, fallback Printer) *DBRouter {
	return &DBRouter{
		db:       db,
		fallback: fallback,
		cache:    make(map[string]cachedDriver),
		cacheTTL: 30 * time.Second,
	}
}

// Resolve реализует Router.
func (r *DBRouter) Resolve(job *models.PrintJob) Printer {
	if p := r.resolveFromDB(job); p != nil {
		return p
	}
	if r.fallback != nil {
		log.Warn().Str("job_id", job.ID).Str("type", job.Type).Msg("router: no DB printer, using fallback")
		return r.fallback
	}
	return nil
}

func (r *DBRouter) resolveFromDB(job *models.PrintJob) Printer {
	var p models.Printer
	q := r.db.Where("enabled = ?", true)

	if job.PrinterID != nil && *job.PrinterID != "" {
		if err := q.Where("id = ?", *job.PrinterID).First(&p).Error; err != nil {
			return nil
		}
	} else {
		if job.RestaurantID == nil {
			return nil
		}
		switch job.Type {
		case "receipt":
			if err := q.Where("restaurant_id = ? AND kind = ? AND enabled = true",
				*job.RestaurantID, "receipt").Order("is_default DESC, created_at ASC").First(&p).Error; err != nil {
				return nil
			}
		case "pre_bill":
			if err := q.Where("restaurant_id = ? AND kind = ? AND enabled = true",
				*job.RestaurantID, "receipt").Order("is_default DESC, created_at ASC").First(&p).Error; err != nil {
				return nil
			}
		case "z_report", "x_report", "service_report":
			// Отчёты смены (Z/X/Обслуживание) печатаются на receipt-принтере.
			if err := q.Where("restaurant_id = ? AND kind = ? AND enabled = true",
				*job.RestaurantID, "receipt").Order("is_default DESC, created_at ASC").First(&p).Error; err != nil {
				return nil
			}
		case "runner", "cancel_runner":
			// Phase 4.5 базово: первый station-принтер. Phase 5: учёт job.Station.
			if err := q.Where("restaurant_id = ? AND kind = ?",
				*job.RestaurantID, "station").First(&p).Error; err != nil {
				return nil
			}
		default:
			return nil
		}
	}

	return r.getOrBuild(&p)
}

// getOrBuild берёт driver из кэша или строит через FromRow.
func (r *DBRouter) getOrBuild(p *models.Printer) Printer {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.cache[p.ID]; ok {
		// Cache hit, проверим что строка не менялась.
		if c.updatedAt.Equal(p.UpdatedAt) && time.Since(c.cachedAt) < r.cacheTTL {
			return c.driver
		}
	}
	dr, err := FromRow(p)
	if err != nil {
		log.Error().Err(err).Str("printer_id", p.ID).Msg("router: build driver failed")
		return nil
	}
	r.cache[p.ID] = cachedDriver{
		driver:    dr,
		updatedAt: p.UpdatedAt,
		cachedAt:  time.Now(),
	}
	return dr
}

// StationRouting — маршрутизация цехов ресторана для runner-эмиссии (053).
//
// enabled: цех → id ВКЛЮЧЁННОГО принтера, обслуживающего его (printer_stations).
// configured: есть ли у ресторана вообще привязки цехов (включая отключённые
// принтеры). Семантика write-side (enqueueRunners):
//   - configured и цех в enabled → печатаем на этот принтер (цехи одного
//     принтера сливаются в один бегунок);
//   - configured и цеха нет в enabled → бесбумажный цех (принтер отключён или
//     цех никуда не привязан): бегунок не печатается, повар видит KDS;
//   - !configured → станционных принтеров нет вовсе: legacy-поведение,
//     job без printer_id на каждый цех (воркер найдёт первый станционный).
//
// Ошибка чтения трактуется как «не настроено» — безопаснее напечатать
// по-старому, чем молча потерять бегунок.
func (r *DBRouter) StationRouting(restaurantID string) (enabled map[string]string, configured bool) {
	var rows []struct {
		Station   string
		PrinterID string
		Enabled   bool
	}
	err := r.db.Table("printer_stations ps").
		Select("ps.station AS station, p.id AS printer_id, p.enabled AS enabled").
		Joins("JOIN printers p ON p.id = ps.printer_id").
		Where("ps.restaurant_id = ? AND p.kind = ?", restaurantID, "station").
		Scan(&rows).Error
	if err != nil || len(rows) == 0 {
		return nil, false
	}
	enabled = make(map[string]string, len(rows))
	for _, row := range rows {
		if row.Enabled {
			enabled[row.Station] = row.PrinterID
		}
	}
	return enabled, true
}
