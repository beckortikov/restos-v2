package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// NetworkService — сетевые справочники для multi-branch (ADR-003, Фаза 1):
// филиалы сети + общий каталог номенклатуры + привязка ингредиентов.
//
// account_id выводим из ресторана в контексте (не из middleware): эти эндпоинты
// доступны любой роли филиала, а сеть определяется рестораном, в котором
// залогинен пользователь.
type NetworkService struct {
	r *repo.Repo
}

func NewNetworkService(r *repo.Repo) *NetworkService {
	return &NetworkService{r: r}
}

// accountForCtx — account_id ресторана из контекста; ErrValidation если не в сети.
func (s *NetworkService) accountForCtx(ctx context.Context) (string, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return "", err
	}
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Select("account_id").Where("id = ?", rid).First(&rest).Error; err != nil {
		return "", err
	}
	if rest.AccountID == nil || *rest.AccountID == "" {
		return "", apperrors.Wrap("VALIDATION", "restaurant is not part of a network", nil)
	}
	return *rest.AccountID, nil
}

// Branch — короткое представление филиала сети.
type Branch struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Kind *string `json:"kind"`
}

// ListBranches возвращает все рестораны сети (включая текущий). Если ресторан
// не в сети — возвращает только его самого (одиночный режим).
func (s *NetworkService) ListBranches(ctx context.Context) ([]Branch, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var self models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&self).Error; err != nil {
		return nil, err
	}
	var rows []models.Restaurant
	if self.AccountID == nil || *self.AccountID == "" {
		rows = []models.Restaurant{self}
	} else {
		if err := s.r.Raw().WithContext(ctx).
			Where("account_id = ?", *self.AccountID).
			Order("kind DESC, name ASC"). // central_warehouse выше outlet
			Find(&rows).Error; err != nil {
			return nil, err
		}
	}
	out := make([]Branch, 0, len(rows))
	for _, r := range rows {
		out = append(out, Branch{ID: r.ID, Name: r.Name, Kind: r.Kind})
	}
	return out, nil
}

// ListNomenclature возвращает общий каталог номенклатуры сети.
func (s *NetworkService) ListNomenclature(ctx context.Context) ([]models.Nomenclature, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.Nomenclature
	if err := s.r.Raw().WithContext(ctx).
		Where("account_id = ?", account).Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// CreateNomenclatureInput — body POST /api/v1/nomenclature.
type CreateNomenclatureInput struct {
	Name     string  `json:"name"`
	Unit     *string `json:"unit,omitempty"`
	Category *string `json:"category,omitempty"`
}

// CreateNomenclature заводит продукт в общий каталог сети.
func (s *NetworkService) CreateNomenclature(ctx context.Context, in CreateNomenclatureInput) (*models.Nomenclature, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	n := &models.Nomenclature{
		ID:        uuid.NewString(),
		AccountID: &account,
		Name:      in.Name,
		Unit:      in.Unit,
		Category:  in.Category,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.r.Raw().WithContext(ctx).Create(n).Error; err != nil {
		return nil, err
	}
	return n, nil
}

// LinkIngredient привязывает ингредиент текущего ресторана к номенклатуре сети.
func (s *NetworkService) LinkIngredient(ctx context.Context, ingredientID, nomenclatureID string) error {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return err
	}
	// Номенклатура должна принадлежать той же сети.
	var nom models.Nomenclature
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", nomenclatureID).First(&nom).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.Wrap("VALIDATION", "nomenclature not found", nil)
		}
		return err
	}
	if nom.AccountID == nil || *nom.AccountID != account {
		return apperrors.Wrap("VALIDATION", "nomenclature belongs to a different network", nil)
	}
	// Обновляем только свой ингредиент (ForTenant — tenant-safe).
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Model(&models.Ingredient{}).
		Where("id = ?", ingredientID).
		Update("nomenclature_id", nomenclatureID)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// CreateNetwork заводит сеть (company_account) и делает ТЕКУЩИЙ ресторан её
// центральным складом. Ошибка, если ресторан уже в сети. Другие филиалы
// присоединяются к сети своим account_id (из лицензии на своей установке).
func (s *NetworkService) CreateNetwork(ctx context.Context, name string) (*models.CompanyAccount, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		return nil, err
	}
	if rest.AccountID != nil && *rest.AccountID != "" {
		return nil, apperrors.Wrap("CONFLICT", "restaurant is already part of a network", nil)
	}
	if name == "" {
		name = rest.Name
	}
	now := time.Now().UTC()
	accountID := uuid.NewString()
	cw := "central_warehouse"
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(&models.CompanyAccount{ID: accountID, Name: name, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			return err
		}
		return tx.Model(&models.Restaurant{}).Where("id = ?", rid).
			Updates(map[string]any{"account_id": accountID, "kind": cw}).Error
	})
	if err != nil {
		return nil, err
	}
	return &models.CompanyAccount{ID: accountID, Name: name, CreatedAt: now, UpdatedAt: now}, nil
}

// SetBranchKind меняет тип филиала (outlet | central_warehouse) в рамках сети
// текущего ресторана.
func (s *NetworkService) SetBranchKind(ctx context.Context, restaurantID, kind string) error {
	if kind != "outlet" && kind != "central_warehouse" {
		return apperrors.Wrap("VALIDATION", "kind must be outlet or central_warehouse", nil)
	}
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return err
	}
	res := s.r.Raw().WithContext(ctx).Model(&models.Restaurant{}).
		Where("id = ? AND account_id = ?", restaurantID, account).
		Update("kind", kind)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// BranchSummary — строка сводки по филиалу.
type BranchSummary struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Kind    *string         `json:"kind"`
	Revenue decimal.Decimal `json:"revenue"`
}

// NetworkSummary — сводка владельцу по сети (ADR-003, Фаза 4).
type NetworkSummary struct {
	From         string          `json:"from,omitempty"`
	To           string          `json:"to,omitempty"`
	TotalRevenue decimal.Decimal `json:"total_revenue"`
	Branches     []BranchSummary `json:"branches"`
}

// Summary — выручка по сети и по каждому филиалу за период (ADR-003, Фаза 4).
// Источник — financial_operations(type=in, category=revenue). На центральном
// узле они собраны со всех филиалов через sync; в однобазовом режиме — там же.
//
// financial_operations не имеет account_id, поэтому фильтруем по restaurant_id
// IN (<филиалы сети>) — сетевой доступ к per-restaurant таблице (Raw, легитимно).
func (s *NetworkService) Summary(ctx context.Context, from, to string) (*NetworkSummary, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	// Филиалы сети.
	var branches []models.Restaurant
	if err := s.r.Raw().WithContext(ctx).
		Where("account_id = ?", account).
		Order("kind DESC, name ASC").
		Find(&branches).Error; err != nil {
		return nil, err
	}
	ids := make([]string, len(branches))
	for i, b := range branches {
		ids[i] = b.ID
	}

	// Выручка по филиалам за период.
	revByRest := make(map[string]decimal.Decimal, len(ids))
	if len(ids) > 0 {
		type revRow struct {
			RestaurantID string
			Revenue      decimal.Decimal
		}
		q := s.r.Raw().WithContext(ctx).
			Model(&models.FinancialOperation{}).
			Select("restaurant_id, COALESCE(SUM(amount), 0) AS revenue").
			Where("restaurant_id IN ? AND type = ? AND category = ?", ids, "in", "revenue")
		if from != "" {
			q = q.Where("created_at >= ?", from)
		}
		if to != "" {
			q = q.Where("created_at <= ?", to)
		}
		var rows []revRow
		if err := q.Group("restaurant_id").Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, r := range rows {
			revByRest[r.RestaurantID] = decimal.Normalize(r.Revenue)
		}
	}

	out := &NetworkSummary{From: from, To: to, TotalRevenue: decimal.Zero}
	for _, b := range branches {
		rev := revByRest[b.ID]
		out.Branches = append(out.Branches, BranchSummary{ID: b.ID, Name: b.Name, Kind: b.Kind, Revenue: rev})
		out.TotalRevenue = decimal.Add(out.TotalRevenue, rev)
	}
	out.TotalRevenue = decimal.Normalize(out.TotalRevenue)
	return out, nil
}
