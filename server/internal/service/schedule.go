package service

// ScheduleService — плановый график смен (102) и перекличка «план против
// факта».
//
// Факт (time_entries) сам по себе не отвечает на главный вопрос владельца:
// «кто не пришёл». Отсутствие отметки неотличимо от выходного, а приход в
// 10:30 — от опоздания на полтора часа. Поэтому нужен план, и он живёт двумя
// слоями: обычная неделя сотрудника (шаблон) и переопределения на конкретные
// даты (подмена, отгул). См. комментарий миграции 102.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

const (
	// defaultLateGraceMinutes — грейс, если ресторан ещё не настраивал политику
	// опозданий (105). Ноль был бы бессмысленно строгим: отметившийся в
	// 09:00:40 при плане на 09:00 опоздавшим не является ни для кого, кроме
	// формулы.
	defaultLateGraceMinutes = 5

	// scheduleMaxRangeDays — предохранитель на диапазон плана. План
	// разворачивается в память по дням × сотрудников; год на 40 человек — это
	// 14 600 строк в одном ответе, чего ни один экран не просит.
	scheduleMaxRangeDays = 92

	dateLayout = "2006-01-02"
)

type ScheduleService struct {
	r      *repo.Repo
	photos *AttendancePhotoStore
}

// latePolicy — правила опозданий ресторана (105).
type latePolicy struct {
	graceMinutes int
	fixed        decimal.Decimal
	perMinute    decimal.Decimal
	max          decimal.Decimal
	loc          *time.Location
}

// fineFor — сколько предложить удержать за опоздание на late минут. Ноль,
// если правила не заданы (по умолчанию так и есть) — тогда перекличка просто
// показывает опоздание, ничего не предлагая.
func (p latePolicy) fineFor(late int) decimal.Decimal {
	over := late - p.graceMinutes
	if over <= 0 {
		return decimal.FromInt(0)
	}
	fine := decimal.Add(p.fixed, decimal.Mul(p.perMinute, decimal.FromInt(int64(over))))
	if decimal.IsPositive(p.max) && decimal.IsPositive(decimal.Sub(fine, p.max)) {
		// Потолок нужен именно из-за поминутной части: «опоздал на 4 часа»
		// иначе съедает дневной заработок целиком.
		return p.max
	}
	return decimal.Normalize(fine)
}

func NewScheduleService(r *repo.Repo, photos *AttendancePhotoStore) *ScheduleService {
	return &ScheduleService{r: r, photos: photos}
}

// ─── Входные структуры ─────────────────────────────────────────────────────

// TemplateSlotInput — одна строка недельного шаблона.
type TemplateSlotInput struct {
	Weekday  int    `json:"weekday"` // 1=пн … 7=вс (ISO)
	StartsAt string `json:"starts_at"`
	EndsAt   string `json:"ends_at"`
}

// SetTemplateInput — недельный шаблон целиком (PUT-семантика).
//
// Заменяем целиком, а не патчим по дню: график недели правят как единое целое
// («теперь работает пн-ср вместо пн-пт»), и частичный апдейт оставлял бы
// висеть снятые дни.
type SetTemplateInput struct {
	UserID string              `json:"user_id"`
	Slots  []TemplateSlotInput `json:"slots"`
}

// ScheduleDayInput — переопределение на дату.
type ScheduleDayInput struct {
	UserID   string  `json:"user_id"`
	Date     string  `json:"date"` // YYYY-MM-DD
	Kind     string  `json:"kind"` // work | off
	StartsAt *string `json:"starts_at,omitempty"`
	EndsAt   *string `json:"ends_at,omitempty"`
	Note     *string `json:"note,omitempty"`
}

// ─── Выходные структуры ────────────────────────────────────────────────────

// PlannedShift — развёрнутый план на конкретную дату.
type PlannedShift struct {
	Date     string `json:"date"`
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
	StartsAt string `json:"starts_at,omitempty"`
	EndsAt   string `json:"ends_at,omitempty"`
	// Source — откуда взялась строка: template | override. Нужен на экране,
	// чтобы менеджер видел, где он уже вмешался вручную.
	Source string  `json:"source"`
	IsOff  bool    `json:"is_off"`
	Note   *string `json:"note,omitempty"`
}

// RollCallRow — строка переклички за день.
type RollCallRow struct {
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
	// Status: on_time | late | absent | unplanned | off.
	Status       string     `json:"status"`
	PlannedStart string     `json:"planned_start,omitempty"`
	PlannedEnd   string     `json:"planned_end,omitempty"`
	ClockIn      *time.Time `json:"clock_in,omitempty"`
	ClockOut     *time.Time `json:"clock_out,omitempty"`
	LateMinutes  int        `json:"late_minutes,omitempty"`
	Source       string     `json:"source,omitempty"` // источник плана
	// EntryID — отметка табеля, к которой относится строка. По нему UI тянет
	// оригинал снимка (превью приходит здесь же).
	EntryID string `json:"entry_id,omitempty"`
	// PhotoThumb — превью селфи прихода в base64 (103). Именно превью, а не
	// оригинал: перекличка на 20 человек иначе весила бы под мегабайт.
	PhotoThumb string `json:"photo_thumb,omitempty"`
	// SuggestedFine — сколько система ПРЕДЛАГАЕТ удержать за это опоздание
	// (105). Не удерживает: подтверждает человек, потому что данные бывают
	// неточными (сбитое время планшета, забытый уход), а деньги чужие.
	SuggestedFine string `json:"suggested_fine,omitempty"`
	// Fined — за этот день уже есть непогашенный штраф.
	Fined bool `json:"fined,omitempty"`
}

// RollCallReport — перекличка за дату.
type RollCallReport struct {
	Date     string `json:"date"`
	Timezone string `json:"timezone"`
	// GraceMinutes / FinesConfigured — чтобы экран объяснял, откуда берутся
	// суммы, и не предлагал штрафовать там, где правила не заданы.
	GraceMinutes    int           `json:"grace_minutes"`
	FinesConfigured bool          `json:"fines_configured"`
	Planned         int           `json:"planned"`
	Present         int           `json:"present"`
	Late            int           `json:"late"`
	Absent          int           `json:"absent"`
	Unplanned       int           `json:"unplanned"`
	Rows            []RollCallRow `json:"rows"`
}

// ─── Шаблон недели ─────────────────────────────────────────────────────────

// Template — недельный шаблон сотрудника.
func (s *ScheduleService) Template(ctx context.Context, userID string) ([]models.ShiftScheduleTemplate, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	if userID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id обязателен", nil)
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.ShiftScheduleTemplate
	if err := scoped.Where("user_id = ?", userID).Order("weekday").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// SetTemplate — заменить недельный шаблон целиком.
func (s *ScheduleService) SetTemplate(ctx context.Context, in SetTemplateInput) ([]models.ShiftScheduleTemplate, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.UserID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id обязателен", nil)
	}
	seen := map[int]bool{}
	for i := range in.Slots {
		slot := &in.Slots[i]
		if slot.Weekday < 1 || slot.Weekday > 7 {
			return nil, apperrors.Wrap("VALIDATION", "weekday должен быть от 1 (пн) до 7 (вс)", nil)
		}
		if seen[slot.Weekday] {
			return nil, apperrors.Wrap("VALIDATION", "день недели повторяется в шаблоне", nil)
		}
		seen[slot.Weekday] = true
		start, err := normalizeHHMM(slot.StartsAt)
		if err != nil {
			return nil, err
		}
		end, err := normalizeHHMM(slot.EndsAt)
		if err != nil {
			return nil, err
		}
		slot.StartsAt, slot.EndsAt = start, end
	}

	now := time.Now().UTC()
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Полная замена: старые дни удаляем, иначе снятый из графика вторник
		// продолжал бы требовать явки. Синк построчный — synclog оперирует
		// строками, и центр должен узнать про КАЖДУЮ снятую.
		var old []models.ShiftScheduleTemplate
		if err := tx.Where("restaurant_id = ? AND user_id = ?", rid, in.UserID).
			Find(&old).Error; err != nil {
			return err
		}
		if err := tx.Where("restaurant_id = ? AND user_id = ?", rid, in.UserID).
			Delete(&models.ShiftScheduleTemplate{}).Error; err != nil {
			return err
		}
		for _, o := range old {
			if err := recordScheduleTemplateDeleteSync(tx, o.ID, rid); err != nil {
				return err
			}
		}
		for _, slot := range in.Slots {
			row := models.ShiftScheduleTemplate{
				ID: uuid.NewString(), RestaurantID: &rid, UserID: &in.UserID,
				Weekday: slot.Weekday, StartsAt: slot.StartsAt, EndsAt: slot.EndsAt,
				CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			if err := recordScheduleTemplateRowSync(tx, row.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.Template(ctx, in.UserID)
}

// ─── Переопределения по датам ──────────────────────────────────────────────

// SetDay — переопределение графика на конкретную дату (upsert).
func (s *ScheduleService) SetDay(ctx context.Context, in ScheduleDayInput) (*models.ShiftScheduleDay, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.UserID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id обязателен", nil)
	}
	date, err := normalizeDate(in.Date)
	if err != nil {
		return nil, err
	}
	kind := in.Kind
	if kind == "" {
		kind = "work"
	}
	if kind != "work" && kind != "off" {
		return nil, apperrors.Wrap("VALIDATION", "kind должен быть work или off", nil)
	}
	row := models.ShiftScheduleDay{
		ID: uuid.NewString(), RestaurantID: &rid, UserID: &in.UserID,
		WorkDate: date, Kind: kind, Note: in.Note,
	}
	if kind == "work" {
		// Рабочий день без времени бессмыслен: сравнивать приход будет не с чем.
		if in.StartsAt == nil || in.EndsAt == nil {
			return nil, apperrors.Wrap("VALIDATION", "для рабочего дня укажите время начала и конца", nil)
		}
		start, err := normalizeHHMM(*in.StartsAt)
		if err != nil {
			return nil, err
		}
		end, err := normalizeHHMM(*in.EndsAt)
		if err != nil {
			return nil, err
		}
		row.StartsAt, row.EndsAt = &start, &end
	}

	row.CreatedAt = time.Now().UTC()
	row.UpdatedAt = row.CreatedAt
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "restaurant_id"}, {Name: "user_id"}, {Name: "work_date"}},
			// Явный список колонок, не UpdateAll: тот затирал бы служебные
			// поля вне DTO (created_at) на каждом сохранении.
			DoUpdates: clause.AssignmentColumns([]string{"kind", "starts_at", "ends_at", "note", "updated_at"}),
		}).Create(&row).Error; err != nil {
			return err
		}
		// При конфликте в БД осталась СТАРАЯ строка со своим id, а row.ID —
		// свежесгенерированный и никуда не записанный. Синкать надо реальный
		// id, иначе центр получил бы строку-призрак.
		var saved models.ShiftScheduleDay
		if err := tx.Where("restaurant_id = ? AND user_id = ? AND work_date = ?::date",
			rid, in.UserID, date).First(&saved).Error; err != nil {
			return err
		}
		return recordScheduleDayRowSync(tx, saved.ID)
	})
	if err != nil {
		return nil, err
	}
	return s.day(ctx, in.UserID, date)
}

// DeleteDay — снять переопределение (вернуться к шаблону).
func (s *ScheduleService) DeleteDay(ctx context.Context, userID, date string) error {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	d, err := normalizeDate(date)
	if err != nil {
		return err
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var existing models.ShiftScheduleDay
		if err := tx.Where("restaurant_id = ? AND user_id = ? AND work_date = ?::date", rid, userID, d).
			First(&existing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if err := tx.Where("id = ?", existing.ID).Delete(&models.ShiftScheduleDay{}).Error; err != nil {
			return err
		}
		return recordScheduleDayDeleteSync(tx, existing.ID, rid)
	})
}

func (s *ScheduleService) day(ctx context.Context, userID, date string) (*models.ShiftScheduleDay, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var row models.ShiftScheduleDay
	if err := scoped.Where("user_id = ? AND work_date = ?::date", userID, date).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &row, nil
}

// ─── План на диапазон ──────────────────────────────────────────────────────

// Plan — развёрнутый график: по строке на (дату × сотрудника), с учётом
// переопределений поверх шаблона.
func (s *ScheduleService) Plan(ctx context.Context, from, to, userID string) ([]PlannedShift, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	days, err := datesInRange(from, to)
	if err != nil {
		return nil, err
	}
	plan, names, err := s.planFor(ctx, days, userID)
	if err != nil {
		return nil, err
	}
	out := make([]PlannedShift, 0, len(plan))
	for _, p := range plan {
		p.UserName = names[p.UserID]
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date < out[j].Date
		}
		return out[i].UserName < out[j].UserName
	})
	return out, nil
}

// planFor — план на набор дат. Возвращает строки и карту имён.
func (s *ScheduleService) planFor(ctx context.Context, days []string, userID string) ([]PlannedShift, map[string]string, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, nil, err
	}
	raw := s.r.Raw().WithContext(ctx)

	var templates []models.ShiftScheduleTemplate
	tq := raw.Where("restaurant_id = ?", rid)
	if userID != "" {
		tq = tq.Where("user_id = ?", userID)
	}
	if err := tq.Find(&templates).Error; err != nil {
		return nil, nil, err
	}

	var overrides []models.ShiftScheduleDay
	oq := raw.Where("restaurant_id = ? AND work_date >= ?::date AND work_date <= ?::date",
		rid, days[0], days[len(days)-1])
	if userID != "" {
		oq = oq.Where("user_id = ?", userID)
	}
	if err := oq.Find(&overrides).Error; err != nil {
		return nil, nil, err
	}

	// Имена — одним запросом, JOIN'ом по карте (тот же приём, что
	// attachUserNames в табеле): уволенные (role='deleted') в график не
	// попадают, но их прошлые строки остаются видимыми под своим именем.
	names, err := s.userNames(ctx, rid)
	if err != nil {
		return nil, nil, err
	}

	byUserWeekday := map[string]models.ShiftScheduleTemplate{}
	for _, t := range templates {
		if t.UserID == nil {
			continue
		}
		byUserWeekday[*t.UserID+"|"+strconv.Itoa(t.Weekday)] = t
	}
	byUserDate := map[string]models.ShiftScheduleDay{}
	for _, o := range overrides {
		if o.UserID == nil {
			continue
		}
		byUserDate[*o.UserID+"|"+normalizeDateLoose(o.WorkDate)] = o
	}

	// Кто вообще участвует: все, у кого есть хоть шаблон, хоть переопределение.
	participants := map[string]bool{}
	for _, t := range templates {
		if t.UserID != nil {
			participants[*t.UserID] = true
		}
	}
	for _, o := range overrides {
		if o.UserID != nil {
			participants[*o.UserID] = true
		}
	}

	out := make([]PlannedShift, 0, len(participants)*len(days))
	for _, d := range days {
		day, _ := time.Parse(dateLayout, d)
		weekday := int(day.Weekday())
		if weekday == 0 {
			weekday = 7 // Go: вс=0, ISO: вс=7
		}
		for uid := range participants {
			if o, ok := byUserDate[uid+"|"+d]; ok {
				row := PlannedShift{Date: d, UserID: uid, Source: "override", Note: o.Note}
				if o.Kind == "off" {
					row.IsOff = true
				} else {
					if o.StartsAt != nil {
						row.StartsAt = *o.StartsAt
					}
					if o.EndsAt != nil {
						row.EndsAt = *o.EndsAt
					}
				}
				out = append(out, row)
				continue
			}
			if t, ok := byUserWeekday[uid+"|"+strconv.Itoa(weekday)]; ok {
				out = append(out, PlannedShift{
					Date: d, UserID: uid, Source: "template",
					StartsAt: t.StartsAt, EndsAt: t.EndsAt,
				})
			}
			// Нет ни того, ни другого — сотрудник в этот день не работает, и
			// строки не появляется: пустой день не должен выглядеть как отгул.
		}
	}
	return out, names, nil
}

// ─── Журнал отметок ────────────────────────────────────────────────────────

// JournalEvent — одно событие: приход ИЛИ уход.
//
// Табель хранит смену одной строкой с двумя концами, а журналу нужны именно
// события: у прихода и ухода свои время, свой снимок и разный смысл. Поэтому
// строки разворачиваются здесь, а не на клиенте — иначе каждый экран
// разворачивал бы их по-своему.
type JournalEvent struct {
	EntryID  string    `json:"entry_id"`
	UserID   string    `json:"user_id"`
	UserName string    `json:"user_name"`
	Kind     string    `json:"kind"` // in | out
	At       time.Time `json:"at"`
	// Source — откуда отметка (101): app | manual | hikvision. Ручную отметку
	// менеджера в ленте видно отдельно — у неё не бывает снимка, и это не
	// повод считать её подозрительной.
	Source string `json:"source,omitempty"`
	// PhotoThumb — превью в base64; пусто, если снимка нет.
	PhotoThumb string `json:"photo_thumb,omitempty"`
	// LateMinutes — только для прихода и только когда опоздание есть.
	LateMinutes int `json:"late_minutes,omitempty"`
}

// Journal — лента отметок за день, свежие сверху.
func (s *ScheduleService) Journal(ctx context.Context, date string) ([]JournalEvent, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	d, err := normalizeDate(date)
	if err != nil {
		return nil, err
	}
	policy := s.loadLatePolicy(ctx, rid)

	// Локальные сутки ресторана: по UTC ночная смена уехала бы в соседний день.
	dayStart, err := time.ParseInLocation(dateLayout, d, policy.loc)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "некорректная дата", err)
	}
	dayEnd := dayStart.Add(24 * time.Hour)

	// Берём записи, У КОТОРЫХ в этот день попал хотя бы один конец: смена,
	// начатая вчера вечером и закрытая сегодня утром, должна дать событие
	// «уход» в сегодняшней ленте.
	var rows []models.TimeEntry
	if err := s.r.Raw().WithContext(ctx).
		Where(`restaurant_id = ? AND (
			(clock_in  >= ? AND clock_in  < ?) OR
			(clock_out >= ? AND clock_out < ?))`,
			rid, dayStart.UTC(), dayEnd.UTC(), dayStart.UTC(), dayEnd.UTC()).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []JournalEvent{}, nil
	}

	names, err := s.userNames(ctx, rid)
	if err != nil {
		return nil, err
	}

	entryIDs := make([]string, 0, len(rows))
	for i := range rows {
		entryIDs = append(entryIDs, rows[i].ID)
	}
	photos := map[string]models.AttendancePhoto{}
	if s.photos != nil {
		if p, err := s.photos.ForEntries(ctx, entryIDs); err == nil {
			photos = p
		} else {
			log.Warn().Err(err).Msg("журнал отметок: превью не подгрузились")
		}
	}

	// Опоздания берём из переклички за ту же дату — один расчёт на оба экрана,
	// иначе лента и перекличка расходились бы в цифрах.
	late := map[string]int{}
	if report, err := s.RollCall(ctx, d); err == nil {
		for _, row := range report.Rows {
			if row.Status == "late" {
				late[row.UserID] = row.LateMinutes
			}
		}
	}

	out := make([]JournalEvent, 0, len(rows)*2)
	add := func(row models.TimeEntry, kind string, at time.Time) {
		if at.Before(dayStart) || !at.Before(dayEnd) {
			return
		}
		ev := JournalEvent{EntryID: row.ID, Kind: kind, At: at}
		if row.UserID != nil {
			ev.UserID = *row.UserID
			ev.UserName = names[*row.UserID]
			if kind == "in" {
				ev.LateMinutes = late[*row.UserID]
			}
		}
		if row.Source != nil {
			ev.Source = *row.Source
		}
		if p, ok := photos[row.ID+"|"+kind]; ok && len(p.Thumb) > 0 {
			ev.PhotoThumb = base64.StdEncoding.EncodeToString(p.Thumb)
		}
		out = append(out, ev)
	}
	for i := range rows {
		if rows[i].ClockIn != nil {
			add(rows[i], "in", rows[i].ClockIn.In(policy.loc))
		}
		if rows[i].ClockOut != nil {
			add(rows[i], "out", rows[i].ClockOut.In(policy.loc))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out, nil
}

// userNames — карта id→имя одним запросом. JOIN-по-карте, а не SQL JOIN: тот
// же приём, что в табеле (attachUserNames).
func (s *ScheduleService) userNames(ctx context.Context, rid string) (map[string]string, error) {
	type nameRow struct {
		ID   string `gorm:"column:id"`
		Name string `gorm:"column:name"`
	}
	var rows []nameRow
	if err := s.r.Raw().WithContext(ctx).Table("users").
		Select("id::text AS id, COALESCE(name, username, '') AS name").
		Where("restaurant_id = ?", rid).Scan(&rows).Error; err != nil {
		return nil, err
	}
	m := make(map[string]string, len(rows))
	for _, r := range rows {
		m[r.ID] = r.Name
	}
	return m, nil
}

// ─── Перекличка ────────────────────────────────────────────────────────────

// RollCall — план против факта за дату: кто пришёл вовремя, кто опоздал, кто
// не пришёл, и кто отметился без плана.
func (s *ScheduleService) RollCall(ctx context.Context, date string) (*RollCallReport, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	d, err := normalizeDate(date)
	if err != nil {
		return nil, err
	}
	policy := s.loadLatePolicy(ctx, rid)
	loc := policy.loc

	plan, names, err := s.planFor(ctx, []string{d}, "")
	if err != nil {
		return nil, err
	}

	// Факт за ЛОКАЛЬНЫЕ сутки ресторана: clock_in хранится в UTC, и наивное
	// сравнение по UTC-дате сдвинуло бы ночные смены на соседний день.
	dayStart, err := time.ParseInLocation(dateLayout, d, loc)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "некорректная дата", err)
	}
	dayEnd := dayStart.Add(24 * time.Hour)
	var entries []models.TimeEntry
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND clock_in >= ? AND clock_in < ?", rid, dayStart.UTC(), dayEnd.UTC()).
		Order("clock_in").Find(&entries).Error; err != nil {
		return nil, err
	}
	firstEntry := map[string]models.TimeEntry{}
	for _, e := range entries {
		if e.UserID == nil {
			continue
		}
		// Первая отметка дня — та, по которой считается опоздание: приход
		// после обеда не должен «исправлять» утреннее опоздание.
		if _, ok := firstEntry[*e.UserID]; !ok {
			firstEntry[*e.UserID] = e
		}
	}

	report := &RollCallReport{
		Date: d, Timezone: loc.String(),
		GraceMinutes: policy.graceMinutes, FinesConfigured: policy.finesConfigured(),
	}
	plannedUsers := map[string]bool{}

	for _, p := range plan {
		plannedUsers[p.UserID] = true
		row := RollCallRow{
			UserID: p.UserID, UserName: names[p.UserID],
			PlannedStart: p.StartsAt, PlannedEnd: p.EndsAt, Source: p.Source,
		}
		entry, came := firstEntry[p.UserID]
		if p.IsOff {
			// Выходной: пришёл — значит вышел сверх графика, это не «вовремя».
			row.Status = "off"
			if came {
				row.Status = "unplanned"
				row.ClockIn, row.ClockOut = entry.ClockIn, entry.ClockOut
				row.EntryID = entry.ID
				report.Unplanned++
			}
			report.Rows = append(report.Rows, row)
			continue
		}
		report.Planned++
		if !came || entry.ClockIn == nil {
			row.Status = "absent"
			report.Absent++
			report.Rows = append(report.Rows, row)
			continue
		}
		row.ClockIn, row.ClockOut = entry.ClockIn, entry.ClockOut
		row.EntryID = entry.ID
		report.Present++
		late := lateMinutes(*entry.ClockIn, d, p.StartsAt, loc)
		if late > policy.graceMinutes {
			row.Status = "late"
			row.LateMinutes = late
			report.Late++
			if fine := policy.fineFor(late); decimal.IsPositive(fine) {
				row.SuggestedFine = fine.String()
			}
		} else {
			row.Status = "on_time"
		}
		report.Rows = append(report.Rows, row)
	}

	// Пришедшие без плана — отдельная категория, а не «молодцы»: подмена без
	// записи в графике и есть та дыра, из-за которой в конце месяца не сходится
	// табель.
	for uid, e := range firstEntry {
		if plannedUsers[uid] {
			continue
		}
		report.Unplanned++
		report.Rows = append(report.Rows, RollCallRow{
			UserID: uid, UserName: names[uid], Status: "unplanned",
			ClockIn: e.ClockIn, ClockOut: e.ClockOut, EntryID: e.ID,
		})
	}

	if err := s.attachPhotos(ctx, report); err != nil {
		return nil, err
	}
	if err := s.attachFineState(ctx, report); err != nil {
		return nil, err
	}
	sort.Slice(report.Rows, func(i, j int) bool {
		return report.Rows[i].UserName < report.Rows[j].UserName
	})
	return report, nil
}

// attachFineState — помечает строки, за которые штраф уже выставлен. Без
// этого кнопка «оштрафовать» выглядела бы доступной и на втором открытии
// экрана, а уникальный индекс возвращал бы ошибку вместо внятного состояния.
func (s *ScheduleService) attachFineState(ctx context.Context, report *RollCallReport) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	refs := make([]string, 0, len(report.Rows))
	for _, row := range report.Rows {
		if row.Status == "late" {
			refs = append(refs, lateFineRef(row.UserID, report.Date))
		}
	}
	if len(refs) == 0 {
		return nil
	}
	var existing []models.SalaryDeduction
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND source_ref IN ? AND cancelled_at IS NULL", rid, refs).
		Find(&existing).Error; err != nil {
		return err
	}
	fined := map[string]bool{}
	for _, d := range existing {
		if d.SourceRef != nil {
			fined[*d.SourceRef] = true
		}
	}
	for i := range report.Rows {
		if report.Rows[i].Status != "late" {
			continue
		}
		if fined[lateFineRef(report.Rows[i].UserID, report.Date)] {
			report.Rows[i].Fined = true
		}
	}
	return nil
}

// lateFineRef — ключ идемпотентности штрафа: один сотрудник, один день, один
// штраф. По нему же стоит уникальный индекс (105).
func lateFineRef(userID, date string) string { return "late:" + userID + ":" + date }

// attachPhotos — превью селфи прихода к строкам переклички. Ошибка хранилища
// не роняет отчёт: перекличка полезна и без картинок.
func (s *ScheduleService) attachPhotos(ctx context.Context, report *RollCallReport) error {
	if s.photos == nil {
		return nil
	}
	ids := make([]string, 0, len(report.Rows))
	for _, row := range report.Rows {
		if row.EntryID != "" {
			ids = append(ids, row.EntryID)
		}
	}
	photos, err := s.photos.ForEntries(ctx, ids)
	if err != nil {
		log.Warn().Err(err).Msg("roll-call: превью снимков не подгрузились")
		return nil
	}
	for i := range report.Rows {
		if report.Rows[i].EntryID == "" {
			continue
		}
		if p, ok := photos[report.Rows[i].EntryID+"|in"]; ok && len(p.Thumb) > 0 {
			report.Rows[i].PhotoThumb = base64.StdEncoding.EncodeToString(p.Thumb)
		}
	}
	return nil
}

// FineLate — удержать штраф за опоздание конкретного сотрудника в конкретный
// день (105).
//
// Отдельное явное действие, а не автоматика внутри переклички: удерживаемая
// сумма — деньги человека, а данные под ней бывают неточными (сбитое время
// планшета, забытый вчера уход, подмена без записи в графике). Молча снятый
// штраф превращается в спор задним числом, который нечем закрыть.
//
// Сумму берём СВОЮ, пересчитанную здесь же, а не присланную клиентом: иначе
// в удержание можно было бы отправить любое число мимо политики.
func (s *ScheduleService) FineLate(ctx context.Context, salary *SalaryService, userID, date string) (*models.SalaryDeduction, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	d, err := normalizeDate(date)
	if err != nil {
		return nil, err
	}
	report, err := s.RollCall(ctx, d)
	if err != nil {
		return nil, err
	}
	var target *RollCallRow
	for i := range report.Rows {
		if report.Rows[i].UserID == userID {
			target = &report.Rows[i]
			break
		}
	}
	if target == nil || target.Status != "late" {
		return nil, apperrors.Wrap("VALIDATION", "в этот день опоздания не зафиксировано", nil)
	}
	if target.Fined {
		return nil, apperrors.Wrap("CONFLICT", "штраф за этот день уже выставлен", nil)
	}
	if target.SuggestedFine == "" {
		return nil, apperrors.Wrap("VALIDATION",
			"правила штрафов не заданы — задайте их в настройках опозданий", nil)
	}

	ref := lateFineRef(userID, d)
	period := d[:7]
	reason := fmt.Sprintf("Опоздание %d мин (%s), смена с %s", target.LateMinutes, d, target.PlannedStart)
	row, err := salary.AddDeduction(ctx, DeductionInput{
		UserID: &userID, Amount: &target.SuggestedFine, Reason: &reason,
		Period: &period, SourceRef: &ref,
	})
	if err != nil {
		// Уникальный индекс по source_ref (105) — второй менеджер, открывший
		// перекличку одновременно, получает внятный отказ, а не 500.
		if strings.Contains(err.Error(), "uq_salary_deductions_source_ref") {
			return nil, apperrors.Wrap("CONFLICT", "штраф за этот день уже выставлен", nil)
		}
		return nil, err
	}
	return row, nil
}

// loadLatePolicy — часовой пояс и правила опозданий ресторана одним запросом.
// Часовой пояс с fallback Asia/Dushanbe — тот же приём, что в нумерации
// заказов (orders_write.go).
func (s *ScheduleService) loadLatePolicy(ctx context.Context, rid string) latePolicy {
	p := latePolicy{
		graceMinutes: defaultLateGraceMinutes,
		fixed:        decimal.FromInt(0),
		perMinute:    decimal.FromInt(0),
		max:          decimal.FromInt(0),
		loc:          time.Local,
	}
	var row models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&row).Error; err == nil {
		if row.LateGraceMinutes >= 0 {
			p.graceMinutes = row.LateGraceMinutes
		}
		p.fixed, p.perMinute, p.max = row.LateFineFixed, row.LateFinePerMinute, row.LateFineMax
	}
	tz := "Asia/Dushanbe"
	if row.Timezone != nil && *row.Timezone != "" {
		tz = *row.Timezone
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		p.loc = loc
	} else if fallback, err2 := time.LoadLocation("Asia/Dushanbe"); err2 == nil {
		p.loc = fallback
	}
	return p
}

// finesConfigured — заданы ли правила. Если нет, перекличка показывает
// опоздания, но ничего не предлагает удерживать: сумма «0 сомони» на экране
// выглядела бы как настроенный нулевой штраф.
func (p latePolicy) finesConfigured() bool {
	return decimal.IsPositive(p.fixed) || decimal.IsPositive(p.perMinute)
}

// lateMinutes — на сколько минут приход позже планового начала. Отрицательное
// (пришёл раньше) схлопывается в 0: ранний приход — не заслуга, которую надо
// накапливать, и в отчёте он не должен компенсировать вчерашнее опоздание.
func lateMinutes(clockIn time.Time, date, plannedStart string, loc *time.Location) int {
	if plannedStart == "" {
		return 0
	}
	planned, err := time.ParseInLocation("2006-01-02 15:04", date+" "+plannedStart, loc)
	if err != nil {
		return 0
	}
	diff := int(clockIn.In(loc).Sub(planned).Minutes())
	if diff < 0 {
		return 0
	}
	return diff
}

// ─── Разбор входных значений ───────────────────────────────────────────────

// normalizeHHMM — «9:5» → «09:05». Принимаем человеческий ввод, но храним
// строго 'HH:MM': на этом формате держится сравнение с фактом.
func normalizeHHMM(raw string) (string, error) {
	v := strings.TrimSpace(raw)
	parts := strings.Split(v, ":")
	if len(parts) != 2 {
		return "", apperrors.Wrap("VALIDATION", "время должно быть в формате ЧЧ:ММ", nil)
	}
	h, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	m, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return "", apperrors.Wrap("VALIDATION", "время должно быть в формате ЧЧ:ММ (00:00–23:59)", nil)
	}
	return fmt.Sprintf("%02d:%02d", h, m), nil
}

func normalizeDate(raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if len(v) > 10 {
		v = v[:10]
	}
	if _, err := time.Parse(dateLayout, v); err != nil {
		return "", apperrors.Wrap("VALIDATION", "дата должна быть в формате ГГГГ-ММ-ДД", nil)
	}
	return v, nil
}

// normalizeDateLoose — DATE из Postgres приезжает в модель строкой, но драйвер
// может отдать её с временем ('2026-09-01T00:00:00Z'). Ключ карты должен быть
// одинаковым в обоих случаях.
func normalizeDateLoose(raw string) string {
	if len(raw) >= 10 {
		return raw[:10]
	}
	return raw
}

func datesInRange(from, to string) ([]string, error) {
	f, err := normalizeDate(from)
	if err != nil {
		return nil, err
	}
	t, err := normalizeDate(to)
	if err != nil {
		return nil, err
	}
	start, _ := time.Parse(dateLayout, f)
	end, _ := time.Parse(dateLayout, t)
	if end.Before(start) {
		return nil, apperrors.Wrap("VALIDATION", "конец периода раньше начала", nil)
	}
	if int(end.Sub(start).Hours()/24)+1 > scheduleMaxRangeDays {
		return nil, apperrors.Wrap("VALIDATION",
			fmt.Sprintf("период больше %d дней — сузьте диапазон", scheduleMaxRangeDays), nil)
	}
	var out []string
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format(dateLayout))
	}
	return out, nil
}
