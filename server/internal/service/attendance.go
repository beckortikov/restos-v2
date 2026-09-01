package service

// AttendanceService — отметки прихода/ухода с терминала :checkin.
//
// Терминал — это УСТРОЙСТВО, а не сотрудник: планшет висит у служебного входа,
// активирован один раз PIN-ом (роль `checkin`) и дальше принимает отметки всей
// смены. Поэтому отметка НЕ создаёт сессию и не трогает токен устройства —
// иначе терминал разлогинивался бы после каждого прихода. Сотрудник
// идентифицируется своим 4-значным PIN в теле запроса, ровно тем же, которым
// он входит на кассу.
//
// Отметки ложатся в тот же `time_entries`, что и ручной веб-табель, и
// отличаются только колонкой `source` (101): 'app' против 'manual'. Никакой
// параллельной таблицы — иначе дневная ЗП (054/059) и сетевой табель считали
// бы по двум разным источникам правды.

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

const (
	// attendanceSource — значение time_entries.source для отметок с терминала.
	attendanceSource = "app"

	// staleShiftAfter — после скольких часов открытая смена считается брошенной
	// (сотрудник ушёл, не отметившись). Порог заведомо больше самой длинной
	// реальной смены: 16 ч перекрывает даже двойную, но не даёт «вчерашнему»
	// приходу тянуться в сегодняшний день и блокировать новую отметку.
	staleShiftAfter = 16 * time.Hour
)

// attendanceRoles — кто может активировать терминал и слать отметки от его
// имени. Зеркало ALLOWED_ROLES в приложении :checkin.
var attendanceRoles = map[string]bool{"checkin": true, "manager": true, "owner": true}

// AttendanceService — сервис терминала отметок.
type AttendanceService struct {
	r       *repo.Repo
	entries *TimeEntriesService
	photos  *AttendancePhotoStore
	guess   *pinGuessThrottle
}

func NewAttendanceService(r *repo.Repo, entries *TimeEntriesService, photos *AttendancePhotoStore) *AttendanceService {
	return &AttendanceService{r: r, entries: entries, photos: photos, guess: newPinGuessThrottle()}
}

// ─── Результаты ────────────────────────────────────────────────────────────

// AttendanceLookupResult — «кто это и что ему предложить».
type AttendanceLookupResult struct {
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
	Position string `json:"position,omitempty"`
	Role     string `json:"role,omitempty"`
	// NextAction — что терминал предложит нажать: "in" (сотрудник не на смене)
	// или "out" (смена открыта).
	NextAction string `json:"next_action"`
	// OnShiftSince — начало открытой смены (только для next_action=out).
	OnShiftSince *time.Time `json:"on_shift_since,omitempty"`
	// WorkedMinutes — сколько уже отработано в открытой смене.
	WorkedMinutes int `json:"worked_minutes,omitempty"`
}

// AttendancePunchResult — результат отметки.
type AttendancePunchResult struct {
	Action        string    `json:"action"` // "in" | "out"
	EntryID       string    `json:"entry_id"`
	UserID        string    `json:"user_id"`
	UserName      string    `json:"user_name"`
	At            time.Time `json:"at"`
	WorkedMinutes int       `json:"worked_minutes,omitempty"` // только для "out"
	// PhotoSaved — прикрепился ли снимок. Отметка засчитывается и без него
	// (нет камеры, нет разрешения, диск не пишется) — не пускать человека на
	// смену из-за фото было бы хуже, чем принять отметку без доказательства.
	PhotoSaved bool `json:"photo_saved"`
	// ClosedStaleEntryID — id брошенной вчерашней смены, которую пришлось
	// закрыть, чтобы открыть сегодняшнюю. Терминал показывает по нему
	// предупреждение, иначе сотрудник не узнает, что его вчерашний уход
	// потерян и день надо править руками.
	ClosedStaleEntryID string `json:"closed_stale_entry_id,omitempty"`
}

// AttendanceOnShiftRow — строка списка «сейчас на смене».
type AttendanceOnShiftRow struct {
	EntryID       string    `json:"entry_id"`
	UserID        string    `json:"user_id"`
	UserName      string    `json:"user_name"`
	ClockIn       time.Time `json:"clock_in"`
	WorkedMinutes int       `json:"worked_minutes"`
}

// ─── Публичные методы ──────────────────────────────────────────────────────

// Lookup — POST /api/v1/attendance/lookup {pin}.
//
// Отдельный шаг перед отметкой (а не «PIN сразу отмечает»): сотрудник должен
// увидеть своё имя и подтвердить действие. Без подтверждения любой промах по
// клавише молча ставил бы чужой приход, и разбираться с этим пришлось бы в
// конце месяца по табелю.
func (s *AttendanceService) Lookup(ctx context.Context, pin string) (*AttendanceLookupResult, error) {
	if err := s.requireTerminal(ctx); err != nil {
		return nil, err
	}
	user, err := s.resolvePIN(ctx, pin)
	if err != nil {
		return nil, err
	}
	open, err := s.openEntry(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	res := &AttendanceLookupResult{
		UserID:     user.ID,
		UserName:   userDisplayName(user),
		NextAction: "in",
	}
	if user.Position != nil {
		res.Position = *user.Position
	}
	if user.Role != nil {
		res.Role = *user.Role
	}
	// Брошенная вчерашняя смена не должна превращать сегодняшний приход в
	// «уход»: предлагаем "in", а закроем её при самой отметке.
	if open != nil && open.ClockIn != nil && time.Since(*open.ClockIn) < staleShiftAfter {
		res.NextAction = "out"
		res.OnShiftSince = open.ClockIn
		res.WorkedMinutes = int(time.Since(*open.ClockIn).Minutes())
	}
	return res, nil
}

// Punch — POST /api/v1/attendance/punch {pin, action}.
//
// action приходит от клиента и сверяется с фактическим состоянием: между
// Lookup и подтверждением сотрудник мог отметиться на другом терминале, а
// двойной тап по кнопке не должен открывать вторую смену.
func (s *AttendanceService) Punch(ctx context.Context, pin, action, photoB64 string) (*AttendancePunchResult, error) {
	if err := s.requireTerminal(ctx); err != nil {
		return nil, err
	}
	if action != "in" && action != "out" {
		return nil, apperrors.Wrap("VALIDATION", "action должен быть in или out", nil)
	}
	user, err := s.resolvePIN(ctx, pin)
	if err != nil {
		return nil, err
	}
	name := userDisplayName(user)

	// Актор для audit_log и synclog — САМ СОТРУДНИК, а не учётка терминала.
	// Иначе в аудите весь табель ресторана выглядел бы как действия одного
	// «Терминала», и concurrent-правку было бы не с кем сопоставить.
	role := "waiter"
	if user.Role != nil && *user.Role != "" {
		role = *user.Role
	}
	actorCtx := audit.WithActor(ctx, audit.Actor{UserID: user.ID, UserName: name, Role: role})

	open, err := s.openEntry(ctx, user.ID)
	if err != nil {
		return nil, err
	}

	if action == "out" {
		if open == nil {
			return nil, apperrors.Wrap("CONFLICT", name+": приход не отмечен — сначала отметьте приход", nil)
		}
		closed, err := s.entries.ClockOut(actorCtx, open.ID, TimeEntryInput{})
		if err != nil {
			return nil, err
		}
		worked := 0
		if closed.ClockIn != nil && closed.ClockOut != nil {
			worked = int(closed.ClockOut.Sub(*closed.ClockIn).Minutes())
		}
		at := time.Now().UTC()
		if closed.ClockOut != nil {
			at = *closed.ClockOut
		}
		res := &AttendancePunchResult{
			Action: "out", EntryID: closed.ID, UserID: user.ID, UserName: name,
			At: at, WorkedMinutes: worked,
		}
		res.PhotoSaved = s.savePhoto(actorCtx, closed.ID, user.ID, "out", photoB64)
		return res, nil
	}

	// action == "in"
	staleID := ""
	if open != nil {
		if open.ClockIn != nil && time.Since(*open.ClockIn) < staleShiftAfter {
			return nil, apperrors.Wrap("CONFLICT",
				name+": смена уже открыта в "+open.ClockIn.Local().Format("15:04")+" — отметьте уход", nil)
		}
		// Брошенная смена: закрываем нулевой длительностью и с пометкой.
		// Выдумывать время ухода нельзя — мы его не знаем; честнее оставить
		// день в табеле с нулём часов и заметкой, чтобы менеджер поправил.
		if err := s.closeStale(actorCtx, open); err != nil {
			return nil, err
		}
		staleID = open.ID
	}

	src := attendanceSource
	created, err := s.entries.ClockIn(actorCtx, TimeEntryInput{UserID: &user.ID, Source: &src})
	if err != nil {
		return nil, err
	}
	at := time.Now().UTC()
	if created.ClockIn != nil {
		at = *created.ClockIn
	}
	res := &AttendancePunchResult{
		Action: "in", EntryID: created.ID, UserID: user.ID, UserName: name,
		At: at, ClosedStaleEntryID: staleID,
	}
	res.PhotoSaved = s.savePhoto(actorCtx, created.ID, user.ID, "in", photoB64)
	return res, nil
}

// OnShift — GET /api/v1/attendance/on-shift: кто сейчас на смене.
// Терминал показывает список на главном экране — это единственный способ для
// сотрудника заметить, что его вчерашний уход не отметился.
func (s *AttendanceService) OnShift(ctx context.Context) ([]AttendanceOnShiftRow, error) {
	if err := s.requireTerminal(ctx); err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.TimeEntry
	if err := scoped.Where("clock_out IS NULL").Order("clock_in DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	ptrs := make([]*models.TimeEntry, len(rows))
	for i := range rows {
		ptrs[i] = &rows[i]
	}
	if err := s.entries.attachUserNames(ctx, ptrs...); err != nil {
		return nil, err
	}
	out := make([]AttendanceOnShiftRow, 0, len(rows))
	for i := range rows {
		if rows[i].ClockIn == nil {
			continue
		}
		// Брошенные смены в списке не показываем: они уже не «на смене», а
		// мусор для менеджера, и терминал не должен их предлагать закрывать.
		if time.Since(*rows[i].ClockIn) >= staleShiftAfter {
			continue
		}
		row := AttendanceOnShiftRow{
			EntryID:       rows[i].ID,
			ClockIn:       *rows[i].ClockIn,
			WorkedMinutes: int(time.Since(*rows[i].ClockIn).Minutes()),
		}
		if rows[i].UserID != nil {
			row.UserID = *rows[i].UserID
		}
		if rows[i].UserName != nil {
			row.UserName = *rows[i].UserName
		}
		out = append(out, row)
	}
	return out, nil
}

// ─── Внутреннее ────────────────────────────────────────────────────────────

// requireTerminal — гвард по РОЛИ, а не по матрице прав: у роли `checkin` прав
// нет вообще (украденный планшет не должен открывать ни меню, ни деньги), и
// requirePermFor для неё всегда вернул бы 403.
func (s *AttendanceService) requireTerminal(ctx context.Context) error {
	actor, _ := audit.ActorFromContext(ctx)
	if !attendanceRoles[actor.Role] {
		return apperrors.Wrap("FORBIDDEN", "отметки принимает только терминал учёта времени", nil)
	}
	return nil
}

// resolvePIN — сотрудник по PIN внутри ресторана терминала.
//
// Повторяет контракт AuthService.LoginByPIN (уникальность PIN в пределах
// ресторана, constant-time сравнение), но НЕ выдаёт токен: отметка — не вход.
func (s *AttendanceService) resolvePIN(ctx context.Context, pin string) (*models.User, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	pin = strings.TrimSpace(pin)
	if pin == "" {
		return nil, apperrors.Wrap("VALIDATION", "введите PIN", nil)
	}
	// Задержка от перебора ДО запроса: 4 цифры — это 10 000 комбинаций, а
	// планшет висит в доступном месте. Не блокировка, а торможение: живой
	// сотрудник после чужих промахов ждёт секунды, перебор растягивается на
	// часы. Блокировать наглухо нельзя — один шутник оставил бы без отметок
	// всю смену.
	s.guess.wait(ctx, rid)

	var candidates []models.User
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND pin IS NOT NULL", rid).
		Find(&candidates).Error; err != nil {
		return nil, err
	}
	for i := range candidates {
		if candidates[i].PIN == nil {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(*candidates[i].PIN), []byte(pin)) != 1 {
			continue
		}
		u := candidates[i]
		// Служебная учётка самого терминала — не сотрудник: пускать её в
		// табель значит копить смены «Терминала» вместо людей.
		if u.Role != nil && *u.Role == "checkin" {
			s.guess.fail(rid)
			return nil, apperrors.Wrap("FORBIDDEN", "это PIN терминала, а не сотрудника", nil)
		}
		// Увольнение в v4 — это role='deleted' (см. usernameTaken в admin.go),
		// отдельного is_active нет. Уволенный не должен отмечаться, даже пока
		// его PIN лежит в базе.
		if u.Role != nil && *u.Role == "deleted" {
			s.guess.fail(rid)
			return nil, apperrors.Wrap("FORBIDDEN", "сотрудник больше не работает — обратитесь к управляющему", nil)
		}
		s.guess.success(rid)
		return &u, nil
	}
	s.guess.fail(rid)
	return nil, apperrors.Wrap("UNAUTHORIZED", "PIN не найден", nil)
}

// openEntry — незакрытая смена сотрудника (самая свежая), либо nil.
func (s *AttendanceService) openEntry(ctx context.Context, userID string) (*models.TimeEntry, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var t models.TimeEntry
	err = scoped.Where("user_id = ? AND clock_out IS NULL", userID).
		Order("clock_in DESC").First(&t).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// closeStale — закрыть брошенную смену временем её же прихода (0 часов) с
// пометкой. Через штатный ClockOut, а не прямым UPDATE: нужен тот же
// synclog-след, иначе центр не увидит закрытие.
func (s *AttendanceService) closeStale(ctx context.Context, open *models.TimeEntry) error {
	if open.ClockIn == nil {
		return nil
	}
	at := open.ClockIn.UTC().Format(time.RFC3339)
	note := "уход не отмечен — смена закрыта автоматически при следующем приходе"
	if open.Note != nil && strings.TrimSpace(*open.Note) != "" {
		note = strings.TrimSpace(*open.Note) + "; " + note
	}
	_, err := s.entries.ClockOut(ctx, open.ID, TimeEntryInput{ClockOut: &at, Note: &note})
	return err
}

// userDisplayName — как показать сотрудника на экране терминала.
func userDisplayName(u *models.User) string {
	if u.Name != nil && strings.TrimSpace(*u.Name) != "" {
		return strings.TrimSpace(*u.Name)
	}
	if u.Username != nil {
		return *u.Username
	}
	return "Сотрудник"
}

// savePhoto — прикрепить селфи к отметке. Ошибка НЕ роняет отметку: она уже в
// табеле, и терять рабочий день из-за проблем со снимком нельзя. Возвращаем
// факт сохранения, чтобы терминал мог честно сказать «фото не сохранилось».
func (s *AttendanceService) savePhoto(ctx context.Context, entryID, userID, kind, photoB64 string) bool {
	if s.photos == nil || !s.photos.Enabled() || strings.TrimSpace(photoB64) == "" {
		return false
	}
	if err := s.photos.Save(ctx, entryID, userID, kind, photoB64); err != nil {
		log.Warn().Err(err).Str("entry_id", entryID).Str("kind", kind).
			Msg("attendance: снимок не сохранён, отметка засчитана")
		return false
	}
	return true
}

// ─── Торможение перебора PIN ───────────────────────────────────────────────

// pinGuessThrottle — счётчик подряд идущих промахов по ресторану с
// нарастающей задержкой ответа. In-memory: бэк — один процесс на кассу, и
// переживать рестарт этому счётчику незачем (перебор с нуля всё равно упрётся
// в ту же лестницу).
type pinGuessThrottle struct {
	mu    sync.Mutex
	fails map[string]int
}

func newPinGuessThrottle() *pinGuessThrottle {
	return &pinGuessThrottle{fails: make(map[string]int)}
}

// delayFor — лестница задержек: первые два промаха бесплатны (обычная
// опечатка), дальше растёт до 4 секунд. При 4 с на попытку полный перебор
// 10 000 PIN-ов занимает больше 11 часов — за смену не уложиться.
func delayFor(fails int) time.Duration {
	switch {
	case fails < 3:
		return 0
	case fails < 5:
		return time.Second
	case fails < 10:
		return 2 * time.Second
	default:
		return 4 * time.Second
	}
}

func (t *pinGuessThrottle) wait(ctx context.Context, key string) {
	t.mu.Lock()
	d := delayFor(t.fails[key])
	t.mu.Unlock()
	if d == 0 {
		return
	}
	select {
	case <-time.After(d):
	case <-ctx.Done():
	}
}

func (t *pinGuessThrottle) fail(key string) {
	t.mu.Lock()
	t.fails[key]++
	t.mu.Unlock()
}

func (t *pinGuessThrottle) success(key string) {
	t.mu.Lock()
	delete(t.fails, key)
	t.mu.Unlock()
}
