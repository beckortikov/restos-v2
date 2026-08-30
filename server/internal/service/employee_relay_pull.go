package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// EmployeeRelayPuller — сторона ФИЛИАЛА. Зеркало DeliveryPuller
// (delivery_pull.go), тянет НЕ общий sync_log, а узкую очередь
// employee_relay_actions (097), интервалом по умолчанию 30 сек (HR — не
// курьерская срочность, см. main.go RESTOS_EMPLOYEE_RELAY_INTERVAL_SEC).
//
// На каждую pending-команду вызывает СВОЙ, настоящий UsersService.Create/
// Patch или SalaryService.SetWorkedDays/ToggleDayMultiplier под
// синтетическим актором Role:"owner" — ОБЯЗАТЕЛЬНО owner: и новый гейт
// UsersService (Фаза 1, admin.go), и уже существующий
// requirePermFor(ctx, s.r, "payroll.manage") внутри SalaryService.
// SetWorkedDays/ToggleDayMultiplier иначе молча отклонят синтетического
// актора без реального UserID.
type EmployeeRelayPuller struct {
	usersSvc  *UsersService
	salarySvc *SalaryService
	r         *repo.Repo
	client    *http.Client
	fallback  PullerFallback
}

func NewEmployeeRelayPuller(usersSvc *UsersService, salarySvc *SalaryService, r *repo.Repo, fallback PullerFallback) *EmployeeRelayPuller {
	return &EmployeeRelayPuller{usersSvc: usersSvc, salarySvc: salarySvc, r: r, client: &http.Client{Timeout: 30 * time.Second}, fallback: fallback}
}

// activeConfig — идентично DeliveryPuller.activeConfig: та же sync_settings
// (singleton), тот же доверенный central, отдельного конфига не заводим.
func (p *EmployeeRelayPuller) activeConfig(ctx context.Context) (centralURL, token, restaurantID string, enabled bool, err error) {
	var st models.SyncSettings
	err = p.r.Raw().WithContext(ctx).Where("id = 1").First(&st).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return p.fallback.CentralURL, p.fallback.Token, p.fallback.RestaurantID, p.fallback.Enabled, nil
	}
	if err != nil {
		return "", "", "", false, err
	}
	if st.CentralURL != nil {
		centralURL = *st.CentralURL
	}
	if st.Token != nil {
		token = *st.Token
	}
	if st.RestaurantID != nil {
		restaurantID = *st.RestaurantID
	}
	return centralURL, token, restaurantID, st.Enabled, nil
}

// PullOnce тянет и материализует один батч. Возвращает число успешно
// доставленных (delivered) команд.
func (p *EmployeeRelayPuller) PullOnce(ctx context.Context) (int, error) {
	centralURL, token, restaurantID, enabled, err := p.activeConfig(ctx)
	if err != nil {
		return 0, err
	}
	if !enabled || centralURL == "" || restaurantID == "" {
		return 0, nil
	}

	u := centralURL + "/api/v1/sync/employees/pending?restaurant_id=" + url.QueryEscape(restaurantID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("employee relay pull %d: %s", resp.StatusCode, b)
	}
	var out struct {
		Actions []models.EmployeeRelayAction `json:"actions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}

	delivered := 0
	for _, ea := range out.Actions {
		if p.processOne(ctx, centralURL, token, restaurantID, ea) {
			delivered++
		}
	}
	return delivered, nil
}

// processOne материализует одну relay-команду (или переиспользует уже
// материализованную — см. employee_relay_received) и шлёт ack.
func (p *EmployeeRelayPuller) processOne(ctx context.Context, centralURL, token, restaurantID string, ea models.EmployeeRelayAction) bool {
	var already models.EmployeeRelayReceived
	err := p.r.Raw().WithContext(ctx).Where("relay_action_id = ?", ea.ID).First(&already).Error
	if err == nil {
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "delivered", LocalUserID: &already.LocalUserID})
		return true
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		log.Warn().Err(err).Str("relay_action_id", ea.ID).Msg("employee relay: local lookup failed")
		return false
	}

	switch ea.Kind {
	case "create":
		return p.processCreate(ctx, centralURL, token, restaurantID, ea)
	case "update_identity", "update_pay":
		// Оба kind'а бьют в один и тот же UsersService.Patch — он уже сегодня
		// принимает identity- и pay-поля одним методом, UserInput их не
		// разделяет (см. Фаза 1).
		return p.processPatch(ctx, centralURL, token, restaurantID, ea)
	case "set_worked_days":
		return p.processSetWorkedDays(ctx, centralURL, token, restaurantID, ea)
	case "toggle_day_multiplier":
		return p.processToggleDayMultiplier(ctx, centralURL, token, restaurantID, ea)
	default:
		msg := "неизвестный тип команды: " + ea.Kind
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
}

func (p *EmployeeRelayPuller) actorCtx(ctx context.Context, restaurantID string) context.Context {
	return audit.WithActor(tenant.WithRestaurant(ctx, restaurantID), audit.Actor{UserName: "Central (управление персоналом)", Role: "owner"})
}

// processCreate — материализует НОВОГО сотрудника (kind=create).
func (p *EmployeeRelayPuller) processCreate(ctx context.Context, centralURL, token, restaurantID string, ea models.EmployeeRelayAction) bool {
	var in UserInput
	if err := json.Unmarshal(ea.Payload, &in); err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	user, err := p.usersSvc.Create(p.actorCtx(ctx, restaurantID), in)
	if err != nil {
		// Коллизия username/PIN (Фаза 1) и любая другая ошибка валидации
		// приходят сюда как читаемый CONFLICT/VALIDATION — central увидит
		// причину в истории (#2), а не потеряет команду молча.
		msg := err.Error()
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	p.recordReceived(ctx, ea.ID, user.ID)
	p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "delivered", LocalUserID: &user.ID})
	return true
}

// processPatch — update_identity/update_pay: правит уже существующего
// сотрудника филиала обычным UsersService.Patch.
func (p *EmployeeRelayPuller) processPatch(ctx context.Context, centralURL, token, restaurantID string, ea models.EmployeeRelayAction) bool {
	if ea.TargetUserID == nil {
		msg := "команда без target_user_id"
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	var in UserInput
	if err := json.Unmarshal(ea.Payload, &in); err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	user, err := p.usersSvc.Patch(p.actorCtx(ctx, restaurantID), *ea.TargetUserID, in)
	if err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	p.recordReceived(ctx, ea.ID, user.ID)
	p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "delivered", LocalUserID: &user.ID})
	return true
}

// processSetWorkedDays — отмечает доп. смены (SalaryService.SetWorkedDays).
func (p *EmployeeRelayPuller) processSetWorkedDays(ctx context.Context, centralURL, token, restaurantID string, ea models.EmployeeRelayAction) bool {
	if ea.TargetUserID == nil {
		msg := "команда без target_user_id"
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	var in SetWorkedDaysRelayInput
	if err := json.Unmarshal(ea.Payload, &in); err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	if _, err := p.salarySvc.SetWorkedDays(p.actorCtx(ctx, restaurantID), *ea.TargetUserID, in.From, in.To, in.Dates); err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	p.recordReceived(ctx, ea.ID, *ea.TargetUserID)
	p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "delivered", LocalUserID: ea.TargetUserID})
	return true
}

// processToggleDayMultiplier — точечный ×2 на день (SalaryService.
// ToggleDayMultiplier).
func (p *EmployeeRelayPuller) processToggleDayMultiplier(ctx context.Context, centralURL, token, restaurantID string, ea models.EmployeeRelayAction) bool {
	if ea.TargetUserID == nil {
		msg := "команда без target_user_id"
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	var in ToggleDayMultiplierRelayInput
	if err := json.Unmarshal(ea.Payload, &in); err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	if _, err := p.salarySvc.ToggleDayMultiplier(p.actorCtx(ctx, restaurantID), *ea.TargetUserID, in.Date, in.From, in.To); err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "failed", Error: &msg})
		return false
	}
	p.recordReceived(ctx, ea.ID, *ea.TargetUserID)
	p.ack(ctx, centralURL, token, ea.ID, AckEmployeeRelayInput{Status: "delivered", LocalUserID: ea.TargetUserID})
	return true
}

// recordReceived — идемпотентность ДО ack — если ack не дойдёт, следующий
// тик найдёт эту запись и не продублирует мутацию повторно.
func (p *EmployeeRelayPuller) recordReceived(ctx context.Context, relayActionID, localUserID string) {
	if err := p.r.Raw().WithContext(ctx).Exec(
		`INSERT INTO employee_relay_received (relay_action_id, local_user_id) VALUES (?, ?) ON CONFLICT (relay_action_id) DO NOTHING`,
		relayActionID, localUserID,
	).Error; err != nil {
		log.Warn().Err(err).Str("relay_action_id", relayActionID).Msg("employee relay: failed to record idempotency ledger")
	}
}

func (p *EmployeeRelayPuller) ack(ctx context.Context, centralURL, token, actionID string, in AckEmployeeRelayInput) {
	body, err := json.Marshal(in)
	if err != nil {
		log.Warn().Err(err).Msg("employee relay: ack marshal failed")
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, centralURL+"/api/v1/sync/employees/"+actionID+"/ack", bytes.NewReader(body))
	if err != nil {
		log.Warn().Err(err).Msg("employee relay: ack request build failed")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		log.Warn().Err(err).Str("relay_action_id", actionID).Msg("employee relay: ack failed")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Warn().Str("relay_action_id", actionID).Int("status", resp.StatusCode).Bytes("body", b).Msg("employee relay: ack rejected")
	}
}

// Run гоняет PullOnce по таймеру до отмены ctx. Запускается БЕЗУСЛОВНО, как и
// Puller/DeliveryPuller — activeConfig на каждом тике сам решает, есть ли
// что делать.
func (p *EmployeeRelayPuller) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log.Info().Dur("interval", interval).Msg("employee relay puller started")
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("employee relay puller stopped")
			return
		case <-ticker.C:
			if _, err := p.PullOnce(ctx); err != nil {
				log.Warn().Err(err).Msg("employee relay pull failed")
			}
		}
	}
}
