package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// Код приглашения филиала в сеть (ADR-003, продолжение). Central генерирует
// одноразовый короткий код (НЕ сам sync-секрет) — филиал обменивает его на
// настоящий sync_settings.token+restaurants.account_id через публичный
// POST /api/v1/sync/pair, после чего used_at гасит код навсегда. Секрет
// никогда не покидает central в открытом виде до подтверждённого обмена.

const inviteTTL = 7 * 24 * time.Hour

// generateInviteCode — 10 случайных байт → base32 без паддинга (алфавит
// A-Z2-7 — без 0/1/O/I, безопасно печатать/читать). 80 бит энтропии —
// подбор вычислительно неосуществим, отдельный rate-limit не нужен. Идиома
// crypto/rand как generateToken() в auth.go — отдельного pkg-хелпера для
// случайных токенов в проекте нет.
func generateInviteCode() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf), nil
}

// NetworkInviteOut — код приглашения с готовой pairing-ссылкой для UI.
type NetworkInviteOut struct {
	ID         string     `json:"id"`
	Label      *string    `json:"label,omitempty"`
	Code       string     `json:"code"`
	PairingURL string     `json:"pairing_url"`
	ExpiresAt  time.Time  `json:"expires_at"`
	UsedAt     *time.Time `json:"used_at,omitempty"`
	UsedByName *string    `json:"used_by_restaurant_name,omitempty"`
}

func inviteOut(inv *models.NetworkInvite, publicURL string) NetworkInviteOut {
	return NetworkInviteOut{
		ID: inv.ID, Label: inv.Label, Code: inv.Code,
		PairingURL: strings.TrimRight(publicURL, "/") + "/pair/" + inv.Code,
		ExpiresAt:  inv.ExpiresAt, UsedAt: inv.UsedAt, UsedByName: inv.UsedByRestaurantName,
	}
}

// requireCentralOwner — общий гвард CreateInvite/ListInvites/RevokeInvite:
// только owner, и только на central-узле сети (только central выпускает
// приглашения). Паттерн владелец-only — как SyncService.Backfill
// (sync_backfill.go): audit.ActorFromContext + Role check, не middleware.
func (s *NetworkService) requireCentralOwner(ctx context.Context) (rid, account string, err error) {
	actor, _ := audit.ActorFromContext(ctx)
	if actor.Role != "owner" {
		return "", "", apperrors.Wrap("FORBIDDEN", "только владелец может управлять приглашениями", nil)
	}
	rid, err = tenant.MustRestaurantID(ctx)
	if err != nil {
		return "", "", err
	}
	var rest models.Restaurant
	if err = s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		return "", "", err
	}
	if rest.Kind == nil || *rest.Kind != "central_warehouse" {
		return "", "", apperrors.Wrap("VALIDATION", "приглашения выпускает только центральный склад сети", nil)
	}
	if rest.AccountID == nil || *rest.AccountID == "" {
		return "", "", apperrors.Wrap("VALIDATION", "ресторан не в сети", nil)
	}
	return rid, *rest.AccountID, nil
}

// CreateInvite — новый код приглашения. publicURL, если передан, сохраняется
// на company_accounts (переиспользуется следующими вызовами без повторного
// ввода); если не передан — берётся ранее сохранённый, ошибка если ни разу
// не задавался.
func (s *NetworkService) CreateInvite(ctx context.Context, label, publicURL string) (*NetworkInviteOut, error) {
	_, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	publicURL = strings.TrimSpace(publicURL)
	var acc models.CompanyAccount
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", account).First(&acc).Error; err != nil {
		return nil, err
	}
	if publicURL != "" {
		if err := s.r.Raw().WithContext(ctx).Model(&models.CompanyAccount{}).
			Where("id = ?", account).Update("public_url", publicURL).Error; err != nil {
			return nil, err
		}
	} else if acc.PublicURL != nil && *acc.PublicURL != "" {
		publicURL = *acc.PublicURL
	} else {
		return nil, apperrors.Wrap("VALIDATION", "укажите публичный адрес центрального узла", nil)
	}

	code, err := generateInviteCode()
	if err != nil {
		return nil, apperrors.Wrap("INTERNAL", "не удалось сгенерировать код", err)
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()
	inv := &models.NetworkInvite{
		ID: uuid.NewString(), AccountID: account, Code: code,
		Label: strPtrOrNil(label), CreatedBy: strPtrOrNil(actor.UserName),
		CreatedAt: now, ExpiresAt: now.Add(inviteTTL),
	}
	if err := s.r.Raw().WithContext(ctx).Create(inv).Error; err != nil {
		return nil, err
	}
	out := inviteOut(inv, publicURL)
	return &out, nil
}

// ListInvites — все коды сети текущего central, новые сверху.
func (s *NetworkService) ListInvites(ctx context.Context) ([]NetworkInviteOut, error) {
	_, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	var acc models.CompanyAccount
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", account).First(&acc).Error; err != nil {
		return nil, err
	}
	publicURL := ""
	if acc.PublicURL != nil {
		publicURL = *acc.PublicURL
	}
	var rows []models.NetworkInvite
	if err := s.r.Raw().WithContext(ctx).Where("account_id = ?", account).
		Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]NetworkInviteOut, 0, len(rows))
	for i := range rows {
		out = append(out, inviteOut(&rows[i], publicURL))
	}
	return out, nil
}

// RevokeInvite — удаляет код (использованный или ещё нет — это просто
// список для владельца, не журнал).
func (s *NetworkService) RevokeInvite(ctx context.Context, id string) error {
	_, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return err
	}
	res := s.r.Raw().WithContext(ctx).Where("id = ? AND account_id = ?", id, account).Delete(&models.NetworkInvite{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// RedeemResult — то, что central отдаёт филиалу при успешном обмене кода.
type RedeemResult struct {
	Token       string `json:"token"`
	AccountID   string `json:"account_id"`
	CentralName string `json:"central_name"`
}

// RedeemInvite — ПУБЛИЧНЫЙ обмен: код → настоящий sync-секрет+account_id.
// Вызывается филиалом server-to-server, БЕЗ auth-контекста — единственная
// защита — обладание кодом (см. заголовок файла: секрет не идёт в открытую
// pairing-строку, только через этот подтверждённый обмен).
func (s *NetworkService) RedeemInvite(ctx context.Context, code, callerRestaurantID, callerRestaurantName string) (*RedeemResult, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil, apperrors.Wrap("VALIDATION", "код обязателен", nil)
	}
	var inv models.NetworkInvite
	if err := s.r.Raw().WithContext(ctx).Where("code = ?", code).First(&inv).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("NOT_FOUND", "код приглашения не найден", nil)
		}
		return nil, err
	}
	if inv.UsedAt != nil {
		return nil, apperrors.Wrap("CONFLICT", "код приглашения уже использован", nil)
	}
	if time.Now().UTC().After(inv.ExpiresAt) {
		return nil, apperrors.Wrap("CONFLICT", "код приглашения истёк", nil)
	}

	// Central обычно единственный ресторан своей БД, но матчим строго по
	// account_id инвайта, не «первый попавшийся central_warehouse».
	var central models.Restaurant
	if err := s.r.Raw().WithContext(ctx).
		Where("account_id = ? AND kind = ?", inv.AccountID, "central_warehouse").
		First(&central).Error; err != nil {
		return nil, apperrors.Wrap("INTERNAL", "central-ресторан сети не найден", err)
	}
	if s.syncToken == "" {
		return nil, apperrors.Wrap("PRECONDITION", "на central не настроен sync-токен", nil)
	}

	now := time.Now().UTC()
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		res := tr.Raw().WithContext(ctx).Model(&models.NetworkInvite{}).
			Where("id = ? AND used_at IS NULL", inv.ID).
			Updates(map[string]any{
				"used_at":                 now,
				"used_by_restaurant_id":   strPtrOrNil(callerRestaurantID),
				"used_by_restaurant_name": strPtrOrNil(callerRestaurantName),
			})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			// Гонка: кто-то использовал код между First() выше и этим Update.
			return apperrors.Wrap("CONFLICT", "код приглашения уже использован", nil)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &RedeemResult{Token: s.syncToken, AccountID: inv.AccountID, CentralName: central.Name}, nil
}

// JoinResult — что фронт филиала показывает после успешного подключения.
type JoinResult struct {
	CentralName string `json:"central_name"`
}

// parsePairingCode разбирает строку вида <baseURL>/pair/<code>.
func parsePairingCode(raw string) (baseURL, code string, err error) {
	raw = strings.TrimSpace(raw)
	const sep = "/pair/"
	idx := strings.LastIndex(raw, sep)
	if idx <= 0 || idx+len(sep) >= len(raw) {
		return "", "", apperrors.Wrap("VALIDATION", "неверный формат кода приглашения", nil)
	}
	// Защита от случайного хвостового «/» при копировании ссылки.
	code = strings.TrimRight(raw[idx+len(sep):], "/")
	if code == "" {
		return "", "", apperrors.Wrap("VALIDATION", "неверный формат кода приглашения", nil)
	}
	return raw[:idx], code, nil
}

// JoinNetwork — сторона филиала: обменивает код приглашения на central на
// настоящие sync-токен+account_id и атомарно сохраняет их локально
// (restaurants.account_id + sync_settings). Owner-only.
func (s *NetworkService) JoinNetwork(ctx context.Context, pairingCode string) (*JoinResult, error) {
	actor, _ := audit.ActorFromContext(ctx)
	if actor.Role != "owner" {
		return nil, apperrors.Wrap("FORBIDDEN", "только владелец может подключить филиал к сети", nil)
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		return nil, err
	}
	if rest.Kind != nil && *rest.Kind == "central_warehouse" {
		return nil, apperrors.Wrap("VALIDATION", "центральный склад не подключается к сети — сеть создаётся здесь", nil)
	}

	baseURL, code, err := parsePairingCode(pairingCode)
	if err != nil {
		return nil, err
	}

	reqBody, _ := json.Marshal(map[string]string{
		"code": code, "restaurant_id": rid, "restaurant_name": rest.Name,
	})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/v1/sync/pair", bytes.NewReader(reqBody))
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "неверный адрес центрального узла", nil)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "не удалось связаться с центральным узлом: "+err.Error(), nil)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var env struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&env)
		msg := env.Message
		if msg == "" {
			msg = fmt.Sprintf("центральный узел ответил %d", resp.StatusCode)
		}
		return nil, apperrors.Wrap("VALIDATION", msg, nil)
	}
	var out RedeemResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, apperrors.Wrap("INTERNAL", "неверный ответ центрального узла", err)
	}

	existing, err := NewSyncSettingsService(s.r).Get(ctx)
	if err != nil {
		return nil, err
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		if err := tr.Raw().WithContext(ctx).Model(&models.Restaurant{}).Where("id = ?", rid).
			Update("account_id", out.AccountID).Error; err != nil {
			return err
		}
		_, err := NewSyncSettingsService(tr).Update(ctx, UpdateSyncSettingsInput{
			Enabled: true, CentralURL: baseURL, Token: out.Token,
			RestaurantID: rid, IntervalSec: existing.IntervalSec,
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	return &JoinResult{CentralName: out.CentralName}, nil
}
